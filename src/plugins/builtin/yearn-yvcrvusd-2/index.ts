import type { ProtocolPlugin } from '../../types';
import { YearnV3Adapter } from '../../../adapters/yearn-v3';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'yearn-yvcrvusd-2',
    name: 'Yearn yvcrvUSD-2 Vault',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new YearnV3Adapter('yearn-yvcrvusd-2', 'Yearn yvcrvUSD-2 Vault');
  },
};

export default plugin;
