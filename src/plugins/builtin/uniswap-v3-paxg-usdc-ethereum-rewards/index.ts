import type { ProtocolPlugin } from '../../types';
import { UniswapV3PaxgUsdcEthereumRewardsAdapter } from '../../../adapters/uniswap-v3-paxg-usdc-ethereum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v3-paxg-usdc-ethereum-rewards',
    name: 'Uniswap v3 PAXG/USDC (Ethereum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV3PaxgUsdcEthereumRewardsAdapter();
  },
};

export default plugin;
