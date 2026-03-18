import { IProtocolAdapter } from './base';
import { AaveV3Adapter } from './aave-v3';
import { AaveUmbrellaAdapter } from './aave-umbrella';
import { CurveScrvUSDAdapter } from './curve-scrvusd';
import { ConvexCvxCrvAdapter } from './convex-cvxcrv';
import { CurveLendingWbtcAdapter } from './curve-lending-wbtc';
import { ConvexCurveVaultAdapter } from './convex-curve-vault';
import { InfinifiSiusdAdapter } from './infinifi-siusd';
import { InfinifiLiusd4wAdapter } from './infinifi-liusd-4w';
import { YearnV3Adapter } from './yearn-v3';
import { UniswapV4Adapter } from './uniswap-v4';
import { UniswapV3WbtcUsdtArbitrumRewardsAdapter } from './uniswap-v3-wbtc-usdt-arbitrum-rewards';
import { UniswapV3WbtcUsdcArbitrumRewardsAdapter } from './uniswap-v3-wbtc-usdc-arbitrum-rewards';
import { UniswapV4WbtcUsdcRewardsAdapter } from './uniswap-v4-wbtc-usdc-rewards';
import { UniswapV3WethUsdcArbitrumRewardsAdapter } from './uniswap-v3-weth-usdc-arbitrum-rewards';
import { UniswapV3PaxgUsdcEthereumRewardsAdapter } from './uniswap-v3-paxg-usdc-ethereum-rewards';
import { UniswapV3WethUsdcEthereumRewardsAdapter } from './uniswap-v3-weth-usdc-ethereum-rewards';
import { UniswapV3UsdtUsdcArbitrumAdapter } from './uniswap-v3-usdt-usdc-arbitrum';
import { PendlePtAdapter } from './pendle-pt';
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
  AaveUmbrellaAdapter,
  CurveScrvUSDAdapter,
  ConvexCvxCrvAdapter,
  CurveLendingWbtcAdapter,
  ConvexCurveVaultAdapter,
  InfinifiSiusdAdapter,
  InfinifiLiusd4wAdapter,
  YearnV3Adapter,
  UniswapV4Adapter,
  UniswapV3WbtcUsdtArbitrumRewardsAdapter,
  UniswapV3WbtcUsdcArbitrumRewardsAdapter,
  UniswapV4WbtcUsdcRewardsAdapter,
  UniswapV3WethUsdcArbitrumRewardsAdapter,
  UniswapV3PaxgUsdcEthereumRewardsAdapter,
  UniswapV3WethUsdcEthereumRewardsAdapter,
  UniswapV3UsdtUsdcArbitrumAdapter,
  PendlePtAdapter,
};
