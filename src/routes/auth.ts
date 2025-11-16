import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';
import { getUserByUsername, createUser } from '../models/user';
import {
  getAuthenticatorsByUserId,
  getAuthenticatorByCredentialId,
  createAuthenticator,
  updateAuthenticatorCounter,
  deleteAuthenticator,
} from '../models/authenticator';
import { requireAuth } from '../middleware/auth';
import { getEnvVar } from '../utils/config';

// WebAuthn configuration
const RP_NAME = getEnvVar('RP_NAME', 'Yapt');
const RP_ID = getEnvVar('RP_ID', 'localhost');
const ORIGIN_ENV = getEnvVar('ORIGIN', 'http://localhost:3000');
const ORIGIN_LIST = ORIGIN_ENV.split(',').map((o) => o.trim()).filter(Boolean);
const EXPECTED_ORIGIN: string | string[] =
  ORIGIN_LIST.length === 1 ? ORIGIN_LIST[0] : ORIGIN_LIST;

// Validate WebAuthn configuration
function validateWebAuthnConfig() {
  const isProduction = process.env.NODE_ENV === 'production';
  const hasDefaultRpId = RP_ID === 'localhost';
  const hasDefaultOrigin = ORIGIN_LIST.includes('http://localhost:3000');

  if (isProduction && (hasDefaultRpId || hasDefaultOrigin)) {
    throw new Error(
      'Production WebAuthn configuration error: RP_ID and ORIGIN must be set to production values. ' +
      'Current values: RP_ID=' + RP_ID + ', ORIGIN=' + ORIGIN_ENV
    );
  }

  if (!isProduction && (hasDefaultRpId || hasDefaultOrigin)) {
    console.warn(
      '⚠️  WARNING: Using default WebAuthn config (RP_ID=' + RP_ID + ', ORIGIN=' + ORIGIN_ENV + '). ' +
      'Set RP_ID and ORIGIN environment variables for production.'
    );
  }

  console.log(
    'WebAuthn config: RP_ID=' + RP_ID + ', ORIGIN(S)=' + ORIGIN_LIST.join(', ')
  );
}

// Run validation on module load
validateWebAuthnConfig();

export default async function authRoutes(server: FastifyInstance) {
  const enableRateLimit = process.env.ENABLE_AUTH_RATE_LIMIT !== 'false';
  const rl = (max: number) =>
    enableRateLimit
      ? ({
          config: {
            rateLimit: {
              max,
              timeWindow: '15 minutes',
            },
          },
        } as const)
      : ({} as const);
  /**
   * POST /api/auth/register/generate-options
   * Generate registration options for a new user
   */
  server.post<{ Body: { username: string } }>(
    '/register/generate-options',
    rl(5),
    async (request: FastifyRequest<{ Body: { username: string } }>, reply: FastifyReply) => {
      const { username } = request.body;

      if (!username || username.length < 3) {
        return reply.code(400).send({ error: 'Username must be at least 3 characters' });
      }

      try {
        // Check if username already exists - reject for initial registration
        const existingUser = await getUserByUsername(username);
        if (existingUser) {
          return reply.code(409).send({
            error: 'Username already exists. If this is your account, log in first and use the add device flow.'
          });
        }

        // Generate registration options (new user, no excludeCredentials)
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: RP_ID,
          userName: username,
          // Don't prompt users for additional information about the authenticator
          attestationType: 'none',
          // No excludeCredentials for new users
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        });

        // Store challenge in session for verification
        request.session.challenge = options.challenge;
        request.session.username = username;

        server.log.info({ sessionId: request.session.sessionId, username }, 'Stored challenge in session, sending response');
        return reply.send(options);
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to generate registration options' });
      }
    }
  );

  /**
   * POST /api/auth/register/verify
   * Verify registration response and create user + authenticator
   */
  server.post<{ Body: RegistrationResponseJSON }>(
    '/register/verify',
    rl(10),
    async (request: FastifyRequest<{ Body: RegistrationResponseJSON }>, reply: FastifyReply) => {
      const body = request.body;
      const expectedChallenge = request.session.challenge;
      const username = request.session.username;

      if (!expectedChallenge || !username) {
        return reply.code(400).send({ error: 'Invalid session' });
      }

      try {
        // Verify the registration response
        const verification = await verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: EXPECTED_ORIGIN,
          expectedRPID: RP_ID,
        });

        const { verified, registrationInfo } = verification;

        if (!verified || !registrationInfo) {
          return reply.code(400).send({ error: 'Registration verification failed' });
        }

        // Double-check user doesn't exist (security check)
        const existingUser = await getUserByUsername(username);
        if (existingUser) {
          return reply.code(409).send({
            error: 'Username already exists. Use the add device flow instead.'
          });
        }

        // Create new user
        const user = await createUser({
          username,
          displayName: username,
        });

        // Store authenticator
        await createAuthenticator({
          userId: user.id,
          credentialId: registrationInfo.credential.id,
          credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
          counter: registrationInfo.credential.counter,
          credentialDeviceType: registrationInfo.credentialDeviceType,
          credentialBackedUp: registrationInfo.credentialBackedUp,
          transports: body.response.transports?.join(',') || null,
        });

        // Clear challenge from session
        request.session.challenge = undefined;
        request.session.username = undefined;

        // Set user ID in session (log them in)
        request.session.userId = user.id;

        return reply.send({
          verified: true,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            isAdmin: (user as any).isAdmin ?? false,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to verify registration' });
      }
    }
  );

  /**
   * POST /api/auth/login/generate-options
   * Generate authentication options for existing user
   */
  server.post<{ Body: { username: string } }>(
    '/login/generate-options',
    rl(10),
    async (request: FastifyRequest<{ Body: { username: string } }>, reply: FastifyReply) => {
      const { username } = request.body;

      if (!username) {
        return reply.code(400).send({ error: 'Username is required' });
      }

      try {
        // Get user
        const user = await getUserByUsername(username);
        if (!user) {
          return reply.code(404).send({ error: 'User not found' });
        }

        // Get user's authenticators
        const authenticators = await getAuthenticatorsByUserId(user.id);

        if (authenticators.length === 0) {
          return reply.code(400).send({ error: 'No authenticators found for user' });
        }

        // Generate authentication options
        const options = await generateAuthenticationOptions({
          rpID: RP_ID,
          allowCredentials: authenticators.map((auth) => ({
            id: auth.credentialId,
            transports: auth.transports?.split(',') as any,
          })),
          userVerification: 'preferred',
        });

        // Store challenge in session
        request.session.challenge = options.challenge;
        request.session.username = username;

        return reply.send(options);
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to generate login options' });
      }
    }
  );

  /**
   * POST /api/auth/login/verify
   * Verify authentication response and log user in
   */
  server.post<{ Body: AuthenticationResponseJSON }>(
    '/login/verify',
    rl(10),
    async (request: FastifyRequest<{ Body: AuthenticationResponseJSON }>, reply: FastifyReply) => {
      const body = request.body;
      const expectedChallenge = request.session.challenge;
      const username = request.session.username;

      if (!expectedChallenge || !username) {
        return reply.code(400).send({ error: 'Invalid session' });
      }

      try {
        // Get user
        const user = await getUserByUsername(username);
        if (!user) {
          return reply.code(404).send({ error: 'User not found' });
        }

        // Get authenticator
        const credentialId = Buffer.from(body.id, 'base64url').toString('base64url');
        const authenticator = await getAuthenticatorByCredentialId(credentialId);

        if (!authenticator || authenticator.userId !== user.id) {
          return reply.code(400).send({ error: 'Authenticator not found' });
        }

        // Verify the authentication response
        const verification = await verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: EXPECTED_ORIGIN,
          expectedRPID: RP_ID,
          credential: {
            id: authenticator.credentialId,
            publicKey: new Uint8Array(authenticator.credentialPublicKey),
            counter: authenticator.counter,
          },
        });

        const { verified, authenticationInfo } = verification;

        if (!verified) {
          return reply.code(400).send({ error: 'Authentication verification failed' });
        }

        // Update authenticator counter
        await updateAuthenticatorCounter(authenticator.credentialId, authenticationInfo.newCounter);

        // Clear challenge from session
        request.session.challenge = undefined;
        request.session.username = undefined;

        // Set user ID in session (log them in)
        request.session.userId = user.id;

        return reply.send({
          verified: true,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            isAdmin: (user as any).isAdmin ?? false,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to verify authentication' });
      }
    }
  );

  /**
   * GET /api/auth/me
   * Get current authenticated user
   */
  server.get('/me', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }

    return reply.send({
      user: {
        id: request.user.id,
        username: request.user.username,
        displayName: request.user.displayName,
        isAdmin: (request.user as any).isAdmin ?? false,
      },
    });
  });

  /**
   * POST /api/auth/logout
   * Log out current user
   */
  server.post('/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    request.session.userId = undefined;
    request.session.challenge = undefined;
    request.session.username = undefined;

    return reply.send({ message: 'Logged out successfully' });
  });

  /**
   * POST /api/auth/add-device/generate-options
   * Generate registration options for adding a new device to the current authenticated user
   * REQUIRES AUTHENTICATION - this prevents unauthorized device additions
   */
  server.post(
    '/add-device/generate-options',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      try {
        // Get existing authenticators to populate excludeCredentials
        const authenticators = await getAuthenticatorsByUserId(request.user.id);
        const excludeCredentials = authenticators.map((auth) => ({
          id: auth.credentialId,
          transports: auth.transports?.split(',') as any,
        }));

        // Generate registration options for adding a device
        const options = await generateRegistrationOptions({
          rpName: RP_NAME,
          rpID: RP_ID,
          userName: request.user.username,
          userDisplayName: request.user.displayName ?? undefined,
          attestationType: 'none',
          excludeCredentials, // Prevent re-registering existing authenticators
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        });

        // Store challenge in session for verification
        request.session.challenge = options.challenge;
        request.session.addDeviceUserId = request.user.id; // Store user ID for verification

        return reply.send(options);
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to generate add device options' });
      }
    }
  );

  /**
   * POST /api/auth/add-device/verify
   * Verify and add a new device to the current authenticated user
   * REQUIRES AUTHENTICATION - this prevents unauthorized device additions
   */
  server.post<{ Body: RegistrationResponseJSON }>(
    '/add-device/verify',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Body: RegistrationResponseJSON }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Authentication required' });
      }

      const body = request.body;
      const expectedChallenge = request.session.challenge;
      const addDeviceUserId = request.session.addDeviceUserId;

      if (!expectedChallenge || !addDeviceUserId) {
        return reply.code(400).send({ error: 'Invalid session' });
      }

      // Security check: ensure the session user matches
      if (addDeviceUserId !== request.user.id) {
        return reply.code(403).send({ error: 'User mismatch' });
      }

      try {
        // Verify the registration response
        const verification = await verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: EXPECTED_ORIGIN,
          expectedRPID: RP_ID,
        });

        const { verified, registrationInfo } = verification;

        if (!verified || !registrationInfo) {
          return reply.code(400).send({ error: 'Device verification failed' });
        }

        // Add authenticator to the current authenticated user
        await createAuthenticator({
          userId: request.user.id,
          credentialId: registrationInfo.credential.id,
          credentialPublicKey: Buffer.from(registrationInfo.credential.publicKey),
          counter: registrationInfo.credential.counter,
          credentialDeviceType: registrationInfo.credentialDeviceType,
          credentialBackedUp: registrationInfo.credentialBackedUp,
          transports: body.response.transports?.join(',') || null,
        });

        // Clear challenge from session
        request.session.challenge = undefined;
        request.session.addDeviceUserId = undefined;

        return reply.send({
          verified: true,
          message: 'Device added successfully',
          user: {
            id: request.user.id,
            username: request.user.username,
            displayName: request.user.displayName,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to add device' });
      }
    }
  );

  /**
   * GET /api/auth/devices
   * List all registered devices/authenticators for current user
   */
  server.get('/devices', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }

    try {
      const authenticators = await getAuthenticatorsByUserId(request.user.id);

      return reply.send({
        devices: authenticators.map((auth) => ({
          id: auth.id,
          credentialId: auth.credentialId,
          deviceType: auth.credentialDeviceType,
          backedUp: auth.credentialBackedUp,
          transports: auth.transports?.split(',').filter(Boolean) || [],
          createdAt: auth.createdAt,
        })),
      });
    } catch (error) {
      server.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch devices' });
    }
  });

  /**
   * DELETE /api/auth/devices/:id
   * Remove a registered device/authenticator
   */
  server.delete<{ Params: { id: string } }>(
    '/devices/:id',
    { preHandler: requireAuth },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { id } = request.params;

      try {
        // Get all user's authenticators to ensure they're not deleting their last one
        const authenticators = await getAuthenticatorsByUserId(request.user.id);

        if (authenticators.length <= 1) {
          return reply.code(400).send({
            error: 'Cannot remove last device. Add another device first.',
          });
        }

        // Verify the authenticator belongs to this user
        const authenticator = authenticators.find((auth) => auth.id === id);
        if (!authenticator) {
          return reply.code(404).send({ error: 'Device not found' });
        }

        // Delete the authenticator
        const deleted = await deleteAuthenticator(id);

        if (!deleted) {
          return reply.code(500).send({ error: 'Failed to remove device' });
        }

        return reply.send({
          message: 'Device removed successfully',
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to remove device' });
      }
    }
  );
}
