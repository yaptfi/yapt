import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, multicallTryAggregate } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';

export class AaveV3Adapter extends BaseProtocolAdapter {
  readonly protocolKey = 'aave-v3' as const;
  readonly protocolName = 'Aave v3';

  // Lightweight in-memory cache of per-wallet aToken balances for this process
  // Keyed by checksum wallet address; values are aToken -> balance (bigint)
  private walletBalanceCache: Map<string, Map<string, bigint>> = new Map();
  private walletBalanceCacheTs: Map<string, number> = new Map();
  // Refresh cache at least this often to avoid stale balances across hourly updates
  private static readonly CACHE_TTL_MS = 60_000; // 60s default

  private getCachedBalance(wallet: string, aToken: string): bigint | undefined {
    const ts = this.walletBalanceCacheTs.get(wallet) || 0;
    const fresh = Date.now() - ts <= AaveV3Adapter.CACHE_TTL_MS;
    if (!fresh) return undefined;
    const byToken = this.walletBalanceCache.get(wallet);
    return byToken ? byToken.get(aToken.toLowerCase()) : undefined;
  }

  private async fetchAllMarketBalances(wallet: string): Promise<Map<string, bigint>> {
    const config = getProtocolConfig()['aave-v3'];
    if (!config || !Array.isArray(config.markets)) {
      const empty = new Map<string, bigint>();
      this.walletBalanceCache.set(wallet, empty);
      return empty;
    }
    const erc20Abi = getAbi('ERC20');
    const balances = new Map<string, bigint>();
    // Prefer a single Multicall3 over N sequential calls
    try {
      const calls: Array<{ target: string; callData: string }> = [];
      const interfaces: Array<{ aToken: string; contract: any }> = [];
      for (const market of config.markets) {
        const c = getContract(market.aToken, erc20Abi) as any;
        const data: string = c.interface.encodeFunctionData('balanceOf', [wallet]);
        calls.push({ target: market.aToken, callData: data });
        interfaces.push({ aToken: market.aToken, contract: c });
      }
      const results = await multicallTryAggregate(calls, false);
      for (let i = 0; i < interfaces.length; i++) {
        const { aToken, contract } = interfaces[i];
        const r = results[i];
        if (r && r.success && r.returnData && r.returnData !== '0x') {
          try {
            const decoded = contract.interface.decodeFunctionResult('balanceOf', r.returnData);
            const bal: bigint = BigInt(decoded[0].toString());
            balances.set(aToken.toLowerCase(), bal);
          } catch (error) {
            // Decoding failure is a critical error - throw instead of returning 0
            console.error(`Failed to decode balance for ${aToken}:`, error);
            throw new Error(`RPC decode error for ${aToken}: ${error}`);
          }
        } else {
          // RPC call failed - this is a critical error, not a zero balance
          console.error(`RPC call failed for ${aToken}, success=${r?.success}, returnData=${r?.returnData}`);
          throw new Error(`RPC call failed for ${aToken}`);
        }
      }
      this.walletBalanceCache.set(wallet, balances);
      this.walletBalanceCacheTs.set(wallet, Date.now());
      return balances;
    } catch (multicallError) {
      // Fallback to sequential calls if multicall unavailable
      console.warn('Multicall failed, falling back to sequential calls:', multicallError);
      for (const market of config.markets) {
        try {
          const aToken = getContract(market.aToken, erc20Abi);
          const bal: bigint = await aToken.balanceOf(wallet);
          balances.set(market.aToken.toLowerCase(), bal);
        } catch (error) {
          // RPC failure is critical - throw instead of returning 0
          console.error(`Sequential RPC call failed for ${market.aToken}:`, error);
          throw new Error(`RPC call failed for ${market.aToken}: ${error}`);
        }
      }
      this.walletBalanceCache.set(wallet, balances);
      this.walletBalanceCacheTs.set(wallet, Date.now());
      return balances;
    }
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['aave-v3'];
    if (!config || !config.markets) {
      throw new Error('Aave v3 config not found');
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    // Pre-fetch all aToken balances for this wallet and cache them
    const balanceMap = await this.fetchAllMarketBalances(checksumAddress);

    for (const market of config.markets) {
      try {
        const balance = balanceMap.get(market.aToken.toLowerCase()) || 0n;
        if (balance > 0n) {
          const positionKey = this.createPositionKey(market.aToken, market.asset);

          positions.push({
            protocolPositionKey: positionKey,
            displayName: `Aave v3 ${market.asset}`,
            baseAsset: market.asset,
            countingMode: 'count',
            measureMethod: 'balance',
            metadata: {
              aToken: market.aToken,
              asset: market.asset,
              decimals: market.decimals,
            },
            isActive: true,
          });
        }
      } catch (error) {
        console.error(`Error processing Aave v3 ${market.asset} for ${walletAddress}:`, error);
      }
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { aToken, asset, decimals } = position.metadata;

    if (!aToken || !asset || decimals === undefined) {
      throw new Error('Invalid Aave v3 position metadata');
    }

    // For Aave aTokens, balanceOf already includes accrued interest; reuse cached discover balance
    const walletAddress = position.metadata.walletAddress;
    if (!walletAddress) {
      throw new Error('Wallet address not found in position metadata');
    }
    // Try cache first to avoid duplicate RPC during same cycle.
    // If cache miss, batch-fetch all market balances once (multicall) and then read from cache.
    const checksum = toChecksumAddress(walletAddress);
    let balance = this.getCachedBalance(checksum, aToken);
    if (balance === undefined) {
      const all = await this.fetchAllMarketBalances(checksum);
      balance = all.get(aToken.toLowerCase()) ?? 0n;
    }
    const balanceReadable = parseFloat(formatUnits(balance, decimals));

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice(asset, priceOverrides);

    return balanceReadable * priceUsd;
  }

}
