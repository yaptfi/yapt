import { UniswapV4StablecoinRewardsAdapter } from './uniswap-v4-stablecoin-rewards';

/** Tracks claimable USDC fees for Uniswap v4 WBTC/USDC positions on Arbitrum. */
export class UniswapV4WbtcUsdcRewardsAdapter extends UniswapV4StablecoinRewardsAdapter {
  constructor() {
    super('uniswap-v4-wbtc-usdc-rewards', 'Uniswap v4 WBTC/USDC');
  }
}
