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
const INVENTORY_FAILURE_CACHE_TTL_MS = 5000;
const DEFAULT_SCAN_CHUNK_SIZE = 50000;
const MAX_QUERY_ATTEMPTS = 4;

// Cache key: walletAddress:positionManagerAddress:fromBlock
interface InventoryCacheEntry {
  expiresAtMs: number;
  promise: Promise<WalletUniswapV4Position[]>;
}

const inventoryCache = new Map<Provider, Map<string, InventoryCacheEntry>>();

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

function getErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      messages.push(value);
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) {
      return;
    }

    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of [
      'shortMessage',
      'message',
      'reason',
      'code',
      'error',
      'info',
      'data',
      'body',
      'value',
      'response',
    ]) {
      visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  return messages;
}

function getCombinedErrorMessage(error: unknown): string {
  return getErrorMessages(error).join(' ').toLowerCase();
}

function isRetryableQueryError(error: unknown): boolean {
  const message = getCombinedErrorMessage(error);

  return (
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('timeout') ||
    message.includes('-32005')
  );
}

function isBlockRangeError(error: unknown): boolean {
  const message = getCombinedErrorMessage(error);

  return (
    message.includes('block range') ||
    message.includes('query returned more than') ||
    message.includes('response size exceeded') ||
    /range.{0,120}exceeds.{0,40}limit/s.test(message) ||
    (message.includes('eth_getlogs') && (
      message.includes('range') ||
      message.includes('limit') ||
      message.includes('exceed')
    ))
  );
}

function getReportedBlockRangeLimit(error: unknown): number | null {
  const patterns = [
    /(?:block\s+)?range[^.\n]{0,120}?exceeds(?:\s+the)?\s+limit(?:\s+of)?\s+([\d,]+)/i,
    /(?:maximum|max)(?:\s+allowed)?\s+(?:block\s+)?range(?:\s+is|\s+of|:)?\s+([\d,]+)/i,
    /(?:block\s+)?range\s+(?:is\s+)?limited\s+to\s+(?:a\s+)?([\d,]+)/i,
    /limited\s+to\s+(?:a\s+)?([\d,]+)\s+blocks?/i,
    /limit(?:ed)?\s+(?:of|to)\s+([\d,]+)\s+blocks?/i,
    /up\s+to\s+(?:a\s+)?([\d,]+)\s+blocks?/i,
  ];

  for (const message of getErrorMessages(error)) {
    const normalizedMessage = message.replace(/,/g, '');
    for (const pattern of patterns) {
      const match = normalizedMessage.match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const limit = Number(match[1]);
      if (Number.isSafeInteger(limit) && limit > 0) {
        return limit;
      }
    }
  }

  return null;
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
      if (
        isBlockRangeError(error) ||
        !isRetryableQueryError(error) ||
        attempt >= MAX_QUERY_ATTEMPTS - 1
      ) {
        throw error;
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }

  throw new Error(`Unreachable queryFilter retry exhaustion for blocks ${fromBlock}-${toBlock}`);
}

async function findCurrentlyOwnedTokenIds(
  positionManager: ethers.Contract,
  filter: any,
  fromBlock: number,
  latestBlock: number,
  initialChunkSize: number,
  expectedBalance: bigint,
  walletAddress: string
): Promise<string[]> {
  if (expectedBalance === 0n) {
    return [];
  }

  const ownedTokenIds: string[] = [];
  const seenTokenIds = new Set<string>();
  let chunkSize = initialChunkSize;
  let nextToBlock = latestBlock;
  let adaptedRange = false;
  let adaptationWarningEmitted = false;

  while (nextToBlock >= fromBlock && BigInt(ownedTokenIds.length) < expectedBalance) {
    const nextFromBlock = Math.max(fromBlock, nextToBlock - chunkSize + 1);
    let chunkEvents: any[];

    try {
      chunkEvents = await queryFilterRange(positionManager, filter, nextFromBlock, nextToBlock);
    } catch (error) {
      const attemptedRangeSize = nextToBlock - nextFromBlock + 1;
      if (!isBlockRangeError(error) || attemptedRangeSize === 1) {
        throw error;
      }

      const reportedLimit = getReportedBlockRangeLimit(error);
      const reducedChunkSize = reportedLimit !== null && reportedLimit < attemptedRangeSize
        ? reportedLimit
        : Math.max(1, Math.floor(attemptedRangeSize / 2));
      chunkSize = Math.min(chunkSize, reducedChunkSize);
      adaptedRange = true;
      continue;
    }

    if (adaptedRange && !adaptationWarningEmitted) {
      console.warn(
        `[Uniswap v4] RPC block-range limit detected; reducing transfer scan chunks from ${initialChunkSize} to ${chunkSize} blocks`
      );
      adaptationWarningEmitted = true;
    }

    for (let index = chunkEvents.length - 1; index >= 0; index--) {
      const tokenId = chunkEvents[index]?.args?.tokenId?.toString();
      if (!tokenId || seenTokenIds.has(tokenId)) {
        continue;
      }
      seenTokenIds.add(tokenId);

      try {
        const currentOwner = await positionManager.ownerOf(tokenId, { blockTag: latestBlock });
        if (currentOwner.toLowerCase() !== walletAddress.toLowerCase()) {
          continue;
        }
      } catch {
        continue;
      }

      ownedTokenIds.push(tokenId);
      if (BigInt(ownedTokenIds.length) === expectedBalance) {
        break;
      }
    }

    nextToBlock = nextFromBlock - 1;
  }

  if (BigInt(ownedTokenIds.length) !== expectedBalance) {
    throw new Error(
      `Uniswap v4 inventory scan exhausted blocks ${fromBlock}-${latestBlock}: ` +
      `found ${ownedTokenIds.length} of ${expectedBalance.toString()} NFTs reported by balanceOf`
    );
  }

  return ownedTokenIds;
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
  const expectedBalance = BigInt(await positionManager.balanceOf(checksumAddress, { blockTag: latestBlock }));

  if (expectedBalance === 0n) {
    return [];
  }

  const receivedFilter = positionManager.filters.Transfer(null, checksumAddress);
  const tokenIds = await findCurrentlyOwnedTokenIds(
    positionManager,
    receivedFilter,
    fromBlock,
    latestBlock,
    chunkSize,
    expectedBalance,
    checksumAddress
  );

  const positions: WalletUniswapV4Position[] = [];

  for (const tokenId of tokenIds) {
    const [poolKey, positionInfoRaw] = await positionManager.getPoolAndPositionInfo(
      tokenId,
      { blockTag: latestBlock }
    );

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
 * positionManager. Successful results are cached for 60s and terminal failures for
 * 5s, so multiple adapters scanning the same wallet share one inventory scan.
 */
export async function getWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  scanProvider: Provider
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const cacheKey = getCacheKey(checksumAddress, positionManagerAddress, fromBlock);

  const providerCache = inventoryCache.get(scanProvider) ?? new Map<string, InventoryCacheEntry>();
  inventoryCache.set(scanProvider, providerCache);

  const existing = providerCache.get(cacheKey);
  const now = Date.now();
  if (existing && existing.expiresAtMs > now) {
    return existing.promise;
  }

  const cacheEntry: InventoryCacheEntry = {
    expiresAtMs: now + INVENTORY_CACHE_TTL_MS,
    promise: Promise.resolve([]),
  };
  cacheEntry.promise = loadWalletUniswapV4Inventory(checksumAddress, positionManagerAddress, fromBlock, scanProvider)
    .catch((error) => {
      cacheEntry.expiresAtMs = Date.now() + INVENTORY_FAILURE_CACHE_TTL_MS;
      throw error;
    });

  providerCache.set(cacheKey, cacheEntry);
  return cacheEntry.promise;
}
