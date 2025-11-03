import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-sfrxusd',
    name: 'Convex Staked cvcrvUSD (sfrxUSD)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-sfrxusd', 'Convex Staked cvcrvUSD (sfrxUSD)');
  },
};

export default plugin;

