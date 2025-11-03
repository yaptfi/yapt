import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getOrCreateWalletByAddress, getWalletById, getWalletByAddress, setWalletEnsName } from '../models/wallet';
import { getUserWallets, addWalletToUser, removeWalletFromUser, isWalletTrackedByUser } from '../models/user-wallet';
import { discoverPositionsWithProgress } from '../services/discovery';
import { isValidAddress, toChecksumAddress, isENSName, resolveENS, lookupEnsForAddress } from '../utils/ethereum';
import { requireAuth } from '../middleware/auth';

interface AddWalletBody {
  address: string;
}

export type DiscoveryProgressEvent =
  | { type: 'start'; data: { totalProtocols: number } }
  | { type: 'protocol_start'; data: { protocol: string; index: number; total: number } }
  | { type: 'position_found'; data: { protocol: string; displayName: string; baseAsset: string; valueUsd: number } }
  | { type: 'protocol_complete'; data: { protocol: string; positionsFound: number } }
  | { type: 'complete'; data: { totalPositions: number } }
  | { type: 'error'; data: { message: string } };

/**
 * Helper function to stream discovery progress via SSE
 */
async function streamDiscoveryProgress(
  walletId: string,
  walletAddress: string,
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Set up SSE headers
  const origin = request.headers.origin || '*';
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
  });

  const sendEvent = (event: DiscoveryProgressEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    // Run discovery with progress streaming
    await discoverPositionsWithProgress(walletId, walletAddress, sendEvent);
    reply.raw.end();
  } catch (error) {
    sendEvent({
      type: 'error',
      data: { message: error instanceof Error ? error.message : 'Discovery failed' },
    });
    reply.raw.end();
  }
}

export default async function walletRoutes(server: FastifyInstance) {
  /**
   * POST /api/wallets
   * Add a wallet to authenticated user (creates wallet if doesn't exist, shares if it does)
   */
  server.post<{ Body: AddWalletBody }>(
    '/',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: AddWalletBody }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      let { address } = request.body;

      if (!address) {
        return reply.code(400).send({ error: 'Address is required' });
      }

      // Check if input is an ENS name and resolve it
      if (isENSName(address)) {
        const resolvedAddress = await resolveENS(address);
        if (!resolvedAddress) {
          return reply.code(400).send({ error: 'ENS name could not be resolved' });
        }
        address = resolvedAddress;
      }

      if (!isValidAddress(address)) {
        return reply.code(400).send({ error: 'Invalid Ethereum address' });
      }

      try {
        const checksumAddress = toChecksumAddress(address);
        const ensName = isENSName(request.body.address) ? request.body.address : null;

        // Check if wallet already exists in database
        const existingWallet = await getWalletByAddress(checksumAddress);
        const walletAlreadyExisted = existingWallet !== null;

        // Get or create wallet
        const wallet = await getOrCreateWalletByAddress(checksumAddress, ensName);

        // Check if user already tracks this wallet
        const alreadyTracking = await isWalletTrackedByUser(request.user.id, wallet.id);
        if (alreadyTracking) {
          return reply.code(409).send({
            error: 'You are already tracking this wallet',
            wallet: {
              id: wallet.id,
              address: wallet.address,
              ensName: wallet.ensName ?? null,
              createdAt: wallet.createdAt,
            },
          });
        }

        // Link wallet to user
        await addWalletToUser(request.user.id, wallet.id);

        // Only trigger discovery if this is a newly created wallet
        // If wallet already existed, it already has positions discovered
        if (!walletAlreadyExisted) {
          discoverPositionsWithProgress(wallet.id, checksumAddress, () => {})
            .then((positions) => {
              server.log.info(`Discovered ${positions.length} positions for wallet ${wallet.id}`);
            })
            .catch((error) => {
              server.log.error(error, `Failed to discover positions for wallet ${wallet.id}`);
            });
        }

        return reply.code(201).send({
          wallet: {
            id: wallet.id,
            address: wallet.address,
            ensName: wallet.ensName ?? null,
            createdAt: wallet.createdAt,
          },
          message: walletAlreadyExisted
            ? 'Wallet added (positions already discovered)'
            : 'Wallet added, discovering positions...',
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to add wallet' });
      }
    }
  );

  /**
   * POST /api/wallets/:id/scan
   * Trigger discovery for an existing wallet to find newly supported protocols (with SSE progress)
   */
  server.post<{ Params: { id: string } }>(
    '/:id/scan',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params;

      try {
        // Check if user tracks this wallet
        const isTracking = await isWalletTrackedByUser(request.user.id, id);
        if (!isTracking) {
          return reply.code(404).send({ error: 'Wallet not found' });
        }

        const wallet = await getWalletById(id);
        if (!wallet) {
          return reply.code(404).send({ error: 'Wallet not found' });
        }

        // Stream discovery progress via SSE
        await streamDiscoveryProgress(wallet.id, wallet.address, request, reply);
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to trigger scan' });
      }
    }
  );

  /**
   * GET /api/wallets
   * Get all wallets tracked by authenticated user
   */
  server.get('/', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    try {
      const wallets = await getUserWallets(request.user.id);

      return reply.send({
        wallets: wallets.map((w) => ({
          id: w.id,
          address: w.address,
          ensName: w.ensName ?? null,
          createdAt: w.createdAt,
        })),
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch wallets' });
    }
  });

  /**
   * POST /api/wallets/discover
   * Add a new wallet with SSE progress streaming
   */
  server.post<{ Body: AddWalletBody }>(
    '/discover',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: AddWalletBody }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      let { address } = request.body;

      if (!address) {
        return reply.code(400).send({ error: 'Address is required' });
      }

      // Check if input is an ENS name and resolve it
      if (isENSName(address)) {
        const resolvedAddress = await resolveENS(address);
        if (!resolvedAddress) {
          return reply.code(400).send({ error: 'ENS name could not be resolved' });
        }
        address = resolvedAddress;
      }

      if (!isValidAddress(address)) {
        return reply.code(400).send({ error: 'Invalid Ethereum address' });
      }

      try {
        const checksumAddress = toChecksumAddress(address);
        const ensName = isENSName(request.body.address) ? request.body.address : null;

        // Check if wallet already exists in database
        const existingWallet = await getWalletByAddress(checksumAddress);
        const walletAlreadyExisted = existingWallet !== null;

        // Get or create wallet (allows sharing)
        const wallet = await getOrCreateWalletByAddress(checksumAddress, ensName);

        // Check if user already tracks this wallet
        const alreadyTracking = await isWalletTrackedByUser(request.user.id, wallet.id);
        if (alreadyTracking) {
          return reply.code(409).send({
            error: 'You are already tracking this wallet',
            wallet: {
              id: wallet.id,
              address: wallet.address,
              createdAt: wallet.createdAt,
            },
          });
        }

        // Link wallet to user
        await addWalletToUser(request.user.id, wallet.id);

        // If wallet already existed, no need to run discovery - just return success
        if (walletAlreadyExisted) {
          return reply.send({
            wallet: {
              id: wallet.id,
              address: wallet.address,
              ensName: wallet.ensName ?? null,
              createdAt: wallet.createdAt,
            },
            message: 'Wallet added (positions already discovered)',
          });
        }

        // Stream discovery progress via SSE (only for new wallets)
        await streamDiscoveryProgress(wallet.id, checksumAddress, request, reply);
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to add wallet' });
      }
    }
  );

  /**
   * DELETE /api/wallets/:id
   * Remove wallet from user's tracked wallets (soft delete - removes user_wallet link only)
   */
  server.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const { id } = request.params;

      try {
        // Check if user tracks this wallet
        const isTracking = await isWalletTrackedByUser(request.user.id, id);
        if (!isTracking) {
          return reply.code(404).send({ error: 'Wallet not found' });
        }

        // Remove user_wallet link (soft delete)
        const removed = await removeWalletFromUser(request.user.id, id);

        if (!removed) {
          return reply.code(404).send({ error: 'Failed to remove wallet' });
        }

        return reply.send({
          message: 'Wallet removed from your tracked wallets',
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to remove wallet' });
      }
    }
  );

  /**
   * POST /api/wallets/backfill-ens
   * Reverse-lookup ENS names for user's wallets missing ens_name
   */
  server.post('/backfill-ens', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Authentication required' });
    }

    try {
      const wallets = await getUserWallets(request.user.id);
      let processed = 0;
      let updated = 0;
      let skipped = 0;

      // Rate limit to avoid RPC throttling
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      for (const w of wallets) {
        processed++;
        if (w.ensName && w.ensName.length > 0) {
          skipped++;
          continue;
        }
        const ens = await lookupEnsForAddress(w.address);
        if (ens) {
          const ok = await setWalletEnsName(w.id, ens);
          if (ok) updated++;
          await sleep(500); // gentle pacing
        } else {
          skipped++;
        }
        await sleep(500); // ~1 req/sec total
      }

      return reply.send({ processed, updated, skipped });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to backfill ENS names' });
    }
  });
}
