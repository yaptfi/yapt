import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import {
  ARBITRUM_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  formatUnits,
  getContract,
  getProviderForChain,
  normalizeAddress,
  toChecksumAddress,
} from '../utils/ethereum';
import { getProtocolConfig, getAbi } from '../utils/config';
import { ethers } from 'ethers';
import { getWalletUniswapV4Inventory } from '../utils/uniswap-v4-inventory';
import { isUniswapV4PositionInRange } from '../utils/uniswap-range';

/**
 * Uniswap V4 LP Position Adapter
 *
 * Tracks USDC/USDT liquidity positions represented as NFTs.
 * This is fundamentally different from other adapters:
 * - NFT-based positions (no balanceOf, must scan Transfer events)
 * - Dual-asset LP (both USDC and USDT)
 * - Tick-based liquidity with complex fee calculations
 *
 * Position Value = Token amounts in range + Uncollected fees
 * Fee Calculation: (feeGrowthCurrent - feeGrowthLast) * liquidity / Q128
 */
export class UniswapV4Adapter extends BaseProtocolAdapter {
  readonly protocolKey = 'uniswap-v4-usdc-usdt' as const;
  readonly protocolName = 'Uniswap v4 USDC/USDT';

  private readonly Q128 = 2n ** 128n; // Used in fee calculations
  private warnedMissingRpc = false;

  private getValidatedConfig() {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.positionManager || !config.currency0 || !config.currency1 || !config.fee) {
      throw new Error('Uniswap v4 USDC/USDT config not found or incomplete');
    }

    return {
      ...config,
      chainId: config.chainId ?? ETHEREUM_CHAIN_ID,
      positionManager: normalizeAddress(config.positionManager),
      stateView: config.stateView ? normalizeAddress(config.stateView) : config.stateView,
      currency0: normalizeAddress(config.currency0),
      currency1: normalizeAddress(config.currency1),
    };
  }

  private getChainLabel(chainId: number): string {
    if (chainId === ARBITRUM_CHAIN_ID) {
      return 'Arbitrum';
    }
    if (chainId === ETHEREUM_CHAIN_ID) {
      return 'Ethereum';
    }
    return `chain ${chainId}`;
  }

  private getChainProvider(chainId: number) {
    try {
      return getProviderForChain(chainId);
    } catch {
      if (!this.warnedMissingRpc) {
        console.warn(
          `[${this.protocolName}] No ${this.getChainLabel(chainId)} RPC provider configured. ` +
          'Configure chain-capable providers in admin or set the matching RPC env vars.'
        );
        this.warnedMissingRpc = true;
      }
      return null;
    }
  }

  private resolveChainId(rawChainId: unknown, fallbackChainId: number): number {
    if (typeof rawChainId === 'number' && Number.isInteger(rawChainId)) {
      return rawChainId;
    }

    if (typeof rawChainId === 'string' && rawChainId.trim().length > 0) {
      const parsed = Number(rawChainId);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }

    return fallbackChainId;
  }

  /**
   * Discover Uniswap v4 positions from verified persisted inventory, newly
   * minted token IDs, and bounded incremental Transfer events.
   */
  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = this.getValidatedConfig();

    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    const provider = this.getChainProvider(config.chainId);
    if (!provider) {
      throw new Error('[Uniswap v4] No RPC provider available');
    }

    const fromBlock = config.deployBlock ?? 21688823;

    try {
      const inventory = await getWalletUniswapV4Inventory(
        checksumAddress,
        config.positionManager!,
        fromBlock,
        provider,
        config.chainId
      );

      const expectedCurrency0 = config.currency0!.toLowerCase();
      const expectedCurrency1 = config.currency1!.toLowerCase();
      const configFee = BigInt(config.fee!);

      for (const entry of inventory) {
        const currency0Lower = entry.poolKey.currency0.toLowerCase();
        const currency1Lower = entry.poolKey.currency1.toLowerCase();

        const pairMatches =
          (currency0Lower === expectedCurrency0 && currency1Lower === expectedCurrency1) ||
          (currency0Lower === expectedCurrency1 && currency1Lower === expectedCurrency0);

        const isTargetPool = pairMatches && entry.poolKey.fee === configFee;

        if (!isTargetPool) {
          continue;
        }

        const positionKey = this.createPositionKey(config.positionManager!, entry.tokenId);
        positions.push({
          protocolPositionKey: positionKey,
          displayName: `Uniswap v4 ${config.currency0Symbol || 'USDC'}/${config.currency1Symbol || 'USDT'} #${entry.tokenId}`,
          baseAsset: config.currency0Symbol || 'USDC',
          countingMode: 'count',
          measureMethod: 'balance',
          metadata: {
            walletAddress: checksumAddress,
            tokenId: entry.tokenId,
            positionManager: config.positionManager,
            stateView: config.stateView,
            poolId: entry.poolId,
            tickLower: entry.tickLower,
            tickUpper: entry.tickUpper,
            chainId: config.chainId,
            currency0: entry.poolKey.currency0,
            currency1: entry.poolKey.currency1,
            currency0Symbol: config.currency0Symbol,
            currency1Symbol: config.currency1Symbol,
            currency0Decimals: config.currency0Decimals,
            currency1Decimals: config.currency1Decimals,
            fee: entry.poolKey.fee.toString(),
            tickSpacing: entry.poolKey.tickSpacing.toString(),
            hooks: entry.poolKey.hooks,
          },
          isActive: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Uniswap v4 inventory scan failed: ${message}`, { cause: error });
    }

    return positions;
  }

  /**
   * Read current value of a Uniswap v4 position
   * Value = Token amounts in range + Uncollected fees (all in USD)
   */
  async readCurrentValue(position: Position): Promise<number> {
    const config = this.getValidatedConfig();
    const chainId = this.resolveChainId(position.metadata.chainId, config.chainId);
    const provider = this.getChainProvider(chainId);
    if (!provider) {
      throw new Error(`[${this.protocolName}] ${this.getChainLabel(chainId)} RPC provider is required to read position values`);
    }

    const {
      tokenId,
      stateView,
      poolId,
      tickLower,
      tickUpper,
      currency0Decimals,
      currency1Decimals,
      positionManager,
    } = position.metadata;

    if (!tokenId || !stateView || !poolId || tickLower === undefined || tickUpper === undefined || !positionManager) {
      throw new Error('Invalid Uniswap v4 position metadata');
    }

    const normalizedStateView = normalizeAddress(stateView);
    const normalizedPositionManager = normalizeAddress(positionManager);
    // Get StateView contract for querying pool state
    const stateViewAbi = getAbi('UniswapV4StateView');
    const stateViewContract = getContract(normalizedStateView, stateViewAbi, provider);

    try {
      // Use tokenId as salt (Uniswap v4 convention)
      const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);

      // IMPORTANT: Query using Position Manager as owner, not wallet address!
      // The Position Manager contract holds the actual liquidity positions in the pool.
      // Users own NFTs that represent claims on those positions.
      const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] =
        await stateViewContract.getPositionInfo(poolId, normalizedPositionManager, tickLower, tickUpper, salt);

      // If no liquidity, position has zero value
      if (liquidity === 0n) {
        return 0;
      }

      // Get current fee growth inside the position's range
      const [feeGrowthInside0X128, feeGrowthInside1X128] = await stateViewContract.getFeeGrowthInside(
        poolId,
        tickLower,
        tickUpper
      );

      // Calculate uncollected fees using the formula:
      // fees = (feeGrowthCurrent - feeGrowthLast) * liquidity / Q128
      // Ensure all values are bigint
      const feeGrowth0Delta: bigint = BigInt(feeGrowthInside0X128) - BigInt(feeGrowthInside0LastX128);
      const feeGrowth1Delta: bigint = BigInt(feeGrowthInside1X128) - BigInt(feeGrowthInside1LastX128);
      const fees0Numerator: bigint = feeGrowth0Delta * liquidity;
      const fees1Numerator: bigint = feeGrowth1Delta * liquidity;
      const fees0Bigint: bigint = fees0Numerator / this.Q128;
      const fees1Bigint: bigint = fees1Numerator / this.Q128;

      const fees0Usd = parseFloat(formatUnits(fees0Bigint, currency0Decimals));
      const fees1Usd = parseFloat(formatUnits(fees1Bigint, currency1Decimals));

      // Calculate actual token amounts using Uniswap tick math
      const liquidityValue = await this.estimateLiquidityValueUSD(
        liquidity,
        currency0Decimals,
        currency1Decimals,
        poolId,
        tickLower,
        tickUpper,
        normalizedStateView,
        provider
      );

      // Total value = principal liquidity + uncollected fees
      const totalValue = liquidityValue + fees0Usd + fees1Usd;

      return totalValue;
    } catch (error) {
      console.error(`Error reading Uniswap v4 position value for token ${tokenId}:`, error);
      throw error;
    }
  }

  async shouldProjectFutureIncome(position: Position): Promise<boolean> {
    const config = this.getValidatedConfig();
    const chainId = this.resolveChainId(position.metadata.chainId, config.chainId);
    const provider = this.getChainProvider(chainId);
    if (!provider) {
      return true;
    }

    const { tokenId, stateView, poolId, tickLower, tickUpper, positionManager } = position.metadata;
    if (
      !tokenId ||
      !stateView ||
      !poolId ||
      tickLower === undefined ||
      tickUpper === undefined ||
      !positionManager
    ) {
      return true;
    }

    return isUniswapV4PositionInRange(
      provider,
      stateView,
      positionManager,
      poolId,
      Number(tickLower),
      Number(tickUpper),
      tokenId
    );
  }

  /**
   * Calculate sqrt price from tick
   * sqrtPriceX96 = 1.0001^(tick/2) * 2^96
   */
  private getSqrtRatioAtTick(tick: number): bigint {
    // Calculate 1.0001^tick to get price, then take square root
    // This is a simplified version - for production, use the full Uniswap library
    const price = Math.pow(1.0001, tick);
    const sqrtPrice = Math.sqrt(price);

    // Scale by 2^96
    const Q96 = 2n ** 96n;
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  /**
   * Calculate token amounts from liquidity using Uniswap v3/v4 math
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
      // Current price below range - all token0
      amount0 = (liquidity * Q96 * (sqrtPriceBX96 - sqrtPriceAX96)) / (sqrtPriceBX96 * sqrtPriceAX96);
    } else if (sqrtPriceX96 < sqrtPriceBX96) {
      // Current price in range
      amount0 = (liquidity * Q96 * (sqrtPriceBX96 - sqrtPriceX96)) / (sqrtPriceBX96 * sqrtPriceX96);
      amount1 = (liquidity * (sqrtPriceX96 - sqrtPriceAX96)) / Q96;
    } else {
      // Current price above range - all token1
      amount1 = (liquidity * (sqrtPriceBX96 - sqrtPriceAX96)) / Q96;
    }

    return { amount0, amount1 };
  }

  /**
   * Estimate USD value of liquidity in a position
   * Uses Uniswap tick math to calculate actual token amounts
   */
  private async estimateLiquidityValueUSD(
    liquidity: bigint,
    decimals0: number,
    decimals1: number,
    poolId: string,
    tickLower: number,
    tickUpper: number,
    stateView: string,
    provider: ReturnType<typeof getProviderForChain>
  ): Promise<number> {
    try {
      // Get current price from pool
      const stateViewAbi = getAbi('UniswapV4StateView');
      const stateViewContract = getContract(stateView, stateViewAbi, provider);

      const [sqrtPriceX96] = await stateViewContract.getSlot0(poolId);

      // Calculate sqrt prices at tick bounds
      const sqrtPriceAX96 = this.getSqrtRatioAtTick(tickLower);
      const sqrtPriceBX96 = this.getSqrtRatioAtTick(tickUpper);

      // Get token amounts from liquidity
      const { amount0, amount1 } = this.getAmountsForLiquidity(
        sqrtPriceX96,
        sqrtPriceAX96,
        sqrtPriceBX96,
        liquidity
      );

      // Convert to USD (both are stablecoins at ~$1.00)
      const amount0Usd = Number(amount0) / Math.pow(10, decimals0);
      const amount1Usd = Number(amount1) / Math.pow(10, decimals1);

      return amount0Usd + amount1Usd;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to estimate liquidity value for pool ${poolId} (ticks ${tickLower}/${tickUpper}): ${errMsg}`
      );
    }
  }

}
