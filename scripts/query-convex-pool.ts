import { ethers } from 'ethers';

const RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';
const provider = new ethers.JsonRpcProvider(RPC_URL);

const BOOSTER_ADDRESS = '0xF403C135812408BFbE8713b5A23a04b3D48AAE31';
const POOL_ID = 344;

const boosterAbi = [
  'function poolInfo(uint256) external view returns(address lptoken, address token, address gauge, address crvRewards, address stash, bool shutdown)',
];

async function queryPool() {
  const booster = new ethers.Contract(BOOSTER_ADDRESS, boosterAbi, provider);

  try {
    const poolInfo = await booster.poolInfo(POOL_ID);
    console.log(`Pool ${POOL_ID} Info:`);
    console.log(`  LP Token: ${poolInfo.lptoken}`);
    console.log(`  Deposit Token: ${poolInfo.token}`);
    console.log(`  Gauge: ${poolInfo.gauge}`);
    console.log(`  Rewards Contract: ${poolInfo.crvRewards}`);
    console.log(`  Stash: ${poolInfo.stash}`);
    console.log(`  Shutdown: ${poolInfo.shutdown}`);
  } catch (error) {
    console.error('Error querying pool:', error);
  }
}

queryPool();
