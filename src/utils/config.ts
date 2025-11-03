import { readFileSync } from 'fs';
import { join } from 'path';
import { ProtocolConfig } from '../types';
import { getPluginAbi } from '../plugins/abi-registry';

let protocolConfig: ProtocolConfig | null = null;
const abiCache: Record<string, any[]> = {};

export function getProtocolConfig(): ProtocolConfig {
  if (!protocolConfig) {
    const configPath = join(__dirname, '../../config/protocols.json');
    const configData = readFileSync(configPath, 'utf-8');
    protocolConfig = JSON.parse(configData) as ProtocolConfig;
  }
  return protocolConfig!;
}

export function getAbi(abiKey: string): any[] {
  // 1) Check if a plugin registered this ABI
  const pluginAbi = getPluginAbi(abiKey);
  if (pluginAbi) {
    return pluginAbi;
  }
  // 2) Fallback to core ABIs on disk with local cache
  if (!abiCache[abiKey]) {
    const abiPath = join(__dirname, `../../config/abis/${abiKey}.json`);
    const abiData = readFileSync(abiPath, 'utf-8');
    abiCache[abiKey] = JSON.parse(abiData);
  }
  return abiCache[abiKey];
}

export function getEnvVar(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (value === undefined) {
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
}

export function getStablePriceOverrides(): Record<string, number> {
  const overrides = process.env.STABLE_PRICE_OVERRIDES;
  if (!overrides) {
    return {
      USDC: 1.0,
      USDT: 1.0,
      DAI: 1.0,
      USDS: 1.0,
      crvUSD: 1.0,
      iUSD: 1.0,
      REUSD: 1.0,
    };
  }

  try {
    return JSON.parse(overrides);
  } catch {
    console.error('Failed to parse STABLE_PRICE_OVERRIDES, using defaults');
    return {
      USDC: 1.0,
      USDT: 1.0,
      DAI: 1.0,
      USDS: 1.0,
      crvUSD: 1.0,
      iUSD: 1.0,
      REUSD: 1.0,
    };
  }
}
