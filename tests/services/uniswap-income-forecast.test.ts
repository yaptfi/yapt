import { UniswapRewardSnapshotRow } from '../../src/models/uniswap-income';
import {
  buildDailyFeeObservations,
  calculateUniswapIncomeForecast,
  getProjectionMaturity,
  selectWeekdayProfile,
  WeekdayProfile,
} from '../../src/services/uniswap-income-forecast';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NEUTRAL_PROFILE: WeekdayProfile = {
  factors: [1, 1, 1, 1, 1, 1, 1],
  source: 'neutral',
};

function snapshot(
  ts: string | Date,
  valueUsd: number,
  overrides: Partial<UniswapRewardSnapshotRow> = {}
): UniswapRewardSnapshotRow {
  return {
    positionId: 'position-1',
    protocolKey: 'uniswap-v4-eth-usdc-rewards',
    measureMethod: 'rewards',
    metadata: { poolId: 'pool-a' },
    ts: typeof ts === 'string' ? new Date(ts) : ts,
    valueUsd,
    yieldDeltaUsd: 0,
    ...overrides,
  };
}

function hourlyRows(options: {
  start: Date;
  days: number;
  dailyRates: number[];
  positionId?: string;
  protocolKey?: string;
  poolId?: string;
  scale?: number;
}): UniswapRewardSnapshotRow[] {
  const rows: UniswapRewardSnapshotRow[] = [];
  let balance = 0;
  const hours = options.days * 24;
  for (let hour = 0; hour <= hours; hour += 1) {
    const ts = new Date(options.start.getTime() + hour * HOUR_MS);
    rows.push(snapshot(ts, balance, {
      positionId: options.positionId ?? 'position-1',
      protocolKey: options.protocolKey ?? 'uniswap-v4-eth-usdc-rewards',
      metadata: { poolId: options.poolId ?? 'pool-a' },
    }));
    if (hour < hours) {
      const weekday = ts.getUTCDay();
      balance += options.dailyRates[weekday] * (options.scale ?? 1) / 24;
    }
  }
  return rows;
}

function hourlyRowsByElapsedDay(options: {
  start: Date;
  dailyRates: number[];
}): UniswapRewardSnapshotRow[] {
  const rows: UniswapRewardSnapshotRow[] = [];
  let balance = 0;
  const hours = options.dailyRates.length * 24;
  for (let hour = 0; hour <= hours; hour += 1) {
    const ts = new Date(options.start.getTime() + hour * HOUR_MS);
    rows.push(snapshot(ts, balance));
    if (hour < hours) {
      balance += options.dailyRates[Math.floor(hour / 24)] / 24;
    }
  }
  return rows;
}

describe('buildDailyFeeObservations', () => {
  it('splits a midnight-crossing interval across UTC days and weights both partial days', () => {
    const rows = [
      snapshot('2026-08-23T23:30:00.000Z', 10),
      snapshot('2026-08-24T00:30:00.000Z', 12),
    ];

    const observations = buildDailyFeeObservations(
      rows,
      new Date('2026-08-23T00:00:00.000Z'),
      new Date('2026-08-25T00:00:00.000Z')
    );

    expect(observations).toHaveLength(2);
    expect(observations.map((entry) => entry.earningsUsd)).toEqual([1, 1]);
    expect(observations[0].coverageDays).toBeCloseTo(1 / 48);
    expect(observations[1].coverageDays).toBeCloseTo(1 / 48);
    expect(observations.map((entry) => entry.dailyRateUsd)).toEqual([48, 48]);
  });

  it('excludes falling-balance claims and gaps longer than six hours', () => {
    const rows = [
      snapshot('2026-08-24T00:00:00.000Z', 0),
      snapshot('2026-08-24T01:00:00.000Z', 1),
      snapshot('2026-08-24T02:00:00.000Z', 0),
      snapshot('2026-08-24T09:00:00.000Z', 2),
      snapshot('2026-08-24T10:00:00.000Z', 3),
    ];

    const [observation] = buildDailyFeeObservations(
      rows,
      new Date('2026-08-24T00:00:00.000Z'),
      new Date('2026-08-25T00:00:00.000Z')
    );

    expect(observation.earningsUsd).toBe(2);
    expect(observation.coverageDays).toBeCloseTo(2 / 24);
    expect(observation.dailyRateUsd).toBeCloseTo(24);
  });

  it('excludes invalid intervals', () => {
    const rows = [
      snapshot('2026-08-24T00:00:00.000Z', 1),
      snapshot('2026-08-24T01:00:00.000Z', Number.NaN),
      snapshot('2026-08-24T02:00:00.000Z', 3),
    ];
    expect(buildDailyFeeObservations(
      rows,
      new Date('2026-08-24T00:00:00.000Z'),
      new Date('2026-08-25T00:00:00.000Z')
    )).toEqual([]);
  });
});

describe('weekday cohort profiles', () => {
  const cutoff = new Date('2026-08-30T00:00:00.000Z');
  const start = new Date(cutoff.getTime() - 28 * DAY_MS);
  const seasonalRates = [0.5, 1.5, 1, 1, 1, 1, 1];

  it('normalizes contributors so position size cannot dominate the profile', () => {
    const small = hourlyRows({ start, days: 28, dailyRates: seasonalRates, positionId: 'small' });
    const large = hourlyRows({
      start,
      days: 28,
      dailyRates: seasonalRates,
      positionId: 'large',
      scale: 100,
    });
    const equalSize = hourlyRows({
      start,
      days: 28,
      dailyRates: seasonalRates,
      positionId: 'equal-size',
    });
    const equalSizeProfile = selectWeekdayProfile(
      [...small, ...equalSize],
      small[0].protocolKey,
      small[0].metadata,
      cutoff
    );
    const combinedProfile = selectWeekdayProfile([...small, ...large], small[0].protocolKey, small[0].metadata, cutoff);

    expect(equalSizeProfile.source).toBe('pool');
    expect(combinedProfile.source).toBe('pool');
    combinedProfile.factors.forEach((factor, weekday) => {
      expect(factor).toBeCloseTo(equalSizeProfile.factors[weekday], 10);
    });
    expect(combinedProfile.factors[1]).toBeGreaterThan(combinedProfile.factors[0]);
    expect(combinedProfile.factors.reduce((sum, factor) => sum + factor, 0) / 7).toBeCloseTo(1, 10);
  });

  it('falls back from pool to all Uniswap cohorts, then to neutral factors', () => {
    const otherPool = hourlyRows({
      start,
      days: 28,
      dailyRates: seasonalRates,
      positionId: 'other',
      protocolKey: 'uniswap-v3-weth-usdc-rewards',
      poolId: 'pool-b',
    });
    const fallback = selectWeekdayProfile(
      otherPool,
      'uniswap-v4-eth-usdc-rewards',
      { poolId: 'pool-a' },
      cutoff
    );
    expect(fallback.source).toBe('uniswap');

    const insufficient = selectWeekdayProfile(
      otherPool.slice(0, 24),
      'uniswap-v4-eth-usdc-rewards',
      { poolId: 'pool-a' },
      cutoff
    );
    expect(insufficient).toEqual(NEUTRAL_PROFILE);
  });
});

describe('Uniswap sustainable forecast', () => {
  it('produces an immediate early estimate from the first valid hourly delta', () => {
    const cutoff = new Date('2026-08-24T01:00:00.000Z');
    const rows = [
      snapshot('2026-08-24T00:00:00.000Z', 10),
      snapshot(cutoff, 11),
    ];
    const forecast = calculateUniswapIncomeForecast(rows, NEUTRAL_PROFILE, cutoff);

    expect(forecast.dailyRateUsd).toBeCloseTo(24);
    expect(forecast.metadata.maturity).toBe('early');
    expect(forecast.metadata.observedDays).toBeCloseTo(1 / 24);
  });

  it('adjusts a partial week for weekdays without changing a complete seasonal week', () => {
    const profile: WeekdayProfile = {
      factors: [0.5, 1.5, 1, 1, 1, 1, 1],
      source: 'pool',
    };
    const mondayCutoff = new Date('2026-08-24T01:00:00.000Z');
    const mondayRows = [
      snapshot('2026-08-24T00:00:00.000Z', 0),
      snapshot(mondayCutoff, 1.5 / 24),
    ];
    expect(calculateUniswapIncomeForecast(mondayRows, profile, mondayCutoff).dailyRateUsd).toBeCloseTo(1);
    expect(calculateUniswapIncomeForecast(mondayRows, NEUTRAL_PROFILE, mondayCutoff).dailyRateUsd).toBeCloseTo(1.5);

    const weekStart = new Date('2026-08-23T00:00:00.000Z');
    const weekRows = hourlyRows({ start: weekStart, days: 7, dailyRates: profile.factors });
    const weekly = calculateUniswapIncomeForecast(
      weekRows,
      profile,
      new Date(weekStart.getTime() + 7 * DAY_MS)
    );
    expect(weekly.dailyRateUsd).toBeCloseTo(1, 10);
  });

  it('returns the expected-average rate for flat and changing regimes', () => {
    const cutoff = new Date('2026-08-29T00:00:00.000Z');
    const start = new Date('2026-08-01T00:00:00.000Z');
    const flat = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({ start, dailyRates: Array(28).fill(100) }),
      NEUTRAL_PROFILE,
      cutoff
    );
    const falling = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({
        start,
        dailyRates: [...Array(21).fill(100), ...Array(7).fill(0)],
      }),
      NEUTRAL_PROFILE,
      cutoff
    );
    const rising = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({
        start,
        dailyRates: [...Array(21).fill(100), ...Array(7).fill(200)],
      }),
      NEUTRAL_PROFILE,
      cutoff
    );
    const alternating = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({
        start,
        dailyRates: Array.from({ length: 28 }, (_, day) => [50, 100, 150, 200][day % 4]),
      }),
      NEUTRAL_PROFILE,
      cutoff
    );

    expect(flat.dailyRateUsd).toBeCloseTo(100, 6);
    expect(falling.dailyRateUsd).toBeCloseTo(60.9475708249, 6);
    expect(rising.dailyRateUsd).toBeCloseTo(139.0524291751, 6);
    expect(alternating.dailyRateUsd).toBeCloseTo(128.0922599024, 6);
  });

  it('keeps observed zero-income history distinct from missing history', () => {
    const cutoff = new Date('2026-08-29T00:00:00.000Z');
    const start = new Date('2026-08-01T00:00:00.000Z');
    const observedZero = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({ start, dailyRates: Array(28).fill(0) }),
      NEUTRAL_PROFILE,
      cutoff
    );
    const noHistory = calculateUniswapIncomeForecast([], NEUTRAL_PROFILE, cutoff);

    expect(observedZero.dailyRateUsd).toBe(0);
    expect(observedZero.metadata.maturity).toBe('mature');
    expect(noHistory.dailyRateUsd).toBe(0);
    expect(noHistory.metadata.maturity).toBe('collecting');
  });

  it('includes a valid isolated high-fee day in the weighted mean', () => {
    const cutoff = new Date('2026-08-29T00:00:00.000Z');
    const start = new Date('2026-08-01T00:00:00.000Z');
    const dailyRates = Array(28).fill(100);
    dailyRates[27] = 1000;
    const forecast = calculateUniswapIncomeForecast(
      hourlyRowsByElapsedDay({ start, dailyRates }),
      NEUTRAL_PROFILE,
      cutoff
    );
    const weights = dailyRates.map((_, day) => Math.pow(0.5, (27.5 - day) / 14));
    const expected = dailyRates.reduce(
      (sum, rate, day) => sum + rate * weights[day],
      0
    ) / weights.reduce((sum, weight) => sum + weight, 0);

    expect(forecast.dailyRateUsd).toBeCloseTo(expected, 6);
    expect(forecast.dailyRateUsd).toBeGreaterThan(100);
  });

  it('transitions through collecting, early, developing, and mature states', () => {
    const cutoff = new Date('2026-08-30T00:00:00.000Z');
    expect(getProjectionMaturity([])).toBe('collecting');

    const earlyRows = [snapshot(new Date(cutoff.getTime() - HOUR_MS), 0), snapshot(cutoff, 1)];
    const earlyObs = buildDailyFeeObservations(
      earlyRows,
      new Date(cutoff.getTime() - 28 * DAY_MS),
      cutoff
    );
    expect(getProjectionMaturity(earlyObs)).toBe('early');

    const developingRows = hourlyRows({
      start: new Date(cutoff.getTime() - 2 * DAY_MS),
      days: 2,
      dailyRates: [1, 1, 1, 1, 1, 1, 1],
    });
    const developingObs = buildDailyFeeObservations(
      developingRows,
      new Date(cutoff.getTime() - 28 * DAY_MS),
      cutoff
    );
    expect(getProjectionMaturity(developingObs)).toBe('developing');

    const matureRows = hourlyRows({
      start: new Date(cutoff.getTime() - 28 * DAY_MS),
      days: 28,
      dailyRates: [1, 1, 1, 1, 1, 1, 1],
    });
    const matureObs = buildDailyFeeObservations(
      matureRows,
      new Date(cutoff.getTime() - 28 * DAY_MS),
      cutoff
    );
    expect(getProjectionMaturity(matureObs)).toBe('mature');
  });
});
