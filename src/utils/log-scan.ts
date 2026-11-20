import type { Log, Provider } from 'ethers';
import { sleep } from './async';
import { getReportedBlockRangeLimit, isBlockRangeError, isRetryableQueryError } from './rpc-errors';

/**
 * Resumable, budgeted `eth_getLogs` scanner for user-filtered event history.
 *
 * The already-scanned history is a single contiguous range
 * `[scannedFromBlock, scannedToBlock]`. Each run:
 *   1. scans forward from `scannedToBlock` (minus a small reorg overlap) to
 *      `latestBlock`, so new events are found first;
 *   2. then extends the range backwards towards `startBlock` until the
 *      budget runs out.
 * A fresh scan starts at `latestBlock` and walks backwards, so recent events
 * are found on the first run even when full history needs several runs.
 *
 * Chunk sizes adapt to provider-reported block-range limits. A failure stops
 * the scan but keeps every chunk that already succeeded, so callers can
 * persist partial progress.
 */

export interface LogScanFilter {
  address: string;
  topics: Array<string | null>;
}

export interface LogScanOptions {
  /** First block that can contain relevant logs (e.g. contract deployment). */
  startBlock: number;
  latestBlock: number;
  scannedFromBlock: number | null;
  scannedToBlock: number | null;
  initialChunkSize: number;
  maxQueries: number;
  /** Blocks below `scannedToBlock` re-scanned to tolerate shallow reorgs. */
  reorgOverlapBlocks?: number;
  /** Log prefix, e.g. "[Infinifi unwinding]". */
  label: string;
}

export interface LogScanResult {
  logs: Log[];
  scannedFromBlock: number | null;
  scannedToBlock: number | null;
  /** True when the scanned range covers `[startBlock, latestBlock]`. */
  complete: boolean;
  queries: number;
  /** Set when scanning stopped early because of an RPC error. */
  error?: Error;
}

const MAX_QUERY_ATTEMPTS = 4;
const DEFAULT_REORG_OVERLAP_BLOCKS = 32;

class LogScanBudgetExceeded extends Error {}

export async function scanLogsResumable(
  provider: Provider,
  filter: LogScanFilter,
  options: LogScanOptions
): Promise<LogScanResult> {
  const { startBlock, latestBlock, label } = options;
  if (!Number.isSafeInteger(options.initialChunkSize) || options.initialChunkSize < 1) {
    throw new Error(`${label} initialChunkSize must be a positive integer`);
  }

  const logs: Log[] = [];
  let queries = 0;
  let chunkSize = options.initialChunkSize;
  let rangeWarningEmitted = false;

  const hasRange = options.scannedFromBlock !== null && options.scannedToBlock !== null;
  // An empty range is represented as from = to + 1 while scanning.
  let scannedFrom = hasRange ? options.scannedFromBlock! : latestBlock + 1;
  let scannedTo = hasRange ? options.scannedToBlock! : latestBlock;

  const fetchRange = async (fromBlock: number, toBlock: number): Promise<Log[]> => {
    let delayMs = 1000;
    for (let attempt = 0; ; attempt++) {
      if (queries >= options.maxQueries) throw new LogScanBudgetExceeded();
      queries++;
      try {
        return await provider.getLogs({ address: filter.address, topics: filter.topics, fromBlock, toBlock });
      } catch (error) {
        if (isBlockRangeError(error) || !isRetryableQueryError(error) || attempt >= MAX_QUERY_ATTEMPTS - 1) {
          throw error;
        }
        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    }
  };

  /**
   * Fetch `[fromBlock, toBlock]`. Returns null when the provider rejected the
   * range size; `chunkSize` is then reduced and the caller recomputes bounds.
   */
  const fetchChunk = async (fromBlock: number, toBlock: number): Promise<Log[] | null> => {
    try {
      return await fetchRange(fromBlock, toBlock);
    } catch (error) {
      const attempted = toBlock - fromBlock + 1;
      if (!isBlockRangeError(error) || attempted === 1) throw error;

      const reported = getReportedBlockRangeLimit(error);
      chunkSize = reported !== null && reported < attempted ? reported : Math.max(1, Math.floor(attempted / 2));
      if (!rangeWarningEmitted) {
        console.warn(`${label} RPC block-range limit detected; reducing log chunks to ${chunkSize} blocks`);
        rangeWarningEmitted = true;
      }
      return null;
    }
  };

  let error: Error | undefined;
  try {
    // Phase 1: forward from the scanned range to the chain head.
    if (scannedTo <= latestBlock) {
      const overlap = options.reorgOverlapBlocks ?? DEFAULT_REORG_OVERLAP_BLOCKS;
      let nextFrom = hasRange ? Math.max(scannedFrom, scannedTo + 1 - overlap) : latestBlock + 1;
      while (nextFrom <= latestBlock) {
        const nextTo = Math.min(latestBlock, nextFrom + chunkSize - 1);
        const chunkLogs = await fetchChunk(nextFrom, nextTo);
        if (chunkLogs === null) continue;
        logs.push(...chunkLogs);
        scannedTo = Math.max(scannedTo, nextTo);
        nextFrom = nextTo + 1;
      }
    }

    // Phase 2: backward towards startBlock.
    while (scannedFrom > startBlock) {
      const nextTo = scannedFrom - 1;
      const nextFrom = Math.max(startBlock, nextTo - chunkSize + 1);
      const chunkLogs = await fetchChunk(nextFrom, nextTo);
      if (chunkLogs === null) continue;
      logs.push(...chunkLogs);
      scannedFrom = nextFrom;
    }
  } catch (caught) {
    if (caught instanceof LogScanBudgetExceeded) {
      console.warn(
        `${label} log scan budget of ${options.maxQueries} queries reached; ` +
        `scanned blocks ${scannedFrom <= scannedTo ? `${scannedFrom}-${scannedTo}` : 'none'}, will resume next run`
      );
    } else {
      error = caught instanceof Error ? caught : new Error(String(caught));
      console.warn(`${label} log scan stopped early: ${error.message}`);
    }
  }

  const hasScanned = scannedFrom <= scannedTo;
  return {
    logs,
    scannedFromBlock: hasScanned ? scannedFrom : null,
    scannedToBlock: hasScanned ? scannedTo : null,
    complete: hasScanned && scannedFrom <= startBlock && scannedTo >= latestBlock,
    queries,
    ...(error ? { error } : {}),
  };
}
