import type { ProtocolPlugin } from '../../types';
import { InfinifiLiusd4wAdapter } from '../../../adapters/infinifi-liusd-4w';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'infinifi-liusd-4w',
    name: 'Infinifi Locked iUSD (4w)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new InfinifiLiusd4wAdapter();
  },
};

export default plugin;

