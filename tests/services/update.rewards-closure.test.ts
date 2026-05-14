import { Position, PositionSnapshot } from '../../src/types';

const mockGetAdapter = jest.fn();
const mockGetLatestSnapshot = jest.fn();
const mockCreateSnapshot = jest.fn();
const mockGetSnapshotNearTime = jest.fn();
const mockGetMostRecentResetSnapshot = jest.fn();
const mockGetTotalYieldSince = jest.fn();
const mockGetSnapshotsSince = jest.fn();
const mockArchivePosition = jest.fn();
const mockUpdatePositionFutureIncomeProjection = jest.fn();

jest.mock('../../src/plugins/registry', () => ({
  getAdapter: mockGetAdapter,
}));

jest.mock('../../src/models/snapshot', () => ({
  getLatestSnapshot: mockGetLatestSnapshot,
  createSnapshot: mockCreateSnapshot,
  getSnapshotNearTime: mockGetSnapshotNearTime,
  getMostRecentResetSnapshot: mockGetMostRecentResetSnapshot,
  getTotalYieldSince: mockGetTotalYieldSince,
  getSnapshotsSince: mockGetSnapshotsSince,
}));

jest.mock('../../src/models/position', () => ({
  archivePosition: mockArchivePosition,
  updatePositionFutureIncomeProjection: mockUpdatePositionFutureIncomeProjection,
}));

jest.mock('../../src/utils/apy', () => ({
  computeApy: jest.fn().mockReturnValue({ apy: 0 }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const updateModule = require('../../src/services/update') as {
  updatePosition: (position: Position) => Promise<void>;
};

const REWARD_POSITION: Position = {
  id: 'position-1',
  walletId: 'wallet-1',
  protocolId: 'protocol-1',
  protocolPositionKey: 'pm:123',
  displayName: 'Uniswap v3 WBTC/USDT (Arbitrum) #123',
  baseAsset: 'USDT',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: {
    protocolKey: 'uniswap-v3-wbtc-usdt-arbitrum-rewards',
    walletAddress: '0xabc0000000000000000000000000000000000000',
    tokenId: '123',
    positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    rewardDecimals: 6,
    rewardTokenIndex: 1,
  },
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const LATEST_SNAPSHOT: PositionSnapshot = {
  id: 1,
  position_id: REWARD_POSITION.id,
  ts: new Date('2026-01-01T01:00:00.000Z'),
  value_usd: '5.0',
  net_flows_usd: '0',
  yield_delta_usd: '0',
  apy: null,
};

describe('updatePosition reward closure handling', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  const adapter = {
    protocolKey: 'uniswap-v3-wbtc-usdt-arbitrum-rewards',
    protocolName: 'Uniswap v3 WBTC/USDT (Arbitrum)',
    discover: jest.fn(),
    readCurrentValue: jest.fn(),
    isPositionClosed: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    mockGetAdapter.mockReturnValue(adapter);
    mockGetLatestSnapshot.mockResolvedValue(LATEST_SNAPSHOT);
    mockCreateSnapshot.mockResolvedValue({});
    mockArchivePosition.mockResolvedValue(undefined);
    mockGetSnapshotNearTime.mockResolvedValue(null);
    mockGetMostRecentResetSnapshot.mockResolvedValue(null);
    mockGetTotalYieldSince.mockResolvedValue({ totalYieldUsd: 0, daysCovered: 0 });
    mockGetSnapshotsSince.mockResolvedValue([]);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('archives rewards position when adapter confirms terminal closure', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    adapter.isPositionClosed.mockResolvedValue(true);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).toHaveBeenCalledWith(REWARD_POSITION.id, 'complete_exit');
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('keeps rewards position active after a zero-value claim when still open', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    adapter.isPositionClosed.mockResolvedValue(false);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).toHaveBeenCalledWith(
      REWARD_POSITION.id,
      expect.any(Date),
      0,
      0,
      0,
      null
    );
  });

  it('archives rewards position when value read fails but closure is confirmed', async () => {
    adapter.readCurrentValue.mockRejectedValue(new Error('invalid token ID'));
    adapter.isPositionClosed.mockResolvedValue(true);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).toHaveBeenCalledWith(REWARD_POSITION.id, 'complete_exit');
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('does not archive when value read fails and closure cannot be confirmed', async () => {
    adapter.readCurrentValue.mockRejectedValue(new Error('temporary RPC issue'));
    adapter.isPositionClosed.mockResolvedValue(false);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('logs closure probe failures as errors with position context', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    const probeError = new Error('RPC timeout');
    adapter.isPositionClosed.mockRejectedValue(probeError);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorMessages = consoleErrorSpy.mock.calls
      .map((args: unknown[]) => args.map((arg) => typeof arg === 'string' ? arg : '').join(' '))
      .join('\n');
    expect(errorMessages).toContain(REWARD_POSITION.id);
    expect(errorMessages).toContain('uniswap-v3-wbtc-usdt-arbitrum-rewards');
  });

  it('archives stale rewards position after 24 hours of $0 snapshots', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    adapter.isPositionClosed.mockResolvedValue(false);
    // Latest snapshot is also $0 so we fall through into the rewards branch
    mockGetLatestSnapshot.mockResolvedValue({
      ...LATEST_SNAPSHOT,
      value_usd: '0',
    });
    // 24 consecutive hourly $0 snapshots
    const baseTime = new Date('2026-05-13T00:00:00.000Z').getTime();
    mockGetSnapshotsSince.mockResolvedValue(
      Array.from({ length: 24 }, (_, i) => ({
        id: i + 1,
        position_id: REWARD_POSITION.id,
        ts: new Date(baseTime + i * 60 * 60 * 1000),
        value_usd: '0',
        net_flows_usd: '0',
        yield_delta_usd: '0',
        apy: null,
      }))
    );

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).toHaveBeenCalledWith(REWARD_POSITION.id, 'complete_exit');
    expect(mockCreateSnapshot).not.toHaveBeenCalled();
  });

  it('does not archive when one snapshot in the window is non-zero', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    adapter.isPositionClosed.mockResolvedValue(false);
    mockGetLatestSnapshot.mockResolvedValue({
      ...LATEST_SNAPSHOT,
      value_usd: '0',
    });
    const baseTime = new Date('2026-05-13T00:00:00.000Z').getTime();
    const snapshots = Array.from({ length: 24 }, (_, i) => ({
      id: i + 1,
      position_id: REWARD_POSITION.id,
      ts: new Date(baseTime + i * 60 * 60 * 1000),
      value_usd: '0',
      net_flows_usd: '0',
      yield_delta_usd: '0',
      apy: null,
    }));
    snapshots[10].value_usd = '0.01';
    mockGetSnapshotsSince.mockResolvedValue(snapshots);

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).toHaveBeenCalled();
  });

  it('does not archive when too few snapshots exist in the window', async () => {
    adapter.readCurrentValue.mockResolvedValue(0);
    adapter.isPositionClosed.mockResolvedValue(false);
    mockGetLatestSnapshot.mockResolvedValue({
      ...LATEST_SNAPSHOT,
      value_usd: '0',
    });
    // Only 3 snapshots — newly discovered position, not stale
    const baseTime = new Date('2026-05-13T00:00:00.000Z').getTime();
    mockGetSnapshotsSince.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: i + 1,
        position_id: REWARD_POSITION.id,
        ts: new Date(baseTime + i * 60 * 60 * 1000),
        value_usd: '0',
        net_flows_usd: '0',
        yield_delta_usd: '0',
        apy: null,
      }))
    );

    await updateModule.updatePosition(REWARD_POSITION);

    expect(mockArchivePosition).not.toHaveBeenCalled();
    expect(mockCreateSnapshot).toHaveBeenCalled();
  });
});
