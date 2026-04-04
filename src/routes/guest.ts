import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { queryOne, query } from '../utils/db';
import { enrichPositionsWithMetrics, getActualYieldSummaryForWallets } from '../services/position-view';

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
  metadata?: Record<string, unknown>;
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
            is_active as "isActive",
            metadata
           FROM position
           WHERE wallet_id = $1 AND is_active = true
           ORDER BY display_name`,
          [id]
        );

        const enrichedPositions = await enrichPositionsWithMetrics(positions);
        const {
          actual24hYield,
          actual7dYield,
          actual30dYield,
        } = await getActualYieldSummaryForWallets([id]);

        return reply.send({
          wallet,
          positions: enrichedPositions,
          summary: {
            actual24hYield,
            actual7dYield,
            actual30dYield,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch wallet data' });
      }
    }
  );
}
