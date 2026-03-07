import { queryOne } from '../utils/db';
import { Position } from '../types';
import { getPositionMetrics, PositionMetrics } from './update';
import { estimateDailyIncome, estimateMonthlyIncome, estimateYearlyIncome } from '../utils/apy';
import { getPositionCategory, PositionCategory } from '../utils/position-category';

export interface PositionLike {
  id: string;
  walletId: string;
  displayName: string;
  baseAsset: string;
  countingMode: string;
  measureMethod: string;
  metadata?: Position['metadata'];
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
    return {
      estDailyUsd: metrics.absoluteYield.avgDailyYield,
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

  const result = await queryOne<{
    total_24h: string;
    total_7d: string;
    total_30d: string;
  }>(
    `SELECT
      COALESCE(SUM(CASE WHEN ts >= $2 THEN yield_delta_usd ELSE 0 END), 0) as total_24h,
      COALESCE(SUM(CASE WHEN ts >= $3 THEN yield_delta_usd ELSE 0 END), 0) as total_7d,
      COALESCE(SUM(CASE WHEN ts >= $4 THEN yield_delta_usd ELSE 0 END), 0) as total_30d
     FROM (
       SELECT ps.ts, ps.yield_delta_usd
       FROM position_snapshot ps
       JOIN position p ON ps.position_id = p.id
       WHERE p.wallet_id = ANY($1::uuid[])
         AND p.counting_mode IN ('count', 'partial')
       UNION ALL
       SELECT psa.ts, psa.yield_delta_usd
       FROM position_snapshot_archive psa
       JOIN position_archive pa ON psa.position_id = pa.id
       WHERE pa.wallet_id = ANY($1::uuid[])
         AND pa.counting_mode IN ('count', 'partial')
     ) combined`,
    [walletIds, twentyFourHoursAgo, sevenDaysAgo, thirtyDaysAgo]
  );

  return {
    actual24hYield: result ? parseFloat(result.total_24h) : 0,
    actual7dYield: result ? parseFloat(result.total_7d) : 0,
    actual30dYield: result ? parseFloat(result.total_30d) : 0,
  };
}
