import type { ProtocolPlugin } from '../../types';
import { AaveUmbrellaAdapter } from '../../../adapters/aave-umbrella';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'aave-umbrella-weth',
    name: 'Aave Umbrella Staked WETH',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new AaveUmbrellaAdapter('aave-umbrella-weth', 'Aave Umbrella Staked WETH');
  },
};

export default plugin;
