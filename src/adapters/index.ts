import { IProtocolAdapter } from './base';
import { AaveV3Adapter } from './aave-v3';
import { CurveScrvUSDAdapter } from './curve-scrvusd';
import { ConvexCvxCrvAdapter } from './convex-cvxcrv';
import { CurveLendingWbtcAdapter } from './curve-lending-wbtc';
import { ConvexCurveVaultAdapter } from './convex-curve-vault';
import { InfinifiSiusdAdapter } from './infinifi-siusd';
import { YearnV3Adapter } from './yearn-v3';
import { UniswapV4Adapter } from './uniswap-v4';
import { ProtocolKey } from '../types';

// Registry of all protocol adapters
const adapters: Map<ProtocolKey, IProtocolAdapter> = new Map();

// Initialize adapters
// (Intentionally left empty) — built-in adapters are now loaded via the plugin loader.

export function getAdapter(protocolKey: ProtocolKey): IProtocolAdapter {
  const adapter = adapters.get(protocolKey);
  if (!adapter) {
    throw new Error(`Adapter not found for protocol: ${protocolKey}`);
  }
  return adapter;
}

export function getAllAdapters(): IProtocolAdapter[] {
  return Array.from(adapters.values());
}

export {
  IProtocolAdapter,
  AaveV3Adapter,
  CurveScrvUSDAdapter,
  ConvexCvxCrvAdapter,
  CurveLendingWbtcAdapter,
  ConvexCurveVaultAdapter,
  InfinifiSiusdAdapter,
  YearnV3Adapter,
  UniswapV4Adapter,
};
