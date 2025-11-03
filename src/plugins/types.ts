import { IProtocolAdapter } from '../sdk/adapter';

export interface PluginManifest {
  key: string; // kebab-case identifier
  name: string;
  version?: string;
  sdkVersion?: string; // semver range (reserved for future checks)
}

export interface ProtocolPlugin {
  manifest: PluginManifest;
  /**
   * Optional setup hook invoked at load time, before the adapter is created.
   * Useful for registering ABIs or other metadata.
   */
  setup?: (ctx: { registerAbi: (key: string, abi: any[]) => void }) => void;
  createAdapter(): IProtocolAdapter;
}
