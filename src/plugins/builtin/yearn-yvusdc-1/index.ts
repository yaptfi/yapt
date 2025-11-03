import type { ProtocolPlugin } from '../../types';
import { YearnV3Adapter } from '../../../adapters/yearn-v3';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'yearn-yvusdc-1',
    name: 'Yearn yvUSDC-1 Vault',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new YearnV3Adapter('yearn-yvusdc-1', 'Yearn yvUSDC-1 Vault');
  },
};

export default plugin;
