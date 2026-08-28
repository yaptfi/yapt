/**
 * Read-only historical comparison of the legacy seven-day Uniswap fee forecast
 * and uniswap-weekday-v1. Forecast inputs are cut off before each evaluation
 * day; the following day is used only to score the already-produced forecast.
 *
 * Usage: BACKTEST_DAYS=28 npx tsx scripts/backtest-uniswap-income.ts
 */
import { closePool } from '../src/utils/db';
import { getPositionCategory } from '../src/utils/position-category';
import { getUniswapRewardSnapshotHistory, UniswapRewardSnapshotRow } from '../src/models/uniswap-income';
import {
  buildDailyFeeObservations,
  calculateUniswapIncomeForecast,
  selectWeekdayProfile,
  WeekdayProfile,
} from '../src/services/uniswap-income-forecast';

const DAY_MS = 24 * 60 * 60 * 1000;
const TRAINING_DAYS = 84;
const DEFAULT_BACKTEST_DAYS = 28;
const MIN_OUTCOME_COVERAGE_DAYS = 0.75;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface ScoredForecast {
  cutoff: Date;
  positionId: string;
  weekday: number;
  oldForecast: number;
  newForecast: number;
  actual: number;
}

function parseBacktestDays(): number {
  const parsed = Number.parseInt(process.env.BACKTEST_DAYS ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BACKTEST_DAYS;
  }
  return Math.min(90, Math.max(7, parsed));
}

function utcStartOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function groupByPosition(rows: UniswapRewardSnapshotRow[]): Map<string, UniswapRewardSnapshotRow[]> {
  const grouped = new Map<string, UniswapRewardSnapshotRow[]>();
  for (const row of rows) {
    if (getPositionCategory(row.measureMethod) !== 'rewards') {
      continue;
    }
    const existing = grouped.get(row.positionId) ?? [];
    existing.push(row);
    grouped.set(row.positionId, existing);
  }
  return grouped;
}

function legacyForecast(rows: UniswapRewardSnapshotRow[], cutoff: Date): number {
  const since = cutoff.getTime() - 7 * DAY_MS;
  const recent = rows.filter((row) => row.ts.getTime() >= since && row.ts.getTime() <= cutoff.getTime());
  if (recent.length < 2) {
    return 0;
  }
  const daysCovered = (recent[recent.length - 1].ts.getTime() - recent[0].ts.getTime()) / DAY_MS;
  if (daysCovered <= 0) {
    return 0;
  }
  const totalYield = recent.reduce((sum, row) => sum + Math.max(0, row.yieldDeltaUsd), 0);
  return totalYield / daysCovered;
}

function poolCacheKey(row: UniswapRewardSnapshotRow): string {
  const pool = typeof row.metadata.poolId === 'string'
    ? row.metadata.poolId
    : typeof row.metadata.poolAddress === 'string'
      ? row.metadata.poolAddress
      : 'protocol';
  return `${row.protocolKey.toLowerCase()}|${pool.toLowerCase()}`;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index];
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

async function run(): Promise<void> {
  const backtestDays = parseBacktestDays();
  const end = utcStartOfToday();
  const firstCutoff = new Date(end.getTime() - backtestDays * DAY_MS);
  const queryFrom = new Date(firstCutoff.getTime() - TRAINING_DAYS * DAY_MS);
  const rows = await getUniswapRewardSnapshotHistory(queryFrom, end);
  const positions = groupByPosition(rows);
  const scores: ScoredForecast[] = [];

  for (let day = 0; day < backtestDays; day += 1) {
    const cutoff = new Date(firstCutoff.getTime() + day * DAY_MS);
    const outcomeEnd = new Date(cutoff.getTime() + DAY_MS);
    const trainingRows = rows.filter((row) => row.ts.getTime() <= cutoff.getTime());
    const profiles = new Map<string, WeekdayProfile>();

    for (const [positionId, positionRows] of positions) {
      const history = positionRows.filter((row) => row.ts.getTime() <= cutoff.getTime());
      if (history.length < 2) continue;
      const latest = history[history.length - 1];
      const key = poolCacheKey(latest);
      let profile = profiles.get(key);
      if (!profile) {
        profile = selectWeekdayProfile(trainingRows, latest.protocolKey, latest.metadata, cutoff);
        profiles.set(key, profile);
      }

      const forecast = calculateUniswapIncomeForecast(history, profile, cutoff);
      if (forecast.metadata.maturity === 'collecting') continue;

      const outcome = buildDailyFeeObservations(positionRows, cutoff, outcomeEnd);
      const coverage = outcome.reduce((sum, observation) => sum + observation.coverageDays, 0);
      if (coverage < MIN_OUTCOME_COVERAGE_DAYS) continue;
      const actual = outcome.reduce((sum, observation) => sum + observation.earningsUsd, 0) / coverage;
      if (actual <= 0) continue;

      scores.push({
        cutoff,
        positionId,
        weekday: cutoff.getUTCDay(),
        oldForecast: legacyForecast(history, cutoff),
        newForecast: forecast.dailyRateUsd,
        actual,
      });
    }
  }

  const changes = (field: 'oldForecast' | 'newForecast'): number[] => {
    const byPosition = new Map<string, ScoredForecast[]>();
    for (const score of scores) {
      const existing = byPosition.get(score.positionId) ?? [];
      existing.push(score);
      byPosition.set(score.positionId, existing);
    }
    const result: number[] = [];
    for (const positionScores of byPosition.values()) {
      positionScores.sort((left, right) => left.cutoff.getTime() - right.cutoff.getTime());
      for (let index = 1; index < positionScores.length; index += 1) {
        const previous = positionScores[index - 1][field];
        const current = positionScores[index][field];
        if (previous > 0) result.push(Math.abs(current - previous) / previous);
      }
    }
    return result;
  };

  const oldChanges = changes('oldForecast');
  const newChanges = changes('newForecast');
  console.log(`Backtest observations: ${scores.length} position-days across ${backtestDays} UTC cutoffs`);
  console.table([
    {
      model: 'legacy-7d',
      medianAbsoluteDailyChange: percentage(percentile(oldChanges, 0.5)),
      p95AbsoluteDailyChange: percentage(percentile(oldChanges, 0.95)),
    },
    {
      model: 'uniswap-weekday-v1',
      medianAbsoluteDailyChange: percentage(percentile(newChanges, 0.5)),
      p95AbsoluteDailyChange: percentage(percentile(newChanges, 0.95)),
    },
  ]);

  console.table(WEEKDAYS.map((weekday, weekdayIndex) => {
    const samples = scores.filter((score) => score.weekday === weekdayIndex);
    const oldBias = samples.map((score) => (score.oldForecast - score.actual) / score.actual);
    const newBias = samples.map((score) => (score.newForecast - score.actual) / score.actual);
    return {
      weekday,
      samples: samples.length,
      legacyMedianBias: percentage(percentile(oldBias, 0.5)),
      newMedianBias: percentage(percentile(newBias, 0.5)),
    };
  }));
}

run()
  .catch((error) => {
    console.error('Uniswap income backtest failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
