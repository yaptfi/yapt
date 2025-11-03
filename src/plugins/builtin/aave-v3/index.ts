import type { ProtocolPlugin } from '../../types';
import { AaveV3Adapter } from '../../../adapters/aave-v3';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'aave-v3',
    name: 'Aave v3',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new AaveV3Adapter();
  },
};

export default plugin;

