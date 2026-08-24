import type { ProtocolPlugin } from '../../types';
import { UniswapV4EthUsdcEthereumRewardsAdapter } from '../../../adapters/uniswap-v4-eth-usdc-ethereum-rewards';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'uniswap-v4-eth-usdc-ethereum-rewards',
    name: 'Uniswap v4 ETH/USDC (Ethereum)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new UniswapV4EthUsdcEthereumRewardsAdapter();
  },
};

export default plugin;
