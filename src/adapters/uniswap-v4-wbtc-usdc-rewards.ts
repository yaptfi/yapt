import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { ethers } from 'ethers';

const PROTOCOL_KEY = 'uniswap-v4-wbtc-usdc-rewards';
const PROTOCOL_NAME = 'Uniswap v4 WBTC/USDC';
const Q128 = 2n ** 128n;

/**
 * Uniswap v4 WBTC/USDC rewards-only adapter.
 *
 * Discovers WBTC/USDC v4 positions and tracks only claimable USDC fees.
 * Principal (WBTC/USDC liquidity) is excluded — same pattern as the
 * Uniswap v3 WBTC/USDT Arbitrum rewards adapter.
 */
export class UniswapV4WbtcUsdcRewardsAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'uniswap-v4-wbtc-usdc-rewards' as const;
  readonly protocolName = PROTOCOL_NAME;

  private getValidatedConfig() {
    const config = getProtocolConfig()[PROTOCOL_KEY];
    if (
      !config ||
      !config.positionManager ||
      !config.currency0 ||
      !config.currency1 ||
      !config.stateView ||
      config.currency1Decimals === undefined
    ) {
      throw new Error(`${PROTOCOL_KEY} config not found or incomplete`);
    }
    return config as typeof config & {
      positionManager: string;
      currency0: string;
      currency1: string;
      stateView: string;
    };
  }

  /**
   * Discover Uniswap v4 WBTC/USDC positions by scanning NFT Transfer events.
   * REQUIRES: RPC provider with supportsLargeBlockScans=true
   */
  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = this.getValidatedConfig();
    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    const { getProvider } = await import('../utils/ethereum');
    const proxyProvider = getProvider();

    let scanProvider;
    if ('getRPCManager' in proxyProvider && typeof proxyProvider.getRPCManager === 'function') {
      const manager = (proxyProvider as any).getRPCManager();
      scanProvider = manager.getScanCapableProvider();
      if (!scanProvider) {
        console.warn(`[${PROTOCOL_NAME}] No scan-capable RPC provider available - skipping discovery`);
        console.warn(`[${PROTOCOL_NAME}] Configure an RPC provider with supportsLargeBlockScans=true`);
        return [];
      }
    } else {
      scanProvider = proxyProvider;
    }

    const positionManagerAbi = getAbi('UniswapV4PositionManager');
    const positionManager = new ethers.Contract(
      config.positionManager,
      positionManagerAbi,
      scanProvider
    );

    const fromBlock = config.deployBlock ?? 21688823;

    try {
      const transferFilter = positionManager.filters.Transfer(null, checksumAddress);
      const receivedEvents = await positionManager.queryFilter(transferFilter, fromBlock);

      const sentFilter = positionManager.filters.Transfer(checksumAddress, null);
      const sentEvents = await positionManager.queryFilter(sentFilter, fromBlock);

      const sentTokenIds = new Set(sentEvents.map((event: any) => event.args.tokenId.toString()));

      for (const event of receivedEvents as any[]) {
        const tokenId = event.args.tokenId.toString();

        if (sentTokenIds.has(tokenId)) {
          continue;
        }

        try {
          const currentOwner = await positionManager.ownerOf(tokenId);
          if (currentOwner.toLowerCase() !== checksumAddress.toLowerCase()) {
            continue;
          }
        } catch {
          continue;
        }

        const [poolKey, positionInfo] = await positionManager.getPoolAndPositionInfo(tokenId);

        const currency0Lower = poolKey.currency0.toLowerCase();
        const currency1Lower = poolKey.currency1.toLowerCase();
        const expectedCurrency0 = config.currency0!.toLowerCase();
        const expectedCurrency1 = config.currency1!.toLowerCase();

        const pairMatches =
          (currency0Lower === expectedCurrency0 && currency1Lower === expectedCurrency1) ||
          (currency0Lower === expectedCurrency1 && currency1Lower === expectedCurrency0);

        if (!pairMatches) {
          continue;
        }

        if (config.fee !== undefined) {
          const poolFee = BigInt(poolKey.fee);
          const configFee = BigInt(config.fee);
          if (poolFee !== configFee) {
            continue;
          }
        }

        // Decode packed PositionInfo (200 bits poolId | 24 bits tickUpper | 24 bits tickLower | 8 bits hasSubscriber)
        const info = BigInt(positionInfo);
        const tickLowerUint = Number((info >> 8n) & 0xFFFFFFn);
        const tickUpperUint = Number((info >> 32n) & 0xFFFFFFn);
        const tickLower = tickLowerUint >= (1 << 23) ? tickLowerUint - (1 << 24) : tickLowerUint;
        const tickUpper = tickUpperUint >= (1 << 23) ? tickUpperUint - (1 << 24) : tickUpperUint;

        const poolId = ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24', 'int24', 'address'],
            [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
          )
        );

        // Determine which index is USDC (the reward token)
        const rewardTokenAddress = config.rewardToken?.toLowerCase() ?? config.currency1!.toLowerCase();
        const rewardTokenIndex = currency0Lower === rewardTokenAddress ? 0 : 1;
        const rewardDecimals = rewardTokenIndex === 0 ? (config.currency0Decimals ?? 6) : (config.currency1Decimals ?? 6);

        positions.push({
          protocolPositionKey: this.createPositionKey(config.positionManager!, tokenId),
          displayName: `${PROTOCOL_NAME} #${tokenId}`,
          baseAsset: config.baseAsset || 'USDC',
          countingMode: config.countingMode || 'partial',
          measureMethod: 'rewards',
          metadata: {
            walletAddress: checksumAddress,
            tokenId,
            positionManager: config.positionManager,
            stateView: config.stateView,
            poolId,
            tickLower,
            tickUpper,
            rewardTokenIndex,
            rewardDecimals,
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: poolKey.fee.toString(),
            tickSpacing: poolKey.tickSpacing.toString(),
            hooks: poolKey.hooks,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering ${PROTOCOL_NAME} positions for ${walletAddress}:`, error);
    }

    return positions;
  }

  /**
   * Read claimable USDC fees for this position.
   * Uses fee growth delta * liquidity / Q128 (Uniswap v4 fee accounting).
   */
  async readCurrentValue(position: Position): Promise<number> {
    const {
      tokenId,
      stateView,
      poolId,
      tickLower,
      tickUpper,
      positionManager,
      rewardTokenIndex,
      rewardDecimals,
    } = position.metadata;

    if (
      !tokenId ||
      !stateView ||
      !poolId ||
      tickLower === undefined ||
      tickUpper === undefined ||
      !positionManager ||
      rewardTokenIndex === undefined ||
      rewardDecimals === undefined
    ) {
      throw new Error(`Invalid ${PROTOCOL_KEY} position metadata`);
    }

    const stateViewAbi = getAbi('UniswapV4StateView');
    const stateViewContract = getContract(stateView, stateViewAbi);

    const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);

    // Query using Position Manager as the owner (v4 pattern)
    const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] =
      await stateViewContract.getPositionInfo(poolId, positionManager, tickLower, tickUpper, salt);

    if (liquidity === 0n) {
      return 0;
    }

    const [feeGrowthInside0X128, feeGrowthInside1X128] = await stateViewContract.getFeeGrowthInside(
      poolId,
      tickLower,
      tickUpper
    );

    const index = Number(rewardTokenIndex);
    const feeGrowthDelta = index === 0
      ? BigInt(feeGrowthInside0X128) - BigInt(feeGrowthInside0LastX128)
      : BigInt(feeGrowthInside1X128) - BigInt(feeGrowthInside1LastX128);

    const rewardRaw = (feeGrowthDelta * liquidity) / Q128;
    const rewardAmount = parseFloat(formatUnits(rewardRaw, Number(rewardDecimals)));
    const stablePriceOverrides = getStablePriceOverrides();
    const rewardPriceUsd = this.getStablePrice(position.baseAsset, stablePriceOverrides);

    return rewardAmount * rewardPriceUsd;
  }
}
