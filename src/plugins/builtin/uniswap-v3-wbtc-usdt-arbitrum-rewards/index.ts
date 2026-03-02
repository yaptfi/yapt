import type { ProtocolPlugin } from '../../types';
import { UniswapV3WbtcUsdtArbitrumRewardsAdapter } from '../../../adapters/uniswap-v3-wbtc-usdt-arbitrum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v3-wbtc-usdt-arbitrum-rewards',
    name: 'Uniswap v3 WBTC/USDT (Arbitrum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV3WbtcUsdtArbitrumRewardsAdapter();
  },
};

export default plugin;
