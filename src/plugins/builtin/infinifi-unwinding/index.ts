import type { ProtocolPlugin } from '../../types';
import { InfinifiUnwindingAdapter } from '../../../adapters/infinifi-unwinding';

export const plugin: ProtocolPlugin = {
  manifest: {
    key: 'infinifi-unwinding',
    name: 'Infinifi iUSD Unwinding',
    version: '0.0.1',
    sdkVersion: '^0.1.0',
  },
  createAdapter() {
    return new InfinifiUnwindingAdapter();
  },
};

export default plugin;
