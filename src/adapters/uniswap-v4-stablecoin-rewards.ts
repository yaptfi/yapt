import { ethers, Provider } from 'ethers';
import { BaseProtocolAdapter } from './base';
import { Position, ProtocolKey } from '../types';
import {
  ARBITRUM_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
  formatUnits,
  getContract,
  getProviderForChain,
  normalizeAddress,
  toChecksumAddress,
} from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { getWalletUniswapV4Inventory } from '../utils/uniswap-v4-inventory';
import { isUniswapV4PositionInRange } from '../utils/uniswap-range';

const Q128 = 2n ** 128n;

interface UniswapV4StateViewContract {
  getPositionInfo(
    poolId: string,
    owner: string,
    tickLower: number,
    tickUpper: number,
    salt: string
  ): Promise<[bigint, bigint, bigint]>;
  getFeeGrowthInside(poolId: string, tickLower: number, tickUpper: number): Promise<[bigint, bigint]>;
}

interface UniswapV4PositionManagerContract {
  ownerOf(tokenId: bigint): Promise<string>;
}

/**
 * Shared Uniswap v4 rewards-only adapter for volatile/stablecoin pairs.
 *
 * Discovers a configured v4 pair and tracks only claimable fees in the
 * configured stablecoin reward token. LP principal is intentionally excluded.
 *
 * Uses the shared v4 inventory utility so multiple v4 adapters share verified
 * persisted state and bounded incremental discovery.
 */
export class UniswapV4StablecoinRewardsAdapter extends BaseProtocolAdapter {
  private warnedMissingRpc = false;

  constructor(
    readonly protocolKey: ProtocolKey,
    readonly protocolName: string
  ) {
    super();
  }

  private getValidatedConfig() {
    const config = getProtocolConfig()[this.protocolKey];
    if (
      !config ||
      !config.positionManager ||
      !config.currency0 ||
      !config.currency1 ||
      !config.stateView ||
      !config.rewardToken ||
      config.currency0Decimals === undefined ||
      config.currency1Decimals === undefined
    ) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }
    return {
      ...config,
      chainId: config.chainId ?? ETHEREUM_CHAIN_ID,
      positionManager: normalizeAddress(config.positionManager),
      stateView: normalizeAddress(config.stateView),
      currency0: normalizeAddress(config.currency0),
      currency1: normalizeAddress(config.currency1),
      rewardToken: normalizeAddress(config.rewardToken),
    } as typeof config & {
      chainId: number;
      positionManager: string;
      currency0: string;
      currency1: string;
      currency0Decimals: number;
      currency1Decimals: number;
      rewardToken: string;
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

  private getPositionSalt(tokenId: string): string {
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  }

  private getStateViewContract(stateView: string, provider: Provider): UniswapV4StateViewContract {
    const normalizedStateView = normalizeAddress(stateView);
    const stateViewAbi = getAbi('UniswapV4StateView');
    return getContract(normalizedStateView, stateViewAbi, provider) as unknown as UniswapV4StateViewContract;
  }

  private getPositionManagerContract(positionManager: string, provider: Provider): UniswapV4PositionManagerContract {
    const normalizedPositionManager = normalizeAddress(positionManager);
    const positionManagerAbi = getAbi('UniswapV4PositionManager');
    return getContract(normalizedPositionManager, positionManagerAbi, provider) as unknown as UniswapV4PositionManagerContract;
  }

  private async getPositionInfo(
    provider: Provider,
    stateView: string,
    positionManager: string,
    poolId: string,
    tickLower: number,
    tickUpper: number,
    tokenId: string
  ): Promise<{
    liquidity: bigint;
    feeGrowthInside0LastX128: bigint;
    feeGrowthInside1LastX128: bigint;
  }> {
    const stateViewContract = this.getStateViewContract(stateView, provider);
    const normalizedPositionManager = normalizeAddress(positionManager);
    const [liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = await stateViewContract.getPositionInfo(
      poolId,
      normalizedPositionManager,
      tickLower,
      tickUpper,
      this.getPositionSalt(tokenId)
    );

    return {
      liquidity: BigInt(liquidity),
      feeGrowthInside0LastX128: BigInt(feeGrowthInside0LastX128),
      feeGrowthInside1LastX128: BigInt(feeGrowthInside1LastX128),
    };
  }

  /**
   * Discover positions for the configured Uniswap v4 pair.
   * Uses shared verified inventory and incremental discovery so multiple v4
   * adapters do not duplicate RPC work for the same wallet.
   */
  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = this.getValidatedConfig();
    const checksumAddress = toChecksumAddress(walletAddress);
    const positions: Partial<Position>[] = [];

    const provider = this.getChainProvider(config.chainId);
    if (!provider) {
      throw new Error(`[${this.protocolName}] No RPC provider available`);
    }

    const fromBlock = config.deployBlock ?? 21688823;

    try {
      const inventory = await getWalletUniswapV4Inventory(
        checksumAddress,
        config.positionManager,
        fromBlock,
        provider,
        config.chainId
      );

      const expectedCurrency0 = config.currency0.toLowerCase();
      const expectedCurrency1 = config.currency1.toLowerCase();
      const rewardTokenAddress = config.rewardToken.toLowerCase();
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

        let liquidity: bigint;
        try {
          ({ liquidity } = await this.getPositionInfo(
            provider,
            config.stateView,
            config.positionManager,
            entry.poolId,
            entry.tickLower,
            entry.tickUpper,
            entry.tokenId
          ));
        } catch (error) {
          console.warn(`[${this.protocolName}] Failed to inspect token ${entry.tokenId} during discovery:`, error);
          continue;
        }

        // Rewards-only positions need a live LP position to accrue claimable fees.
        // Skip empty shells so discovery does not create permanent $0 positions.
        if (liquidity === 0n) {
          continue;
        }

        const rewardTokenIndex = currency0Lower === rewardTokenAddress
          ? 0
          : currency1Lower === rewardTokenAddress
            ? 1
            : -1;
        if (rewardTokenIndex < 0) {
          continue;
        }
        const rewardDecimals = rewardTokenIndex === 0
          ? config.currency0Decimals
          : config.currency1Decimals;

        positions.push({
          protocolPositionKey: this.createPositionKey(config.positionManager, entry.tokenId),
          displayName: `${this.protocolName} #${entry.tokenId}`,
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
            // Rewards-only positions can legitimately have zero claimable fees while liquidity remains.
            allowZeroValueDiscovery: true,
          },
          isActive: true,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.protocolName} inventory scan failed: ${message}`, { cause: error });
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
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const index = Number(rewardTokenIndex);
    if (index !== 0 && index !== 1) {
      throw new Error(`Invalid rewardTokenIndex for ${this.protocolKey}: ${rewardTokenIndex}`);
    }

    const {
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
    } = await this.getPositionInfo(
      provider,
      stateView,
      positionManager,
      poolId,
      tickLower,
      tickUpper,
      tokenId
    );

    if (liquidity === 0n) {
      return 0;
    }

    const stateViewContract = this.getStateViewContract(stateView, provider);
    const [feeGrowthInside0X128, feeGrowthInside1X128] = await stateViewContract.getFeeGrowthInside(
      poolId,
      tickLower,
      tickUpper
    );

    const feeGrowthDelta = index === 0
      ? BigInt(feeGrowthInside0X128) - BigInt(feeGrowthInside0LastX128)
      : BigInt(feeGrowthInside1X128) - BigInt(feeGrowthInside1LastX128);

    const rewardRaw = (feeGrowthDelta * liquidity) / Q128;
    const rewardAmount = parseFloat(formatUnits(rewardRaw, Number(rewardDecimals)));
    const stablePriceOverrides = getStablePriceOverrides();
    const rewardPriceUsd = this.getStablePrice(position.baseAsset, stablePriceOverrides);

    return rewardAmount * rewardPriceUsd;
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

  async isPositionClosed(position: Position): Promise<boolean> {
    const config = this.getValidatedConfig();
    const chainId = this.resolveChainId(position.metadata.chainId, config.chainId);
    const provider = this.getChainProvider(chainId);
    if (!provider) {
      throw new Error(`[${this.protocolName}] ${this.getChainLabel(chainId)} RPC provider is required to verify position closure`);
    }

    const {
      walletAddress,
      tokenId,
      stateView,
      poolId,
      tickLower,
      tickUpper,
      positionManager,
    } = position.metadata;

    if (
      !walletAddress ||
      !tokenId ||
      !stateView ||
      !poolId ||
      tickLower === undefined ||
      tickUpper === undefined ||
      !positionManager
    ) {
      throw new Error(`Invalid ${this.protocolKey} position metadata for closure detection`);
    }

    const checksumAddress = toChecksumAddress(walletAddress);
    const positionManagerContract = this.getPositionManagerContract(positionManager, provider);

    let owner: string;
    try {
      owner = await positionManagerContract.ownerOf(BigInt(tokenId));
    } catch (error: any) {
      if (error?.code === 'CALL_EXCEPTION') {
        return true;
      }
      throw error;
    }

    if (owner.toLowerCase() !== checksumAddress.toLowerCase()) {
      return true;
    }

    let liquidity: bigint;
    try {
      ({ liquidity } = await this.getPositionInfo(
        provider,
        stateView,
        positionManager,
        poolId,
        tickLower,
        tickUpper,
        tokenId
      ));
    } catch (error) {
      console.error(
        `[${this.protocolName}] getPositionInfo failed during closure check ` +
        `(tokenId=${tokenId}, wallet=${checksumAddress}); treating as inconclusive:`,
        error
      );
      return false;
    }

    return liquidity === 0n;
  }
}
