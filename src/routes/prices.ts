import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fetchStablecoinPrices } from '../services/stablecoinPriceMonitor';

export default async function pricesRoutes(server: FastifyInstance) {
  /**
   * GET /api/prices/stablecoins
   * Get current stablecoin prices from CoinGecko
   */
  server.get('/stablecoins', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const prices = await fetchStablecoinPrices();
      return reply.send({ prices });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch stablecoin prices' });
    }
  });
}
