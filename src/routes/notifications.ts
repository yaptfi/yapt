import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth';
import {
  getNotificationSettings,
  upsertNotificationSettings,
  deleteNotificationSettings,
} from '../models/notificationSettings';
import { getNotificationLogsWithCount } from '../models/notificationLog';
import { createDevice, deleteDevice } from '../models/device';
import { NotificationSeverity, NotificationType, DeviceType } from '../types';

export default async function notificationRoutes(server: FastifyInstance) {
  /**
   * GET /api/notifications/settings
   * Get notification settings for current user
   */
  server.get(
    '/settings',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        const settings = await getNotificationSettings(request.user.id);

        if (!settings) {
          // Return default settings if none exist
          return reply.send({
            settings: {
              depegEnabled: false,
              depegSeverity: 'default',
              depegLowerThreshold: 0.99,
              depegUpperThreshold: null,
              depegSymbols: null, // null => all supported stablecoins
              apyEnabled: false,
              apySeverity: 'default',
              apyThreshold: 0.01,
              ntfyTopic: null,
            },
          });
        }

        return reply.send({
          settings: {
            depegEnabled: settings.depegEnabled,
            depegSeverity: settings.depegSeverity,
            depegLowerThreshold: parseFloat(settings.depegLowerThreshold),
            depegUpperThreshold: settings.depegUpperThreshold ? parseFloat(settings.depegUpperThreshold) : null,
            depegSymbols: settings.depegSymbols,
            apyEnabled: settings.apyEnabled,
            apySeverity: settings.apySeverity,
            apyThreshold: parseFloat(settings.apyThreshold),
            ntfyTopic: settings.ntfyTopic,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch notification settings' });
      }
    }
  );

  /**
   * PUT /api/notifications/settings
   * Update notification settings for current user
   */
  server.put<{
    Body: {
      depegEnabled?: boolean;
      depegSeverity?: NotificationSeverity;
      depegLowerThreshold?: string;
      depegUpperThreshold?: string | null;
      depegSymbols?: string[] | null;
      apyEnabled?: boolean;
      apySeverity?: NotificationSeverity;
      apyThreshold?: string;
    };
  }>(
    '/settings',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Body: {
          depegEnabled?: boolean;
          depegSeverity?: NotificationSeverity;
          depegLowerThreshold?: string;
          depegUpperThreshold?: string | null;
          depegSymbols?: string[] | null;
          apyEnabled?: boolean;
          apySeverity?: NotificationSeverity;
          apyThreshold?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const {
        depegEnabled,
        depegLowerThreshold,
        depegUpperThreshold,
        apyEnabled,
        apyThreshold,
      } = request.body;

      let { depegSeverity, apySeverity, depegSymbols } = request.body;

      // Normalize legacy value 'medium' -> 'default' (cast to string to tolerate unexpected values)
      if ((depegSeverity as unknown as string) === 'medium') depegSeverity = 'default' as NotificationSeverity;
      if ((apySeverity as unknown as string) === 'medium') apySeverity = 'default' as NotificationSeverity;

      // Validate severity values if provided
      const validSeverities: NotificationSeverity[] = ['min', 'low', 'default', 'high', 'urgent'];
      if (depegSeverity && !validSeverities.includes(depegSeverity)) {
        return reply.code(400).send({ error: 'Invalid depeg severity' });
      }
      if (apySeverity && !validSeverities.includes(apySeverity)) {
        return reply.code(400).send({ error: 'Invalid APY severity' });
      }

      // Validate thresholds if provided
      if (depegLowerThreshold !== undefined) {
        const value = parseFloat(depegLowerThreshold);
        if (isNaN(value) || value < 0 || value > 2) {
          return reply.code(400).send({ error: 'Invalid depeg lower threshold (must be 0-2)' });
        }
      }

      if (depegUpperThreshold !== undefined && depegUpperThreshold !== null) {
        const value = parseFloat(depegUpperThreshold);
        if (isNaN(value) || value < 0 || value > 2) {
          return reply.code(400).send({ error: 'Invalid depeg upper threshold (must be 0-2)' });
        }
      }

      if (apyThreshold !== undefined) {
        const value = parseFloat(apyThreshold);
        if (isNaN(value) || value < 0 || value > 1) {
          return reply.code(400).send({ error: 'Invalid APY threshold (must be 0-1 as decimal)' });
        }
      }

      // Validate depegSymbols if provided
      if (depegSymbols !== undefined && depegSymbols !== null) {
        if (!Array.isArray(depegSymbols)) {
          return reply.code(400).send({ error: 'Invalid depegSymbols (must be an array of symbols or null)' });
        }
        if (depegSymbols.some((s) => typeof s !== 'string' || s.length < 2 || s.length > 16)) {
          return reply.code(400).send({ error: 'Invalid stablecoin symbol in depegSymbols' });
        }
        // Normalize to uppercase
        depegSymbols = depegSymbols.map((s) => s.toUpperCase());
      }

      try {
        const settings = await upsertNotificationSettings(request.user.id, {
          depegEnabled,
          depegSeverity,
          depegLowerThreshold,
          depegUpperThreshold,
          depegSymbols,
          apyEnabled,
          apySeverity,
          apyThreshold,
        });

        return reply.send({
          settings: {
            depegEnabled: settings.depegEnabled,
            depegSeverity: settings.depegSeverity,
            depegLowerThreshold: parseFloat(settings.depegLowerThreshold),
            depegUpperThreshold: settings.depegUpperThreshold ? parseFloat(settings.depegUpperThreshold) : null,
            depegSymbols: settings.depegSymbols,
            apyEnabled: settings.apyEnabled,
            apySeverity: settings.apySeverity,
            apyThreshold: parseFloat(settings.apyThreshold),
            ntfyTopic: settings.ntfyTopic,
          },
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to update notification settings' });
      }
    }
  );

  /**
   * DELETE /api/notifications/settings
   * Delete notification settings for current user
   */
  server.delete(
    '/settings',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        await deleteNotificationSettings(request.user.id);
        return reply.send({ message: 'Notification settings deleted' });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to delete notification settings' });
      }
    }
  );

  /**
   * GET /api/notifications/history
   * Get notification history for current user
   */
  server.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      type?: 'depeg' | 'apy' | 'apy_drop';
    };
  }>(
    '/history',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Querystring: {
          limit?: string;
          offset?: string;
          type?: 'depeg' | 'apy' | 'apy_drop';
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        const limit = Math.min(request.query.limit ? parseInt(request.query.limit) : 50, 100);
        const offset = request.query.offset ? parseInt(request.query.offset) : 0;

        // Map 'apy' to 'apy_drop' for backwards compatibility with iOS app
        let notificationType: NotificationType | undefined;
        if (request.query.type === 'apy') {
          notificationType = 'apy_drop';
        } else if (request.query.type) {
          notificationType = request.query.type as NotificationType;
        }

        const { notifications, total } = await getNotificationLogsWithCount(request.user.id, {
          limit,
          offset,
          notificationType,
        });

        // Map field names for iOS compatibility
        const mappedNotifications = notifications.map((log) => ({
          id: log.id,
          type: log.notificationType === 'apy_drop' ? 'apy' : log.notificationType,
          severity: log.severity,
          title: log.title,
          message: log.message,
          metadata: {
            positionId: log.metadata?.positionId ?? null,
            walletId: log.metadata?.walletId ?? null,
            symbol: log.metadata?.stablecoin ?? log.metadata?.symbol ?? null,
            price: log.metadata?.price ?? null,
            deviation: log.metadata?.deviation ?? null,
            oldApy: log.metadata?.oldApy ?? null,
            newApy: log.metadata?.newApy ?? log.metadata?.currentApy ?? null,
            change: log.metadata?.change ?? null,
          },
          createdAt: log.sentAt,
        }));

        return reply.send({
          notifications: mappedNotifications,
          total,
          hasMore: offset + notifications.length < total,
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch notification history' });
      }
    }
  );

  /**
   * POST /api/notifications/devices
   * Register an iOS device for push notifications
   */
  server.post<{
    Body: {
      token: string;
      platform: 'ios';
    };
  }>(
    '/devices',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Body: {
          token: string;
          platform: 'ios';
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { token, platform } = request.body;

      // Validate required fields
      if (!token || !platform) {
        return reply.code(400).send({ error: 'token and platform are required' });
      }

      // Validate platform
      if (platform !== 'ios') {
        return reply.code(400).send({ error: 'Invalid platform (must be ios)' });
      }

      // Validate token format (APNs tokens are 64 hex characters)
      if (!/^[a-fA-F0-9]{64}$/.test(token)) {
        return reply.code(400).send({ error: 'Invalid token format (must be 64 hex characters)' });
      }

      try {
        const device = await createDevice({
          userId: request.user.id,
          deviceType: platform as DeviceType,
          pushToken: token,
          environment: 'production', // Default to production for iOS
        });

        return reply.code(201).send({
          deviceId: device.id,
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to register device' });
      }
    }
  );

  /**
   * DELETE /api/notifications/devices/:deviceId
   * Unregister a device from push notifications
   */
  server.delete<{
    Params: { deviceId: string };
  }>(
    '/devices/:deviceId',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Params: { deviceId: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { deviceId } = request.params;

      try {
        // Delete device - idempotent, succeeds even if not found
        await deleteDevice(deviceId, request.user.id);
        return reply.code(204).send();
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to unregister device' });
      }
    }
  );
}
