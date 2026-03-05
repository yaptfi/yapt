import { Position } from '../../src/types';
import { toChecksumAddress } from '../../src/utils/ethereum';

type PartialDiscoveredPosition = Pick<
  Position,
  'protocolPositionKey' | 'displayName' | 'baseAsset' | 'countingMode' | 'measureMethod'
> & {
  metadata?: Record<string, unknown>;
  isActive?: boolean;
};

interface StubAdapter {
  protocolKey: string;
  protocolName: string;
  discover: jest.Mock<Promise<PartialDiscoveredPosition[]>, [string]>;
  readCurrentValue: jest.Mock<Promise<number>, [Position]>;
}

const mockGetAllAdapters = jest.fn<StubAdapter[], []>();
const mockGetAdapter = jest.fn();
const mockCreatePosition = jest.fn();
const mockGetLatestSnapshot = jest.fn();
const mockCreateSnapshot = jest.fn();

jest.mock('../../src/plugins/registry', () => ({
  getAllAdapters: mockGetAllAdapters,
  getAdapter: mockGetAdapter,
}));

jest.mock('../../src/models/position', () => ({
  createPosition: mockCreatePosition,
}));

jest.mock('../../src/models/snapshot', () => ({
  getLatestSnapshot: mockGetLatestSnapshot,
  createSnapshot: mockCreateSnapshot,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const discoveryModule = require('../../src/services/discovery') as {
  discoverPositions: (walletId: string, walletAddress: string) => Promise<Position[]>;
  discoverPositionsWithProgress: (
    walletId: string,
    walletAddress: string,
    onProgress: (event: { type: string; data: Record<string, unknown> }) => void
  ) => Promise<Position[]>;
  __resetDiscoveryCircuitBreakersForTests: () => void;
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(turns: number = 6): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function createDiscoveredPosition(
  overrides: Partial<PartialDiscoveredPosition> & Pick<PartialDiscoveredPosition, 'protocolPositionKey'>
): PartialDiscoveredPosition {
  return {
    protocolPositionKey: overrides.protocolPositionKey,
    displayName: overrides.displayName ?? overrides.protocolPositionKey,
    baseAsset: overrides.baseAsset ?? 'USDC',
    countingMode: overrides.countingMode ?? 'count',
    measureMethod: overrides.measureMethod ?? 'balance',
    metadata: overrides.metadata ?? {},
    isActive: overrides.isActive ?? true,
  };
}

function createStubAdapter(args: {
  protocolKey: string;
  protocolName: string;
  positions: PartialDiscoveredPosition[];
  valuesByPositionKey: Record<string, number>;
}): StubAdapter {
  return {
    protocolKey: args.protocolKey,
    protocolName: args.protocolName,
    discover: jest.fn().mockResolvedValue(args.positions),
    readCurrentValue: jest.fn(async (position: Position) => {
      const value = args.valuesByPositionKey[position.protocolPositionKey];
      if (value === undefined) {
        throw new Error(`No value stub for ${position.protocolPositionKey}`);
      }
      return value;
    }),
  };
}

describe('discovery service integration', () => {
  const walletId = 'wallet-123';
  const walletAddress = '0xabc0000000000000000000000000000000000000';
  const checksumAddress = toChecksumAddress(walletAddress);

  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let createdPositionCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    createdPositionCounter = 0;

    delete process.env.DISCOVERY_PARALLEL_ENABLED;
    delete process.env.DISCOVERY_MAX_CONCURRENCY;
    delete process.env.DISCOVERY_ETHEREUM_MAX_CONCURRENCY;
    delete process.env.DISCOVERY_ARBITRUM_MAX_CONCURRENCY;
    delete process.env.DISCOVERY_OTHER_MAX_CONCURRENCY;
    delete process.env.DISCOVERY_LOG_METRICS;
    delete process.env.DISCOVERY_RETRY_MAX_ATTEMPTS;
    delete process.env.DISCOVERY_RETRY_BASE_DELAY_MS;
    delete process.env.DISCOVERY_RETRY_MAX_DELAY_MS;
    delete process.env.DISCOVERY_DISCOVER_TIMEOUT_MS;
    delete process.env.DISCOVERY_READ_TIMEOUT_MS;
    delete process.env.DISCOVERY_CIRCUIT_BREAKER_ENABLED;
    delete process.env.DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    delete process.env.DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS;

    discoveryModule.__resetDiscoveryCircuitBreakersForTests();

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockGetLatestSnapshot.mockResolvedValue(null);

    mockCreatePosition.mockImplementation(
      async (inputWalletId: string, protocolKey: string, positionData: PartialDiscoveredPosition): Promise<Position> => {
        createdPositionCounter += 1;
        return {
          id: `position-${createdPositionCounter}`,
          walletId: inputWalletId,
          protocolId: `protocol-${createdPositionCounter}`,
          protocolPositionKey: positionData.protocolPositionKey,
          displayName: positionData.displayName,
          baseAsset: positionData.baseAsset,
          stablecoinId: `stablecoin-${createdPositionCounter}`,
          countingMode: positionData.countingMode,
          measureMethod: positionData.measureMethod,
          metadata: positionData.metadata ?? {},
          isActive: positionData.isActive ?? true,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        };
      }
    );
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('discovers and persists rewards, savings, and fixed-income positions above thresholds', async () => {
    const rewardsAdapter = createStubAdapter({
      protocolKey: 'rewards-protocol',
      protocolName: 'Rewards Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'rewards:1', measureMethod: 'rewards' })],
      valuesByPositionKey: { 'rewards:1': 0.25 },
    });

    const savingsAdapter = createStubAdapter({
      protocolKey: 'savings-protocol',
      protocolName: 'Savings Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'savings:1', measureMethod: 'balance' })],
      valuesByPositionKey: { 'savings:1': 25 },
    });

    const fixedIncomeAdapter = createStubAdapter({
      protocolKey: 'fixed-income-protocol',
      protocolName: 'Fixed Income Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'fixed:1', measureMethod: 'fixed-income' })],
      valuesByPositionKey: { 'fixed:1': 12.5 },
    });

    const adapters = [rewardsAdapter, savingsAdapter, fixedIncomeAdapter];
    mockGetAllAdapters.mockReturnValue(adapters);

    const discovered = await discoveryModule.discoverPositions(walletId, walletAddress);

    expect(discovered).toHaveLength(3);
    expect(mockCreatePosition).toHaveBeenCalledTimes(3);
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(3);

    for (const adapter of adapters) {
      expect(adapter.discover).toHaveBeenCalledWith(checksumAddress);
      expect(adapter.readCurrentValue).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            walletAddress: checksumAddress,
            protocolKey: adapter.protocolKey,
          }),
        })
      );
    }

    const persistedProtocols = mockCreatePosition.mock.calls.map((call) => call[1] as string).sort();
    expect(persistedProtocols).toEqual([
      'fixed-income-protocol',
      'rewards-protocol',
      'savings-protocol',
    ]);

    const snapshotValues = mockCreateSnapshot.mock.calls.map((call) => call[2] as number).sort((a, b) => a - b);
    expect(snapshotValues).toEqual([0.25, 12.5, 25]);
  });

  it('ignores dust positions for rewards, savings, and fixed-income categories', async () => {
    const adapter = createStubAdapter({
      protocolKey: 'mixed-protocol',
      protocolName: 'Mixed Protocol',
      positions: [
        createDiscoveredPosition({ protocolPositionKey: 'rewards:zero', measureMethod: 'rewards' }),
        createDiscoveredPosition({ protocolPositionKey: 'savings:dust', measureMethod: 'balance' }),
        createDiscoveredPosition({ protocolPositionKey: 'fixed:dust', measureMethod: 'fixed-income' }),
      ],
      valuesByPositionKey: {
        'rewards:zero': 0,
        'savings:dust': 10,
        'fixed:dust': 10,
      },
    });

    mockGetAllAdapters.mockReturnValue([adapter]);

    const discovered = await discoveryModule.discoverPositions(walletId, walletAddress);

    expect(discovered).toEqual([]);
    expect(adapter.readCurrentValue).toHaveBeenCalledTimes(3);
    expect(mockCreatePosition).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('keeps zero-value rewards positions when adapter marks them discoverable', async () => {
    const adapter = createStubAdapter({
      protocolKey: 'rewards-zero-keep-protocol',
      protocolName: 'Rewards Zero Keep Protocol',
      positions: [
        createDiscoveredPosition({
          protocolPositionKey: 'rewards:zero-open',
          measureMethod: 'rewards',
          metadata: { allowZeroValueDiscovery: true },
        }),
      ],
      valuesByPositionKey: {
        'rewards:zero-open': 0,
      },
    });

    mockGetAllAdapters.mockReturnValue([adapter]);

    const discovered = await discoveryModule.discoverPositions(walletId, walletAddress);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.protocolPositionKey).toBe('rewards:zero-open');
    expect(mockCreatePosition).toHaveBeenCalledTimes(1);
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Date),
      0,
      0,
      0,
      null
    );
  });

  it('deduplicates concurrent discovery calls for the same wallet', async () => {
    const deferred = createDeferred<PartialDiscoveredPosition[]>();
    const adapter = createStubAdapter({
      protocolKey: 'dedupe-protocol',
      protocolName: 'Dedupe Protocol',
      positions: [],
      valuesByPositionKey: { 'dedupe:1': 14 },
    });
    adapter.discover.mockReturnValue(deferred.promise);

    mockGetAllAdapters.mockReturnValue([adapter]);

    const firstDiscoveryPromise = discoveryModule.discoverPositions(walletId, walletAddress);
    await flushMicrotasks();
    const secondDiscoveryPromise = discoveryModule.discoverPositions(walletId, walletAddress);
    await flushMicrotasks();

    expect(adapter.discover).toHaveBeenCalledTimes(1);

    deferred.resolve([
      createDiscoveredPosition({ protocolPositionKey: 'dedupe:1', measureMethod: 'balance' }),
    ]);

    const [firstDiscovered, secondDiscovered] = await Promise.all([
      firstDiscoveryPromise,
      secondDiscoveryPromise,
    ]);

    expect(firstDiscovered.map((position) => position.protocolPositionKey)).toEqual(['dedupe:1']);
    expect(secondDiscovered.map((position) => position.protocolPositionKey)).toEqual(['dedupe:1']);
    expect(mockCreatePosition).toHaveBeenCalledTimes(1);
    expect(mockCreateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('emits progress events and keeps assertions order-agnostic for future parallel discovery refactors', async () => {
    const adapterA = createStubAdapter({
      protocolKey: 'protocol-a',
      protocolName: 'Protocol A',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'a:1', measureMethod: 'balance' })],
      valuesByPositionKey: { 'a:1': 15 },
    });

    const adapterB = createStubAdapter({
      protocolKey: 'protocol-b',
      protocolName: 'Protocol B',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'b:1', measureMethod: 'fixed-income' })],
      valuesByPositionKey: { 'b:1': 22 },
    });

    mockGetAllAdapters.mockReturnValue([adapterA, adapterB]);

    const progressEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const discovered = await discoveryModule.discoverPositionsWithProgress(
      walletId,
      walletAddress,
      (event) => progressEvents.push(event)
    );

    expect(discovered).toHaveLength(2);

    const eventTypes = progressEvents.map((event) => event.type);
    expect(eventTypes.filter((type) => type === 'start')).toHaveLength(1);
    expect(eventTypes.filter((type) => type === 'protocol_start')).toHaveLength(2);
    expect(eventTypes.filter((type) => type === 'position_found')).toHaveLength(2);
    expect(eventTypes.filter((type) => type === 'protocol_complete')).toHaveLength(2);
    expect(eventTypes.filter((type) => type === 'complete')).toHaveLength(1);

    const protocolStarts = progressEvents
      .filter((event) => event.type === 'protocol_start')
      .map((event) => event.data.protocol)
      .sort();
    expect(protocolStarts).toEqual(['Protocol A', 'Protocol B']);

    const completeEvent = progressEvents.find((event) => event.type === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data.totalPositions).toBe(2);
  });

  it('parallel mode allows ethereum discovery to finish while arbitrum adapter is still pending', async () => {
    process.env.DISCOVERY_PARALLEL_ENABLED = 'true';
    process.env.DISCOVERY_MAX_CONCURRENCY = '3';
    process.env.DISCOVERY_ETHEREUM_MAX_CONCURRENCY = '2';
    process.env.DISCOVERY_ARBITRUM_MAX_CONCURRENCY = '1';

    const slowArbitrumDeferred = createDeferred<PartialDiscoveredPosition[]>();

    const slowArbitrumAdapter = createStubAdapter({
      protocolKey: 'slow-arbitrum-protocol',
      protocolName: 'Slow Arbitrum Protocol',
      positions: [],
      valuesByPositionKey: { 'arb:1': 20 },
    });
    slowArbitrumAdapter.discover.mockReturnValue(slowArbitrumDeferred.promise);

    const fastEthereumAdapter = createStubAdapter({
      protocolKey: 'fast-ethereum-protocol',
      protocolName: 'Fast Ethereum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'eth:1', measureMethod: 'balance' })],
      valuesByPositionKey: { 'eth:1': 15 },
    });

    mockGetAllAdapters.mockReturnValue([slowArbitrumAdapter, fastEthereumAdapter]);

    const discoveryPromise = discoveryModule.discoverPositions(walletId, walletAddress);
    await flushMicrotasks();

    expect(slowArbitrumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(fastEthereumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(fastEthereumAdapter.readCurrentValue).toHaveBeenCalledTimes(1);
    expect(slowArbitrumAdapter.readCurrentValue).not.toHaveBeenCalled();

    slowArbitrumDeferred.resolve([
      createDiscoveredPosition({ protocolPositionKey: 'arb:1', measureMethod: 'rewards' }),
    ]);
    const discovered = await discoveryPromise;

    expect(discovered.map((p) => p.protocolPositionKey)).toEqual(['arb:1', 'eth:1']);
    expect(mockCreatePosition).toHaveBeenCalledTimes(2);
  });

  it('parallel mode enforces arbitrum lane cap while non-arbitrum work proceeds', async () => {
    process.env.DISCOVERY_PARALLEL_ENABLED = 'true';
    process.env.DISCOVERY_MAX_CONCURRENCY = '3';
    process.env.DISCOVERY_ETHEREUM_MAX_CONCURRENCY = '2';
    process.env.DISCOVERY_ARBITRUM_MAX_CONCURRENCY = '1';

    const firstArbitrumDeferred = createDeferred<PartialDiscoveredPosition[]>();

    const firstArbitrumAdapter = createStubAdapter({
      protocolKey: 'first-arbitrum-protocol',
      protocolName: 'First Arbitrum Protocol',
      positions: [],
      valuesByPositionKey: { 'arb:slow': 25 },
    });
    firstArbitrumAdapter.discover.mockReturnValue(firstArbitrumDeferred.promise);

    const secondArbitrumAdapter = createStubAdapter({
      protocolKey: 'second-arbitrum-protocol',
      protocolName: 'Second Arbitrum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'arb:queued', measureMethod: 'balance' })],
      valuesByPositionKey: { 'arb:queued': 30 },
    });

    const ethereumAdapter = createStubAdapter({
      protocolKey: 'ethereum-protocol',
      protocolName: 'Ethereum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'eth:fast', measureMethod: 'balance' })],
      valuesByPositionKey: { 'eth:fast': 18 },
    });

    mockGetAllAdapters.mockReturnValue([firstArbitrumAdapter, secondArbitrumAdapter, ethereumAdapter]);

    const discoveryPromise = discoveryModule.discoverPositions(walletId, walletAddress);
    await flushMicrotasks();

    expect(firstArbitrumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(secondArbitrumAdapter.discover).not.toHaveBeenCalled();
    expect(ethereumAdapter.discover).toHaveBeenCalledTimes(1);

    firstArbitrumDeferred.resolve([
      createDiscoveredPosition({ protocolPositionKey: 'arb:slow', measureMethod: 'rewards' }),
    ]);

    const discovered = await discoveryPromise;
    expect(secondArbitrumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(discovered.map((p) => p.protocolPositionKey)).toEqual([
      'arb:slow',
      'arb:queued',
      'eth:fast',
    ]);
    expect(mockCreatePosition).toHaveBeenCalledTimes(3);
  });

  it('retries transient discover failures with bounded attempts', async () => {
    process.env.DISCOVERY_RETRY_MAX_ATTEMPTS = '3';
    process.env.DISCOVERY_RETRY_BASE_DELAY_MS = '0';
    process.env.DISCOVERY_RETRY_MAX_DELAY_MS = '1';

    const adapter = createStubAdapter({
      protocolKey: 'retryable-ethereum-protocol',
      protocolName: 'Retryable Ethereum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'retry:1', measureMethod: 'balance' })],
      valuesByPositionKey: { 'retry:1': 42 },
    });

    adapter.discover
      .mockRejectedValueOnce(new Error('429 too many requests'))
      .mockResolvedValueOnce([createDiscoveredPosition({ protocolPositionKey: 'retry:1', measureMethod: 'balance' })]);

    mockGetAllAdapters.mockReturnValue([adapter]);

    const discovered = await discoveryModule.discoverPositions(walletId, walletAddress);

    expect(adapter.discover).toHaveBeenCalledTimes(2);
    expect(discovered.map((position) => position.protocolPositionKey)).toEqual(['retry:1']);
    expect(mockCreatePosition).toHaveBeenCalledTimes(1);
  });

  it('opens arbitrum circuit breaker and skips subsequent arbitrum adapters during cooldown', async () => {
    process.env.DISCOVERY_CIRCUIT_BREAKER_ENABLED = 'true';
    process.env.DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '1';
    process.env.DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS = '60000';
    process.env.DISCOVERY_RETRY_MAX_ATTEMPTS = '1';

    const failingArbitrumAdapter = createStubAdapter({
      protocolKey: 'failing-arbitrum-protocol',
      protocolName: 'Failing Arbitrum Protocol',
      positions: [],
      valuesByPositionKey: {},
    });
    failingArbitrumAdapter.discover.mockRejectedValue(new Error('arbitrum timeout'));

    const queuedArbitrumAdapter = createStubAdapter({
      protocolKey: 'queued-arbitrum-protocol',
      protocolName: 'Queued Arbitrum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'arb:queued', measureMethod: 'balance' })],
      valuesByPositionKey: { 'arb:queued': 21 },
    });

    const healthyEthereumAdapter = createStubAdapter({
      protocolKey: 'healthy-ethereum-protocol',
      protocolName: 'Healthy Ethereum Protocol',
      positions: [createDiscoveredPosition({ protocolPositionKey: 'eth:healthy', measureMethod: 'balance' })],
      valuesByPositionKey: { 'eth:healthy': 19 },
    });

    mockGetAllAdapters.mockReturnValue([failingArbitrumAdapter, queuedArbitrumAdapter, healthyEthereumAdapter]);

    const discovered = await discoveryModule.discoverPositions(walletId, walletAddress);

    expect(failingArbitrumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(queuedArbitrumAdapter.discover).not.toHaveBeenCalled();
    expect(healthyEthereumAdapter.discover).toHaveBeenCalledTimes(1);
    expect(discovered.map((position) => position.protocolPositionKey)).toEqual(['eth:healthy']);
    expect(mockCreatePosition).toHaveBeenCalledTimes(1);
  });
});
