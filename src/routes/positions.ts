import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getActivePositionsByWallets,
  getPositionById,
  updatePositionCountingMode,
  updatePositionActiveStatus,
} from '../models/position';
import { getUserWallets } from '../models/user-wallet';
import { getSnapshotsInRange } from '../models/snapshot';
import { CountingMode } from '../types';
import { requireAuth } from '../middleware/auth';
import {
  enrichPositionsWithMetrics,
  getActualYieldSummaryForWallets,
  getPortfolioProjectionMetadata,
} from '../services/position-view';

interface UpdatePositionBody {
  countingMode?: CountingMode;
  isActive?: boolean;
}

interface GetSnapshotsQuery {
  from?: string;
  to?: string;
}

const VALID_COUNTING_MODES: CountingMode[] = ['count', 'partial', 'ignore'];

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
      const enrichedPositions = await enrichPositionsWithMetrics(positions);
      const {
        actual24hYield,
        actual7dYield,
        actual30dYield,
      } = await getActualYieldSummaryForWallets(userWalletIds);

      return reply.send({
        positions: enrichedPositions,
        summary: {
          actual24hYield,
          actual7dYield,
          actual30dYield,
          projection: getPortfolioProjectionMetadata(enrichedPositions),
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

        if ((from && Number.isNaN(fromDate.getTime())) || (to && Number.isNaN(toDate.getTime()))) {
          return reply.code(400).send({ error: 'Invalid date range. Use ISO-8601 timestamps for from/to.' });
        }
        if (fromDate > toDate) {
          return reply.code(400).send({ error: '"from" must be before or equal to "to".' });
        }

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
        if (countingMode !== undefined && !VALID_COUNTING_MODES.includes(countingMode)) {
          return reply.code(400).send({ error: 'Invalid countingMode. Must be one of: count, partial, ignore.' });
        }
        if (isActive !== undefined && typeof isActive !== 'boolean') {
          return reply.code(400).send({ error: 'Invalid isActive. Must be a boolean.' });
        }

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
