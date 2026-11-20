import { AbiCoder, Interface, keccak256, zeroPadValue } from 'ethers';
import type { Log } from 'ethers';
import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import {
  ETHEREUM_CHAIN_ID,
  formatUnits,
  getContract,
  getScanCapableProviderForChain,
  rpcThrottle,
  toChecksumAddress,
} from '../utils/ethereum';
import { getAbi, getProtocolConfig, getStablePriceOverrides } from '../utils/config';
import { scanLogsResumable } from '../utils/log-scan';
import { getWalletLogScanState, saveWalletLogScanState } from '../models/wallet-log-scan-state';

/**
 * Infinifi unwinding (cooldown) positions.
 *
 * Calling `startUnwinding` on liUSD burns the locked shares and moves the
 * underlying iUSD into the UnwindingModule, where it keeps earning (with a
 * linearly decreasing reward weight) until the user withdraws. Each unwinding
 * is keyed by (user, block.timestamp of startUnwinding) and is not enumerable
 * on-chain, so discovery finds start timestamps from the LockingController's
 * `PositionRemoved(timestamp indexed, user indexed, amount, unwindingEpochs indexed)`
 * logs, then verifies each with `UnwindingModule.balanceOf(user, timestamp)`.
 *
 * `PositionRemoved` is also emitted by `increaseUnwindingEpochs`; those
 * timestamps have no unwinding position and verify to a zero balance.
 */

// EpochLib: 1-week epochs offset by 3 days.
const EPOCH_SECONDS = 7 * 24 * 60 * 60;
const EPOCH_OFFSET_SECONDS = 3 * 24 * 60 * 60;

const PROTOCOL_KEY = 'infinifi-unwinding';
const LOG_LABEL = '[Infinifi unwinding]';
const DEFAULT_SCAN_CHUNK_SIZE = 500_000;
const DEFAULT_MAX_LOG_QUERIES = 100;

interface UnwindingModuleContract {
  balanceOf(user: string, startUnwindingTimestamp: bigint): Promise<bigint>;
  positions(id: string): Promise<{ toEpoch: bigint }>;
}

interface InfinifiUnwindingConfig {
  lockingController: string;
  unwindingModule: string;
  deployBlock: number;
  baseAsset: string;
  decimals: number;
}

function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

/** Matches UnwindingModule._unwindingId: keccak256(abi.encode(user, timestamp)). */
export function getUnwindingId(user: string, startUnwindingTimestamp: bigint): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [user, startUnwindingTimestamp]));
}

/** Matches EpochLib.epochToTimestamp. */
export function epochToTimestamp(epoch: bigint): bigint {
  return epoch * BigInt(EPOCH_SECONDS) + BigInt(EPOCH_OFFSET_SECONDS);
}

/**
 * Extract unique start timestamps (decimal strings) from PositionRemoved logs
 * for `walletAddress`. Logs for other users or unparseable logs are ignored.
 */
export function extractUnwindingTimestamps(logs: readonly Log[], walletAddress: string): string[] {
  const iface = new Interface(getAbi('InfinifiLockingController'));
  const timestamps = new Set<string>();
  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      continue;
    }
    if (parsed?.name !== 'PositionRemoved') continue;
    if (String(parsed.args.user).toLowerCase() !== walletAddress.toLowerCase()) continue;
    timestamps.add((parsed.args.timestamp as bigint).toString());
  }
  return [...timestamps];
}

function parseTimestamp(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`Invalid Infinifi unwinding start timestamp: ${String(value)}`);
  }
  return BigInt(value);
}

export class InfinifiUnwindingAdapter extends BaseProtocolAdapter {
  readonly protocolKey = PROTOCOL_KEY;
  readonly protocolName = 'Infinifi iUSD Unwinding';

  private getConfig(): InfinifiUnwindingConfig {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config?.lockingController || !config.unwindingModule || config.deployBlock === undefined) {
      throw new Error('Infinifi unwinding config is missing lockingController, unwindingModule or deployBlock');
    }
    return {
      lockingController: config.lockingController,
      unwindingModule: config.unwindingModule,
      deployBlock: config.deployBlock,
      baseAsset: config.baseAsset || 'iUSD',
      decimals: config.decimals ?? 18,
    };
  }

  private getModule(address: string): UnwindingModuleContract {
    return getContract(address, getAbi('InfinifiUnwindingModule')) as unknown as UnwindingModuleContract;
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = this.getConfig();
    const user = toChecksumAddress(walletAddress);
    const scanKey = `${PROTOCOL_KEY}:${config.lockingController.toLowerCase()}`;

    const state = await getWalletLogScanState(user, ETHEREUM_CHAIN_ID, scanKey);
    const candidateTimestamps = new Set(state.foundKeys);
    let scanError: Error | undefined;

    const scanProvider = getScanCapableProviderForChain(ETHEREUM_CHAIN_ID);
    if (!scanProvider) {
      console.warn(`${LOG_LABEL} No scan-capable Ethereum provider; only re-verifying known unwinding positions`);
    } else {
      const iface = new Interface(getAbi('InfinifiLockingController'));
      const latestBlock = await scanProvider.getBlockNumber();
      const result = await scanLogsResumable(
        scanProvider,
        {
          address: config.lockingController,
          topics: [iface.getEvent('PositionRemoved')!.topicHash, null, zeroPadValue(user, 32)],
        },
        {
          startBlock: config.deployBlock,
          latestBlock,
          scannedFromBlock: state.scannedFromBlock,
          scannedToBlock: state.scannedToBlock,
          initialChunkSize: getPositiveIntegerEnv('INFINIFI_UNWINDING_SCAN_CHUNK_SIZE', DEFAULT_SCAN_CHUNK_SIZE),
          maxQueries: getPositiveIntegerEnv('INFINIFI_UNWINDING_MAX_LOG_QUERIES', DEFAULT_MAX_LOG_QUERIES),
          label: LOG_LABEL,
        }
      );
      for (const timestamp of extractUnwindingTimestamps(result.logs, user)) {
        candidateTimestamps.add(timestamp);
      }
      state.scannedFromBlock = result.scannedFromBlock;
      state.scannedToBlock = result.scannedToBlock;
      scanError = result.error;
    }

    // Persist scan progress and candidates before any verification read can fail.
    state.foundKeys = [...candidateTimestamps];
    await saveWalletLogScanState(user, ETHEREUM_CHAIN_ID, scanKey, state);

    const module = this.getModule(config.unwindingModule);
    const positions: Partial<Position>[] = [];
    const liveTimestamps: string[] = [];

    for (const timestampKey of candidateTimestamps) {
      const startTimestamp = parseTimestamp(timestampKey);
      await rpcThrottle();
      const balance = await module.balanceOf(user, startTimestamp);
      if (balance === 0n) continue; // withdrawn, cancelled, or an epoch-extension event

      liveTimestamps.push(timestampKey);
      await rpcThrottle();
      const { toEpoch } = await module.positions(getUnwindingId(user, startTimestamp));
      const unlockTimestamp = epochToTimestamp(BigInt(toEpoch));
      const unlockDate = new Date(Number(unlockTimestamp) * 1000).toISOString().slice(0, 10);

      positions.push({
        protocolPositionKey: this.createPositionKey(config.unwindingModule.toLowerCase(), timestampKey),
        displayName: `Infinifi iUSD unwinding (unlocks ${unlockDate})`,
        baseAsset: config.baseAsset,
        countingMode: 'count',
        measureMethod: 'balance',
        metadata: {
          unwindingModule: config.unwindingModule,
          lockingController: config.lockingController,
          startUnwindingTimestamp: timestampKey,
          unlockTimestamp: unlockTimestamp.toString(),
          decimals: config.decimals,
          baseAsset: config.baseAsset,
          chainId: ETHEREUM_CHAIN_ID,
        },
        isActive: true,
      });
    }

    // Drop candidates confirmed empty on-chain so later runs skip them.
    if (liveTimestamps.length !== candidateTimestamps.size) {
      state.foundKeys = liveTimestamps;
      await saveWalletLogScanState(user, ETHEREUM_CHAIN_ID, scanKey, state);
    }

    if (scanError && positions.length === 0) {
      // Nothing verified and history is incomplete: surface the failure so discovery retries.
      throw new Error(`${LOG_LABEL} log scan failed for ${user}`, { cause: scanError });
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { unwindingModule, startUnwindingTimestamp, decimals, walletAddress } = position.metadata;
    if (!unwindingModule || !walletAddress || decimals === undefined) {
      throw new Error('Invalid Infinifi unwinding position metadata');
    }

    const startTimestamp = parseTimestamp(startUnwindingTimestamp);
    await rpcThrottle();
    const balance = await this.getModule(unwindingModule).balanceOf(walletAddress, startTimestamp);
    if (balance === 0n) {
      console.log(`${LOG_LABEL} Zero balance for unwinding ${startTimestamp} (withdrawn or cancelled)`);
      return 0;
    }

    const baseAsset = position.metadata.baseAsset || 'iUSD';
    const priceUsd = this.getStablePrice(baseAsset, getStablePriceOverrides());
    return parseFloat(formatUnits(balance, decimals)) * priceUsd;
  }
}
