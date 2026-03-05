import { Provider } from 'ethers';
import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getAbi, getProtocolConfig, getStablePriceOverrides } from '../utils/config';
import {
  ARBITRUM_CHAIN_ID,
  formatUnits,
  getContract,
  getProviderForChain,
  toChecksumAddress,
} from '../utils/ethereum';
import {
  getUniswapV3PositionField,
  getWalletUniswapV3Inventory,
  RawUniswapV3PositionInfo,
} from '../utils/uniswap-v3-inventory';
const MAX_UINT128 = (2n ** 128n) - 1n;

interface UniswapV3LpConfig {
  positionManager: string;
  poolAddress: string;
  currency0: string;
  currency1: string;
  currency0Symbol: string;
  currency1Symbol: string;
  currency0Decimals: number;
  currency1Decimals: number;
}

interface UniswapV3PositionInfo {
  token0: string;
  token1: string;
  fee: bigint | number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

interface UniswapV3CollectParams {
  tokenId: bigint;
  recipient: string;
  amount0Max: bigint;
  amount1Max: bigint;
}

type UniswapV3CollectResult = [bigint, bigint] | { amount0: bigint; amount1: bigint };

interface UniswapV3PositionManagerContract {
  balanceOf(owner: string): Promise<bigint>;
  tokenOfOwnerByIndex(owner: string, index: bigint): Promise<bigint>;
  positions(tokenId: bigint): Promise<UniswapV3PositionInfo>;
  collect: {
    staticCall(
      params: UniswapV3CollectParams,
      overrides: { from: string }
    ): Promise<UniswapV3CollectResult>;
  };
}

interface UniswapV3PoolContract {
  slot0(): Promise<[bigint, number, ...unknown[]]>;
}

/**
 * Uniswap v3 USDT/USDC (Arbitrum) full savings adapter.
 *
 * Tracks the full LP position value (principal + uncollected fees) for the
 * USDC/USDT pool on Arbitrum. Both tokens are stablecoins so USD value ≈ token amounts.
 */
export class UniswapV3UsdtUsdcArbitrumAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'uniswap-v3-usdt-usdc-arbitrum' as const;
  readonly protocolName = 'Uniswap v3 USDT/USDC (Arbitrum)';

  private arbitrumProvider: Provider | null = null;
  private warnedMissingRpc = false;

  private getPositionField(positionInfo: UniswapV3PositionInfo, index: number, key: keyof UniswapV3PositionInfo): unknown {
    return getUniswapV3PositionField(positionInfo as unknown as RawUniswapV3PositionInfo, index, key);
  }

  private getArbitrumProvider(): Provider | null {
    if (this.arbitrumProvider) {
      return this.arbitrumProvider;
    }

    try {
      this.arbitrumProvider = getProviderForChain(ARBITRUM_CHAIN_ID);
      return this.arbitrumProvider;
    } catch {
      if (!this.warnedMissingRpc) {
        console.warn(
          `[${this.protocolName}] No Arbitrum RPC provider configured. ` +
          `Configure chain-capable providers in admin or set ARBITRUM_RPC_URL/ARBITRUM_RPC_URLS.`
        );
        this.warnedMissingRpc = true;
      }
      return null;
    }
  }

  private getValidatedConfig(): UniswapV3LpConfig {
    const config = getProtocolConfig()[this.protocolKey];
    if (
      !config ||
      !config.positionManager ||
      !config.poolAddress ||
      !config.currency0 ||
      !config.currency1 ||
      config.currency0Decimals === undefined ||
      config.currency1Decimals === undefined
    ) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }

    return {
      positionManager: config.positionManager,
      poolAddress: config.poolAddress,
      currency0: config.currency0,
      currency1: config.currency1,
      currency0Symbol: config.currency0Symbol || 'USDC',
      currency1Symbol: config.currency1Symbol || 'USDT',
      currency0Decimals: config.currency0Decimals,
      currency1Decimals: config.currency1Decimals,
    };
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const provider = this.getArbitrumProvider();
    if (!provider) {
      return [];
    }

    const config = this.getValidatedConfig();
    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    try {
      const inventory = await getWalletUniswapV3Inventory(
        ARBITRUM_CHAIN_ID,
        checksumAddress,
        config.positionManager,
        provider
      );
      if (inventory.length === 0) {
        return positions;
      }

      const expectedToken0 = config.currency0.toLowerCase();
      const expectedToken1 = config.currency1.toLowerCase();

      for (const entry of inventory) {
        const token0 = entry.token0.toLowerCase();
        const token1 = entry.token1.toLowerCase();

        const pairMatches =
          (token0 === expectedToken0 && token1 === expectedToken1) ||
          (token0 === expectedToken1 && token1 === expectedToken0);
        if (!pairMatches) {
          continue;
        }

        const tokenIdString = entry.tokenId.toString();

        positions.push({
          protocolPositionKey: this.createPositionKey(config.positionManager, tokenIdString),
          displayName: `${this.protocolName} #${tokenIdString}`,
          baseAsset: config.currency0Symbol,
          countingMode: 'count',
          measureMethod: 'lp-position',
          metadata: {
            walletAddress: checksumAddress,
            tokenId: tokenIdString,
            positionManager: config.positionManager,
            poolAddress: config.poolAddress,
            currency0Decimals: config.currency0Decimals,
            currency1Decimals: config.currency1Decimals,
            currency0Symbol: config.currency0Symbol,
            currency1Symbol: config.currency1Symbol,
            chainId: ARBITRUM_CHAIN_ID,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering ${this.protocolName} positions for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const provider = this.getArbitrumProvider();
    if (!provider) {
      throw new Error(`[${this.protocolName}] Arbitrum RPC provider is required to read position values`);
    }

    const {
      walletAddress,
      tokenId,
      positionManager,
      poolAddress,
      currency0Decimals,
      currency1Decimals,
    } = position.metadata;

    if (
      !walletAddress ||
      !tokenId ||
      !positionManager ||
      !poolAddress ||
      currency0Decimals === undefined ||
      currency1Decimals === undefined
    ) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const checksumAddress = toChecksumAddress(walletAddress);
    const positionManagerAbi = getAbi('UniswapV3NonfungiblePositionManager');
    const contract = getContract(
      positionManager,
      positionManagerAbi,
      provider
    ) as unknown as UniswapV3PositionManagerContract;

    const tokenIdBigInt = BigInt(tokenId);
    const collectParams: UniswapV3CollectParams = {
      tokenId: tokenIdBigInt,
      recipient: checksumAddress,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    };

    // Get current position state (liquidity + ticks)
    const positionInfo = await contract.positions(tokenIdBigInt);
    const liquidity = BigInt((this.getPositionField(positionInfo, 7, 'liquidity') ?? 0n) as bigint | number | string);
    const tickLower = Number(this.getPositionField(positionInfo, 5, 'tickLower') ?? 0);
    const tickUpper = Number(this.getPositionField(positionInfo, 6, 'tickUpper') ?? 0);

    // Get uncollected fees via staticCall
    const collectResult = await contract.collect.staticCall(collectParams, { from: checksumAddress });
    const fees0Raw = Array.isArray(collectResult) ? collectResult[0] : collectResult.amount0;
    const fees1Raw = Array.isArray(collectResult) ? collectResult[1] : collectResult.amount1;
    const fees0 = BigInt(fees0Raw ?? 0n);
    const fees1 = BigInt(fees1Raw ?? 0n);

    const stablePriceOverrides = getStablePriceOverrides();
    const token0Price = this.getStablePrice(
      position.metadata.currency0Symbol || 'USDC',
      stablePriceOverrides
    );
    const token1Price = this.getStablePrice(
      position.metadata.currency1Symbol || 'USDT',
      stablePriceOverrides
    );

    const fees0Usd = parseFloat(formatUnits(fees0, Number(currency0Decimals))) * token0Price;
    const fees1Usd = parseFloat(formatUnits(fees1, Number(currency1Decimals))) * token1Price;

    // If no liquidity, return only fees
    if (liquidity === 0n) {
      return fees0Usd + fees1Usd;
    }

    // Get current sqrt price from pool
    const poolAbi = getAbi('UniswapV3Pool');
    const poolContract = getContract(poolAddress, poolAbi, provider) as unknown as UniswapV3PoolContract;
    const slot0Result = await poolContract.slot0();
    const sqrtPriceX96 = BigInt(slot0Result[0]);

    // Calculate token amounts from liquidity using tick math
    const sqrtPriceAX96 = this.getSqrtRatioAtTick(tickLower);
    const sqrtPriceBX96 = this.getSqrtRatioAtTick(tickUpper);
    const { amount0, amount1 } = this.getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtPriceAX96,
      sqrtPriceBX96,
      liquidity
    );

    const amount0Usd = parseFloat(formatUnits(amount0, Number(currency0Decimals))) * token0Price;
    const amount1Usd = parseFloat(formatUnits(amount1, Number(currency1Decimals))) * token1Price;

    return amount0Usd + amount1Usd + fees0Usd + fees1Usd;
  }

  /**
   * Calculate sqrt price from tick: sqrtPriceX96 = sqrt(1.0001^tick) * 2^96
   */
  private getSqrtRatioAtTick(tick: number): bigint {
    const price = Math.pow(1.0001, tick);
    const sqrtPrice = Math.sqrt(price);
    const Q96 = 2n ** 96n;
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  /**
   * Calculate token amounts from liquidity using Uniswap v3 math.
   */
  private getAmountsForLiquidity(
    sqrtPriceX96: bigint,
    sqrtPriceAX96: bigint,
    sqrtPriceBX96: bigint,
    liquidity: bigint
  ): { amount0: bigint; amount1: bigint } {
    if (sqrtPriceAX96 > sqrtPriceBX96) {
      [sqrtPriceAX96, sqrtPriceBX96] = [sqrtPriceBX96, sqrtPriceAX96];
    }

    const Q96 = 2n ** 96n;
    let amount0 = 0n;
    let amount1 = 0n;

    if (sqrtPriceX96 <= sqrtPriceAX96) {
      // Current price below range — all token0
      amount0 = (liquidity * Q96 * (sqrtPriceBX96 - sqrtPriceAX96)) / (sqrtPriceBX96 * sqrtPriceAX96);
    } else if (sqrtPriceX96 < sqrtPriceBX96) {
      // Current price in range
      amount0 = (liquidity * Q96 * (sqrtPriceBX96 - sqrtPriceX96)) / (sqrtPriceBX96 * sqrtPriceX96);
      amount1 = (liquidity * (sqrtPriceX96 - sqrtPriceAX96)) / Q96;
    } else {
      // Current price above range — all token1
      amount1 = (liquidity * (sqrtPriceBX96 - sqrtPriceAX96)) / Q96;
    }

    return { amount0, amount1 };
  }
}
