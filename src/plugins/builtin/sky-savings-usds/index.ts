import type { ProtocolPlugin } from '../../types';
import { SkySavingsUsdsAdapter } from '../../../adapters/sky-savings-usds';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'sky-savings-usds',
    name: 'Sky Savings USDS',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new SkySavingsUsdsAdapter();
  },
};

export default plugin;

