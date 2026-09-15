/**
 * Read-only, ungated historical fee-run-rate evaluation comparing the legacy
 * seven-day forecast with uniswap-weekday-v2. Forecast inputs are restricted
 * to each UTC cutoff; later rows are used only to score settled outcomes.
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
const HORIZONS = [1, 7, 30] as const;
const COMPLETE_EPSILON_DAYS = 1e-9;
const PARTIAL_COVERAGE_FRACTION = 0.75;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type HorizonDays = typeof HORIZONS[number];
type CoverageGroup = 'complete' | 'partial';
type ModelField = 'oldForecast' | 'newForecast';

interface ScoredForecast {
  cutoff: Date;
  positionId: string;
  weekday: number;
  horizonDays: HorizonDays;
  coverageDays: number;
  coverageGroup: CoverageGroup;
  oldForecast: number;
  newForecast: number;
  actual: number;
}

interface ExclusionCounts {
  pendingOutcome: number;
  collecting: number;
  insufficientCoverage: number;
}

interface ScoreSummary {
  samples: number;
  zeroOutcomeSamples: number;
  meanErrorUsd: number | null;
  maeUsd: number | null;
  totalForecastUsd: number | null;
  totalTargetUsd: number | null;
  wape: number | null;
  overpredictionFraction: number | null;
  meanCoverageFraction: number | null;
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
  for (const positionRows of grouped.values()) {
    positionRows.sort((left, right) => left.ts.getTime() - right.ts.getTime());
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

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(quantile * sorted.length)));
  return sorted[index];
}

function summarizeScores(scores: ScoredForecast[], field: ModelField): ScoreSummary {
  if (scores.length === 0) {
    return {
      samples: 0,
      zeroOutcomeSamples: 0,
      meanErrorUsd: null,
      maeUsd: null,
      totalForecastUsd: null,
      totalTargetUsd: null,
      wape: null,
      overpredictionFraction: null,
      meanCoverageFraction: null,
    };
  }

  let totalForecast = 0;
  let totalTarget = 0;
  let totalError = 0;
  let totalAbsoluteError = 0;
  let overpredictions = 0;
  let zeroOutcomes = 0;
  let totalCoverageFraction = 0;
  for (const score of scores) {
    const forecast = score[field];
    const error = forecast - score.actual;
    totalForecast += forecast;
    totalTarget += score.actual;
    totalError += error;
    totalAbsoluteError += Math.abs(error);
    overpredictions += forecast > score.actual ? 1 : 0;
    zeroOutcomes += score.actual === 0 ? 1 : 0;
    totalCoverageFraction += score.coverageDays / score.horizonDays;
  }

  return {
    samples: scores.length,
    zeroOutcomeSamples: zeroOutcomes,
    meanErrorUsd: totalError / scores.length,
    maeUsd: totalAbsoluteError / scores.length,
    totalForecastUsd: totalForecast,
    totalTargetUsd: totalTarget,
    wape: totalTarget === 0 ? null : totalAbsoluteError / totalTarget,
    overpredictionFraction: overpredictions / scores.length,
    meanCoverageFraction: totalCoverageFraction / scores.length,
  };
}

function displaySummary(summary: ScoreSummary): Record<string, number | string> {
  return {
    samples: summary.samples,
    zeroOutcomeSamples: summary.zeroOutcomeSamples,
    meanErrorUsd: summary.meanErrorUsd ?? 'N/A',
    maeUsd: summary.maeUsd ?? 'N/A',
    totalForecastUsd: summary.totalForecastUsd ?? 'N/A',
    totalTargetUsd: summary.totalTargetUsd ?? 'N/A',
    wape: summary.wape ?? 'N/A',
    overpredictionFraction: summary.overpredictionFraction ?? 'N/A',
    meanCoverageFraction: summary.meanCoverageFraction ?? 'N/A',
  };
}

async function run(): Promise<void> {
  const backtestDays = parseBacktestDays();
  const end = utcStartOfToday();
  const firstCutoff = new Date(end.getTime() - backtestDays * DAY_MS);
  const queryFrom = new Date(firstCutoff.getTime() - TRAINING_DAYS * DAY_MS);
  const rows = await getUniswapRewardSnapshotHistory(queryFrom, end);
  const positions = groupByPosition(rows);
  const scores: ScoredForecast[] = [];
  const exclusions: Record<HorizonDays, ExclusionCounts> = {
    1: { pendingOutcome: 0, collecting: 0, insufficientCoverage: 0 },
    7: { pendingOutcome: 0, collecting: 0, insufficientCoverage: 0 },
    30: { pendingOutcome: 0, collecting: 0, insufficientCoverage: 0 },
  };
  const loadedHistoryEndMs = rows.reduce(
    (latest, row) => Math.max(latest, row.ts.getTime()),
    Number.NEGATIVE_INFINITY
  );

  for (let day = 0; day < backtestDays; day += 1) {
    const cutoff = new Date(firstCutoff.getTime() + day * DAY_MS);
    const trainingRows = rows.filter((row) => row.ts.getTime() <= cutoff.getTime());
    const profiles = new Map<string, WeekdayProfile>();
    for (const [positionId, positionRows] of positions) {
      const history = positionRows.filter((row) => row.ts.getTime() <= cutoff.getTime());
      let oldDailyForecast = 0;
      let newDailyForecast = 0;
      let collecting = history.length < 2;

      if (!collecting) {
        const latest = history[history.length - 1];
        const key = poolCacheKey(latest);
        let profile = profiles.get(key);
        if (!profile) {
          profile = selectWeekdayProfile(trainingRows, latest.protocolKey, latest.metadata, cutoff);
          profiles.set(key, profile);
        }
        const forecast = calculateUniswapIncomeForecast(history, profile, cutoff);
        collecting = forecast.metadata.maturity === 'collecting';
        oldDailyForecast = legacyForecast(history, cutoff);
        newDailyForecast = forecast.dailyRateUsd;
      }

      for (const horizonDays of HORIZONS) {
        const exclusion = exclusions[horizonDays];
        const outcomeEnd = new Date(cutoff.getTime() + horizonDays * DAY_MS);
        if (outcomeEnd.getTime() > loadedHistoryEndMs) {
          exclusion.pendingOutcome += 1;
          continue;
        }
        if (collecting) {
          exclusion.collecting += 1;
          continue;
        }

        const outcome = buildDailyFeeObservations(positionRows, cutoff, outcomeEnd);
        const coverageDays = outcome.reduce(
          (sum, observation) => sum + observation.coverageDays,
          0
        );
        const earningsUsd = outcome.reduce(
          (sum, observation) => sum + observation.earningsUsd,
          0
        );
        let coverageGroup: CoverageGroup;
        let actual: number;
        if (coverageDays >= horizonDays - COMPLETE_EPSILON_DAYS) {
          coverageGroup = 'complete';
          actual = earningsUsd;
        } else if (coverageDays >= PARTIAL_COVERAGE_FRACTION * horizonDays) {
          coverageGroup = 'partial';
          actual = earningsUsd / coverageDays * horizonDays;
        } else {
          exclusion.insufficientCoverage += 1;
          continue;
        }

        scores.push({
          cutoff,
          positionId,
          weekday: cutoff.getUTCDay(),
          horizonDays,
          coverageDays,
          coverageGroup,
          oldForecast: oldDailyForecast * horizonDays,
          newForecast: newDailyForecast * horizonDays,
          actual,
        });
      }
    }
  }

  console.log('Ungated historical fee-run-rate evaluation; sums are overlapping evaluation cases, not earned portfolio totals.');
  console.log(`Loaded ${rows.length} snapshots for ${positions.size} positions across ${backtestDays} UTC cutoffs.`);
  console.log('Complete outcomes (primary target: observed calendar-horizon earnings)');
  console.table(HORIZONS.flatMap((horizonDays) => (
    (['oldForecast', 'newForecast'] as const).map((field) => {
      const modelScores = scores.filter(
        (score) => score.horizonDays === horizonDays && score.coverageGroup === 'complete'
      );
      return {
        model: field === 'oldForecast' ? 'legacy-7d' : 'uniswap-weekday-v2',
        horizonDays,
        coverageGroup: 'complete',
        ...displaySummary(summarizeScores(modelScores, field)),
      };
    })
  )));

  console.log('Partial outcomes (secondary target: coverage-adjusted equivalent)');
  console.table(HORIZONS.flatMap((horizonDays) => (
    (['oldForecast', 'newForecast'] as const).map((field) => {
      const modelScores = scores.filter(
        (score) => score.horizonDays === horizonDays && score.coverageGroup === 'partial'
      );
      return {
        model: field === 'oldForecast' ? 'legacy-7d' : 'uniswap-weekday-v2',
        horizonDays,
        coverageGroup: 'partial',
        ...displaySummary(summarizeScores(modelScores, field)),
      };
    })
  )));

  console.log('Exclusions by horizon');
  console.table(HORIZONS.map((horizonDays) => ({
    horizonDays,
    ...exclusions[horizonDays],
  })));

  const oneDayScores = scores.filter((score) => score.horizonDays === 1);
  const changes = (field: ModelField): { values: number[]; zeroPriorExcluded: number } => {
    const byPosition = new Map<string, ScoredForecast[]>();
    for (const score of oneDayScores) {
      const existing = byPosition.get(score.positionId) ?? [];
      existing.push(score);
      byPosition.set(score.positionId, existing);
    }
    const values: number[] = [];
    let zeroPriorExcluded = 0;
    for (const positionScores of byPosition.values()) {
      positionScores.sort((left, right) => left.cutoff.getTime() - right.cutoff.getTime());
      for (let index = 1; index < positionScores.length; index += 1) {
        const previousScore = positionScores[index - 1];
        const currentScore = positionScores[index];
        if (currentScore.cutoff.getTime() - previousScore.cutoff.getTime() !== DAY_MS) {
          continue;
        }
        const previous = previousScore[field];
        if (previous === 0) {
          zeroPriorExcluded += 1;
          continue;
        }
        values.push(Math.abs(currentScore[field] - previous) / Math.abs(previous));
      }
    }
    return { values, zeroPriorExcluded };
  };

  console.log('Adjacent one-day forecast movement diagnostic');
  console.table((['oldForecast', 'newForecast'] as const).map((field) => {
    const result = changes(field);
    const median = percentile(result.values, 0.5);
    const p95 = percentile(result.values, 0.95);
    return {
      model: field === 'oldForecast' ? 'legacy-7d' : 'uniswap-weekday-v2',
      samples: result.values.length,
      zeroPriorExcluded: result.zeroPriorExcluded,
      medianAbsoluteDailyChange: median === null ? 'N/A' : `${(median * 100).toFixed(1)}%`,
      p95AbsoluteDailyChange: p95 === null ? 'N/A' : `${(p95 * 100).toFixed(1)}%`,
    };
  }));

  console.log('Complete-outcome weekday error breakdown');
  console.table(HORIZONS.flatMap((horizonDays) => WEEKDAYS.flatMap((weekday, weekdayIndex) => (
    (['oldForecast', 'newForecast'] as const).map((field) => {
      const weekdayScores = scores.filter((score) => (
        score.coverageGroup === 'complete'
        && score.horizonDays === horizonDays
        && score.weekday === weekdayIndex
      ));
      const summary = summarizeScores(weekdayScores, field);
      return {
        model: field === 'oldForecast' ? 'legacy-7d' : 'uniswap-weekday-v2',
        horizonDays,
        weekday,
        samples: summary.samples,
        meanErrorUsd: summary.meanErrorUsd ?? 'N/A',
        maeUsd: summary.maeUsd ?? 'N/A',
      };
    })
  ))));
}

run()
  .catch((error) => {
    console.error('Uniswap income backtest failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
