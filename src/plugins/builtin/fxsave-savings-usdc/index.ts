import type { ProtocolPlugin } from '../../types';
import { FxsaveSavingsUsdcAdapter } from '../../../adapters/fxsave-savings-usdc';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'fxsave-savings-usdc',
    name: 'f(x) fxSAVE (USDC)',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new FxsaveSavingsUsdcAdapter();
  },
};

export default plugin;

