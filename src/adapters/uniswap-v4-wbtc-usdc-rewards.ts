import { ethers } from 'ethers';
import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { getWalletUniswapV4Inventory } from '../utils/uniswap-v4-inventory';

const PROTOCOL_KEY = 'uniswap-v4-wbtc-usdc-rewards';
const PROTOCOL_NAME = 'Uniswap v4 WBTC/USDC';
const Q128 = 2n ** 128n;

/**
 * Uniswap v4 WBTC/USDC rewards-only adapter.
 *
 * Discovers WBTC/USDC v4 positions and tracks only claimable USDC fees.
 * Principal (WBTC/USDC liquidity) is excluded — same pattern as the
 * Uniswap v3 WBTC/USDT Arbitrum rewards adapter.
 *
 * Uses the shared v4 inventory utility so multiple v4 adapters share a
 * single eth_getLogs round-trip per wallet per TTL.
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
   * Discover Uniswap v4 WBTC/USDC positions.
   * Uses shared inventory cache — does not issue duplicate eth_getLogs when
   * multiple v4 adapters discover for the same wallet.
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
        return [];
      }
    } else {
      scanProvider = proxyProvider;
    }

    const fromBlock = config.deployBlock ?? 21688823;

    try {
      const inventory = await getWalletUniswapV4Inventory(
        checksumAddress,
        config.positionManager,
        fromBlock,
        scanProvider
      );

      const expectedCurrency0 = config.currency0.toLowerCase();
      const expectedCurrency1 = config.currency1.toLowerCase();
      const rewardTokenAddress = config.rewardToken?.toLowerCase() ?? expectedCurrency1;
      const configFee = config.fee !== undefined ? BigInt(config.fee) : null;

      for (const entry of inventory) {
        const currency0Lower = entry.poolKey.currency0.toLowerCase();
        const currency1Lower = entry.poolKey.currency1.toLowerCase();

        const pairMatches =
          (currency0Lower === expectedCurrency0 && currency1Lower === expectedCurrency1) ||
          (currency0Lower === expectedCurrency1 && currency1Lower === expectedCurrency0);

        if (!pairMatches) {
          continue;
        }

        if (configFee !== null && entry.poolKey.fee !== configFee) {
          continue;
        }

        const rewardTokenIndex = currency0Lower === rewardTokenAddress ? 0 : 1;
        const rewardDecimals = rewardTokenIndex === 0 ? (config.currency0Decimals ?? 6) : (config.currency1Decimals ?? 6);

        positions.push({
          protocolPositionKey: this.createPositionKey(config.positionManager, entry.tokenId),
          displayName: `${PROTOCOL_NAME} #${entry.tokenId}`,
          baseAsset: config.baseAsset || 'USDC',
          countingMode: config.countingMode || 'partial',
          measureMethod: 'rewards',
          metadata: {
            walletAddress: checksumAddress,
            tokenId: entry.tokenId,
            positionManager: config.positionManager,
            stateView: config.stateView,
            poolId: entry.poolId,
            tickLower: entry.tickLower,
            tickUpper: entry.tickUpper,
            rewardTokenIndex,
            rewardDecimals,
            currency0: entry.poolKey.currency0,
            currency1: entry.poolKey.currency1,
            fee: entry.poolKey.fee.toString(),
            tickSpacing: entry.poolKey.tickSpacing.toString(),
            hooks: entry.poolKey.hooks,
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
