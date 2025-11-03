import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, queryOne } from '../utils/db';
import { requireAdmin } from '../middleware/auth';
import {
  getAllRPCProviders,
  createRPCProvider,
  deleteRPCProvider,
  updateRPCProvider,
} from '../models/rpc-provider';
import { reloadRPCProviders, getRPCStatus } from '../utils/ethereum';

interface WalletWithUsers {
  id: string;
  address: string;
  ensName: string | null;
  createdAt: Date;
  userCount: number;
  positionCount: number;
  snapshotCount: number;
}

export default async function adminRoutes(server: FastifyInstance) {
  /**
   * GET /api/admin/wallets
   * Get all wallets with user counts and stats
   */
  server.get('/wallets', { preHandler: requireAdmin }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const wallets = await query<WalletWithUsers>(`
        SELECT
          w.id,
          w.address,
          w.ens_name as "ensName",
          w.created_at as "createdAt",
          COUNT(DISTINCT uw.user_id) as "userCount",
          COUNT(DISTINCT p.id) as "positionCount",
          COUNT(DISTINCT ps.id) as "snapshotCount"
        FROM wallet w
        LEFT JOIN user_wallet uw ON w.id = uw.wallet_id
        LEFT JOIN position p ON w.id = p.wallet_id
        LEFT JOIN position_snapshot ps ON p.id = ps.position_id
        GROUP BY w.id, w.address, w.ens_name, w.created_at
        ORDER BY w.created_at DESC
      `);

      return reply.send({ wallets });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch wallets' });
    }
  });

  /**
   * DELETE /api/admin/wallets/:id
   * Hard delete wallet and all associated data (positions, snapshots, user links)
   */
  server.delete<{ Params: { id: string } }>(
    '/wallets/:id',
    { preHandler: requireAdmin },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;

      try {
        // Check if wallet exists
        const wallet = await queryOne<{ id: string; address: string }>(
          'SELECT id, address FROM wallet WHERE id = $1',
          [id]
        );

        if (!wallet) {
          return reply.code(404).send({ error: 'Wallet not found' });
        }

        // Get counts before deletion
        const stats = await queryOne<{ positions: number; snapshots: number; users: number }>(`
          SELECT
            COUNT(DISTINCT p.id) as positions,
            COUNT(DISTINCT ps.id) as snapshots,
            COUNT(DISTINCT uw.user_id) as users
          FROM wallet w
          LEFT JOIN position p ON w.id = p.wallet_id
          LEFT JOIN position_snapshot ps ON p.id = ps.position_id
          LEFT JOIN user_wallet uw ON w.id = uw.wallet_id
          WHERE w.id = $1
          GROUP BY w.id
        `, [id]);

        // Hard delete (cascades will handle related records)
        // Order: snapshots -> positions -> user_wallet links -> wallet
        await query('BEGIN');

        try {
          // Delete snapshots first
          await query(`
            DELETE FROM position_snapshot
            WHERE position_id IN (
              SELECT id FROM position WHERE wallet_id = $1
            )
          `, [id]);

          // Delete positions
          await query('DELETE FROM position WHERE wallet_id = $1', [id]);

          // Delete user_wallet links
          await query('DELETE FROM user_wallet WHERE wallet_id = $1', [id]);

          // Delete wallet
          await query('DELETE FROM wallet WHERE id = $1', [id]);

          await query('COMMIT');

          server.log.info({
            walletId: id,
            address: wallet.address,
            deleted: stats || { positions: 0, snapshots: 0, users: 0 }
          }, 'Wallet hard deleted');

          return reply.send({
            message: 'Wallet and all associated data deleted',
            deleted: {
              wallet: wallet.address,
              positions: stats?.positions || 0,
              snapshots: stats?.snapshots || 0,
              users: stats?.users || 0,
            }
          });
        } catch (error) {
          await query('ROLLBACK');
          throw error;
        }
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to delete wallet' });
      }
    }
  );

  /**
   * GET /api/admin/rpc-providers
   * Get all RPC providers with current status
   */
  server.get('/rpc-providers', { preHandler: requireAdmin }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const providers = await getAllRPCProviders();
      const status = getRPCStatus();

      return reply.send({
        providers,
        status: status || null,
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch RPC providers' });
    }
  });

  /**
   * POST /api/admin/rpc-providers
   * Create a new RPC provider
   */
  server.post<{
    Body: {
      name: string;
      url: string;
      callsPerSecond: number;
      callsPerDay?: number;
      priority: number;
      isActive: boolean;
      supportsLargeBlockScans?: boolean;
      supportsENS?: boolean;
    };
  }>('/rpc-providers', { preHandler: requireAdmin }, async (request, reply) => {
    const { name, url, callsPerSecond, callsPerDay, priority, isActive, supportsLargeBlockScans, supportsENS } = request.body;

    // Validate inputs
    if (!name || !url || callsPerSecond === undefined || priority === undefined) {
      return reply.code(400).send({ error: 'Missing required fields: name, url, callsPerSecond, priority' });
    }

    if (callsPerSecond <= 0 || callsPerSecond > 1000) {
      return reply.code(400).send({ error: 'callsPerSecond must be between 0 and 1000' });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return reply.code(400).send({ error: 'url must start with http:// or https://' });
    }

    try {
      const provider = await createRPCProvider({
        name,
        url,
        callsPerSecond,
        callsPerDay,
        priority,
        isActive: isActive !== false, // Default to true
        supportsLargeBlockScans,
        supportsENS,
      });

      // Reload providers to apply changes
      await reloadRPCProviders();

      server.log.info({ providerId: provider.id, name: provider.name }, 'RPC provider created');

      return reply.code(201).send({ provider });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to create RPC provider' });
    }
  });

  /**
   * PATCH /api/admin/rpc-providers/:id
   * Update an RPC provider
   */
  server.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      url?: string;
      callsPerSecond?: number;
      callsPerDay?: number;
      priority?: number;
      isActive?: boolean;
      supportsLargeBlockScans?: boolean;
      supportsENS?: boolean;
    };
  }>('/rpc-providers/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params;
    const updates = request.body;

    // Validate numeric ID
    const providerId = parseInt(id);
    if (isNaN(providerId)) {
      return reply.code(400).send({ error: 'Invalid provider ID' });
    }

    // Validate updates if provided
    if (updates.callsPerSecond !== undefined && (updates.callsPerSecond <= 0 || updates.callsPerSecond > 1000)) {
      return reply.code(400).send({ error: 'callsPerSecond must be between 0 and 1000' });
    }

    if (updates.url && !updates.url.startsWith('http://') && !updates.url.startsWith('https://')) {
      return reply.code(400).send({ error: 'url must start with http:// or https://' });
    }

    try {
      const provider = await updateRPCProvider(providerId, updates);

      if (!provider) {
        return reply.code(404).send({ error: 'RPC provider not found' });
      }

      // Reload providers to apply changes
      await reloadRPCProviders();

      server.log.info({ providerId: provider.id, name: provider.name, updates }, 'RPC provider updated');

      return reply.send({ provider });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to update RPC provider' });
    }
  });

  /**
   * DELETE /api/admin/rpc-providers/:id
   * Delete an RPC provider
   */
  server.delete<{ Params: { id: string } }>(
    '/rpc-providers/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id } = request.params;

      // Validate numeric ID
      const providerId = parseInt(id);
      if (isNaN(providerId)) {
        return reply.code(400).send({ error: 'Invalid provider ID' });
      }

      try {
        const success = await deleteRPCProvider(providerId);

        if (!success) {
          return reply.code(404).send({ error: 'RPC provider not found' });
        }

        // Reload providers to apply changes
        await reloadRPCProviders();

        server.log.info({ providerId }, 'RPC provider deleted');

        return reply.send({ message: 'RPC provider deleted successfully' });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to delete RPC provider' });
      }
    }
  );
}
