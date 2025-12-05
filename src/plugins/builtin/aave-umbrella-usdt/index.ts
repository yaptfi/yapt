import type { ProtocolPlugin } from '../../types';
import { AaveUmbrellaAdapter } from '../../../adapters/aave-umbrella';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'aave-umbrella-usdt',
    name: 'Aave Umbrella Staked USDT',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new AaveUmbrellaAdapter('aave-umbrella-usdt', 'Aave Umbrella Staked USDT');
  },
};

export default plugin;
