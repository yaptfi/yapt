import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits } from '../utils/ethereum';
import { getAbi } from '../utils/config';

const PROTOCOL_CONFIG = {
  stakingContract: '0xaa0C3f5F7DFD688C6E646F66CD2a6B66ACdbE434',
  cvxCrvToken: '0x62B9c7356A2Dc64a1969e19C23e4f579F9810Aa7',
  rewardToken: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', // crvUSD
  rewardDecimals: 18,
  cvxCrvDecimals: 18,
};

/**
 * Convex cvxCRV Staking Adapter
 *
 * Tracks ONLY crvUSD rewards (partial counting mode).
 * Ignores cvxCRV principal value since it's volatile.
 *
 * APY Calculation Strategy:
 * - Position value = claimable crvUSD rewards
 * - Stores initial cvxCRV deposit value in metadata for APY baseline
 * - APY = annualized crvUSD accrual rate relative to initial deposit
 */
export class ConvexCvxCrvAdapter extends BaseProtocolAdapter {
  protocolKey = 'convex-cvxcrv' as const;
  protocolName = 'Convex Staked cvxCRV';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const abi = getAbi('ConvexCvxCrvStaking');
    const stakingContract = getContract(PROTOCOL_CONFIG.stakingContract, abi);
    const checksumAddress = toChecksumAddress(walletAddress);

    // Check staked balance
    const stakedBalance = await stakingContract.balanceOf(checksumAddress);

    if (stakedBalance === 0n) {
      return [];
    }

    // Calculate initial deposit value for APY baseline
    // We'll use the current staked balance * $1 as a placeholder
    // In a real scenario, we'd fetch cvxCRV price, but for APY we just need a consistent baseline
    const stakedAmount = parseFloat(formatUnits(stakedBalance, PROTOCOL_CONFIG.cvxCrvDecimals));

    return [
      {
        protocolPositionKey: `${PROTOCOL_CONFIG.stakingContract}:cvxCRV`,
        displayName: 'Convex cvxCRV → crvUSD',
        baseAsset: 'crvUSD',
        countingMode: 'partial', // Only count stable yield
        measureMethod: 'rewards',
        metadata: {
          walletAddress: checksumAddress,
          stakingContract: PROTOCOL_CONFIG.stakingContract,
          cvxCrvToken: PROTOCOL_CONFIG.cvxCrvToken,
          rewardToken: PROTOCOL_CONFIG.rewardToken,
          rewardDecimals: PROTOCOL_CONFIG.rewardDecimals,
          cvxCrvDecimals: PROTOCOL_CONFIG.cvxCrvDecimals,
          // Store staked amount as baseline for APY calculation
          stakedCvxCrvAmount: stakedAmount.toString(),
          initialDepositUsd: stakedAmount.toString(), // Placeholder baseline
        },
        isActive: true,
      },
    ];
  }

  async readCurrentValue(position: Position): Promise<number> {
    const abi = getAbi('ConvexCvxCrvStaking');
    const stakingContract = getContract(position.metadata.stakingContract, abi);
    const walletAddress = position.metadata.walletAddress;
    const crvUsdToken = position.metadata.rewardToken.toLowerCase();

    // Call earned() which returns an array of (token, amount) tuples
    const earnedData = await stakingContract.earned(walletAddress);

    console.log(`Convex earned data for ${walletAddress}:`, JSON.stringify(earnedData, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    ));

    // Find crvUSD in the earned rewards
    for (const reward of earnedData) {
      const rewardToken = reward.token.toLowerCase();
      console.log(`Checking reward token: ${rewardToken} against ${crvUsdToken}`);

      if (rewardToken === crvUsdToken) {
        // Found crvUSD rewards!
        const earnedAmount = parseFloat(formatUnits(reward.amount, position.metadata.rewardDecimals));
        console.log(`Found crvUSD rewards: ${earnedAmount} USD`);

        // Assume crvUSD is $1.00
        return earnedAmount * 1.0;
      }
    }

    console.log(`crvUSD not found in earned rewards for ${walletAddress}`);
    // crvUSD not found in earned rewards (might not be accrued yet)
    return 0;
  }

}
