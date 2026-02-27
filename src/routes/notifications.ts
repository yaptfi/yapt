import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth';
import {
  getNotificationSettings,
  upsertNotificationSettings,
  deleteNotificationSettings,
} from '../models/notificationSettings';
import { getNotificationLogsWithCount } from '../models/notificationLog';
import { createDevice, deleteDevice } from '../models/device';
import { NotificationSeverity, NotificationType, DeviceType, ApyWindow } from '../types';

interface NotificationSettingsResponse {
  depegEnabled: boolean;
  depegSeverity: NotificationSeverity;
  depegLowerThreshold: number;
  depegUpperThreshold: number | null;
  depegSymbols: string[] | null;
  apyEnabled: boolean;
  apySeverity: NotificationSeverity;
  apyThreshold: number;
  apyWindow: ApyWindow;
  ntfyTopic: string | null;
}

function buildSettingsResponse(settings: NotificationSettingsResponse) {
  // Keep both wrapped and flat response shape for compatibility.
  return {
    settings,
    ...settings,
  };
}

export default async function notificationRoutes(server: FastifyInstance) {
  // Add request logging hook for all /devices routes (visible in production)
  server.addHook('onRequest', async (request) => {
    if (request.url.includes('/devices')) {
      server.log.warn({
        method: request.method,
        url: request.url,
        params: (request as any).params,
        userId: (request as any).user?.id,
        headers: {
          cookie: request.headers.cookie ? 'present' : 'missing',
          contentType: request.headers['content-type'],
        },
      }, '[Devices] Incoming request');
    }
  });

  // Add error logging hook for debugging
  server.addHook('onError', async (request, reply, error) => {
    if (request.url.includes('/devices')) {
      server.log.error({
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        error: error.message,
        stack: error.stack,
      }, '[Devices] Request error');
    }
  });

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
          return reply.send(buildSettingsResponse({
            depegEnabled: false,
            depegSeverity: 'default',
            depegLowerThreshold: 0.99,
            depegUpperThreshold: null,
            depegSymbols: null, // null => all supported stablecoins
            apyEnabled: false,
            apySeverity: 'default',
            apyThreshold: 0.01,
            apyWindow: '7d',
            ntfyTopic: null,
          }));
        }

        return reply.send(buildSettingsResponse({
          depegEnabled: settings.depegEnabled,
          depegSeverity: settings.depegSeverity,
          depegLowerThreshold: parseFloat(settings.depegLowerThreshold),
          depegUpperThreshold: settings.depegUpperThreshold ? parseFloat(settings.depegUpperThreshold) : null,
          depegSymbols: settings.depegSymbols,
          apyEnabled: settings.apyEnabled,
          apySeverity: settings.apySeverity,
          apyThreshold: parseFloat(settings.apyThreshold),
          apyWindow: settings.apyWindow,
          ntfyTopic: settings.ntfyTopic,
        }));
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
      apyWindow?: ApyWindow;
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
          apyWindow?: ApyWindow;
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
        apyWindow,
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

      // Validate apyWindow if provided
      if (apyWindow !== undefined) {
        const validWindows: ApyWindow[] = ['4h', '7d'];
        if (!validWindows.includes(apyWindow)) {
          return reply.code(400).send({ error: 'Invalid APY window (must be "4h" or "7d")' });
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
          apyWindow,
        });

        return reply.send(buildSettingsResponse({
          depegEnabled: settings.depegEnabled,
          depegSeverity: settings.depegSeverity,
          depegLowerThreshold: parseFloat(settings.depegLowerThreshold),
          depegUpperThreshold: settings.depegUpperThreshold ? parseFloat(settings.depegUpperThreshold) : null,
          depegSymbols: settings.depegSymbols,
          apyEnabled: settings.apyEnabled,
          apySeverity: settings.apySeverity,
          apyThreshold: parseFloat(settings.apyThreshold),
          apyWindow: settings.apyWindow,
          ntfyTopic: settings.ntfyTopic,
        }));
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
    {
      preHandler: requireAuth,
      // Handle iOS clients sending Content-Type: application/json with empty body
      onRequest: async (request) => {
        if (request.headers['content-type']?.includes('application/json')) {
          delete request.headers['content-type'];
        }
      },
    },
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
        const rawLimit = request.query.limit;
        const rawOffset = request.query.offset;

        if (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) {
          return reply.code(400).send({ error: 'Invalid limit. Must be a positive integer.' });
        }
        if (rawOffset !== undefined && !/^\d+$/.test(rawOffset)) {
          return reply.code(400).send({ error: 'Invalid offset. Must be a non-negative integer.' });
        }

        const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : 50;
        const parsedOffset = rawOffset ? parseInt(rawOffset, 10) : 0;
        const limit = Math.min(Math.max(parsedLimit, 1), 100);
        const offset = Math.max(parsedOffset, 0);

        if (request.query.type && !['depeg', 'apy', 'apy_drop'].includes(request.query.type)) {
          return reply.code(400).send({ error: 'Invalid type. Must be one of: depeg, apy, apy_drop.' });
        }

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
          // Current response contract
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
          // Legacy compatibility fields
          notificationType: log.notificationType,
          sentAt: log.sentAt,
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
      environment?: 'production' | 'sandbox';
    };
  }>(
    '/devices',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Body: {
          token: string;
          platform: 'ios';
          environment?: 'production' | 'sandbox';
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { token, platform, environment } = request.body;

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
          environment: environment || 'production', // Default to production for iOS
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
    {
      preHandler: requireAuth,
      // Handle iOS clients sending Content-Type: application/json with empty body
      onRequest: async (request) => {
        if (request.headers['content-type']?.includes('application/json')) {
          // Remove content-type so Fastify doesn't try to parse empty body as JSON
          delete request.headers['content-type'];
        }
      },
    },
    async (
      request: FastifyRequest<{
        Params: { deviceId: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        server.log.error('[DELETE /devices/:deviceId] Not authenticated');
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { deviceId } = request.params;

      // Log for debugging (use warn level so it appears in production logs)
      server.log.warn(`[DELETE /devices/:deviceId] Attempting to delete device ${deviceId} for user ${request.user.id}`);

      // Validate deviceId format
      if (!deviceId || typeof deviceId !== 'string') {
        server.log.error(`[DELETE /devices/:deviceId] Invalid deviceId format: ${deviceId}`);
        return reply.code(400).send({ error: 'Invalid device ID' });
      }

      try {
        // Delete device - idempotent, succeeds even if not found
        const deleted = await deleteDevice(deviceId, request.user.id);
        server.log.warn(`[DELETE /devices/:deviceId] Device ${deviceId} deleted: ${deleted}`);
        return reply.code(204).send();
      } catch (error) {
        server.log.error(error, '[DELETE /devices/:deviceId] Error deleting device');
        return reply.code(500).send({ error: 'Failed to unregister device' });
      }
    }
  );

  /**
   * POST /api/notifications/test
   * Send a test notification to all registered devices
   */
  server.post(
    '/test',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        // Import device and notification services
        const { getActiveDevices } = await import('../models/device');
        const { sendApnsNotification } = await import('../services/apns');

        // Get user's active devices
        const devices = await getActiveDevices(request.user.id);

        if (devices.length === 0) {
          return reply.send({
            message: 'No active devices registered',
            sent: 0,
            failed: 0,
          });
        }

        // Send test notification to each device
        let sent = 0;
        let failed = 0;

        for (const device of devices) {
          if (device.deviceType !== 'ios' || !device.pushToken) {
            server.log.warn(`[Test Notification] Skipping device ${device.id} - not iOS or no token`);
            failed++;
            continue;
          }

          const success = await sendApnsNotification({
            deviceToken: device.pushToken,
            deviceId: device.id,
            environment: (device.environment as 'production' | 'sandbox') || 'production',
            title: 'Test Notification',
            message: 'This is a test notification from Yapt. If you see this, push notifications are working!',
            severity: 'default',
            data: {
              type: 'test',
              timestamp: new Date().toISOString(),
            },
          });

          if (success) {
            sent++;
            server.log.warn(`[Test Notification] Successfully sent to device ${device.id}`);
          } else {
            failed++;
            server.log.warn(`[Test Notification] Failed to send to device ${device.id}`);
          }
        }

        return reply.send({
          message: `Test notification sent to ${devices.length} device(s)`,
          sent,
          failed,
          devices: devices.map((d) => ({
            id: d.id,
            type: d.deviceType,
            name: d.deviceName,
            environment: d.environment,
          })),
        });
      } catch (error) {
        server.log.error(error, '[Test Notification] Error sending test notification');
        return reply.code(500).send({ error: 'Failed to send test notification' });
      }
    }
  );
}
