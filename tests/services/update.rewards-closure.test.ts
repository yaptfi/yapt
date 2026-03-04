import { Position, PositionSnapshot } from '../../src/types';

const mockGetAdapter = jest.fn();
const mockGetLatestSnapshot = jest.fn();
const mockCreateSnapshot = jest.fn();
const mockGetSnapshotNearTime = jest.fn();
const mockGetMostRecentResetSnapshot = jest.fn();
const mockGetTotalYieldSince = jest.fn();
const mockArchivePosition = jest.fn();

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
});
