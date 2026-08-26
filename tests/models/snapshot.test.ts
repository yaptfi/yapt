jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { queryOne } from '../../src/utils/db';
import { getTotalYieldSince } from '../../src/models/snapshot';

describe('getTotalYieldSince', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('can exclude negative claim deltas from reward earnings', async () => {
    const since = new Date('2026-08-19T00:00:00.000Z');
    (queryOne as jest.Mock).mockResolvedValue({
      total_yield: '12.5',
      first_ts: new Date('2026-08-19T00:00:00.000Z'),
      last_ts: new Date('2026-08-26T00:00:00.000Z'),
    });

    await expect(getTotalYieldSince('position-1', since, { positiveOnly: true })).resolves.toEqual({
      totalYieldUsd: 12.5,
      daysCovered: 7,
    });

    const [sql, params] = (queryOne as jest.Mock).mock.calls[0];
    expect(sql).toContain('SUM(GREATEST(yield_delta_usd, 0))');
    expect(params).toEqual(['position-1', since]);
  });

  it('can exclude near-zero post-claim snapshots from the projection window', async () => {
    const since = new Date('2026-08-19T00:00:00.000Z');
    (queryOne as jest.Mock).mockResolvedValue(null);

    await expect(getTotalYieldSince('position-1', since, {
      positiveOnly: true,
      minimumValueUsd: 1,
    })).resolves.toEqual({
      totalYieldUsd: 0,
      daysCovered: 0,
    });

    const [sql, params] = (queryOne as jest.Mock).mock.calls[0];
    expect(sql).toContain('value_usd >= $3');
    expect(params).toEqual(['position-1', since, '1']);
  });
});
