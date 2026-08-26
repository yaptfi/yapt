jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query } from '../../src/utils/db';
import { getActualYieldSummaryForWallets } from '../../src/services/position-view';

describe('getActualYieldSummaryForWallets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('excludes reward claims but preserves negative deltas for non-reward positions', async () => {
    (query as jest.Mock).mockResolvedValue([
      {
        measure_method: 'rewards',
        total_24h: '-95',
        total_7d: '-90',
        total_30d: '-80',
        positive_total_24h: '5',
        positive_total_7d: '10',
        positive_total_30d: '20',
      },
      {
        measure_method: 'balance',
        total_24h: '-1',
        total_7d: '2',
        total_30d: '3',
        positive_total_24h: '0',
        positive_total_7d: '3',
        positive_total_30d: '4',
      },
    ]);

    await expect(getActualYieldSummaryForWallets(['wallet-1'])).resolves.toEqual({
      actual24hYield: 4,
      actual7dYield: 12,
      actual30dYield: 23,
    });

    const sql = (query as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('GREATEST(yield_delta_usd, 0)');
    expect(sql).toContain('GROUP BY measure_method');
  });
});
