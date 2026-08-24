import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { query, queryOne, withTransaction, queryOnClient } from '../utils/db';
import { requireAdmin } from '../middleware/auth';
import {
  getAllRPCProviders,
  createRPCProvider,
  deleteRPCProvider,
  getRPCProviderById,
  updateRPCProvider,
  updateRPCProviderProbeResults,
} from '../models/rpc-provider';
import { reloadRPCProviders, getRPCStatus } from '../utils/ethereum';
import { probeRPCProviderUrls } from '../services/rpc-provider-probe';

interface WalletWithUsers {
  id: string;
  address: string;
  ensName: string | null;
  createdAt: Date;
  userCount: number;
  positionCount: number;
  snapshotCount: number;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseRPCProviderId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

        // Hard delete in one DB transaction.
        // Order: snapshots -> positions -> user_wallet links -> wallet
        await withTransaction(async (client) => {
          await queryOnClient(
            client,
            `DELETE FROM position_snapshot
             WHERE position_id IN (
               SELECT id FROM position WHERE wallet_id = $1
             )`,
            [id]
          );

          await queryOnClient(client, 'DELETE FROM position WHERE wallet_id = $1', [id]);
          await queryOnClient(client, 'DELETE FROM user_wallet WHERE wallet_id = $1', [id]);
          await queryOnClient(client, 'DELETE FROM wallet WHERE id = $1', [id]);
        });

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
   * POST /api/admin/rpc-providers/probe
   * Probe editable URLs before creating a provider. Results never include URLs.
   */
  server.post<{
    Body: { url: string; arbitrumUrl?: string | null };
  }>('/rpc-providers/probe', { preHandler: requireAdmin }, async (request, reply) => {
    const { url, arbitrumUrl } = request.body;
    if (!url) {
      return reply.code(400).send({ error: 'Ethereum RPC URL is required' });
    }

    try {
      const probe = await probeRPCProviderUrls(url, arbitrumUrl);
      server.log.info(
        {
          userId: request.user?.id,
          ethereumBasic: probe.ethereum.basic.ok,
          ethereumBlockScan: probe.ethereum.blockScan.status,
          arbitrumBasic: probe.arbitrum?.basic.ok,
          arbitrumBlockScan: probe.arbitrum?.blockScan.status,
        },
        'RPC provider wizard probe completed'
      );
      return reply.send({ probe });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to probe RPC URLs';
      return reply.code(400).send({ error: message });
    }
  });

  /**
   * POST /api/admin/rpc-providers
   * Create a new RPC provider after independently re-checking its URLs.
   */
  server.post<{
    Body: {
      name: string;
      url: string;
      arbitrumUrl?: string;
      callsPerSecond: number;
      callsPerDay?: number;
      priority: number;
      isActive: boolean;
    };
  }>('/rpc-providers', { preHandler: requireAdmin }, async (request, reply) => {
    const {
      name,
      url,
      arbitrumUrl,
      callsPerSecond,
      callsPerDay,
      priority,
      isActive,
    } = request.body;

    // Validate inputs
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      typeof url !== 'string' ||
      url.trim().length === 0 ||
      callsPerSecond === undefined ||
      priority === undefined
    ) {
      return reply.code(400).send({ error: 'Missing required fields: name, url, callsPerSecond, priority' });
    }

    if (!Number.isFinite(callsPerSecond) || callsPerSecond <= 0 || callsPerSecond > 1000) {
      return reply.code(400).send({ error: 'callsPerSecond must be between 0 and 1000' });
    }

    if (!Number.isInteger(priority)) {
      return reply.code(400).send({ error: 'priority must be an integer' });
    }

    if (
      callsPerDay !== undefined &&
      callsPerDay !== null &&
      (!Number.isInteger(callsPerDay) || callsPerDay < 1)
    ) {
      return reply.code(400).send({ error: 'callsPerDay must be at least 1 when provided' });
    }

    if (!isHttpUrl(url)) {
      return reply.code(400).send({ error: 'url must be a valid HTTP or HTTPS URL' });
    }

    if (arbitrumUrl && !isHttpUrl(arbitrumUrl)) {
      return reply.code(400).send({ error: 'arbitrumUrl must be a valid HTTP or HTTPS URL' });
    }

    try {
      const normalizedUrl = url.trim();
      const normalizedArbitrumUrl = arbitrumUrl?.trim() || undefined;
      const probe = await probeRPCProviderUrls(normalizedUrl, normalizedArbitrumUrl);
      if (!probe.canSave) {
        return reply.code(422).send({
          error: 'RPC capability checks were inconclusive or failed. Edit the URL and retry.',
          probe,
        });
      }

      const supportsEthereumBlockScans = probe.ethereum.blockScan.compatible;
      const supportsArbitrumBlockScans = probe.arbitrum?.blockScan.compatible ?? false;
      const provider = await createRPCProvider({
        name: name.trim(),
        url: normalizedUrl,
        arbitrumUrl: normalizedArbitrumUrl,
        callsPerSecond,
        callsPerDay,
        priority,
        isActive: isActive !== false, // Default to true
        supportsLargeBlockScans: supportsEthereumBlockScans || supportsArbitrumBlockScans,
        supportsEthereumBlockScans,
        supportsArbitrumBlockScans,
        supportsENS: probe.ethereum.basic.ok,
        ethereumProbe: probe.ethereum,
        arbitrumProbe: probe.arbitrum,
      });

      // Reload providers to apply changes
      await reloadRPCProviders();

      server.log.info({ providerId: provider.id, name: provider.name }, 'RPC provider created');

      return reply.code(201).send({ provider, probe });
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
      arbitrumUrl?: string | null;
      callsPerSecond?: number;
      callsPerDay?: number | null;
      priority?: number;
      isActive?: boolean;
      supportsLargeBlockScans?: boolean;
      supportsENS?: boolean;
    };
  }>('/rpc-providers/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params;
    const updates = request.body;

    // Validate numeric ID
    const providerId = parseRPCProviderId(id);
    if (providerId === null) {
      return reply.code(400).send({ error: 'Invalid provider ID' });
    }

    // Validate updates if provided
    if (updates.name !== undefined && (typeof updates.name !== 'string' || updates.name.trim().length === 0)) {
      return reply.code(400).send({ error: 'name must not be empty' });
    }
    if (
      updates.callsPerSecond !== undefined &&
      (!Number.isFinite(updates.callsPerSecond) || updates.callsPerSecond <= 0 || updates.callsPerSecond > 1000)
    ) {
      return reply.code(400).send({ error: 'callsPerSecond must be between 0 and 1000' });
    }

    if (updates.priority !== undefined && !Number.isInteger(updates.priority)) {
      return reply.code(400).send({ error: 'priority must be an integer' });
    }

    if (
      updates.callsPerDay !== undefined &&
      updates.callsPerDay !== null &&
      (!Number.isInteger(updates.callsPerDay) || updates.callsPerDay < 1)
    ) {
      return reply.code(400).send({ error: 'callsPerDay must be at least 1 when provided' });
    }

    if (updates.url !== undefined && !isHttpUrl(updates.url)) {
      return reply.code(400).send({ error: 'url must be a valid HTTP or HTTPS URL' });
    }

    if (
      updates.arbitrumUrl !== undefined &&
      updates.arbitrumUrl !== null &&
      updates.arbitrumUrl !== '' &&
      !isHttpUrl(updates.arbitrumUrl)
    ) {
      return reply.code(400).send({ error: 'arbitrumUrl must be a valid HTTP or HTTPS URL' });
    }

    if (updates.supportsLargeBlockScans !== undefined) {
      return reply.code(400).send({
        error: 'Historical scan capability is detected automatically. Use the provider test action.',
      });
    }

    try {
      if (updates.name !== undefined) {
        updates.name = updates.name.trim();
      }
      if (updates.url !== undefined) {
        updates.url = updates.url.trim();
      }
      if (typeof updates.arbitrumUrl === 'string') {
        updates.arbitrumUrl = updates.arbitrumUrl.trim();
      }
      if (updates.arbitrumUrl === '') {
        updates.arbitrumUrl = null;
      }
      let urlProbe = null;
      if (updates.url !== undefined || updates.arbitrumUrl !== undefined) {
        const existing = await getRPCProviderById(providerId);
        if (!existing) {
          return reply.code(404).send({ error: 'RPC provider not found' });
        }
        urlProbe = await probeRPCProviderUrls(
          updates.url ?? existing.url,
          updates.arbitrumUrl === undefined ? existing.arbitrumUrl : updates.arbitrumUrl
        );
        if (!urlProbe.canSave) {
          return reply.code(422).send({
            error: 'Updated RPC URLs did not pass capability checks. Edit the URL and retry.',
            probe: urlProbe,
          });
        }
      }

      const providerUpdates = urlProbe
        ? {
            ...updates,
            supportsLargeBlockScans:
              urlProbe.ethereum.blockScan.compatible ||
              (urlProbe.arbitrum?.blockScan.compatible ?? false),
            supportsEthereumBlockScans: urlProbe.ethereum.blockScan.compatible,
            supportsArbitrumBlockScans: urlProbe.arbitrum?.blockScan.compatible ?? false,
            supportsENS: urlProbe.ethereum.basic.ok,
            ethereumProbe: urlProbe.ethereum,
            arbitrumProbe: urlProbe.arbitrum,
          }
        : updates;
      const provider = await updateRPCProvider(providerId, providerUpdates);

      if (!provider) {
        return reply.code(404).send({ error: 'RPC provider not found' });
      }

      // Reload providers to apply changes
      await reloadRPCProviders();

      server.log.info(
        {
          providerId: provider.id,
          name: provider.name,
          changedFields: Object.keys(providerUpdates),
          scanRoutingEnabled: providerUpdates.supportsLargeBlockScans,
          isActive: updates.isActive,
        },
        'RPC provider updated and routing reloaded'
      );

      return reply.send({ provider, probe: urlProbe });
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
      const providerId = parseRPCProviderId(id);
      if (providerId === null) {
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

  /**
   * POST /api/admin/rpc-providers/:id/probe
   * Re-check and persist per-chain capabilities for an existing provider.
   */
  server.post<{ Params: { id: string } }>(
    '/rpc-providers/:id/probe',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const providerId = parseRPCProviderId(request.params.id);
      if (providerId === null) {
        return reply.code(400).send({ error: 'Invalid provider ID' });
      }

      const existing = await getRPCProviderById(providerId);
      if (!existing) {
        return reply.code(404).send({ error: 'RPC provider not found' });
      }

      try {
        const probe = await probeRPCProviderUrls(existing.url, existing.arbitrumUrl);
        const previousEthereumScan = existing.supportsEthereumBlockScans === true;
        const previousArbitrumScan = existing.supportsArbitrumBlockScans === true;
        const provider = await updateRPCProviderProbeResults(providerId, probe);
        if (!provider) {
          return reply.code(404).send({ error: 'RPC provider not found' });
        }

        const routingChanged =
          previousEthereumScan !== provider.supportsEthereumBlockScans ||
          previousArbitrumScan !== provider.supportsArbitrumBlockScans;
        if (routingChanged) {
          await reloadRPCProviders();
        }

        server.log.info(
          {
            providerId,
            name: existing.name,
            ethereumBasic: probe.ethereum.basic.ok,
            ethereumBlockScan: probe.ethereum.blockScan.status,
            arbitrumBasic: probe.arbitrum?.basic.ok,
            arbitrumBlockScan: probe.arbitrum?.blockScan.status,
            routingChanged,
          },
          'RPC provider capability probe completed'
        );

        return reply.send({ provider, probe, routingChanged });
      } catch (error) {
        server.log.error(
          { err: error, providerId, name: existing.name },
          'RPC provider capability probe failed unexpectedly'
        );
        return reply.code(500).send({ error: 'Failed to probe RPC provider' });
      }
    }
  );
}
