jest.mock('../../src/utils/async', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

import type { Log, Provider } from 'ethers';
import { scanLogsResumable, LogScanOptions } from '../../src/utils/log-scan';

interface Call {
  fromBlock: number;
  toBlock: number;
}

/** Fake provider returning one log per block listed in `eventBlocks`. */
function createProvider(eventBlocks: number[], options: { maxRange?: number; failAt?: (call: Call) => Error | null } = {}) {
  const calls: Call[] = [];
  const getLogs = jest.fn(async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
    const call = { fromBlock, toBlock };
    calls.push(call);
    const failure = options.failAt?.(call);
    if (failure) throw failure;
    if (options.maxRange !== undefined && toBlock - fromBlock + 1 > options.maxRange) {
      throw new Error(`could not coalesce error (error={ "code": -32602, "message": "range ${toBlock - fromBlock + 1} exceeds limit of ${options.maxRange}" })`);
    }
    return eventBlocks
      .filter((block) => block >= fromBlock && block <= toBlock)
      .map((blockNumber) => ({ blockNumber }) as unknown as Log);
  });
  return { provider: { getLogs } as unknown as Provider, calls };
}

const FILTER = { address: '0xcontroller', topics: ['0xtopic', null, '0xuser'] };

function options(overrides: Partial<LogScanOptions> = {}): LogScanOptions {
  return {
    startBlock: 1_000,
    latestBlock: 1_999,
    scannedFromBlock: null,
    scannedToBlock: null,
    initialChunkSize: 250,
    maxQueries: 100,
    reorgOverlapBlocks: 0,
    label: '[test]',
    ...overrides,
  };
}

describe('scanLogsResumable', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('scans a fresh range backwards from the chain head and reports completion', async () => {
    const { provider, calls } = createProvider([1_000, 1_500, 1_999]);

    const result = await scanLogsResumable(provider, FILTER, options());

    expect(calls[0]).toEqual({ fromBlock: 1_750, toBlock: 1_999 });
    expect(calls.at(-1)).toEqual({ fromBlock: 1_000, toBlock: 1_249 });
    expect(result.logs.map((log) => log.blockNumber).sort()).toEqual([1_000, 1_500, 1_999]);
    expect(result).toMatchObject({ scannedFromBlock: 1_000, scannedToBlock: 1_999, complete: true, queries: 4 });
    expect(result.error).toBeUndefined();
  });

  it('stops at the query budget and keeps the newest contiguous range', async () => {
    const { provider } = createProvider([1_900]);

    const result = await scanLogsResumable(provider, FILTER, options({ maxQueries: 2 }));

    expect(result).toMatchObject({ scannedFromBlock: 1_500, scannedToBlock: 1_999, complete: false, queries: 2 });
    expect(result.logs).toHaveLength(1);
  });

  it('resumes by scanning new blocks forward first, then older history', async () => {
    const { provider, calls } = createProvider([1_200, 2_100]);

    const result = await scanLogsResumable(
      provider,
      FILTER,
      options({ latestBlock: 2_199, scannedFromBlock: 1_500, scannedToBlock: 1_999, reorgOverlapBlocks: 10 })
    );

    expect(calls[0]).toEqual({ fromBlock: 1_990, toBlock: 2_199 });
    expect(calls.slice(1)).toEqual([
      { fromBlock: 1_250, toBlock: 1_499 },
      { fromBlock: 1_000, toBlock: 1_249 },
    ]);
    expect(result.logs.map((log) => log.blockNumber).sort()).toEqual([1_200, 2_100]);
    expect(result).toMatchObject({ scannedFromBlock: 1_000, scannedToBlock: 2_199, complete: true });
  });

  it('adapts chunk size to a provider-reported range limit', async () => {
    const { provider, calls } = createProvider([1_005], { maxRange: 100 });

    const result = await scanLogsResumable(provider, FILTER, options({ initialChunkSize: 1_000 }));

    expect(calls[0]).toEqual({ fromBlock: 1_000, toBlock: 1_999 });
    expect(calls[1]).toEqual({ fromBlock: 1_900, toBlock: 1_999 });
    expect(calls.slice(1).every((call) => call.toBlock - call.fromBlock + 1 <= 100)).toBe(true);
    expect(result).toMatchObject({ complete: true, scannedFromBlock: 1_000 });
    expect(result.logs).toHaveLength(1);
  });

  it('retries throttled queries before succeeding', async () => {
    let throttled = 0;
    const { provider } = createProvider([], {
      failAt: () => (throttled++ < 2 ? new Error('Too Many Requests (-32005)') : null),
    });

    const result = await scanLogsResumable(provider, FILTER, options({ initialChunkSize: 1_000 }));

    expect(result).toMatchObject({ complete: true, queries: 3 });
    expect(result.error).toBeUndefined();
  });

  it('keeps already-scanned progress when a non-retryable error stops the scan', async () => {
    const { provider } = createProvider([1_800], {
      failAt: (call) => (call.toBlock < 1_500 ? new Error('internal error') : null),
    });

    const result = await scanLogsResumable(provider, FILTER, options());

    expect(result.error?.message).toBe('internal error');
    expect(result).toMatchObject({ scannedFromBlock: 1_500, scannedToBlock: 1_999, complete: false });
    expect(result.logs).toHaveLength(1);
  });

  it('reports no range when the first query fails', async () => {
    const { provider } = createProvider([], { failAt: () => new Error('internal error') });

    const result = await scanLogsResumable(provider, FILTER, options());

    expect(result).toMatchObject({ scannedFromBlock: null, scannedToBlock: null, complete: false });
  });
});
