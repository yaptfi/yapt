/**
 * Debug script to check Aave Umbrella rewards detection
 * Run with: npx tsx scripts/debug_aave_umbrella_rewards.ts <wallet_address>
 */
import { getContract, toChecksumAddress, formatUnits } from '../src/utils/ethereum';
import { getAbi } from '../src/utils/config';

const AAVE_UMBRELLA_CONFIGS = {
  usdt: {
    name: 'USDT',
    stakeToken: '0xA484Ab92fe32B143AEE7019fC1502b1dAA522D31',
    decimals: 6,
  },
  usdc: {
    name: 'USDC',
    stakeToken: '0x6bf183243FdD1e306ad2C4450BC7dcf6f0bf8Aa6',
    decimals: 6,
  },
  weth: {
    name: 'WETH',
    stakeToken: '0xaAFD07D53A7365D3e9fb6F3a3B09EC19676B73Ce',
    decimals: 18,
  },
};

async function checkRewards(walletAddress: string) {
  const checksumAddress = toChecksumAddress(walletAddress);
  console.log(`\nChecking Aave Umbrella rewards for: ${checksumAddress}\n`);

  for (const [key, config] of Object.entries(AAVE_UMBRELLA_CONFIGS)) {
    console.log(`\n=== ${config.name} ===`);

    try {
      const stakeTokenAbi = getAbi('AaveUmbrellaStakeToken');
      const stakeTokenContract = getContract(config.stakeToken, stakeTokenAbi);

      // Check staked balance
      const stakedBalance = await stakeTokenContract.balanceOf(checksumAddress);
      const stakedAmount = parseFloat(formatUnits(stakedBalance, config.decimals));

      console.log(`Staked Balance: ${stakedAmount.toFixed(6)} stk${config.name}`);

      if (stakedBalance === 0n) {
        console.log('No stake - skipping rewards check');
        continue;
      }

      // Get wrapped amount (stakeToken → waToken)
      const wrappedAmount = await stakeTokenContract.convertToAssets(stakedBalance);
      console.log(`Wrapped Amount: ${formatUnits(wrappedAmount, config.decimals)} wa${config.name}`);

      // Get wrapped token address
      const wrappedToken = await stakeTokenContract.asset();
      console.log(`Wrapped Token: ${wrappedToken}`);

      // Get rewards controller
      const rewardsControllerAddress = await stakeTokenContract.REWARDS_CONTROLLER();
      console.log(`Rewards Controller: ${rewardsControllerAddress}`);

      const rewardsAbi = getAbi('AaveRewardsController');
      const rewardsController = getContract(rewardsControllerAddress, rewardsAbi);

      // Get current rewards
      const [rewardTokens, rewardAmounts] = await rewardsController.calculateCurrentUserRewards(
        config.stakeToken,
        checksumAddress
      );

      console.log(`\nReward Tokens Found: ${rewardTokens.length}`);

      let totalRewardsUsd = 0;
      for (let i = 0; i < rewardTokens.length; i++) {
        const tokenAddr = rewardTokens[i];
        const rawAmount = rewardAmounts[i];

        // Try different decimal conversions
        const amount18 = parseFloat(formatUnits(rawAmount, 18));
        const amount6 = parseFloat(formatUnits(rawAmount, 6));

        console.log(`\nReward ${i}:`);
        console.log(`  Token: ${tokenAddr}`);
        console.log(`  Raw Amount: ${rawAmount.toString()}`);
        console.log(`  As 18 decimals: ${amount18.toFixed(6)}`);
        console.log(`  As 6 decimals: ${amount6.toFixed(6)}`);

        // Check if it's a stablecoin (USDC, USDT, DAI, etc.)
        const tokenLower = tokenAddr.toLowerCase();
        const knownStables = {
          '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USDC', decimals: 6 },
          '0xdac17f958d2ee523a2206206994597c13d831ec7': { name: 'USDT', decimals: 6 },
          '0x6b175474e89094c44da98b954eedeac495271d0f': { name: 'DAI', decimals: 18 },
          '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e': { name: 'crvUSD', decimals: 18 },
          '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { name: 'wstETH', decimals: 18 },
        };

        const stableInfo = knownStables[tokenLower];
        if (stableInfo) {
          const correctAmount = parseFloat(formatUnits(rawAmount, stableInfo.decimals));
          console.log(`  ✓ Identified as ${stableInfo.name} (${stableInfo.decimals} decimals): ${correctAmount.toFixed(6)}`);
          totalRewardsUsd += correctAmount;
        } else {
          console.log(`  ⚠ Unknown token - assuming 18 decimals`);
          totalRewardsUsd += amount18;
        }
      }

      console.log(`\n📊 Total Claimable Rewards: ~$${totalRewardsUsd.toFixed(4)} USD`);

    } catch (error: any) {
      console.error(`Error checking ${config.name}:`, error.message);
    }
  }
}

const walletAddress = process.argv[2];
if (!walletAddress) {
  console.error('Usage: npx tsx scripts/debug_aave_umbrella_rewards.ts <wallet_address>');
  process.exit(1);
}

checkRewards(walletAddress)
  .then(() => {
    console.log('\n✓ Done');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
