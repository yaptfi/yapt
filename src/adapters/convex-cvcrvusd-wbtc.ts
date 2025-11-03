import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

export class ConvexCvcrvusdWbtcAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'convex-cvcrvusd-wbtc' as const;
  readonly protocolName = 'Convex Staked cvcrvUSD (wBTC)';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['convex-cvcrvusd-wbtc'];
    if (!config || !config.stakingContract || !config.depositToken) {
      throw new Error('Convex cvcrvUSD (wBTC) config not found');
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const rewardsAbi = getAbi('ConvexBaseRewardPool');
      const stakingContract = getContract(config.stakingContract, rewardsAbi);

      // Check staked balance
      const stakedBalance = await stakingContract.balanceOf(checksumAddress);

      if (stakedBalance > 0n) {
        const positionKey = this.createPositionKey(config.stakingContract, 'crvUSD');

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'Convex cvcrvUSD (wBTC)',
          baseAsset: 'crvUSD',
          countingMode: config.countingMode || 'count',
          measureMethod: 'exchangeRate',
          metadata: {
            stakingContract: config.stakingContract,
            depositToken: config.depositToken,
            curveVaultToken: config.curveVaultToken,
            rewardToken: config.rewardToken,
            depositDecimals: config.depositDecimals,
            rewardDecimals: config.rewardDecimals,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering Convex cvcrvUSD (wBTC) for ${walletAddress}:`, error);
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
      throw new Error('Invalid Convex cvcrvUSD position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('crvUSD', priceOverrides);

    // Get staked balance and rewards
    const rewardsAbi = getAbi('ConvexBaseRewardPool');
    const stakingContractInstance = getContract(stakingContract, rewardsAbi);

    await rpcThrottle();
    const stakedBalance = await stakingContractInstance.balanceOf(walletAddress);
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
      `Convex cvcrvUSD (wBTC): ${formatUnits(stakedBalance, depositDecimals)} staked → ${principalCrvUSD.toFixed(2)} crvUSD principal + ${rewardsCrvUSD.toFixed(2)} crvUSD rewards = ${totalCrvUSD.toFixed(2)} crvUSD total`
    );

    return totalCrvUSD * priceUsd;
  }

}
