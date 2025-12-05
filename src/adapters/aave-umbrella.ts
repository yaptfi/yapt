import { BaseProtocolAdapter } from './base';
import { Position, ProtocolKey } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

/**
 * Generic Aave Umbrella Staking Adapter
 *
 * Supports all Aave Umbrella staking positions (stkwaUSDT, stkwaUSDC, stkwaWETH, etc.)
 *
 * Architecture:
 * - User stakes aTokens (e.g., aUSDT) which get wrapped into waTokens
 * - waTokens are staked into stkwaTokens (StakeToken contract)
 * - Users earn both:
 *   1. Underlying Aave lending APY (aToken continues accruing)
 *   2. Safety Incentive rewards (distributed by RewardsController)
 *
 * Value Calculation:
 * - stkwaToken balance → convertToAssets() → waToken amount
 * - waToken amount → convertToAssets() → aToken amount (principal)
 * - Plus: claimable rewards from RewardsController
 *
 * This adapter is config-driven - each vault variant gets its own protocol key
 * but uses the same adapter logic.
 */
export class AaveUmbrellaAdapter extends BaseProtocolAdapter {
  readonly protocolKey: ProtocolKey;
  readonly protocolName: string;

  constructor(protocolKey: ProtocolKey, protocolName: string) {
    super();
    this.protocolKey = protocolKey;
    this.protocolName = protocolName;
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.stakeToken || !config.baseAsset) {
      throw new Error(`${this.protocolKey} config not found or incomplete (missing stakeToken or baseAsset)`);
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const stakeTokenAbi = getAbi('AaveUmbrellaStakeToken');
      const stakeTokenContract = getContract(config.stakeToken, stakeTokenAbi);

      // Check staked balance
      const stakedBalance = await stakeTokenContract.balanceOf(checksumAddress);

      if (stakedBalance === 0n) {
        return positions;
      }

      const positionKey = this.createPositionKey(config.stakeToken, config.baseAsset);

      positions.push({
        protocolPositionKey: positionKey,
        displayName: config.name,
        baseAsset: config.baseAsset,
        countingMode: config.countingMode || 'count',
        measureMethod: 'exchangeRate',
        metadata: {
          walletAddress: checksumAddress,
          stakeToken: config.stakeToken,
          wrappedToken: config.wrappedToken, // Optional - can be read from contract
          baseAsset: config.baseAsset,
          decimals: config.decimals,
        },
        isActive: true,
      });
    } catch (error) {
      console.error(`Error discovering ${this.protocolKey} for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const {
      stakeToken,
      baseAsset,
      decimals,
      walletAddress,
    } = position.metadata;

    if (
      !stakeToken ||
      !baseAsset ||
      decimals === undefined ||
      !walletAddress
    ) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice(baseAsset, priceOverrides);

    // Get staked balance
    const stakeTokenAbi = getAbi('AaveUmbrellaStakeToken');
    const stakeTokenContract = getContract(stakeToken, stakeTokenAbi);

    await rpcThrottle();
    const stakedBalance = await stakeTokenContract.balanceOf(walletAddress);

    // Early return for zero balance (position exited)
    if (stakedBalance === 0n) {
      console.log(`${this.protocolName}: Zero staked balance detected (position exited)`);
      return 0;
    }

    // Convert staked tokens to wrapped tokens (stkwaToken → waToken)
    // The stakeToken is an ERC4626 vault, so convertToAssets gives us waToken amount
    await rpcThrottle();
    const wrappedAmount = await stakeTokenContract.convertToAssets(stakedBalance);

    // Get wrapped token address from stakeToken if not in metadata
    let wrappedToken = position.metadata.wrappedToken;
    if (!wrappedToken) {
      await rpcThrottle();
      wrappedToken = await stakeTokenContract.asset();
      console.log(`${this.protocolName}: Read wrapped token address from contract: ${wrappedToken}`);
    }

    // Convert wrapped tokens to underlying aTokens (waToken → aToken)
    // The wrappedToken (waToken) is also an ERC4626 vault wrapping the rebasing aToken
    const underlyingAmount = await sharesToAssets(wrappedToken, wrappedAmount);

    // Convert to decimal representation (aTokens have same decimals as underlying)
    const principalAmount = parseFloat(formatUnits(underlyingAmount, decimals));

    // Get rewards from RewardsController
    await rpcThrottle();
    const rewardsControllerAddress = await stakeTokenContract.REWARDS_CONTROLLER();

    const rewardsAbi = getAbi('AaveRewardsController');
    const rewardsController = getContract(rewardsControllerAddress, rewardsAbi);

    await rpcThrottle();
    const [rewardTokens, rewardAmounts] = await rewardsController.calculateCurrentUserRewards(
      stakeToken,
      walletAddress
    );

    // Sum all rewards (assuming stablecoin rewards are $1.00 each)
    // Note: For non-stablecoin rewards (AAVE, GHO), we'd need price oracles
    let totalRewards = 0;
    for (let i = 0; i < rewardTokens.length; i++) {
      const rewardAmount = parseFloat(formatUnits(rewardAmounts[i], 18)); // Most rewards are 18 decimals
      totalRewards += rewardAmount;
      console.log(`${this.protocolName}: Reward ${i}: ${rewardTokens[i]} = ${rewardAmount.toFixed(4)}`);
    }

    const totalValue = principalAmount + totalRewards;

    console.log(
      `${this.protocolName}: ${formatUnits(stakedBalance, decimals)} staked → ${principalAmount.toFixed(2)} ${baseAsset} principal + ${totalRewards.toFixed(2)} rewards = ${totalValue.toFixed(2)} ${baseAsset} total`
    );

    return totalValue * priceUsd;
  }
}
