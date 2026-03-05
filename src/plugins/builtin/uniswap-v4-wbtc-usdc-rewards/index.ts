import type { ProtocolPlugin } from '../../types';
import { UniswapV4WbtcUsdcRewardsAdapter } from '../../../adapters/uniswap-v4-wbtc-usdc-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v4-wbtc-usdc-rewards',
    name: 'Uniswap v4 WBTC/USDC',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV4WbtcUsdcRewardsAdapter();
  },
};

export default plugin;
