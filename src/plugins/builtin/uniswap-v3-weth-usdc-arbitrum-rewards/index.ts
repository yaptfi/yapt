import type { ProtocolPlugin } from '../../types';
import { UniswapV3WethUsdcArbitrumRewardsAdapter } from '../../../adapters/uniswap-v3-weth-usdc-arbitrum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v3-weth-usdc-arbitrum-rewards',
    name: 'Uniswap v3 WETH/USDC (Arbitrum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV3WethUsdcArbitrumRewardsAdapter();
  },
};

export default plugin;
