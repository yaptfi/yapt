import type { ProtocolPlugin } from '../../types';
import { PendlePtAdapter } from '../../../adapters/pendle-pt';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'pendle-pt-reusde-jun25',
    name: 'Pendle PT reUSDe (Jun 2025)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new PendlePtAdapter('pendle-pt-reusde-jun25', 'Pendle PT reUSDe (Jun 2025)');
  },
};

export default plugin;
