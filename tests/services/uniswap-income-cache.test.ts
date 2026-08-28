import { Position } from '../../src/types';

const mockGetUniswapRewardSnapshotHistory = jest.fn();
const mockGetPositionUniswapFeeSnapshotHistory = jest.fn();

jest.mock('../../src/models/uniswap-income', () => ({
  getUniswapRewardSnapshotHistory: mockGetUniswapRewardSnapshotHistory,
  getPositionUniswapFeeSnapshotHistory: mockGetPositionUniswapFeeSnapshotHistory,
}));

import {
  clearUniswapIncomeForecastCache,
  getUniswapIncomeForecast,
} from '../../src/services/uniswap-income-forecast';

const position: Position = {
  id: 'position-1',
  walletId: 'wallet-1',
  protocolId: 'protocol-1',
  protocolPositionKey: 'pm:1',
  displayName: 'Uniswap test',
  baseAsset: 'USDC',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: { poolId: 'pool-a' },
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('Uniswap weekday profile cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearUniswapIncomeForecastCache();
    mockGetUniswapRewardSnapshotHistory.mockResolvedValue([
      {
        positionId: position.id,
        protocolKey: 'uniswap-v4-eth-usdc-rewards',
        measureMethod: 'rewards',
        metadata: position.metadata,
        ts: new Date('2026-08-28T00:00:00.000Z'),
        valueUsd: 0,
        yieldDeltaUsd: 0,
      },
      {
        positionId: position.id,
        protocolKey: 'uniswap-v4-eth-usdc-rewards',
        measureMethod: 'rewards',
        metadata: position.metadata,
        ts: new Date('2026-08-28T01:00:00.000Z'),
        valueUsd: 1,
        yieldDeltaUsd: 1,
      },
    ]);
    mockGetPositionUniswapFeeSnapshotHistory.mockResolvedValue([
      { ts: new Date('2026-08-28T00:00:00.000Z'), valueUsd: 0 },
      { ts: new Date('2026-08-28T01:00:00.000Z'), valueUsd: 1 },
    ]);
  });

  it('coalesces concurrent history/profile calculations and keeps them for an hour', async () => {
    const cutoff = new Date('2026-08-28T01:00:00.000Z');
    const [first, second] = await Promise.all([
      getUniswapIncomeForecast(position, 'uniswap-v4-eth-usdc-rewards', cutoff),
      getUniswapIncomeForecast(position, 'uniswap-v4-eth-usdc-rewards', cutoff),
    ]);
    const third = await getUniswapIncomeForecast(position, 'uniswap-v4-eth-usdc-rewards', cutoff);

    expect(mockGetUniswapRewardSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(mockGetPositionUniswapFeeSnapshotHistory).toHaveBeenCalledTimes(1);
    expect(first.dailyRateUsd).toBe(24);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
