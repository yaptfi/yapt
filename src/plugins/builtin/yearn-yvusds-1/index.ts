import type { ProtocolPlugin } from '../../types';
import { YearnV3Adapter } from '../../../adapters/yearn-v3';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'yearn-yvusds-1',
    name: 'Yearn yvUSDS-1 Vault',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new YearnV3Adapter('yearn-yvusds-1', 'Yearn yvUSDS-1 Vault');
  },
};

export default plugin;
