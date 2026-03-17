import type { ProtocolPlugin } from '../../types';
import { UniswapV3WbtcUsdcArbitrumRewardsAdapter } from '../../../adapters/uniswap-v3-wbtc-usdc-arbitrum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v3-wbtc-usdc-arbitrum-rewards',
    name: 'Uniswap v3 WBTC/USDC (Arbitrum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV3WbtcUsdcArbitrumRewardsAdapter();
  },
};

export default plugin;
