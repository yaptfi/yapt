import { UniswapV4StablecoinRewardsAdapter } from './uniswap-v4-stablecoin-rewards';

/** Tracks claimable USDC fees for native ETH/USDC Uniswap v4 positions on Arbitrum. */
export class UniswapV4EthUsdcArbitrumRewardsAdapter extends UniswapV4StablecoinRewardsAdapter {
  constructor() {
    super('uniswap-v4-eth-usdc-arbitrum-rewards', 'Uniswap v4 ETH/USDC (Arbitrum)');
  }
}
