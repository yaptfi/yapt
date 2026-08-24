import { ethers, Provider } from 'ethers';
import { getAbi } from './config';
import { getMulticallContract, toChecksumAddress } from './ethereum';
import { sleep } from './async';
import {
  getUniswapV4InventoryState,
  saveUniswapV4InventoryState,
  UniswapV4InventoryState,
} from '../models/uniswap-v4-inventory';
import {
  getUniswapV4MaxLogQueries,
  getUniswapV4OwnerBatchSize,
  getUniswapV4RecentScanBlocks,
  getUniswapV4RecentTokenWindow,
  getUniswapV4ScanChunkSize,
  getUniswapV4ScanTimeoutMs,
} from './uniswap-v4-scan-config';

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

const INVENTORY_CACHE_TTL_MS = 60_000;
const INVENTORY_FAILURE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_QUERY_ATTEMPTS = 4;
const MIN_OWNER_BATCH_SIZE = 10;

interface InventoryCacheEntry {
  expiresAtMs: number;
  settled: boolean;
  promise: Promise<WalletUniswapV4Position[]>;
}

interface ScanBudget {
  queries: number;
  maxQueries: number;
  startedAtMs: number;
  timeoutMs: number;
}

interface OwnerBatchState {
  size: number;
  warningEmitted: boolean;
  cursor: bigint | null;
}

class InventoryBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryBudgetError';
  }
}

const EMPTY_INVENTORY_STATE: UniswapV4InventoryState = {
  tokenIds: [],
  lastScannedBlock: null,
  nextTokenId: null,
  coldScanCursor: null,
  isComplete: false,
};

let inventoryCache = new WeakMap<Provider, Map<string, InventoryCacheEntry>>();

export function clearWalletUniswapV4InventoryCache(): void {
  inventoryCache = new WeakMap<Provider, Map<string, InventoryCacheEntry>>();
}

function getCacheKey(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  chainId: number
): string {
  return `${chainId}:${walletAddress.toLowerCase()}:${positionManagerAddress.toLowerCase()}:${fromBlock}`;
}

function assertScanBudget(budget: ScanBudget, operation: string): void {
  const elapsedMs = Date.now() - budget.startedAtMs;
  if (elapsedMs >= budget.timeoutMs) {
    throw new InventoryBudgetError(
      `Uniswap v4 inventory discovery stopped after ${budget.queries} bounded RPC queries and ${elapsedMs}ms: ` +
      `time budget of ${budget.timeoutMs}ms exhausted before ${operation}. Progress was saved for the next scan.`
    );
  }
  if (budget.queries >= budget.maxQueries) {
    throw new InventoryBudgetError(
      `Uniswap v4 inventory discovery stopped after ${budget.queries} bounded RPC queries: ` +
      `query budget of ${budget.maxQueries} exhausted before ${operation}. Progress was saved for the next scan.`
    );
  }
  budget.queries += 1;
  if (budget.queries === 100 && budget.maxQueries > 100) {
    console.warn(
      `[Uniswap v4] inventory discovery has used 100 of ${budget.maxQueries} bounded RPC queries; ` +
      'verified positions will be retained and cold-start progress will be resumed later'
    );
  }
}

function getErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      messages.push(value);
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;

    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of [
      'shortMessage',
      'message',
      'reason',
      'code',
      'cause',
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
    message.includes('service unavailable') ||
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
      message.includes('range') || message.includes('limit') || message.includes('exceed')
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
      const limit = match?.[1] ? Number(match[1]) : Number.NaN;
      if (Number.isSafeInteger(limit) && limit > 0) return limit;
    }
  }
  return null;
}

function isNonexistentTokenError(error: unknown): boolean {
  const message = getCombinedErrorMessage(error);
  return (
    message.includes('nonexistent token') ||
    message.includes('invalid token id') ||
    message.includes('owner query for nonexistent') ||
    message.includes('erc721nonexistenttoken')
  );
}

async function readOwnerAtBlock(
  positionManager: ethers.Contract,
  tokenId: string,
  latestBlock: number
): Promise<string | null> {
  let delayMs = 500;
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
    try {
      return await positionManager.ownerOf(tokenId, { blockTag: latestBlock });
    } catch (error) {
      if (isNonexistentTokenError(error)) return null;
      if (!isRetryableQueryError(error) || attempt >= MAX_QUERY_ATTEMPTS - 1) {
        throw new Error(`Failed to verify ownerOf(${tokenId}) during Uniswap v4 inventory discovery`, {
          cause: error,
        });
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
  throw new Error(`Unreachable ownerOf retry exhaustion for token ${tokenId}`);
}

async function queryFilterRange(
  positionManager: ethers.Contract,
  filter: any,
  fromBlock: number,
  toBlock: number,
  budget: ScanBudget
): Promise<any[]> {
  let delayMs = 1000;
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
    try {
      assertScanBudget(budget, `historical logs for blocks ${fromBlock}-${toBlock}`);
      return await positionManager.queryFilter(filter, fromBlock, toBlock);
    } catch (error) {
      if (isBlockRangeError(error) || !isRetryableQueryError(error) || attempt >= MAX_QUERY_ATTEMPTS - 1) {
        throw error;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
  throw new Error(`Unreachable queryFilter retry exhaustion for blocks ${fromBlock}-${toBlock}`);
}

async function loadPersistedState(
  walletAddress: string,
  chainId: number,
  positionManagerAddress: string
): Promise<UniswapV4InventoryState> {
  try {
    return await getUniswapV4InventoryState(walletAddress, chainId, positionManagerAddress);
  } catch (error) {
    console.warn(
      '[Uniswap v4] Failed to load persisted inventory state; continuing with bounded cold discovery:',
      error instanceof Error ? error.message : String(error)
    );
    return { ...EMPTY_INVENTORY_STATE };
  }
}

async function persistState(
  walletAddress: string,
  chainId: number,
  positionManagerAddress: string,
  state: UniswapV4InventoryState
): Promise<void> {
  try {
    await saveUniswapV4InventoryState(walletAddress, chainId, positionManagerAddress, state);
  } catch (error) {
    console.warn(
      '[Uniswap v4] Failed to persist inventory progress; discovery results remain usable:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function scanTokenIdRange(
  positionManager: ethers.Contract,
  provider: Provider,
  walletAddress: string,
  latestBlock: number,
  expectedBalance: bigint,
  ownedTokenIds: Set<string>,
  inspectedTokenIds: Set<string>,
  startTokenId: bigint,
  endTokenId: bigint,
  budget: ScanBudget,
  batchState: OwnerBatchState
): Promise<bigint> {
  if (startTokenId < endTokenId || startTokenId < 1n) return startTokenId;

  const multicall = getMulticallContract(undefined, provider);
  let cursor = startTokenId;

  while (cursor >= endTokenId && BigInt(ownedTokenIds.size) < expectedBalance) {
    const tokenIds: bigint[] = [];
    let nextCursor = cursor;
    while (nextCursor >= endTokenId && tokenIds.length < batchState.size) {
      const tokenIdString = nextCursor.toString();
      if (!inspectedTokenIds.has(tokenIdString)) tokenIds.push(nextCursor);
      nextCursor -= 1n;
    }

    if (tokenIds.length === 0) {
      cursor = nextCursor;
      continue;
    }

    const calls = tokenIds.map((tokenId) => ({
      target: positionManager.target as string,
      callData: positionManager.interface.encodeFunctionData('ownerOf', [tokenId]),
    }));

    try {
      assertScanBudget(
        budget,
        `batched owner checks for token IDs ${tokenIds.at(-1)?.toString()}-${tokenIds[0]?.toString()}`
      );
      const results = await multicall.tryAggregate.staticCall(false, calls, { blockTag: latestBlock });
      for (const tokenId of tokenIds) inspectedTokenIds.add(tokenId.toString());

      for (let index = 0; index < tokenIds.length; index++) {
        const result = results[index];
        const success = Boolean(result?.success ?? result?.[0]);
        const returnData = String(result?.returnData ?? result?.[1] ?? '0x');
        if (!success || returnData === '0x') continue;

        try {
          const [owner] = positionManager.interface.decodeFunctionResult('ownerOf', returnData);
          if (String(owner).toLowerCase() === walletAddress.toLowerCase()) {
            ownedTokenIds.add(tokenIds[index].toString());
            if (BigInt(ownedTokenIds.size) >= expectedBalance) break;
          }
        } catch {
          // A malformed individual result is equivalent to allowFailure=true.
        }
      }
      cursor = nextCursor;
      batchState.cursor = cursor;
    } catch (error) {
      if (error instanceof InventoryBudgetError) throw error;
      if (batchState.size <= MIN_OWNER_BATCH_SIZE) throw error;
      batchState.size = Math.max(MIN_OWNER_BATCH_SIZE, Math.floor(batchState.size / 2));
      if (!batchState.warningEmitted) {
        console.warn(
          `[Uniswap v4] RPC rejected a ${tokenIds.length}-token ownership multicall; ` +
          `reducing batches to ${batchState.size}`
        );
        batchState.warningEmitted = true;
      }
    }
  }

  return cursor;
}

async function scanIncomingTransfers(
  positionManager: ethers.Contract,
  walletAddress: string,
  latestBlock: number,
  fromBlock: number,
  expectedBalance: bigint,
  ownedTokenIds: Set<string>,
  inspectedTokenIds: Set<string>,
  budget: ScanBudget
): Promise<void> {
  if (fromBlock > latestBlock || BigInt(ownedTokenIds.size) >= expectedBalance) return;

  const initialChunkSize = getUniswapV4ScanChunkSize();
  const filter = positionManager.filters.Transfer(null, walletAddress);
  let chunkSize = initialChunkSize;
  let nextToBlock = latestBlock;
  let adaptedRange = false;
  let adaptationWarningEmitted = false;

  while (nextToBlock >= fromBlock && BigInt(ownedTokenIds.size) < expectedBalance) {
    const nextFromBlock = Math.max(fromBlock, nextToBlock - chunkSize + 1);
    let events: any[];

    try {
      events = await queryFilterRange(positionManager, filter, nextFromBlock, nextToBlock, budget);
    } catch (error) {
      const attemptedRangeSize = nextToBlock - nextFromBlock + 1;
      if (!isBlockRangeError(error) || attemptedRangeSize === 1) throw error;

      const reportedLimit = getReportedBlockRangeLimit(error);
      chunkSize = reportedLimit !== null && reportedLimit < attemptedRangeSize
        ? reportedLimit
        : Math.max(1, Math.floor(attemptedRangeSize / 2));
      adaptedRange = true;
      continue;
    }

    if (adaptedRange && !adaptationWarningEmitted) {
      console.warn(
        `[Uniswap v4] RPC block-range limit detected; incremental transfer chunks reduced from ` +
        `${initialChunkSize} to ${chunkSize} blocks`
      );
      adaptationWarningEmitted = true;
    }

    for (let index = events.length - 1; index >= 0; index--) {
      const rawTokenId = events[index]?.args?.tokenId ?? events[index]?.args?.id ?? events[index]?.args?.[2];
      const tokenId = rawTokenId?.toString();
      if (!tokenId || inspectedTokenIds.has(tokenId)) continue;
      inspectedTokenIds.add(tokenId);

      const owner = await readOwnerAtBlock(positionManager, tokenId, latestBlock);
      if (owner?.toLowerCase() === walletAddress.toLowerCase()) {
        ownedTokenIds.add(tokenId);
        if (BigInt(ownedTokenIds.size) >= expectedBalance) break;
      }
    }
    nextToBlock = nextFromBlock - 1;
  }
}

function parsePositiveBigInt(value: string | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function sortTokenIdsDescending(tokenIds: Set<string>): string[] {
  return [...tokenIds].sort((a, b) => {
    const aValue = BigInt(a);
    const bValue = BigInt(b);
    return aValue === bValue ? 0 : aValue > bValue ? -1 : 1;
  });
}

async function loadWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  provider: Provider,
  chainId: number
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const positionManager = new ethers.Contract(
    positionManagerAddress,
    getAbi('UniswapV4PositionManager'),
    provider
  );
  const latestBlock = await provider.getBlockNumber();
  const persistedState = await loadPersistedState(checksumAddress, chainId, positionManagerAddress);
  const [balanceRaw, nextTokenIdRaw] = await Promise.all([
    positionManager.balanceOf(checksumAddress, { blockTag: latestBlock }),
    positionManager.nextTokenId({ blockTag: latestBlock }),
  ]);
  const expectedBalance = BigInt(balanceRaw);
  const currentNextTokenId = BigInt(nextTokenIdRaw);

  if (expectedBalance === 0n) {
    await persistState(checksumAddress, chainId, positionManagerAddress, {
      tokenIds: [],
      lastScannedBlock: latestBlock,
      nextTokenId: currentNextTokenId.toString(),
      coldScanCursor: null,
      isComplete: true,
    });
    return [];
  }

  const ownedTokenIds = new Set<string>();
  const inspectedTokenIds = new Set<string>();
  let terminalError: unknown;

  for (const tokenId of persistedState.tokenIds) {
    try {
      const owner = await readOwnerAtBlock(positionManager, tokenId, latestBlock);
      inspectedTokenIds.add(tokenId);
      if (owner?.toLowerCase() === checksumAddress.toLowerCase()) ownedTokenIds.add(tokenId);
    } catch (error) {
      // Keep looking. The bounded token-ID scan can verify this ID through
      // Multicall, and other known/current positions must not be discarded.
      terminalError = terminalError ?? error;
    }
  }

  const budget: ScanBudget = {
    queries: 0,
    maxQueries: getUniswapV4MaxLogQueries(),
    startedAtMs: Date.now(),
    timeoutMs: getUniswapV4ScanTimeoutMs(),
  };
  const batchState: OwnerBatchState = {
    size: getUniswapV4OwnerBatchSize(),
    warningEmitted: false,
    cursor: null,
  };
  const previousNextTokenId = parsePositiveBigInt(persistedState.nextTokenId);
  let coldScanCursor = parsePositiveBigInt(persistedState.coldScanCursor);
  const resumingColdScan = coldScanCursor !== null;

  if (BigInt(ownedTokenIds.size) < expectedBalance) {
    try {
      if (previousNextTokenId !== null && currentNextTokenId > previousNextTokenId) {
        await scanTokenIdRange(
          positionManager,
          provider,
          checksumAddress,
          latestBlock,
          expectedBalance,
          ownedTokenIds,
          inspectedTokenIds,
          currentNextTokenId - 1n,
          previousNextTokenId,
          budget,
          batchState
        );
      }

      if (
        BigInt(ownedTokenIds.size) < expectedBalance &&
        coldScanCursor === null &&
        !persistedState.isComplete
      ) {
        const newestTokenId = currentNextTokenId - 1n;
        const hasKnownPositions = persistedState.tokenIds.length > 0;
        const recentWindow = BigInt(getUniswapV4RecentTokenWindow());
        const recentEnd = hasKnownPositions
          ? (currentNextTokenId > recentWindow ? currentNextTokenId - recentWindow : 1n)
          : 1n;
        coldScanCursor = await scanTokenIdRange(
          positionManager,
          provider,
          checksumAddress,
          latestBlock,
          expectedBalance,
          ownedTokenIds,
          inspectedTokenIds,
          newestTokenId,
          recentEnd,
          budget,
          batchState
        );
      }

      if (
        BigInt(ownedTokenIds.size) < expectedBalance &&
        persistedState.tokenIds.length > 0 &&
        !resumingColdScan
      ) {
        const incrementalFromBlock = persistedState.lastScannedBlock !== null
          ? persistedState.lastScannedBlock + 1
          : Math.max(fromBlock, latestBlock - getUniswapV4RecentScanBlocks() + 1);
        await scanIncomingTransfers(
          positionManager,
          checksumAddress,
          latestBlock,
          incrementalFromBlock,
          expectedBalance,
          ownedTokenIds,
          inspectedTokenIds,
          budget
        );
      }

      if (BigInt(ownedTokenIds.size) < expectedBalance) {
        const resumeFrom = coldScanCursor ?? (currentNextTokenId - 1n);
        coldScanCursor = await scanTokenIdRange(
          positionManager,
          provider,
          checksumAddress,
          latestBlock,
          expectedBalance,
          ownedTokenIds,
          inspectedTokenIds,
          resumeFrom,
          1n,
          budget,
          batchState
        );
      }
    } catch (error) {
      if (batchState.cursor !== null) coldScanCursor = batchState.cursor;
      terminalError = error;
    }
  }

  const complete = BigInt(ownedTokenIds.size) === expectedBalance;
  const tokenIds = sortTokenIdsDescending(ownedTokenIds);
  await persistState(checksumAddress, chainId, positionManagerAddress, {
    tokenIds,
    lastScannedBlock: complete ? latestBlock : persistedState.lastScannedBlock,
    nextTokenId: currentNextTokenId.toString(),
    coldScanCursor: complete ? null : (coldScanCursor ?? currentNextTokenId - 1n).toString(),
    isComplete: complete,
  });

  if (!complete) {
    const reason = terminalError instanceof Error
      ? terminalError.message
      : `verified ${tokenIds.length} of ${expectedBalance.toString()} NFTs`;
    if (tokenIds.length === 0) {
      throw new Error(`Uniswap v4 inventory discovery is incomplete: ${reason}`, {
        cause: terminalError,
      });
    }
    console.warn(
      `[Uniswap v4] Inventory discovery is incomplete (${tokenIds.length}/${expectedBalance.toString()} NFTs); ` +
      `returning verified positions and resuming later. ${reason}`
    );
  }

  const positions: WalletUniswapV4Position[] = [];
  let positionInfoError: unknown;
  for (const tokenId of tokenIds) {
    try {
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
    } catch (error) {
      positionInfoError = positionInfoError ?? error;
    }
  }

  if (positions.length === 0 && tokenIds.length > 0) {
    throw new Error('Failed to read pool information for every verified Uniswap v4 NFT', {
      cause: positionInfoError,
    });
  }
  if (positions.length < tokenIds.length) {
    console.warn(
      `[Uniswap v4] Returning ${positions.length}/${tokenIds.length} verified NFTs because ` +
      'some pool metadata reads failed; the omitted NFTs will be retried on a later scan'
    );
  }
  return positions;
}

/**
 * Returns currently owned Uniswap v4 PositionManager NFTs. Persisted positions
 * and checkpoints are verified first; new token IDs and incremental transfers
 * are then inspected with bounded calls. In-flight scans never expire, while
 * settled results are cached briefly for sibling v4 adapters.
 */
export async function getWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  provider: Provider,
  chainId = 1
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const cacheKey = getCacheKey(checksumAddress, positionManagerAddress, fromBlock, chainId);
  const providerCache = inventoryCache.get(provider) ?? new Map<string, InventoryCacheEntry>();
  inventoryCache.set(provider, providerCache);

  const existing = providerCache.get(cacheKey);
  const now = Date.now();
  if (existing && (!existing.settled || existing.expiresAtMs > now)) return existing.promise;
  if (existing) providerCache.delete(cacheKey);

  const cacheEntry: InventoryCacheEntry = {
    expiresAtMs: Number.POSITIVE_INFINITY,
    settled: false,
    promise: Promise.resolve([]),
  };
  cacheEntry.promise = loadWalletUniswapV4Inventory(
    checksumAddress,
    positionManagerAddress,
    fromBlock,
    provider,
    chainId
  )
    .then((inventory) => {
      cacheEntry.settled = true;
      cacheEntry.expiresAtMs = Date.now() + INVENTORY_CACHE_TTL_MS;
      return inventory;
    })
    .catch((error) => {
      cacheEntry.settled = true;
      cacheEntry.expiresAtMs = Date.now() + INVENTORY_FAILURE_CACHE_TTL_MS;
      throw error;
    });

  providerCache.set(cacheKey, cacheEntry);
  return cacheEntry.promise;
}
