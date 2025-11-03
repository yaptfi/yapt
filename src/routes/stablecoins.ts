import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getAllStablecoins } from '../models/stablecoin';

export default async function stablecoinsRoutes(server: FastifyInstance) {
  /**
   * GET /api/stablecoins
   * List supported stablecoins from the database
   */
  server.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = await getAllStablecoins();
      return reply.send({
        stablecoins: rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          name: r.name,
          coingeckoId: r.coingeckoId,
          decimals: r.decimals,
        })),
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch stablecoins' });
    }
  });
}

