import { Position, PositionSnapshot } from '../../src/types';

const mockGetAdapter = jest.fn();
const mockGetLatestSnapshot = jest.fn();
const mockCreateSnapshot = jest.fn();
const mockGetSnapshotNearTime = jest.fn();
const mockGetMostRecentResetSnapshot = jest.fn();
const mockGetTotalYieldSince = jest.fn();
const mockArchivePosition = jest.fn();
const mockUpdatePositionFutureIncomeProjection = jest.fn();
const mockGetUniswapIncomeForecast = jest.fn();

jest.mock('../../src/plugins/registry', () => ({
  getAdapter: mockGetAdapter,
}));

jest.mock('../../src/models/snapshot', () => ({
  getLatestSnapshot: mockGetLatestSnapshot,
  createSnapshot: mockCreateSnapshot,
  getSnapshotNearTime: mockGetSnapshotNearTime,
  getMostRecentResetSnapshot: mockGetMostRecentResetSnapshot,
  getTotalYieldSince: mockGetTotalYieldSince,
}));

jest.mock('../../src/models/position', () => ({
  archivePosition: mockArchivePosition,
  updatePositionFutureIncomeProjection: mockUpdatePositionFutureIncomeProjection,
}));

jest.mock('../../src/utils/apy', () => ({
  computeApy: jest.fn().mockReturnValue({ apy: 0 }),
}));

jest.mock('../../src/services/uniswap-income-forecast', () => ({
  getUniswapIncomeForecast: mockGetUniswapIncomeForecast,
  isUniswapProtocol: (protocolKey: string | undefined) => protocolKey?.startsWith('uniswap-') ?? false,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const updateModule = require('../../src/services/update') as {
  getPositionMetrics: (positionId: string, position?: Position) => Promise<{
    shouldProjectFutureIncome: boolean;
  } | null>;
  updatePosition: (position: Position) => Promise<void>;
};

const REWARD_POSITION: Position = {
  id: 'position-1',
  walletId: 'wallet-1',
  protocolId: 'protocol-1',
  protocolPositionKey: 'pm:123',
  displayName: 'Uniswap v3 WETH/USDC (Arbitrum) #123',
  baseAsset: 'USDC',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: {
    protocolKey: 'uniswap-v3-weth-usdc-arbitrum-rewards',
    walletAddress: '0xabc0000000000000000000000000000000000000',
    tokenId: '123',
    positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    futureIncomeProjection: {
      shouldProject: false,
      checkedAt: '2026-03-07T18:00:00.000Z',
    },
  },
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const LATEST_SNAPSHOT: PositionSnapshot = {
  id: 1,
  position_id: REWARD_POSITION.id,
  ts: new Date('2026-03-07T18:00:00.000Z'),
  value_usd: '25.0',
  net_flows_usd: '0',
  yield_delta_usd: '0.5',
  apy: null,
};

describe('future-income projection caching', () => {
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockGetLatestSnapshot.mockResolvedValue(LATEST_SNAPSHOT);
    mockGetTotalYieldSince.mockResolvedValue({ totalYieldUsd: 7, daysCovered: 7 });
    mockCreateSnapshot.mockResolvedValue({});
    mockGetSnapshotNearTime.mockResolvedValue(null);
    mockGetMostRecentResetSnapshot.mockResolvedValue(null);
    mockArchivePosition.mockResolvedValue(undefined);
    mockUpdatePositionFutureIncomeProjection.mockResolvedValue(undefined);
    mockGetUniswapIncomeForecast.mockResolvedValue({
      dailyRateUsd: 1,
      metadata: {
        model: 'uniswap-weekday-v1',
        maturity: 'early',
        observedDays: 1,
        weekdayProfileSource: 'neutral',
      },
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it('uses cached projection state from metadata on the request path', async () => {
    const adapter = {
      protocolKey: 'uniswap-v3-weth-usdc-arbitrum-rewards',
      protocolName: 'Uniswap v3 WETH/USDC (Arbitrum)',
      discover: jest.fn(),
      readCurrentValue: jest.fn(),
      shouldProjectFutureIncome: jest.fn().mockResolvedValue(true),
    };
    mockGetAdapter.mockReturnValue(adapter);

    const result = await updateModule.getPositionMetrics(REWARD_POSITION.id, REWARD_POSITION);

    expect(result?.shouldProjectFutureIncome).toBe(false);
    expect(mockGetAdapter).not.toHaveBeenCalled();
    expect(adapter.shouldProjectFutureIncome).not.toHaveBeenCalled();
  });

  it('refreshes cached projection state during background updates', async () => {
    const adapter = {
      protocolKey: 'uniswap-v3-weth-usdc-arbitrum-rewards',
      protocolName: 'Uniswap v3 WETH/USDC (Arbitrum)',
      discover: jest.fn(),
      readCurrentValue: jest.fn().mockResolvedValue(25),
      shouldProjectFutureIncome: jest.fn().mockResolvedValue(false),
      isPositionClosed: jest.fn().mockResolvedValue(false),
    };
    mockGetAdapter.mockReturnValue(adapter);

    await updateModule.updatePosition({
      ...REWARD_POSITION,
      metadata: {
        ...REWARD_POSITION.metadata,
        futureIncomeProjection: undefined,
      },
    });

    expect(adapter.shouldProjectFutureIncome).toHaveBeenCalledTimes(1);
    expect(mockUpdatePositionFutureIncomeProjection).toHaveBeenCalledWith(
      REWARD_POSITION.id,
      false,
      expect.any(Date)
    );
  });
});
