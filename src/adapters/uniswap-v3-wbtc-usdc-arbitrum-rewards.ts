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
import { isUniswapV3PositionInRange } from '../utils/uniswap-range';
const MAX_UINT128 = (2n ** 128n) - 1n;

interface UniswapV3RewardsConfig {
  positionManager: string;
  currency0: string;
  currency1: string;
  rewardToken: string;
  rewardDecimals: number;
  fee?: number;
  countingMode?: 'count' | 'partial' | 'ignore';
  currency0Symbol?: string;
  currency1Symbol?: string;
  baseAsset?: string;
}

interface UniswapV3PositionInfo {
  token0: string;
  token1: string;
  fee: bigint | number;
  liquidity?: bigint | number;
  tokensOwed0?: bigint | number;
  tokensOwed1?: bigint | number;
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
  ownerOf(tokenId: bigint): Promise<string>;
  tokenOfOwnerByIndex(owner: string, index: bigint): Promise<bigint>;
  positions(tokenId: bigint): Promise<UniswapV3PositionInfo>;
  collect: {
    staticCall(
      params: UniswapV3CollectParams,
      overrides: { from: string }
    ): Promise<UniswapV3CollectResult>;
  };
}

/**
 * Uniswap v3 WBTC/USDC (Arbitrum) rewards-only adapter.
 *
 * Tracks only claimable USDC fees/rewards from the NFT position and ignores LP principal.
 */
export class UniswapV3WbtcUsdcArbitrumRewardsAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'uniswap-v3-wbtc-usdc-arbitrum-rewards' as const;
  readonly protocolName = 'Uniswap v3 WBTC/USDC (Arbitrum)';

  private warnedMissingRpc = false;

  private getArbitrumProvider(): Provider | null {
    try {
      return getProviderForChain(ARBITRUM_CHAIN_ID);
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

  private getValidatedConfig(): UniswapV3RewardsConfig {
    const config = getProtocolConfig()[this.protocolKey];
    if (
      !config ||
      !config.positionManager ||
      !config.currency0 ||
      !config.currency1 ||
      !config.rewardToken ||
      config.rewardDecimals === undefined
    ) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }

    return {
      positionManager: config.positionManager,
      currency0: config.currency0,
      currency1: config.currency1,
      rewardToken: config.rewardToken,
      rewardDecimals: config.rewardDecimals,
      fee: config.fee,
      countingMode: config.countingMode,
      currency0Symbol: config.currency0Symbol,
      currency1Symbol: config.currency1Symbol,
      baseAsset: config.baseAsset,
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
      const expectedRewardToken = config.rewardToken.toLowerCase();
      const requiredFee = config.fee !== undefined ? BigInt(config.fee) : null;

      for (const entry of inventory) {
        const token0 = entry.token0.toLowerCase();
        const token1 = entry.token1.toLowerCase();
        const fee = entry.fee;

        const pairMatches =
          (token0 === expectedToken0 && token1 === expectedToken1) ||
          (token0 === expectedToken1 && token1 === expectedToken0);
        if (!pairMatches) {
          continue;
        }

        if (requiredFee !== null && fee !== requiredFee) {
          continue;
        }

        const rewardTokenIndex = token0 === expectedRewardToken ? 0 : token1 === expectedRewardToken ? 1 : -1;
        if (rewardTokenIndex < 0) {
          continue;
        }

        // Skip fully exhausted NFTs early to avoid unnecessary reward valuation calls.
        if (entry.liquidity === 0n && entry.tokensOwed0 === 0n && entry.tokensOwed1 === 0n) {
          continue;
        }

        const rewardSymbol = expectedRewardToken === expectedToken0
          ? (config.currency0Symbol || config.baseAsset || 'USDC')
          : expectedRewardToken === expectedToken1
            ? (config.currency1Symbol || config.baseAsset || 'USDC')
            : (config.baseAsset || 'USDC');
        const tokenIdString = entry.tokenId.toString();

        positions.push({
          protocolPositionKey: this.createPositionKey(config.positionManager, tokenIdString),
          displayName: `${this.protocolName} #${tokenIdString}`,
          baseAsset: rewardSymbol,
          countingMode: config.countingMode || 'partial',
          measureMethod: 'rewards',
          metadata: {
            walletAddress: checksumAddress,
            tokenId: tokenIdString,
            positionManager: config.positionManager,
            rewardToken: config.rewardToken,
            rewardDecimals: config.rewardDecimals,
            rewardTokenIndex,
            feeTier: fee.toString(),
            chainId: ARBITRUM_CHAIN_ID,
            allowZeroValueDiscovery: entry.liquidity > 0n,
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
      rewardDecimals,
      rewardTokenIndex,
    } = position.metadata;

    if (
      !walletAddress ||
      !tokenId ||
      !positionManager ||
      rewardDecimals === undefined ||
      rewardTokenIndex === undefined
    ) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const index = Number(rewardTokenIndex);
    if (index !== 0 && index !== 1) {
      throw new Error(`Invalid rewardTokenIndex for ${this.protocolKey}: ${rewardTokenIndex}`);
    }

    const checksumAddress = toChecksumAddress(walletAddress);
    const positionManagerAbi = getAbi('UniswapV3NonfungiblePositionManager');
    const contract = getContract(
      positionManager,
      positionManagerAbi,
      provider
    ) as unknown as UniswapV3PositionManagerContract;

    const collectResult = await contract.collect.staticCall(
      {
        tokenId: BigInt(tokenId),
        recipient: checksumAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      {
        from: checksumAddress,
      }
    );

    const amount0Raw = Array.isArray(collectResult) ? collectResult[0] : collectResult.amount0;
    const amount1Raw = Array.isArray(collectResult) ? collectResult[1] : collectResult.amount1;
    const amount0 = BigInt(amount0Raw ?? 0n);
    const amount1 = BigInt(amount1Raw ?? 0n);
    const rewardRaw = index === 0 ? amount0 : amount1;

    const rewardAmount = parseFloat(formatUnits(rewardRaw, Number(rewardDecimals)));
    const stablePriceOverrides = getStablePriceOverrides();
    const rewardPriceUsd = this.getStablePrice(position.baseAsset, stablePriceOverrides);

    return rewardAmount * rewardPriceUsd;
  }

  async shouldProjectFutureIncome(position: Position): Promise<boolean> {
    const provider = this.getArbitrumProvider();
    if (!provider) {
      return true;
    }

    const { tokenId, positionManager } = position.metadata;
    if (!tokenId || !positionManager) {
      return true;
    }

    return isUniswapV3PositionInRange(provider, positionManager, tokenId);
  }

  async isPositionClosed(position: Position): Promise<boolean> {
    const provider = this.getArbitrumProvider();
    if (!provider) {
      throw new Error(`[${this.protocolName}] Arbitrum RPC provider is required to verify position closure`);
    }

    const { walletAddress, tokenId, positionManager } = position.metadata;
    if (!walletAddress || !tokenId || !positionManager) {
      throw new Error(`Invalid ${this.protocolKey} position metadata for closure detection`);
    }

    const checksumAddress = toChecksumAddress(walletAddress);
    const tokenIdBigInt = BigInt(tokenId);
    const positionManagerAbi = getAbi('UniswapV3NonfungiblePositionManager');
    const contract = getContract(
      positionManager,
      positionManagerAbi,
      provider
    ) as unknown as UniswapV3PositionManagerContract;

    // Burned/non-existent NFT -> terminally closed.
    let owner: string;
    try {
      owner = await contract.ownerOf(tokenIdBigInt);
    } catch {
      return true;
    }

    // Moved to another wallet -> treat as closed for this tracked wallet.
    if (owner.toLowerCase() !== checksumAddress.toLowerCase()) {
      return true;
    }

    const positionInfo = await contract.positions(tokenIdBigInt);
    const liquidity = BigInt((getUniswapV3PositionField(
      positionInfo as unknown as RawUniswapV3PositionInfo,
      7,
      'liquidity'
    ) ?? 0n) as bigint | number | string);
    if (liquidity > 0n) {
      return false;
    }

    const collectResult = await contract.collect.staticCall(
      {
        tokenId: tokenIdBigInt,
        recipient: checksumAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: checksumAddress }
    );

    const amount0Raw = Array.isArray(collectResult) ? collectResult[0] : collectResult.amount0;
    const amount1Raw = Array.isArray(collectResult) ? collectResult[1] : collectResult.amount1;
    const amount0 = BigInt(amount0Raw ?? 0n);
    const amount1 = BigInt(amount1Raw ?? 0n);
    const owed0 = BigInt((getUniswapV3PositionField(
      positionInfo as unknown as RawUniswapV3PositionInfo,
      10,
      'tokensOwed0'
    ) ?? 0n) as bigint | number | string);
    const owed1 = BigInt((getUniswapV3PositionField(
      positionInfo as unknown as RawUniswapV3PositionInfo,
      11,
      'tokensOwed1'
    ) ?? 0n) as bigint | number | string);

    return amount0 === 0n && amount1 === 0n && owed0 === 0n && owed1 === 0n;
  }
}
