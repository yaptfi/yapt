import { FastifyInstance } from 'fastify';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const pkgVersion = (() => {
  try {
    const data = readFileSync(resolve(__dirname, '../../package.json'), 'utf-8');
    return (JSON.parse(data) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

export const APP_VERSION = pkgVersion;
export const GIT_SHA = process.env.GIT_SHA ?? 'unknown';
export const BUILD_TIME = process.env.BUILD_TIME ?? 'unknown';

export default async function versionRoutes(server: FastifyInstance) {
  server.get('/', async () => ({
    version: APP_VERSION,
    gitSha: GIT_SHA,
    buildTime: BUILD_TIME,
    nodeEnv: process.env.NODE_ENV ?? 'development',
  }));
}
