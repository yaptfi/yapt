import type { ProtocolPlugin } from '../../types';
import { CurveLendingWbtcAdapter } from '../../../adapters/curve-lending-wbtc';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'curve-lending-wbtc',
    name: 'Curve Lending Vault (wBTC)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new CurveLendingWbtcAdapter();
  },
};

export default plugin;

