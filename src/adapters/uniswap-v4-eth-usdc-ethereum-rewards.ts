import { UniswapV4StablecoinRewardsAdapter } from './uniswap-v4-stablecoin-rewards';

/** Tracks claimable USDC fees for native ETH/USDC Uniswap v4 positions on Ethereum. */
export class UniswapV4EthUsdcEthereumRewardsAdapter extends UniswapV4StablecoinRewardsAdapter {
  constructor() {
    super('uniswap-v4-eth-usdc-ethereum-rewards', 'Uniswap v4 ETH/USDC (Ethereum)');
  }
}
