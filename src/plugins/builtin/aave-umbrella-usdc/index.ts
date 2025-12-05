import type { ProtocolPlugin } from '../../types';
import { AaveUmbrellaAdapter } from '../../../adapters/aave-umbrella';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'aave-umbrella-usdc',
    name: 'Aave Umbrella Staked USDC',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new AaveUmbrellaAdapter('aave-umbrella-usdc', 'Aave Umbrella Staked USDC');
  },
};

export default plugin;
