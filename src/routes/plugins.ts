import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getLoadedPlugins } from '../plugins/registry';

export default async function pluginRoutes(server: FastifyInstance) {
  // GET /api/plugins
  server.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const plugins = getLoadedPlugins();
      return reply.send({ plugins });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch plugins' });
    }
  });
}

