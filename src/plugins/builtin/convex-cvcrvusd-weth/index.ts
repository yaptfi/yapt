import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-weth',
    name: 'Convex Staked cvcrvUSD (WETH)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-weth', 'Convex Staked cvcrvUSD (WETH)');
  },
};

export default plugin;

