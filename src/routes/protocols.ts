import { FastifyInstance } from 'fastify';
import { getProtocolConfig } from '../utils/config';

export default async function protocolsRoutes(server: FastifyInstance) {
  // Public endpoint: list supported protocols from config
  server.get('/', async (_request, reply) => {
    try {
      const cfg = getProtocolConfig();
      const protocols = Object.entries(cfg).map(([key, value]) => {
        const family = key.split('-')[0] || key;
        return {
          key,
          family,
          ...value,
        };
      });

      return reply.send({ protocols });
    } catch (error: any) {
      server.log.error({ err: error }, 'Failed to load protocol config');
      return reply.code(500).send({ error: 'Failed to load protocols' });
    }
  });
}

