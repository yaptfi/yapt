import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getActivePositionsByWallets,
  getPositionById,
  updatePositionCountingMode,
  updatePositionActiveStatus,
} from '../models/position';
import { getUserWallets } from '../models/user-wallet';
import { getSnapshotsInRange } from '../models/snapshot';
import { getPositionMetrics } from '../services/update';
import { CountingMode } from '../types';
import { estimateDailyIncome, estimateMonthlyIncome, estimateYearlyIncome } from '../utils/apy';
import { requireAuth } from '../middleware/auth';
import { query } from '../utils/db';

interface UpdatePositionBody {
  countingMode?: CountingMode;
  isActive?: boolean;
}

interface GetSnapshotsQuery {
  from?: string;
  to?: string;
}

export default async function positionRoutes(server: FastifyInstance) {
  /**
   * GET /api/positions
   * Get all active positions for user's wallets with latest metrics
   */
  server.get('/', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    try {
      // Get user's wallet IDs
      const userWallets = await getUserWallets(request.user.id);
      const userWalletIds = userWallets.map((w) => w.id);

      // Get active positions filtered by user's wallets at DB level
      const positions = await getActivePositionsByWallets(userWalletIds);

      // Enrich with metrics
      const enrichedPositions = await Promise.all(
        positions.map(async (pos) => {
          const metrics = await getPositionMetrics(pos.id, pos);

          if (!metrics) {
            return {
              ...pos,
              walletId: pos.walletId,
              measureMethod: pos.measureMethod,
              valueUsd: 0,
              apy: null,
              apy7d: null,
              apy30d: null,
              estDailyUsd: 0,
              estMonthlyUsd: 0,
              estYearlyUsd: 0,
            };
          }

          // For reward-based positions, use absolute yield metrics
          // For APY-based positions, use percentage-based income projections
          const isRewardBased = pos.measureMethod === 'rewards';
          let estDailyUsd, estMonthlyUsd, estYearlyUsd;

          if (isRewardBased && metrics.absoluteYield) {
            // Use actual yield data
            estDailyUsd = metrics.absoluteYield.avgDailyYield;
            estMonthlyUsd = metrics.absoluteYield.projectedMonthlyYield;
            estYearlyUsd = metrics.absoluteYield.projectedYearlyYield;
          } else {
            // Use APY-based calculation
            const currentApy = metrics.apy7d || metrics.apy || 0;
            estDailyUsd = estimateDailyIncome(metrics.valueUsd, currentApy);
            estMonthlyUsd = estimateMonthlyIncome(metrics.valueUsd, currentApy);
            estYearlyUsd = estimateYearlyIncome(metrics.valueUsd, currentApy);
          }

          return {
            id: pos.id,
            walletId: pos.walletId,
            displayName: pos.displayName,
            baseAsset: pos.baseAsset,
            countingMode: pos.countingMode,
            measureMethod: pos.measureMethod,
            valueUsd: metrics.valueUsd,
            // Don't show APY for reward-based positions (volatile principal)
            // Only show for stable principal positions
            ...(!isRewardBased && {
              apy: metrics.apy,
              apy7d: metrics.apy7d,
              apy30d: metrics.apy30d,
            }),
            estDailyUsd,
            estMonthlyUsd,
            estYearlyUsd,
            lastUpdated: metrics.lastUpdated,
            // Include absolute yield metrics for reward positions
            ...(metrics.absoluteYield && { absoluteYield: metrics.absoluteYield }),
          };
        })
      );

      // Calculate actual yields from snapshots for different time periods
      // Sum ALL yield_delta_usd values - resets mark deposits/withdrawals but don't invalidate yield history
      let actual24hYield = 0;
      let actual7dYield = 0;
      let actual30dYield = 0;

      if (userWalletIds.length > 0) {
        // 24 hours actual yield - sum all deltas in the period
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const result24h = await query<{ total_yield: string }>(
          `SELECT COALESCE(SUM(ps.yield_delta_usd), 0) as total_yield
           FROM position_snapshot ps
           JOIN position p ON ps.position_id = p.id
           WHERE p.wallet_id = ANY($1::uuid[])
             AND p.is_active = true
             AND p.counting_mode IN ('count', 'partial')
             AND ps.ts >= $2`,
          [userWalletIds, twentyFourHoursAgo]
        );
        actual24hYield = result24h.length > 0 ? parseFloat(result24h[0].total_yield) : 0;

        // 7 days actual yield - sum all deltas in the period
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const result7d = await query<{ total_yield: string }>(
          `SELECT COALESCE(SUM(ps.yield_delta_usd), 0) as total_yield
           FROM position_snapshot ps
           JOIN position p ON ps.position_id = p.id
           WHERE p.wallet_id = ANY($1::uuid[])
             AND p.is_active = true
             AND p.counting_mode IN ('count', 'partial')
             AND ps.ts >= $2`,
          [userWalletIds, sevenDaysAgo]
        );
        actual7dYield = result7d.length > 0 ? parseFloat(result7d[0].total_yield) : 0;

        // 30 days actual yield - sum all deltas in the period
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result30d = await query<{ total_yield: string }>(
          `SELECT COALESCE(SUM(ps.yield_delta_usd), 0) as total_yield
           FROM position_snapshot ps
           JOIN position p ON ps.position_id = p.id
           WHERE p.wallet_id = ANY($1::uuid[])
             AND p.is_active = true
             AND p.counting_mode IN ('count', 'partial')
             AND ps.ts >= $2`,
          [userWalletIds, thirtyDaysAgo]
        );
        actual30dYield = result30d.length > 0 ? parseFloat(result30d[0].total_yield) : 0;
      }

      return reply.send({
        positions: enrichedPositions,
        summary: {
          actual24hYield,
          actual7dYield,
          actual30dYield,
        },
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch positions' });
    }
  });

  /**
   * GET /api/positions/:id/snapshots
   * Get snapshots for a position within a time range
   */
  server.get<{ Params: { id: string }; Querystring: GetSnapshotsQuery }>(
    '/:id/snapshots',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params;
      const { from, to } = request.query;

      try {
        const position = await getPositionById(id);
        if (!position) {
          return reply.code(404).send({ error: 'Position not found' });
        }

        // Check if position belongs to user's wallet
        const userWallets = await getUserWallets(request.user.id);
        const userWalletIds = new Set(userWallets.map((w) => w.id));

        if (!userWalletIds.has(position.walletId)) {
          return reply.code(404).send({ error: 'Position not found' });
        }

        const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const toDate = to ? new Date(to) : new Date();

        const snapshots = await getSnapshotsInRange(id, fromDate, toDate);

        return reply.send({
          position: {
            id: position.id,
            displayName: position.displayName,
          },
          snapshots: snapshots.map((s) => ({
            ts: s.ts,
            valueUsd: parseFloat(s.value_usd),
            netFlowsUsd: parseFloat(s.net_flows_usd),
            yieldDeltaUsd: parseFloat(s.yield_delta_usd),
            apy: s.apy ? parseFloat(s.apy) : null,
          })),
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch snapshots' });
      }
    }
  );

  /**
   * PATCH /api/positions/:id
   * Update position settings (counting mode, active status)
   */
  server.patch<{ Params: { id: string }; Body: UpdatePositionBody }>(
    '/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params;
      const { countingMode, isActive } = request.body;

      try {
        const position = await getPositionById(id);
        if (!position) {
          return reply.code(404).send({ error: 'Position not found' });
        }

        // Check if position belongs to user's wallet
        const userWallets = await getUserWallets(request.user.id);
        const userWalletIds = new Set(userWallets.map((w) => w.id));

        if (!userWalletIds.has(position.walletId)) {
          return reply.code(404).send({ error: 'Position not found' });
        }

        let updated = position;

        if (countingMode !== undefined) {
          const result = await updatePositionCountingMode(id, countingMode);
          if (result) updated = result;
        }

        if (isActive !== undefined) {
          const result = await updatePositionActiveStatus(id, isActive);
          if (result) updated = result;
        }

        return reply.send({
          position: {
            id: updated.id,
            displayName: updated.displayName,
            countingMode: updated.countingMode,
            isActive: updated.isActive,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to update position' });
      }
    }
  );
}
