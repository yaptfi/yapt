import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { queryOne, query } from '../utils/db';
import { getPositionMetrics } from '../services/update';

interface Wallet {
  id: string;
  address: string;
  ensName: string | null;
  createdAt: Date;
}

interface PositionRow {
  id: string;
  walletId: string;
  displayName: string;
  baseAsset: string;
  countingMode: string;
  measureMethod: string;
  isActive: boolean;
  valueUsd: number;
  apy: number | null;
  apy7d: number | null;
  apy30d: number | null;
  estDailyUsd: number;
  estMonthlyUsd: number;
  estYearlyUsd: number;
  lastUpdated: Date | null;
}

export default async function guestRoutes(server: FastifyInstance) {
  /**
   * GET /api/guest/default-wallet
   * Public endpoint returning a configured default guest wallet.
   * Configuration via env:
   *  - GUEST_DEFAULT_WALLET_ID (UUID)
   *  - GUEST_DEFAULT_WALLET_ADDRESS (0x-address)
   * If only one of id/address is provided, the other is looked up from DB when possible.
   */
  server.get('/default-wallet', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const configuredId = process.env.GUEST_DEFAULT_WALLET_ID;
      const id = configuredId && configuredId.trim() ? configuredId.trim() : undefined;

      if (!id) {
        return reply.code(404).send({ error: 'Default guest wallet not configured' });
      }

      // Keep response minimal to just ID (address no longer returned)
      return reply.send({ id });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch default guest wallet' });
    }
  });

  /**
   * GET /api/guest/wallets/:id
   * Get wallet and positions for guest view (no authentication required)
   */
  server.get<{ Params: { id: string } }>(
    '/wallets/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      try {
        // Get wallet info
        const wallet = await queryOne<Wallet>(
          `SELECT id, address, ens_name as "ensName", created_at as "createdAt"
           FROM wallet
           WHERE id = $1`,
          [id]
        );

        if (!wallet) {
          return reply.code(404).send({ error: 'Wallet not found' });
        }

        // Get positions for this wallet
        const positions = await query<PositionRow>(
          `SELECT
            id,
            wallet_id as "walletId",
            display_name as "displayName",
            base_asset as "baseAsset",
            counting_mode as "countingMode",
            measure_method as "measureMethod",
            is_active as "isActive"
           FROM position
           WHERE wallet_id = $1 AND is_active = true
           ORDER BY display_name`,
          [id]
        );

        // Enrich positions with metrics
        const enrichedPositions = await Promise.all(
          positions.map(async (pos) => {
            const metrics = await getPositionMetrics(pos.id, pos as any);

            if (!metrics) {
              return {
                ...pos,
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

            const valueUsd = metrics.valueUsd || 0;

            // Reward-based positions: hide APY and use absolute yield metrics
            const isRewardBased = pos.measureMethod === 'rewards';
            let estDailyUsd: number, estMonthlyUsd: number, estYearlyUsd: number;

            if (isRewardBased && (metrics as any).absoluteYield) {
              const a = (metrics as any).absoluteYield;
              estDailyUsd = a.avgDailyYield;
              estMonthlyUsd = a.projectedMonthlyYield;
              estYearlyUsd = a.projectedYearlyYield;
            } else {
              const currentApy = metrics.apy7d || metrics.apy || 0;
              estDailyUsd = (valueUsd * currentApy) / 365;
              estMonthlyUsd = (valueUsd * currentApy) / 12;
              estYearlyUsd = valueUsd * currentApy;
            }

            return {
              id: pos.id,
              walletId: pos.walletId,
              displayName: pos.displayName,
              baseAsset: pos.baseAsset,
              countingMode: pos.countingMode,
              measureMethod: pos.measureMethod,
              valueUsd,
              // Hide APY fields for reward-based positions
              ...(!isRewardBased && {
                apy: metrics.apy,
                apy7d: metrics.apy7d,
                apy30d: metrics.apy30d,
              }),
              estDailyUsd,
              estMonthlyUsd,
              estYearlyUsd,
              lastUpdated: metrics.lastUpdated,
              // Include absolute yield metrics for rewards if present
              ...((metrics as any).absoluteYield && { absoluteYield: (metrics as any).absoluteYield }),
            };
          })
        );

        return reply.send({
          wallet,
          positions: enrichedPositions,
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch wallet data' });
      }
    }
  );
}
