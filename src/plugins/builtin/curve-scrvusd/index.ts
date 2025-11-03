import type { ProtocolPlugin } from '../../types';
import { CurveScrvUSDAdapter } from '../../../adapters/curve-scrvusd';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'curve-scrvusd',
    name: 'Curve Savings crvUSD',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new CurveScrvUSDAdapter();
  },
};

export default plugin;

