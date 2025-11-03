import { FastifyRequest, FastifyReply } from 'fastify';
import { getUserById } from '../models/user';

/**
 * Authentication middleware
 * Checks if user is authenticated and attaches user to request
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  // Check if user ID is in session
  const userId = request.session.userId;

  if (!userId) {
    return reply.code(401).send({ error: 'Authentication required' });
  }

  // Load user from database
  const user = await getUserById(userId);

  if (!user) {
    // User ID in session but user doesn't exist - destroy session without blocking
    // Don't await to avoid hanging on Redis operations
    request.session.destroy(() => {});
    return reply.code(401).send({ error: 'User not found' });
  }

  // Attach user to request for use in route handlers
  request.user = user;
}

/**
 * Optional authentication middleware
 * Attaches user to request if authenticated, but doesn't reject if not
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
  const userId = request.session.userId;

  if (userId) {
    const user = await getUserById(userId);
    if (user) {
      request.user = user;
    }
  }
}

/**
 * Admin authentication middleware
 * Checks if user is authenticated AND is an admin
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  // First check authentication
  await requireAuth(request, reply);

  // If requireAuth already sent a response, stop here
  if (reply.sent) {
    return;
  }

  // Check if user is admin
  if (!request.user || !request.user.isAdmin) {
    return reply.code(403).send({ error: 'Admin access required' });
  }
}
