import type { ProtocolPlugin } from '../../types';
import { UniswapV4Adapter } from '../../../adapters/uniswap-v4';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v4-usdc-usdt',
    name: 'Uniswap v4 USDC/USDT',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV4Adapter();
  },
};

export default plugin;
