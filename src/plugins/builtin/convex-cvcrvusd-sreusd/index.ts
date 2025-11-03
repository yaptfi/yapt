import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-sreusd',
    name: 'Convex Staked cvcrvUSD (sreUSD)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-sreusd', 'Convex Staked cvcrvUSD (sreUSD)');
  },
};

export default plugin;

