import type { ProtocolPlugin } from '../../types';
import { ConvexCvxCrvAdapter } from '../../../adapters/convex-cvxcrv';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'convex-cvxcrv',
    name: 'Convex Staked cvxCRV',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new ConvexCvxCrvAdapter();
  },
};

export default plugin;

