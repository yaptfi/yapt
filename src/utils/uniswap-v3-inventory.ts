import { Provider } from 'ethers';
import { getAbi } from './config';
import { getContract, toChecksumAddress } from './ethereum';

export interface RawUniswapV3PositionInfo {
  token0?: string;
  token1?: string;
  fee?: bigint | number | string;
  tickLower?: bigint | number | string;
  tickUpper?: bigint | number | string;
  liquidity?: bigint | number | string;
  tokensOwed0?: bigint | number | string;
  tokensOwed1?: bigint | number | string;
  [key: string]: unknown;
}

interface UniswapV3PositionManagerContract {
  balanceOf(owner: string): Promise<bigint>;
  tokenOfOwnerByIndex(owner: string, index: bigint): Promise<bigint>;
  positions(tokenId: bigint): Promise<RawUniswapV3PositionInfo>;
}

export interface WalletUniswapV3Position {
  tokenId: bigint;
  token0: string;
  token1: string;
  fee: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

const INVENTORY_CACHE_TTL_MS = 60000;
const inventoryCache = new Map<Provider, Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV3Position[]> }>>();

export function clearWalletUniswapV3InventoryCache(): void {
  inventoryCache.clear();
}

export function getUniswapV3PositionField(
  positionInfo: RawUniswapV3PositionInfo,
  index: number,
  key: keyof RawUniswapV3PositionInfo
): unknown {
  const record = positionInfo as Record<string, unknown>;
  const indexed = record[String(index)];
  if (indexed !== undefined && indexed !== null) {
    return indexed;
  }
  return record[key as string];
}

function getCacheKey(chainId: number, walletAddress: string, positionManagerAddress: string): string {
  return `${chainId}:${walletAddress.toLowerCase()}:${positionManagerAddress.toLowerCase()}`;
}

function normalizeBigInt(value: unknown): bigint {
  if (value === undefined || value === null) {
    return 0n;
  }
  return BigInt(value as bigint | number | string);
}

function normalizeNumber(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  return Number(value);
}

function normalizeInventoryEntry(tokenId: bigint, positionInfo: RawUniswapV3PositionInfo): WalletUniswapV3Position | null {
  const token0Raw = getUniswapV3PositionField(positionInfo, 2, 'token0');
  const token1Raw = getUniswapV3PositionField(positionInfo, 3, 'token1');
  const feeRaw = getUniswapV3PositionField(positionInfo, 4, 'fee');

  if (typeof token0Raw !== 'string' || typeof token1Raw !== 'string' || feeRaw === undefined || feeRaw === null) {
    return null;
  }

  return {
    tokenId,
    token0: token0Raw,
    token1: token1Raw,
    fee: normalizeBigInt(feeRaw),
    tickLower: normalizeNumber(getUniswapV3PositionField(positionInfo, 5, 'tickLower')),
    tickUpper: normalizeNumber(getUniswapV3PositionField(positionInfo, 6, 'tickUpper')),
    liquidity: normalizeBigInt(getUniswapV3PositionField(positionInfo, 7, 'liquidity')),
    tokensOwed0: normalizeBigInt(getUniswapV3PositionField(positionInfo, 10, 'tokensOwed0')),
    tokensOwed1: normalizeBigInt(getUniswapV3PositionField(positionInfo, 11, 'tokensOwed1')),
  };
}

async function loadWalletUniswapV3Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  provider: Provider
): Promise<WalletUniswapV3Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const positionManagerAbi = getAbi('UniswapV3NonfungiblePositionManager');
  const positionManager = getContract(
    positionManagerAddress,
    positionManagerAbi,
    provider
  ) as unknown as UniswapV3PositionManagerContract;

  const ownedCount = BigInt(await positionManager.balanceOf(checksumAddress));
  const positions: WalletUniswapV3Position[] = [];

  for (let i = 0n; i < ownedCount; i++) {
    const tokenId = BigInt(await positionManager.tokenOfOwnerByIndex(checksumAddress, i));
    const positionInfo = await positionManager.positions(tokenId);
    const normalized = normalizeInventoryEntry(tokenId, positionInfo);
    if (normalized) {
      positions.push(normalized);
    }
  }

  return positions;
}

export async function getWalletUniswapV3Inventory(
  chainId: number,
  walletAddress: string,
  positionManagerAddress: string,
  provider: Provider
): Promise<WalletUniswapV3Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const cacheKey = getCacheKey(chainId, checksumAddress, positionManagerAddress);
  const providerCache = inventoryCache.get(provider) ?? new Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV3Position[]> }>();
  inventoryCache.set(provider, providerCache);
  const existing = providerCache.get(cacheKey);
  const now = Date.now();

  if (existing && existing.expiresAtMs > now) {
    return existing.promise;
  }

  const promise = loadWalletUniswapV3Inventory(checksumAddress, positionManagerAddress, provider)
    .catch((error) => {
      providerCache.delete(cacheKey);
      throw error;
    });

  providerCache.set(cacheKey, {
    expiresAtMs: now + INVENTORY_CACHE_TTL_MS,
    promise,
  });

  return promise;
}
