import { ethers, Provider } from 'ethers';
import { getAbi } from './config';
import { toChecksumAddress } from './ethereum';
import { sleep } from './async';

export interface WalletUniswapV4Position {
  tokenId: string;
  poolKey: {
    currency0: string;
    currency1: string;
    fee: bigint;
    tickSpacing: bigint;
    hooks: string;
  };
  tickLower: number;
  tickUpper: number;
  poolId: string;
}

const INVENTORY_CACHE_TTL_MS = 60000;
const DEFAULT_SCAN_CHUNK_SIZE = 50000;
const MAX_QUERY_ATTEMPTS = 4;

// Cache key: walletAddress:positionManagerAddress:fromBlock
const inventoryCache = new Map<Provider, Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV4Position[]> }>>();

export function clearWalletUniswapV4InventoryCache(): void {
  inventoryCache.clear();
}

function getCacheKey(walletAddress: string, positionManagerAddress: string, fromBlock: number): string {
  return `${walletAddress.toLowerCase()}:${positionManagerAddress.toLowerCase()}:${fromBlock}`;
}

function getScanChunkSize(): number {
  const rawValue = process.env.UNISWAP_V4_SCAN_CHUNK_SIZE;
  if (!rawValue) {
    return DEFAULT_SCAN_CHUNK_SIZE;
  }

  const parsed = parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 1) {
    return DEFAULT_SCAN_CHUNK_SIZE;
  }

  return parsed;
}

function isRetryableQueryError(error: unknown): boolean {
  const message = String((error as { shortMessage?: string; message?: string } | undefined)?.shortMessage
    || (error as { message?: string } | undefined)?.message
    || '').toLowerCase();

  return (
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('timeout') ||
    message.includes('-32005')
  );
}

function isBlockRangeError(error: unknown): boolean {
  const message = String((error as { shortMessage?: string; message?: string } | undefined)?.shortMessage
    || (error as { message?: string } | undefined)?.message
    || '').toLowerCase();

  return (
    message.includes('block range') ||
    message.includes('query returned more than') ||
    message.includes('eth_getlogs') ||
    message.includes('exceed') ||
    message.includes('response size exceeded')
  );
}

async function queryFilterRange(
  positionManager: ethers.Contract,
  filter: any,
  fromBlock: number,
  toBlock: number
): Promise<any[]> {
  let delayMs = 1000;

  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
    try {
      return await positionManager.queryFilter(filter, fromBlock, toBlock);
    } catch (error) {
      if (!isRetryableQueryError(error) || attempt >= MAX_QUERY_ATTEMPTS - 1) {
        throw error;
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }

  throw new Error(`Unreachable queryFilter retry exhaustion for blocks ${fromBlock}-${toBlock}`);
}

async function queryFilterChunked(
  positionManager: ethers.Contract,
  filter: any,
  fromBlock: number,
  toBlock: number,
  chunkSize: number
): Promise<any[]> {
  if (fromBlock > toBlock) {
    return [];
  }

  try {
    return await queryFilterRange(positionManager, filter, fromBlock, toBlock);
  } catch (error) {
    if (!isBlockRangeError(error) || fromBlock === toBlock) {
      throw error;
    }
  }

  const events: any[] = [];
  for (let startBlock = fromBlock; startBlock <= toBlock; startBlock += chunkSize) {
    const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);
    const chunkEvents = await queryFilterRange(positionManager, filter, startBlock, endBlock);
    events.push(...chunkEvents);
  }

  return events;
}

async function loadWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  scanProvider: Provider
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const positionManagerAbi = getAbi('UniswapV4PositionManager');
  const positionManager = new ethers.Contract(positionManagerAddress, positionManagerAbi, scanProvider);
  const latestBlock = await scanProvider.getBlockNumber();
  const chunkSize = getScanChunkSize();

  const receivedFilter = positionManager.filters.Transfer(null, checksumAddress);
  const receivedEvents = await queryFilterChunked(positionManager, receivedFilter, fromBlock, latestBlock, chunkSize);

  const positions: WalletUniswapV4Position[] = [];
  const seenTokenIds = new Set<string>();

  for (const event of receivedEvents as any[]) {
    const tokenId = event.args.tokenId.toString();
    if (seenTokenIds.has(tokenId)) {
      continue;
    }
    seenTokenIds.add(tokenId);

    try {
      const currentOwner = await positionManager.ownerOf(tokenId);
      if (currentOwner.toLowerCase() !== checksumAddress.toLowerCase()) {
        continue;
      }
    } catch {
      continue;
    }

    const [poolKey, positionInfoRaw] = await positionManager.getPoolAndPositionInfo(tokenId);

    const info = BigInt(positionInfoRaw);
    const tickLowerUint = Number((info >> 8n) & 0xFFFFFFn);
    const tickUpperUint = Number((info >> 32n) & 0xFFFFFFn);
    const tickLower = tickLowerUint >= (1 << 23) ? tickLowerUint - (1 << 24) : tickLowerUint;
    const tickUpper = tickUpperUint >= (1 << 23) ? tickUpperUint - (1 << 24) : tickUpperUint;

    const poolId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
      )
    );

    positions.push({
      tokenId,
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: BigInt(poolKey.fee),
        tickSpacing: BigInt(poolKey.tickSpacing),
        hooks: poolKey.hooks,
      },
      tickLower,
      tickUpper,
      poolId,
    });
  }

  return positions;
}

/**
 * Returns all Uniswap v4 positions currently owned by walletAddress for the given
 * positionManager. Results are cached for 60s and deduplicated — multiple adapters
 * scanning the same wallet share one eth_getLogs round-trip.
 */
export async function getWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  scanProvider: Provider
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const cacheKey = getCacheKey(checksumAddress, positionManagerAddress, fromBlock);

  const providerCache = inventoryCache.get(scanProvider) ?? new Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV4Position[]> }>();
  inventoryCache.set(scanProvider, providerCache);

  const existing = providerCache.get(cacheKey);
  const now = Date.now();
  if (existing && existing.expiresAtMs > now) {
    return existing.promise;
  }

  const promise = loadWalletUniswapV4Inventory(checksumAddress, positionManagerAddress, fromBlock, scanProvider)
    .catch((error) => {
      providerCache.delete(cacheKey);
      throw error;
    });

  providerCache.set(cacheKey, { expiresAtMs: now + INVENTORY_CACHE_TTL_MS, promise });
  return promise;
}
