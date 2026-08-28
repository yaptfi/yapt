import {
  getPortfolioProjectionMetadata,
  getProjectedIncomeFromMetrics,
} from '../../src/services/position-view';
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

  it('uses the sustainable rate consistently for Uniswap projection fields', () => {
    const projected = getProjectedIncomeFromMetrics(
      {
        ...baseMetrics,
        absoluteYield: {
          totalYield7d: 70,
          avgDailyYield: 10,
          projectedMonthlyYield: 60,
          projectedYearlyYield: 730,
        },
        projection: {
          model: 'uniswap-weekday-v1',
          maturity: 'developing',
          observedDays: 7,
          weekdayProfileSource: 'pool',
        },
      },
      'rewards'
    );

    expect(projected).toEqual({
      estDailyUsd: 2,
      estMonthlyUsd: 60,
      estYearlyUsd: 730,
    });
  });

  it('leaves generic reward projections based on their observed average', () => {
    const projected = getProjectedIncomeFromMetrics(
      {
        ...baseMetrics,
        absoluteYield: {
          totalYield7d: 21,
          avgDailyYield: 3,
          projectedMonthlyYield: 90,
          projectedYearlyYield: 1095,
        },
      },
      'rewards'
    );

    expect(projected.estDailyUsd).toBe(3);
  });

  it('still forces an out-of-range Uniswap forecast to zero', () => {
    const projected = getProjectedIncomeFromMetrics(
      {
        ...baseMetrics,
        shouldProjectFutureIncome: false,
        absoluteYield: {
          totalYield7d: 14,
          avgDailyYield: 2,
          projectedMonthlyYield: 45,
          projectedYearlyYield: 547.5,
        },
        projection: {
          model: 'uniswap-weekday-v1',
          maturity: 'early',
          observedDays: 1,
          weekdayProfileSource: 'pool',
        },
      },
      'rewards'
    );

    expect(projected).toEqual({ estDailyUsd: 0, estMonthlyUsd: 0, estYearlyUsd: 0 });
  });

  it('summarizes a portfolio using its least mature and weakest-source estimate', () => {
    expect(getPortfolioProjectionMetadata([
      {
        projection: {
          model: 'uniswap-weekday-v1',
          maturity: 'mature',
          observedDays: 28,
          weekdayProfileSource: 'pool',
        },
      },
      {
        projection: {
          model: 'uniswap-weekday-v1',
          maturity: 'developing',
          observedDays: 9,
          weekdayProfileSource: 'neutral',
        },
      },
    ])).toEqual({
      model: 'uniswap-weekday-v1',
      maturity: 'developing',
      observedDays: 9,
      weekdayProfileSource: 'neutral',
    });
  });
});
