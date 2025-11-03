import { BaseProtocolAdapter } from './base';
import { Position, ProtocolKey } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

/**
 * Generic Convex Curve Vault Adapter
 *
 * Supports all Convex-staked Curve vault positions that follow the same pattern:
 * - Deposit tokens into Convex rewards contract
 * - Earn CRV/CVX rewards in crvUSD
 * - Underlying Curve vault tokens represent crvUSD principal
 *
 * This adapter is config-driven - each vault variant gets its own protocol key
 * but uses the same adapter logic.
 */
export class ConvexCurveVaultAdapter extends BaseProtocolAdapter {
  readonly protocolKey: ProtocolKey;
  readonly protocolName: string;

  constructor(protocolKey: ProtocolKey, protocolName: string) {
    super();
    this.protocolKey = protocolKey;
    this.protocolName = protocolName;
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.stakingContract || !config.depositToken) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const rewardsAbi = getAbi('ConvexBaseRewardPool');
      const stakingContract = getContract(config.stakingContract, rewardsAbi);

      // Check staked balance
      const stakedBalance = await stakingContract.balanceOf(checksumAddress);

      if (stakedBalance === 0n) {
        return positions;
      }

      const positionKey = this.createPositionKey(config.stakingContract, 'crvUSD');

      positions.push({
        protocolPositionKey: positionKey,
        displayName: config.name,
        baseAsset: 'crvUSD',
        countingMode: config.countingMode || 'count',
        measureMethod: 'exchangeRate',
        metadata: {
          walletAddress: checksumAddress,
          stakingContract: config.stakingContract,
          depositToken: config.depositToken,
          curveVaultToken: config.curveVaultToken,
          rewardToken: config.rewardToken,
          depositDecimals: config.depositDecimals,
          rewardDecimals: config.rewardDecimals,
          poolId: config.poolId,
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
      stakingContract,
      curveVaultToken,
      rewardToken,
      depositDecimals,
      rewardDecimals,
      walletAddress,
    } = position.metadata;

    if (
      !stakingContract ||
      !curveVaultToken ||
      !rewardToken ||
      depositDecimals === undefined ||
      rewardDecimals === undefined ||
      !walletAddress
    ) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('crvUSD', priceOverrides);

    // Get staked balance and rewards
    const rewardsAbi = getAbi('ConvexBaseRewardPool');
    const stakingContractInstance = getContract(stakingContract, rewardsAbi);

    await rpcThrottle();
    const stakedBalance = await stakingContractInstance.balanceOf(walletAddress);

    // Early return for zero balance (position exited)
    if (stakedBalance === 0n) {
      console.log(`${this.protocolName}: Zero staked balance detected (position exited)`);
      return 0;
    }

    await rpcThrottle();
    const earnedRewards = await stakingContractInstance.earned(walletAddress);

    // Convert staked balance to crvUSD value using Curve vault
    // The deposit token represents shares in the Curve vault
    const underlyingAssets = await sharesToAssets(curveVaultToken, stakedBalance);
    const principalCrvUSD = parseFloat(formatUnits(underlyingAssets, depositDecimals));

    // Get claimable rewards value
    const rewardsCrvUSD = parseFloat(formatUnits(earnedRewards, rewardDecimals));

    const totalCrvUSD = principalCrvUSD + rewardsCrvUSD;

    console.log(
      `${this.protocolName}: ${formatUnits(stakedBalance, depositDecimals)} staked → ${principalCrvUSD.toFixed(2)} crvUSD principal + ${rewardsCrvUSD.toFixed(2)} crvUSD rewards = ${totalCrvUSD.toFixed(2)} crvUSD total`
    );

    return totalCrvUSD * priceUsd;
  }

}
