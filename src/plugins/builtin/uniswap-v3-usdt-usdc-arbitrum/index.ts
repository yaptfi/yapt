import type { ProtocolPlugin } from '../../types';
import { UniswapV3UsdtUsdcArbitrumAdapter } from '../../../adapters/uniswap-v3-usdt-usdc-arbitrum';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v3-usdt-usdc-arbitrum',
    name: 'Uniswap v3 USDT/USDC (Arbitrum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV3UsdtUsdcArbitrumAdapter();
  },
};
