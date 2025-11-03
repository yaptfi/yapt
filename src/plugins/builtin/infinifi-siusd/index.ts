import type { ProtocolPlugin } from '../../types';
import { InfinifiSiusdAdapter } from '../../../adapters/infinifi-siusd';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'infinifi-siusd',
    name: 'Infinifi Staked iUSD',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new InfinifiSiusdAdapter();
  },
};

export default plugin;
