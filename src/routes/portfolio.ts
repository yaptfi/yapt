import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getActivePositionsByWallets } from '../models/position';
import { getUserWallets } from '../models/user-wallet';
import { getPositionMetrics } from '../services/update';
import { estimateDailyIncome, estimateMonthlyIncome, estimateYearlyIncome } from '../utils/apy';
import { query } from '../utils/db';
import { requireAuth } from '../middleware/auth';

export default async function portfolioRoutes(server: FastifyInstance) {
  /**
   * GET /api/portfolio/summary
   * Get current portfolio summary with projections for user's wallets
   */
  server.get('/summary', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    try {
      // Get user's wallet IDs
      const userWallets = await getUserWallets(request.user.id);
      const userWalletIds = userWallets.map((w) => w.id);

      // Get active positions filtered by user's wallets at DB level
      const positions = await getActivePositionsByWallets(userWalletIds);

      let totalValueUsd = 0;
      let totalEstDailyUsd = 0;
      let totalEstMonthlyUsd = 0;
      let totalEstYearlyUsd = 0;
      let mostRecentUpdate: Date | null = null;

      const positionsWithMetrics = await Promise.all(
        positions
          .filter((p) => p.countingMode === 'count' || p.countingMode === 'partial') // Include count and partial
          .map(async (pos) => {
            const metrics = await getPositionMetrics(pos.id, pos);

            if (!metrics) {
              return null;
            }

            // Track most recent update across all positions
            if (metrics.lastUpdated) {
              const updateTime = metrics.lastUpdated instanceof Date
                ? metrics.lastUpdated
                : new Date(metrics.lastUpdated);
              if (!mostRecentUpdate || updateTime > mostRecentUpdate) {
                mostRecentUpdate = updateTime;
              }
            }

            // For reward-based positions, use absolute yield metrics
            // For APY-based positions, use percentage-based income projections
            const isRewardBased = pos.measureMethod === 'rewards';
            let estDaily, estMonthly, estYearly;

            if (isRewardBased && metrics.absoluteYield) {
              // Use actual yield data
              estDaily = metrics.absoluteYield.avgDailyYield;
              estMonthly = metrics.absoluteYield.projectedMonthlyYield;
              estYearly = metrics.absoluteYield.projectedYearlyYield;
            } else {
              // Use APY-based calculation
              const currentApy = metrics.apy7d || metrics.apy || 0;
              estDaily = estimateDailyIncome(metrics.valueUsd, currentApy);
              estMonthly = estimateMonthlyIncome(metrics.valueUsd, currentApy);
              estYearly = estimateYearlyIncome(metrics.valueUsd, currentApy);
            }

            // Include position value in total
            // For 'count' mode: valueUsd = principal + accrued interest
            // For 'partial' mode (reward positions): valueUsd = claimable rewards only
            totalValueUsd += metrics.valueUsd;

            // Always include income projections
            totalEstDailyUsd += estDaily;
            totalEstMonthlyUsd += estMonthly;
            totalEstYearlyUsd += estYearly;

            return {
              id: pos.id,
              displayName: pos.displayName,
              measureMethod: pos.measureMethod,
              valueUsd: metrics.valueUsd,
              // Don't show APY for reward-based positions (volatile principal)
              ...(!isRewardBased && {
                apy: metrics.apy,
                apy7d: metrics.apy7d,
                apy30d: metrics.apy30d,
              }),
              countingMode: pos.countingMode,
              estDailyUsd: estDaily,
              estMonthlyUsd: estMonthly,
              estYearlyUsd: estYearly,
              // Include absolute yield metrics for reward positions
              ...(metrics.absoluteYield && { absoluteYield: metrics.absoluteYield }),
            };
          })
      );

      const validPositions = positionsWithMetrics.filter((p) => p !== null);

      // Use most recent update time, or current time if no positions have been updated
      const asOfDate = mostRecentUpdate || new Date();

      return reply.send({
        asOf: asOfDate.toISOString(),
        totalValueUsd,
        estDailyUsd: totalEstDailyUsd,
        estMonthlyUsd: totalEstMonthlyUsd,
        estYearlyUsd: totalEstYearlyUsd,
        positions: validPositions,
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch portfolio summary' });
    }
  });

  /**
   * GET /api/portfolio/history
   * Get historical portfolio values (one data point per day)
   * Optional query param: walletIds (comma-separated list of wallet IDs to filter - restricted to user's wallets)
   */
  server.get<{ Querystring: { walletIds?: string } }>(
    '/history',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Querystring: { walletIds?: string } }>, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    try {
      // Get user's wallet IDs
      const userWallets = await getUserWallets(request.user.id);
      const userWalletIds = userWallets.map((w) => w.id);

      if (userWalletIds.length === 0) {
        return reply.send({ history: [] });
      }

      const { walletIds } = request.query;

      // Parse wallet IDs if provided and filter to only user's wallets
      let walletIdList = walletIds
        ? walletIds.split(',').filter(id => id.trim() && userWalletIds.includes(id.trim()))
        : userWalletIds;

      // Ensure we only use user's wallets
      walletIdList = walletIdList.filter(id => userWalletIds.includes(id));

      if (walletIdList.length === 0) {
        return reply.send({ history: [] });
      }

      // Build WHERE clause for wallet filtering
      const walletFilter = `AND p.wallet_id = ANY($1::uuid[])`;

      // Get daily snapshots aggregated across positions (optionally filtered by wallet)
      // Only include positions with counting_mode = 'count' or 'partial'
      // Use DISTINCT ON to get the latest snapshot per position per day
      const rows = await query<{
        date: string;
        totalValueUsd: string;
        timestamp: Date;
      }>(
        `
        WITH latest_daily_snapshots AS (
          SELECT DISTINCT ON (p.id, DATE(ps.ts AT TIME ZONE 'UTC'))
            p.id as position_id,
            DATE(ps.ts AT TIME ZONE 'UTC') as date,
            ps.value_usd,
            ps.ts
          FROM position_snapshot ps
          JOIN position p ON ps.position_id = p.id
          WHERE p.counting_mode IN ('count', 'partial')
          ${walletFilter}
          ORDER BY p.id, DATE(ps.ts AT TIME ZONE 'UTC'), ps.ts DESC
        )
        SELECT
          date::text as date,
          SUM(value_usd) as "totalValueUsd",
          MAX(ts) as "timestamp"
        FROM latest_daily_snapshots
        GROUP BY date
        ORDER BY date ASC
      `,
        [walletIdList]
      );

      const history = rows.map((row) => ({
        date: row.date,
        totalValueUsd: parseFloat(row.totalValueUsd),
        timestamp: row.timestamp,
      }));

      return reply.send({ history });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch portfolio history' });
    }
  });
}
