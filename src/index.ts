import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyRedis from '@fastify/redis';
import { readFileSync } from 'fs';
import { initializeScheduler, shutdownScheduler } from './jobs/scheduler';
import { closePool } from './utils/db';
import { getEnvVar } from './utils/config';
import { initPlugins } from './plugins/loader';
import { RedisStore } from 'connect-redis';

// Import routes
import authRoutes from './routes/auth';
import walletRoutes from './routes/wallets';
import positionRoutes from './routes/positions';
import portfolioRoutes from './routes/portfolio';
import pluginRoutes from './routes/plugins';
import pricesRoutes from './routes/prices';
import adminRoutes from './routes/admin';
import guestRoutes from './routes/guest';
import notificationRoutes from './routes/notifications';
import stablecoinsRoutes from './routes/stablecoins';
import protocolsRoutes from './routes/protocols';

const PORT = parseInt(getEnvVar('PORT', '3000'));
const SESSION_SECRET = getEnvVar('SESSION_SECRET');
const REDIS_URL = getEnvVar('REDIS_URL', 'redis://localhost:6379');

// HTTPS configuration
const HTTPS_ENABLED = getEnvVar('HTTPS_ENABLED', 'false') === 'true';
const HTTPS_CERT = getEnvVar('HTTPS_CERT', '');
const HTTPS_KEY = getEnvVar('HTTPS_KEY', '');

// Fastify server options
const LOG_LEVEL = getEnvVar('LOG_LEVEL', process.env.NODE_ENV === 'production' ? 'warn' : 'info');
const serverOptions: any = {
  logger: {
    level: LOG_LEVEL,
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      },
    },
  },
};

// Add HTTPS support if enabled
if (HTTPS_ENABLED && HTTPS_CERT && HTTPS_KEY) {
  try {
    serverOptions.https = {
      key: readFileSync(HTTPS_KEY),
      cert: readFileSync(HTTPS_CERT),
    };
    console.log('✅ HTTPS enabled');
  } catch (error) {
    console.error('❌ Failed to load HTTPS certificates:', error);
    console.error('Falling back to HTTP');
  }
}

const server = Fastify(serverOptions);

async function start() {
  try {
    // CORS configuration - restrict to allowed origins in production
    const allowedOrigins = getEnvVar('ALLOWED_ORIGINS', 'http://localhost:8080,https://localhost:8080');
    await server.register(fastifyCors, {
      origin: allowedOrigins.split(',').map(o => o.trim()),
      credentials: true,
    });

    if (process.env.ENABLE_AUTH_RATE_LIMIT !== 'false') {
      await server.register(fastifyRateLimit, {
        global: false, // Don't apply globally; enabled per-route
        max: 100,
        timeWindow: '15 minutes',
      });
    } else {
      console.log('Auth rate limiting disabled via ENABLE_AUTH_RATE_LIMIT=false');
    }

    await server.register(fastifyCookie);

    // Register Redis for BullMQ and general Redis usage
    await server.register(fastifyRedis, {
      url: REDIS_URL,
      closeClient: true,
    });

    // Session store configuration
    // Note: Redis session storage has compatibility issues between connect-redis/ioredis
    // Using memory store for now (sessions are per-instance but work reliably)
    const useRedisStore = false; // getEnvVar('SESSION_STORE', 'memory') === 'redis';
    const sessionOptions: any = {
      secret: SESSION_SECRET,
      // Use a distinct cookie name to avoid stale client cookies when switching stores
      cookieName: 'yapt.sid',
      cookie: {
        secure: HTTPS_ENABLED, // Set secure flag when using HTTPS
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
      },
      saveUninitialized: false, // Don't save empty sessions
      rolling: false, // Do not re‑set cookie/store on every request
    };

    if (useRedisStore) {
      // Use the already-registered Fastify Redis client for session storage.
      // This avoids creating a second connection which can queue commands and
      // cause request hangs if not yet ready.
      const redisClient = (server as any).redis;
      if (!redisClient) {
        console.warn('Redis client not available; falling back to in-memory session store');
      } else {
        // Ensure Redis is ready; otherwise fall back to memory store to avoid hanging requests.
        const ready = await new Promise<boolean>((resolve) => {
          try {
            if (redisClient.status === 'ready') return resolve(true);
            const onReady = () => {
              cleanup();
              resolve(true);
            };
            const onError = () => {
              cleanup();
              resolve(false);
            };
            const onEnd = () => {
              cleanup();
              resolve(false);
            };
            const cleanup = () => {
              try { redisClient.off('ready', onReady); } catch {}
              try { redisClient.off('error', onError); } catch {}
              try { redisClient.off('end', onEnd); } catch {}
            };
            redisClient.once('ready', onReady);
            redisClient.once('error', onError);
            redisClient.once('end', onEnd);
            // Timeout guard
            setTimeout(() => {
              cleanup();
              resolve(false);
            }, 3000);
          } catch {
            resolve(false);
          }
        });
        if (!ready) {
          console.warn('Redis not ready within timeout; using in-memory session store');
        } else {
          // Create a wrapper client with command timeouts to prevent hanging
          // Skip internal properties but wrap all methods
          const skipProps = ['then', 'catch', 'constructor', 'status', 'on', 'once', 'off', 'emit', 'options', 'isCluster'];
          const timeoutRedisClient = new Proxy(redisClient, {
            get(target, prop) {
              const original = (target as any)[prop];

              // If it's a function and not in skip list, wrap it with timeout
              if (typeof prop === 'string' && !skipProps.includes(prop) && typeof original === 'function') {
                return function(this: any, ...args: any[]) {
                  const result = original.apply(target, args);

                  // If it returns a promise, add timeout
                  if (result && typeof result.then === 'function') {
                    // Log command details
                    const logArgs = args.slice(0, 3).map((arg: any) => {
                      if (typeof arg === 'string' && arg.length > 100) return arg.slice(0, 100) + '...';
                      if (typeof arg === 'object') return '[object]';
                      return arg;
                    });
                    server.log.info({ command: prop, args: logArgs }, `Redis ${prop} called`);

                    return Promise.race([
                      result.catch((err: any) => {
                        server.log.error({ command: prop, error: err.message, args: logArgs }, `Redis ${prop} failed`);
                        throw err;
                      }),
                      new Promise((_, reject) =>
                        setTimeout(() => {
                          server.log.error({ command: prop }, `Redis ${prop} timeout after 2s`);
                          reject(new Error(`Redis ${prop} timeout after 2s`));
                        }, 2000)
                      )
                    ]);
                  }

                  return result;
                };
              }

              return original;
            }
          });

          // Use connect-redis which is more compatible with ioredis
          sessionOptions.store = new RedisStore({
            client: timeoutRedisClient as any,
            prefix: 'sess:',
            ttl: 30 * 24 * 60 * 60, // 30 days in seconds
          });
          console.log('✅ Using Redis session store (connect-redis) with command timeouts');
        }
      }
    } else {
      // Use in-memory store (development)
      console.log('Using in-memory session store (dev mode)');
    }

    await server.register(fastifySession, sessionOptions);

    // Log session errors to help debug Redis issues
    server.addHook('onError', async (request, _reply, error) => {
      if (error.message?.includes('session') || error.message?.includes('Redis')) {
        server.log.error({ err: error, url: request.url }, 'Session/Redis error');
      }
    });

    // Log when response is about to be sent (before session save)
    server.addHook('onSend', async (request, reply, payload) => {
      if (request.url?.includes('/auth/')) {
        server.log.info({ url: request.url, statusCode: reply.statusCode }, 'onSend: about to send response');
      }
      return payload;
    });

    // Static frontend is now served separately (see frontend/).
    // The backend focuses on API under /api only.

    // Initialize protocol plugins (built-ins for now)
    await initPlugins();

    // Register routes
    // Observability for /api/auth hangs
    server.addHook('onRequest', (req, _rep, done) => {
      if ((req.url || '').startsWith('/api/auth')) {
        server.log.info({ url: req.url, id: (req as any).id }, 'auth onRequest');
      }
      done();
    });
    server.addHook('onResponse', (req, rep, done) => {
      if ((req.url || '').startsWith('/api/auth')) {
        server.log.info({ url: req.url, statusCode: rep.statusCode, id: (req as any).id }, 'auth onResponse');
      }
      done();
    });
    await server.register(authRoutes, { prefix: '/api/auth' });
    await server.register(walletRoutes, { prefix: '/api/wallets' });
    await server.register(positionRoutes, { prefix: '/api/positions' });
    await server.register(portfolioRoutes, { prefix: '/api/portfolio' });
    await server.register(pluginRoutes, { prefix: '/api/plugins' });
    await server.register(pricesRoutes, { prefix: '/api/prices' });
    await server.register(adminRoutes, { prefix: '/api/admin' });
    await server.register(guestRoutes, { prefix: '/api/guest' });
    await server.register(notificationRoutes, { prefix: '/api/notifications' });
    await server.register(stablecoinsRoutes, { prefix: '/api/stablecoins' });
    await server.register(protocolsRoutes, { prefix: '/api/protocols' });

    // Health check
    server.get('/health', async () => {
      return { status: 'ok', timestamp: new Date().toISOString() };
    });

    // Initialize scheduler
    await initializeScheduler();

    // Start server
    await server.listen({ port: PORT, host: '0.0.0.0' });

    console.log(`Server listening on port ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await shutdownScheduler();
  await closePool();
  await server.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await shutdownScheduler();
  await closePool();
  await server.close();
  process.exit(0);
});

start();
