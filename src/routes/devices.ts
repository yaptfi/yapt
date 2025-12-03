import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth';
import {
  getUserDevices,
  createDevice,
  updateDevice,
  deleteDevice,
  countActiveDevices,
} from '../models/device';
import { DeviceType, ApnsEnvironment } from '../types';

export default async function deviceRoutes(server: FastifyInstance) {
  /**
   * POST /api/devices/register
   * Register a new device for push notifications
   */
  server.post<{
    Body: {
      deviceType: DeviceType;
      pushToken: string;
      deviceName?: string;
      deviceId?: string;
      endpoint?: string;
      environment?: ApnsEnvironment;
    };
  }>(
    '/register',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Body: {
          deviceType: DeviceType;
          pushToken: string;
          deviceName?: string;
          deviceId?: string;
          endpoint?: string;
          environment?: ApnsEnvironment;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { deviceType, pushToken, deviceName, deviceId, endpoint, environment } = request.body;

      // Validate required fields
      if (!deviceType || !pushToken) {
        return reply.code(400).send({ error: 'deviceType and pushToken are required' });
      }

      // Validate deviceType
      const validDeviceTypes: DeviceType[] = ['ios', 'android', 'web'];
      if (!validDeviceTypes.includes(deviceType)) {
        return reply.code(400).send({ error: 'Invalid deviceType (must be ios, android, or web)' });
      }

      // Validate environment for iOS devices
      if (deviceType === 'ios' && environment) {
        const validEnvironments: ApnsEnvironment[] = ['production', 'sandbox'];
        if (!validEnvironments.includes(environment)) {
          return reply.code(400).send({ error: 'Invalid environment (must be production or sandbox)' });
        }
      }

      // Validate pushToken format (basic validation)
      if (pushToken.length < 10 || pushToken.length > 500) {
        return reply.code(400).send({ error: 'Invalid pushToken format' });
      }

      try {
        const device = await createDevice({
          userId: request.user.id,
          deviceType,
          pushToken,
          deviceName,
          deviceId,
          endpoint,
          environment,
        });

        return reply.code(201).send({
          id: device.id,
          deviceType: device.deviceType,
          deviceName: device.deviceName,
          isActive: device.isActive,
          environment: device.environment,
          createdAt: device.createdAt,
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to register device' });
      }
    }
  );

  /**
   * GET /api/devices
   * Get all devices for current user
   */
  server.get(
    '/',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        const devices = await getUserDevices(request.user.id);

        // Don't expose full push tokens in list view (security)
        const sanitizedDevices = devices.map((device) => ({
          id: device.id,
          deviceType: device.deviceType,
          deviceName: device.deviceName,
          isActive: device.isActive,
          environment: device.environment,
          lastUsedAt: device.lastUsedAt,
          createdAt: device.createdAt,
          // Only show last 8 characters of push token
          pushTokenPreview: device.pushToken.slice(-8),
        }));

        return reply.send({ devices: sanitizedDevices });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to fetch devices' });
      }
    }
  );

  /**
   * PUT /api/devices/:id
   * Update an existing device
   */
  server.put<{
    Params: { id: string };
    Body: {
      pushToken?: string;
      deviceName?: string;
      isActive?: boolean;
      environment?: ApnsEnvironment;
    };
  }>(
    '/:id',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: {
          pushToken?: string;
          deviceName?: string;
          isActive?: boolean;
          environment?: ApnsEnvironment;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { id } = request.params;
      const { pushToken, deviceName, isActive, environment } = request.body;

      // Validate environment if provided
      if (environment) {
        const validEnvironments: ApnsEnvironment[] = ['production', 'sandbox'];
        if (!validEnvironments.includes(environment)) {
          return reply.code(400).send({ error: 'Invalid environment (must be production or sandbox)' });
        }
      }

      // Validate pushToken if provided
      if (pushToken && (pushToken.length < 10 || pushToken.length > 500)) {
        return reply.code(400).send({ error: 'Invalid pushToken format' });
      }

      try {
        const device = await updateDevice(id, request.user.id, {
          pushToken,
          deviceName,
          isActive,
          environment,
        });

        if (!device) {
          return reply.code(404).send({ error: 'Device not found or access denied' });
        }

        return reply.send({
          id: device.id,
          deviceType: device.deviceType,
          deviceName: device.deviceName,
          isActive: device.isActive,
          environment: device.environment,
          updatedAt: device.updatedAt,
        });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to update device' });
      }
    }
  );

  /**
   * DELETE /api/devices/:id
   * Delete a device registration
   */
  server.delete<{
    Params: { id: string };
  }>(
    '/:id',
    { preHandler: requireAuth },
    async (
      request: FastifyRequest<{
        Params: { id: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      const { id } = request.params;

      try {
        const deleted = await deleteDevice(id, request.user.id);

        if (!deleted) {
          return reply.code(404).send({ error: 'Device not found or access denied' });
        }

        return reply.send({ message: 'Device deleted successfully' });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to delete device' });
      }
    }
  );

  /**
   * GET /api/devices/count
   * Get count of active devices for current user
   */
  server.get(
    '/count',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'Not authenticated' });
      }

      try {
        const count = await countActiveDevices(request.user.id);
        return reply.send({ count });
      } catch (error) {
        server.log.error(error);
        return reply.code(500).send({ error: 'Failed to count devices' });
      }
    }
  );
}
