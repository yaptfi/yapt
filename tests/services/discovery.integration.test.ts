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
};

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
  let consoleErrorSpy: jest.SpyInstance;
  let createdPositionCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    createdPositionCounter = 0;

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
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
});
