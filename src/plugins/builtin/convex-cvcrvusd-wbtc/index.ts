import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-wbtc',
    name: 'Convex Staked cvcrvUSD (WBTC)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-wbtc', 'Convex Staked cvcrvUSD (WBTC)');
  },
};

export default plugin;

