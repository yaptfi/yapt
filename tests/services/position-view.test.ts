import { getProjectedIncomeFromMetrics } from '../../src/services/position-view';
import { PositionMetrics } from '../../src/services/update';

describe('getProjectedIncomeFromMetrics', () => {
  const baseMetrics: PositionMetrics = {
    valueUsd: 1000,
    apy: 0.12,
    apy7d: 0.1,
    apy30d: 0.08,
    lastUpdated: new Date('2026-03-06T00:00:00.000Z'),
    shouldProjectFutureIncome: true,
  };

  it('zeros reward projections when future income is currently blocked', () => {
    const projected = getProjectedIncomeFromMetrics(
      {
        ...baseMetrics,
        shouldProjectFutureIncome: false,
        absoluteYield: {
          totalYield7d: 14,
          avgDailyYield: 2,
          projectedMonthlyYield: 60,
          projectedYearlyYield: 730,
        },
      },
      'rewards'
    );

    expect(projected).toEqual({
      estDailyUsd: 0,
      estMonthlyUsd: 0,
      estYearlyUsd: 0,
    });
  });

  it('zeros APY-based projections when future income is currently blocked', () => {
    const projected = getProjectedIncomeFromMetrics(
      {
        ...baseMetrics,
        shouldProjectFutureIncome: false,
      },
      'savings'
    );

    expect(projected).toEqual({
      estDailyUsd: 0,
      estMonthlyUsd: 0,
      estYearlyUsd: 0,
    });
  });
});
