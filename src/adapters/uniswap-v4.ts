import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits } from '../utils/ethereum';
import { getProtocolConfig, getAbi } from '../utils/config';
import { ethers } from 'ethers';

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

  /**
   * Discover Uniswap v4 positions by scanning NFT Transfer events
   * Since v4 Position Manager doesn't implement ERC721Enumerable,
   * we must query Transfer events to find owned NFTs
   *
   * REQUIRES: RPC provider with supportsLargeBlockScans=true
   */
  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['uniswap-v4-usdc-usdt'];
    if (!config || !config.positionManager || !config.currency0 || !config.currency1 || !config.fee) {
      throw new Error('Uniswap v4 USDC/USDT config not found or incomplete');
    }

    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    // Get scan-capable provider for historical event queries
    const { getProvider } = await import('../utils/ethereum');
    const proxyProvider = getProvider();

    // Check if provider supports block scans
    let scanProvider;
    if ('getRPCManager' in proxyProvider && typeof proxyProvider.getRPCManager === 'function') {
      const manager = (proxyProvider as any).getRPCManager();
      scanProvider = manager.getScanCapableProvider();

      if (!scanProvider) {
        console.warn('[Uniswap v4] No scan-capable RPC provider available - skipping Uniswap discovery');
        console.warn('[Uniswap v4] Configure an RPC provider with supportsLargeBlockScans=true (e.g., Infura)');
        return [];
      }
    } else {
      // Fallback to regular provider (single provider setup)
      scanProvider = proxyProvider;
    }

    // Get Position Manager contract with scan-capable provider
    const positionManagerAbi = getAbi('UniswapV4PositionManager');
    const positionManager = new ethers.Contract(
      config.positionManager,
      positionManagerAbi,
      scanProvider
    );

    try {
      // Query all Transfer events where wallet is the recipient
      const transferFilter = positionManager.filters.Transfer(null, checksumAddress);
      const receivedEvents = await positionManager.queryFilter(transferFilter);

      // Query all Transfer events where wallet is the sender (to filter out transferred positions)
      const sentFilter = positionManager.filters.Transfer(checksumAddress, null);
      const sentEvents = await positionManager.queryFilter(sentFilter);

      // Build set of tokenIds that were sent away
      const sentTokenIds = new Set(sentEvents.map((event: any) => event.args.tokenId.toString()));

      // Process each received NFT
      for (const event of receivedEvents as any[]) {
        const tokenId = event.args.tokenId.toString();

        // Skip if this NFT was subsequently transferred away
        if (sentTokenIds.has(tokenId)) {
          continue;
        }

        // Verify current ownership (belt-and-suspenders check)
        try {
          const currentOwner = await positionManager.ownerOf(tokenId);
          if (currentOwner.toLowerCase() !== checksumAddress.toLowerCase()) {
            continue;
          }
        } catch {
          // NFT may have been burned or doesn't exist
          continue;
        }

        // Get position details
        const [poolKey, positionInfo] = await positionManager.getPoolAndPositionInfo(tokenId);

        // Check if this is the USDC/USDT pool we're tracking
        const currency0Lower = poolKey.currency0.toLowerCase();
        const currency1Lower = poolKey.currency1.toLowerCase();
        const expectedCurrency0 = config.currency0!.toLowerCase();
        const expectedCurrency1 = config.currency1!.toLowerCase();

        // Convert both to BigInt for comparison (poolKey.fee is already BigInt)
        const poolFee = BigInt(poolKey.fee);
        const configFee = BigInt(config.fee!);
        const feeMatches = poolFee === configFee;

        const isTargetPool =
          currency0Lower === expectedCurrency0 &&
          currency1Lower === expectedCurrency1 &&
          feeMatches;

        if (!isTargetPool) {
          continue;
        }

        // Decode packed PositionInfo (200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber)
        const info = BigInt(positionInfo);
        const tickLowerUint = Number((info >> 8n) & 0xFFFFFFn);
        const tickUpperUint = Number((info >> 32n) & 0xFFFFFFn);

        // Convert from uint24 to int24 (two's complement)
        const tickLower = tickLowerUint >= (1 << 23) ? tickLowerUint - (1 << 24) : tickLowerUint;
        const tickUpper = tickUpperUint >= (1 << 23) ? tickUpperUint - (1 << 24) : tickUpperUint;

        // Calculate poolId from PoolKey
        const poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
          )
        );

        // Create position
        const positionKey = this.createPositionKey(config.positionManager!, tokenId);
        positions.push({
          protocolPositionKey: positionKey,
          displayName: `Uniswap v4 ${config.currency0Symbol || 'USDC'}/${config.currency1Symbol || 'USDT'} #${tokenId}`,
          baseAsset: config.currency0Symbol || 'USDC', // Use currency0 as base for display purposes
          countingMode: 'count', // Both assets are stablecoins at ~$1
          measureMethod: 'balance', // Using balance-based measurement
          metadata: {
            walletAddress: checksumAddress,
            tokenId,
            positionManager: config.positionManager,
            stateView: config.stateView,
            poolId,
            tickLower,
            tickUpper,
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            currency0Symbol: config.currency0Symbol,
            currency1Symbol: config.currency1Symbol,
            currency0Decimals: config.currency0Decimals,
            currency1Decimals: config.currency1Decimals,
            // Convert BigInt values to strings for JSON serialization
            fee: poolKey.fee.toString(),
            tickSpacing: poolKey.tickSpacing.toString(),
            hooks: poolKey.hooks,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering Uniswap v4 positions for ${walletAddress}:`, error);
    }

    return positions;
  }

  /**
   * Read current value of a Uniswap v4 position
   * Value = Token amounts in range + Uncollected fees (all in USD)
   */
  async readCurrentValue(position: Position): Promise<number> {
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

    // Get StateView contract for querying pool state
    const stateViewAbi = getAbi('UniswapV4StateView');
    const stateViewContract = getContract(stateView, stateViewAbi);

    try {
      // Use tokenId as salt (Uniswap v4 convention)
      const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);

      // IMPORTANT: Query using Position Manager as owner, not wallet address!
      // The Position Manager contract holds the actual liquidity positions in the pool.
      // Users own NFTs that represent claims on those positions.
      const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] =
        await stateViewContract.getPositionInfo(poolId, positionManager, tickLower, tickUpper, salt);

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
        stateView
      );

      // Total value = principal liquidity + uncollected fees
      const totalValue = liquidityValue + fees0Usd + fees1Usd;

      return totalValue;
    } catch (error) {
      console.error(`Error reading Uniswap v4 position value for token ${tokenId}:`, error);
      throw error;
    }
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
    stateView: string
  ): Promise<number> {
    try {
      // Get current price from pool
      const stateViewAbi = getAbi('UniswapV4StateView');
      const stateViewContract = getContract(stateView, stateViewAbi);

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
      console.error('Error estimating liquidity value:', error);
      return 0;
    }
  }

}
