import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-fxsave',
    name: 'Convex Staked cvcrvUSD (fxSAVE)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-fxsave', 'Convex Staked cvcrvUSD (fxSAVE)');
  },
};

export default plugin;

