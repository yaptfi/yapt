import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';

interface LockedPositionTokenContract {
  core(): Promise<string>;
  unwindingEpochs(): Promise<bigint>;
}

interface LockingControllerContract {
  exchangeRate(unwindingEpochs: number): Promise<bigint>;
}

export const INFINIFI_RATE_SCALE_DEFAULT = 10n ** 27n;

export function parseRateScale(rateScale?: string): bigint {
  if (!rateScale) {
    return INFINIFI_RATE_SCALE_DEFAULT;
  }

  try {
    const parsed = BigInt(rateScale);
    return parsed > 0n ? parsed : INFINIFI_RATE_SCALE_DEFAULT;
  } catch {
    return INFINIFI_RATE_SCALE_DEFAULT;
  }
}

export function applyScaledExchangeRate(
  shareAmount: bigint,
  exchangeRate: bigint,
  rateScale: bigint = INFINIFI_RATE_SCALE_DEFAULT
): bigint {
  if (rateScale <= 0n) {
    throw new Error('Rate scale must be positive');
  }

  return (shareAmount * exchangeRate) / rateScale;
}

export class InfinifiLiusd4wAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'infinifi-liusd-4w' as const;
  readonly protocolName = 'Infinifi Locked iUSD (4w)';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.token) {
      throw new Error('Infinifi liUSD-4w config not found');
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);
    const erc20Abi = getAbi('ERC20');
    const lockedTokenAbi = getAbi('InfinifiLockedPositionTokenV2');

    try {
      const tokenContract = getContract(config.token, erc20Abi);
      await rpcThrottle();
      const lockedBalance = await tokenContract.balanceOf(checksumAddress);

      if (lockedBalance === 0n) {
        return positions;
      }

      const lockedTokenContract = getContract(config.token, lockedTokenAbi);
      const lockedTokenReads = lockedTokenContract as unknown as LockedPositionTokenContract;
      let lockingController = config.lockingController;
      let unwindingEpochs = config.unwindingEpochs;

      if (!lockingController) {
        try {
          await rpcThrottle();
          lockingController = await lockedTokenReads.core();
        } catch {
          console.warn('Infinifi liUSD-4w: failed to read core() from locked token');
        }
      }

      if (unwindingEpochs === undefined) {
        try {
          await rpcThrottle();
          const epochsRaw = await lockedTokenReads.unwindingEpochs();
          unwindingEpochs = parseInt(epochsRaw.toString(), 10);
        } catch {
          console.warn('Infinifi liUSD-4w: failed to read unwindingEpochs() from locked token');
        }
      }

      const baseAsset = config.baseAsset || 'iUSD';
      const positionKey = this.createPositionKey(config.token, baseAsset);

      positions.push({
        protocolPositionKey: positionKey,
        displayName: 'Infinifi liUSD-4w',
        baseAsset,
        countingMode: config.countingMode || 'count',
        measureMethod: 'exchangeRate',
        metadata: {
          token: config.token,
          decimals: config.decimals ?? 18,
          lockingController,
          unwindingEpochs,
          exchangeRateScale: config.exchangeRateScale || INFINIFI_RATE_SCALE_DEFAULT.toString(),
          baseAsset,
          type: config.type,
        },
        isActive: true,
      });
    } catch (error) {
      console.error(`Error discovering Infinifi liUSD-4w for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, decimals, walletAddress } = position.metadata;

    if (!token || decimals === undefined || !walletAddress) {
      throw new Error('Invalid Infinifi liUSD-4w position metadata');
    }

    const erc20Abi = getAbi('ERC20');
    const lockedTokenAbi = getAbi('InfinifiLockedPositionTokenV2');
    const lockingControllerAbi = getAbi('InfinifiLockingController');

    const tokenContract = getContract(token, erc20Abi);
    await rpcThrottle();
    const lockedBalance = await tokenContract.balanceOf(walletAddress);

    if (lockedBalance === 0n) {
      console.log('Infinifi liUSD-4w: Zero balance detected (position exited)');
      return 0;
    }

    let lockingController: string | undefined = position.metadata.lockingController;
    let unwindingEpochs: number | undefined = position.metadata.unwindingEpochs;

    if (!lockingController || unwindingEpochs === undefined) {
      const lockedTokenContract = getContract(token, lockedTokenAbi);
      const lockedTokenReads = lockedTokenContract as unknown as LockedPositionTokenContract;

      if (!lockingController) {
        await rpcThrottle();
        lockingController = await lockedTokenReads.core();
      }

      if (unwindingEpochs === undefined) {
        await rpcThrottle();
        const epochsRaw = await lockedTokenReads.unwindingEpochs();
        unwindingEpochs = parseInt(epochsRaw.toString(), 10);
      }
    }

    if (!lockingController || unwindingEpochs === undefined) {
      throw new Error('Missing locking controller or unwinding epochs for Infinifi liUSD-4w');
    }

    const controllerContract = getContract(lockingController, lockingControllerAbi);
    const controllerReads = controllerContract as unknown as LockingControllerContract;
    await rpcThrottle();
    const exchangeRate = await controllerReads.exchangeRate(unwindingEpochs);

    const rateScale = parseRateScale(position.metadata.exchangeRateScale);
    const receiptAmount = applyScaledExchangeRate(lockedBalance, exchangeRate, rateScale);

    const baseAsset = position.metadata.baseAsset || 'iUSD';
    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice(baseAsset, priceOverrides);

    const receiptReadable = parseFloat(formatUnits(receiptAmount, decimals));

    console.log(
      `Infinifi liUSD-4w: ${formatUnits(lockedBalance, decimals)} locked shares -> ${receiptReadable.toFixed(2)} ${baseAsset}`
    );

    return receiptReadable * priceUsd;
  }
}
