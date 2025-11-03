import type { ProtocolPlugin } from '../../types';
import { MorpheusGtUsdcPrimeAdapter } from '../../../adapters/morpheus-gtusdc-prime';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'morpheus-gtusdc-prime',
    name: 'Morpheus Gauntlet USDC Prime (gtUSDC)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new MorpheusGtUsdcPrimeAdapter();
  },
};

export default plugin;

