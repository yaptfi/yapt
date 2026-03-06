import { ethers, Provider } from 'ethers';
import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import {
  ARBITRUM_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  formatUnits,
  getContract,
  getProviderForChain,
  getScanCapableProviderForChain,
  normalizeAddress,
  toChecksumAddress,
} from '../utils/ethereum';
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
  private warnedMissingRpc = false;

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
    return {
      ...config,
      chainId: config.chainId ?? ETHEREUM_CHAIN_ID,
      positionManager: normalizeAddress(config.positionManager),
      stateView: normalizeAddress(config.stateView),
      currency0: normalizeAddress(config.currency0),
      currency1: normalizeAddress(config.currency1),
      rewardToken: config.rewardToken ? normalizeAddress(config.rewardToken) : config.rewardToken,
    } as typeof config & {
      chainId: number;
      positionManager: string;
      currency0: string;
      currency1: string;
      stateView: string;
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

  private getChainProvider(chainId: number): Provider | null {
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

  private getScanProvider(chainId: number): Provider | null {
    const provider = this.getChainProvider(chainId);
    if (!provider) {
      return null;
    }
    return getScanCapableProviderForChain(chainId);
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
   * Discover Uniswap v4 WBTC/USDC positions.
   * Uses shared inventory cache — does not issue duplicate eth_getLogs when
   * multiple v4 adapters discover for the same wallet.
   * REQUIRES: RPC provider with supportsLargeBlockScans=true
   */
  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = this.getValidatedConfig();
    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    const scanProvider = this.getScanProvider(config.chainId);
    if (!scanProvider) {
      console.warn(`[${PROTOCOL_NAME}] No scan-capable RPC provider available - skipping discovery`);
      return [];
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
            chainId: config.chainId,
            currency0: entry.poolKey.currency0,
            currency1: entry.poolKey.currency1,
            fee: entry.poolKey.fee.toString(),
            tickSpacing: entry.poolKey.tickSpacing.toString(),
            hooks: entry.poolKey.hooks,
            // Rewards-only positions can legitimately have zero claimable fees at discovery time.
            allowZeroValueDiscovery: true,
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

    const normalizedStateView = normalizeAddress(stateView);
    const normalizedPositionManager = normalizeAddress(positionManager);
    const stateViewAbi = getAbi('UniswapV4StateView');
    const stateViewContract = getContract(normalizedStateView, stateViewAbi, provider);

    const salt = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);

    // Query using Position Manager as the owner (v4 pattern)
    const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] =
      await stateViewContract.getPositionInfo(poolId, normalizedPositionManager, tickLower, tickUpper, salt);

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
