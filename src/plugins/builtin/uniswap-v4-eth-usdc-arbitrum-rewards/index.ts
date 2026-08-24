import type { ProtocolPlugin } from '../../types';
import { UniswapV4EthUsdcArbitrumRewardsAdapter } from '../../../adapters/uniswap-v4-eth-usdc-arbitrum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v4-eth-usdc-arbitrum-rewards',
    name: 'Uniswap v4 ETH/USDC (Arbitrum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV4EthUsdcArbitrumRewardsAdapter();
  },
};

export default plugin;
