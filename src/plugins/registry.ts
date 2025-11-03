import { IProtocolAdapter } from '../sdk/adapter';
import * as staticRegistry from '../adapters';
import { ProtocolKey } from '../types';

// In-memory plugin-backed registry (Phase 2)
const pluginAdapters: Map<ProtocolKey, IProtocolAdapter> = new Map();
type PluginSource = 'builtin' | 'third-party';
export interface LoadedPluginInfo {
  key: ProtocolKey;
  name: string;
  source: PluginSource;
}
const pluginInfos: Map<ProtocolKey, LoadedPluginInfo> = new Map();

export function registerPlugin(adapter: IProtocolAdapter, info: LoadedPluginInfo): void {
  pluginAdapters.set(adapter.protocolKey, adapter);
  pluginInfos.set(adapter.protocolKey, info);
}

export function getAdapter(protocolKey: ProtocolKey): IProtocolAdapter {
  const fromPlugins = pluginAdapters.get(protocolKey);
  if (fromPlugins) return fromPlugins;
  return staticRegistry.getAdapter(protocolKey);
}

export function getAllAdapters(): IProtocolAdapter[] {
  const list: IProtocolAdapter[] = [];
  const seen = new Set<ProtocolKey>();
  for (const a of pluginAdapters.values()) {
    list.push(a);
    seen.add(a.protocolKey);
  }
  for (const a of staticRegistry.getAllAdapters()) {
    if (!seen.has(a.protocolKey)) list.push(a);
  }
  return list;
}

export function clearRegistry(): void {
  pluginAdapters.clear();
  pluginInfos.clear();
}

export function getLoadedPlugins(): LoadedPluginInfo[] {
  return Array.from(pluginInfos.values());
}
