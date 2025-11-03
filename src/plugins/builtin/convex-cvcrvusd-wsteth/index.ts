import type { ProtocolPlugin } from '../../types';
import { ConvexCurveVaultAdapter } from '../../../adapters/convex-curve-vault';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvcrvusd-wsteth',
    name: 'Convex Staked cvcrvUSD (wstETH)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCurveVaultAdapter('convex-cvcrvusd-wsteth', 'Convex Staked cvcrvUSD (wstETH)');
  },
};

export default plugin;

