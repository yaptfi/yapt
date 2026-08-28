import { query } from '../utils/db';
import { Position } from '../types';
import { getPositionMetrics, PositionMetrics } from './update';
import { estimateDailyIncome, estimateMonthlyIncome, estimateYearlyIncome } from '../utils/apy';
import { getPositionCategory, PositionCategory } from '../utils/position-category';
import { ProjectionMaturity, UniswapProjectionMetadata } from './uniswap-income-forecast';

export interface PositionLike {
  id: string;
  walletId: string;
  displayName: string;
  baseAsset: string;
  countingMode: string;
  measureMethod: string;
  metadata?: Position['metadata'];
  protocolKey?: string;
  protocol_key?: string;
}

export interface EnrichedPositionView {
  id: string;
  walletId: string;
  displayName: string;
  baseAsset: string;
  countingMode: string;
  measureMethod: string;
  positionType: PositionCategory;
  valueUsd: number;
  apy?: number | null;
  apy7d?: number | null;
  apy30d?: number | null;
  estDailyUsd: number;
  estMonthlyUsd: number;
  estYearlyUsd: number;
  lastUpdated: Date | null;
  absoluteYield?: {
    totalYield7d: number;
    avgDailyYield: number;
    projectedMonthlyYield: number;
    projectedYearlyYield: number;
  };
  projection?: UniswapProjectionMetadata;
}

export interface ActualYieldSummary {
  actual24hYield: number;
  actual7dYield: number;
  actual30dYield: number;
}

const SLOW_ENRICH_POSITIONS_MS = 750;

export function getProjectedIncomeFromMetrics(
  metrics: PositionMetrics,
  category: PositionCategory
): { estDailyUsd: number; estMonthlyUsd: number; estYearlyUsd: number } {
  if (metrics.shouldProjectFutureIncome === false) {
    return {
      estDailyUsd: 0,
      estMonthlyUsd: 0,
      estYearlyUsd: 0,
    };
  }

  if (category === 'rewards' && metrics.absoluteYield) {
    const projectedDailyYield = metrics.projection
      ? metrics.absoluteYield.projectedMonthlyYield / 30
      : metrics.absoluteYield.avgDailyYield;
    return {
      estDailyUsd: projectedDailyYield,
      estMonthlyUsd: metrics.absoluteYield.projectedMonthlyYield,
      estYearlyUsd: metrics.absoluteYield.projectedYearlyYield,
    };
  }

  const currentApy = metrics.apy7d || metrics.apy || 0;
  return {
    estDailyUsd: estimateDailyIncome(metrics.valueUsd, currentApy),
    estMonthlyUsd: estimateMonthlyIncome(metrics.valueUsd, currentApy),
    estYearlyUsd: estimateYearlyIncome(metrics.valueUsd, currentApy),
  };
}

/**
 * Enrich positions with APY/absolute-yield metrics and income projections.
 * Shared by authenticated and guest position endpoints.
 */
export async function enrichPositionsWithMetrics(
  positions: PositionLike[]
): Promise<EnrichedPositionView[]> {
  const enrichStart = Date.now();
  const result = await Promise.all(
    positions.map(async (position): Promise<EnrichedPositionView> => {
      const metrics = await getPositionMetrics(position.id, position as unknown as Position);

      const category = getPositionCategory(position.measureMethod);
      const isRewardBased = category === 'rewards';

      if (!metrics) {
        return {
          id: position.id,
          walletId: position.walletId,
          displayName: position.displayName,
          baseAsset: position.baseAsset,
          countingMode: position.countingMode,
          measureMethod: position.measureMethod,
          positionType: category,
          valueUsd: 0,
          apy: null,
          apy7d: null,
          apy30d: null,
          estDailyUsd: 0,
          estMonthlyUsd: 0,
          estYearlyUsd: 0,
          lastUpdated: null,
        };
      }
      const { estDailyUsd, estMonthlyUsd, estYearlyUsd } = getProjectedIncomeFromMetrics(metrics, category);

      return {
        id: position.id,
        walletId: position.walletId,
        displayName: position.displayName,
        baseAsset: position.baseAsset,
        countingMode: position.countingMode,
        measureMethod: position.measureMethod,
        positionType: category,
        valueUsd: metrics.valueUsd,
        ...(!isRewardBased && {
          apy: metrics.apy,
          apy7d: metrics.apy7d,
          apy30d: metrics.apy30d,
        }),
        estDailyUsd,
        estMonthlyUsd,
        estYearlyUsd,
        lastUpdated: metrics.lastUpdated,
        ...(metrics.absoluteYield && { absoluteYield: metrics.absoluteYield }),
        ...(metrics.projection && { projection: metrics.projection }),
      };
    })
  );

  const enrichDurationMs = Date.now() - enrichStart;
  if (enrichDurationMs >= SLOW_ENRICH_POSITIONS_MS) {
    console.warn(
      `[positions] Slow enrichPositionsWithMetrics for ${positions.length} position(s): ${enrichDurationMs}ms`
    );
  }

  return result;
}

const MATURITY_PRIORITY: Record<ProjectionMaturity, number> = {
  collecting: 0,
  early: 1,
  developing: 2,
  mature: 3,
};

/** Describe the least mature Uniswap estimate included in a portfolio total. */
export function getPortfolioProjectionMetadata(
  positions: Array<{ projection?: UniswapProjectionMetadata }>
): UniswapProjectionMetadata | undefined {
  const projections = positions
    .map((position) => position.projection)
    .filter((projection): projection is UniswapProjectionMetadata => projection !== undefined);
  if (projections.length === 0) {
    return undefined;
  }

  const leastMature = projections.reduce((current, projection) =>
    MATURITY_PRIORITY[projection.maturity] < MATURITY_PRIORITY[current.maturity]
      ? projection
      : current
  );
  const source = projections.some((projection) => projection.weekdayProfileSource === 'neutral')
    ? 'neutral'
    : projections.some((projection) => projection.weekdayProfileSource === 'uniswap')
      ? 'uniswap'
      : 'pool';

  return {
    model: 'uniswap-weekday-v1',
    maturity: leastMature.maturity,
    observedDays: Math.min(...projections.map((projection) => projection.observedDays)),
    weekdayProfileSource: source,
  };
}

/**
 * Aggregate actual yield deltas for 24h/7d/30d windows across active + archived positions.
 */
export async function getActualYieldSummaryForWallets(walletIds: string[]): Promise<ActualYieldSummary> {
  if (walletIds.length === 0) {
    return {
      actual24hYield: 0,
      actual7dYield: 0,
      actual30dYield: 0,
    };
  }

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const results = await query<{
    measure_method: string;
    total_24h: string;
    total_7d: string;
    total_30d: string;
    positive_total_24h: string;
    positive_total_7d: string;
    positive_total_30d: string;
  }>(
    `SELECT measure_method,
      COALESCE(SUM(CASE WHEN ts >= $2 THEN yield_delta_usd ELSE 0 END), 0) as total_24h,
      COALESCE(SUM(CASE WHEN ts >= $3 THEN yield_delta_usd ELSE 0 END), 0) as total_7d,
      COALESCE(SUM(CASE WHEN ts >= $4 THEN yield_delta_usd ELSE 0 END), 0) as total_30d,
      COALESCE(SUM(CASE WHEN ts >= $2 THEN GREATEST(yield_delta_usd, 0) ELSE 0 END), 0) as positive_total_24h,
      COALESCE(SUM(CASE WHEN ts >= $3 THEN GREATEST(yield_delta_usd, 0) ELSE 0 END), 0) as positive_total_7d,
      COALESCE(SUM(CASE WHEN ts >= $4 THEN GREATEST(yield_delta_usd, 0) ELSE 0 END), 0) as positive_total_30d
     FROM (
       SELECT ps.ts, ps.yield_delta_usd, p.measure_method
       FROM position_snapshot ps
       JOIN position p ON ps.position_id = p.id
       WHERE p.wallet_id = ANY($1::uuid[])
         AND p.counting_mode IN ('count', 'partial')
       UNION ALL
       SELECT psa.ts, psa.yield_delta_usd, pa.measure_method
       FROM position_snapshot_archive psa
       JOIN position_archive pa ON psa.position_id = pa.id
       WHERE pa.wallet_id = ANY($1::uuid[])
         AND pa.counting_mode IN ('count', 'partial')
     ) combined
     GROUP BY measure_method`,
    [walletIds, twentyFourHoursAgo, sevenDaysAgo, thirtyDaysAgo]
  );

  return results.reduce<ActualYieldSummary>((summary, result) => {
    const usePositiveTotals = getPositionCategory(result.measure_method) === 'rewards';
    summary.actual24hYield += parseFloat(usePositiveTotals ? result.positive_total_24h : result.total_24h);
    summary.actual7dYield += parseFloat(usePositiveTotals ? result.positive_total_7d : result.total_7d);
    summary.actual30dYield += parseFloat(usePositiveTotals ? result.positive_total_30d : result.total_30d);
    return summary;
  }, {
    actual24hYield: 0,
    actual7dYield: 0,
    actual30dYield: 0,
  });
}
