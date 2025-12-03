import { query, queryOne } from '../utils/db';
import { DevicePushToken, DeviceType, ApnsEnvironment } from '../types';

/**
 * Get all active devices for a user
 */
export async function getActiveDevices(userId: string): Promise<DevicePushToken[]> {
  return query<DevicePushToken>(
    `SELECT
      id,
      user_id as "userId",
      device_type as "deviceType",
      device_name as "deviceName",
      device_id as "deviceId",
      push_token as "pushToken",
      endpoint,
      is_active as "isActive",
      environment,
      last_used_at as "lastUsedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"
     FROM device_push_token
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
}

/**
 * Get all devices for a user (including inactive)
 */
export async function getUserDevices(userId: string): Promise<DevicePushToken[]> {
  return query<DevicePushToken>(
    `SELECT
      id,
      user_id as "userId",
      device_type as "deviceType",
      device_name as "deviceName",
      device_id as "deviceId",
      push_token as "pushToken",
      endpoint,
      is_active as "isActive",
      environment,
      last_used_at as "lastUsedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"
     FROM device_push_token
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
}

/**
 * Get a specific device by ID (with ownership check)
 */
export async function getDeviceById(deviceId: string, userId: string): Promise<DevicePushToken | null> {
  return queryOne<DevicePushToken>(
    `SELECT
      id,
      user_id as "userId",
      device_type as "deviceType",
      device_name as "deviceName",
      device_id as "deviceId",
      push_token as "pushToken",
      endpoint,
      is_active as "isActive",
      environment,
      last_used_at as "lastUsedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"
     FROM device_push_token
     WHERE id = $1 AND user_id = $2`,
    [deviceId, userId]
  );
}

/**
 * Create a new device registration
 */
export async function createDevice(data: {
  userId: string;
  deviceType: DeviceType;
  pushToken: string;
  deviceName?: string;
  deviceId?: string;
  endpoint?: string;
  environment?: ApnsEnvironment;
}): Promise<DevicePushToken> {
  const result = await queryOne<DevicePushToken>(
    `INSERT INTO device_push_token (
      user_id,
      device_type,
      push_token,
      device_name,
      device_id,
      endpoint,
      environment
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, push_token)
    DO UPDATE SET
      device_name = COALESCE($4, device_push_token.device_name),
      device_id = COALESCE($5, device_push_token.device_id),
      endpoint = COALESCE($6, device_push_token.endpoint),
      environment = COALESCE($7, device_push_token.environment),
      is_active = true,
      updated_at = NOW()
    RETURNING
      id,
      user_id as "userId",
      device_type as "deviceType",
      device_name as "deviceName",
      device_id as "deviceId",
      push_token as "pushToken",
      endpoint,
      is_active as "isActive",
      environment,
      last_used_at as "lastUsedAt",
      created_at as "createdAt",
      updated_at as "updatedAt"`,
    [
      data.userId,
      data.deviceType,
      data.pushToken,
      data.deviceName ?? null,
      data.deviceId ?? null,
      data.endpoint ?? null,
      data.environment ?? null,
    ]
  );

  if (!result) {
    throw new Error('Failed to create device registration');
  }

  return result;
}

/**
 * Update an existing device
 */
export async function updateDevice(
  deviceId: string,
  userId: string,
  data: {
    pushToken?: string;
    deviceName?: string;
    isActive?: boolean;
    environment?: ApnsEnvironment;
  }
): Promise<DevicePushToken | null> {
  // Build dynamic update query based on provided fields
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.pushToken !== undefined) {
    updates.push(`push_token = $${paramIndex++}`);
    values.push(data.pushToken);
  }

  if (data.deviceName !== undefined) {
    updates.push(`device_name = $${paramIndex++}`);
    values.push(data.deviceName);
  }

  if (data.isActive !== undefined) {
    updates.push(`is_active = $${paramIndex++}`);
    values.push(data.isActive);
  }

  if (data.environment !== undefined) {
    updates.push(`environment = $${paramIndex++}`);
    values.push(data.environment);
  }

  if (updates.length === 0) {
    // No updates provided, just return current device
    return getDeviceById(deviceId, userId);
  }

  updates.push('updated_at = NOW()');

  // Add WHERE clause parameters
  values.push(deviceId);
  const deviceIdParam = paramIndex++;
  values.push(userId);
  const userIdParam = paramIndex;

  return queryOne<DevicePushToken>(
    `UPDATE device_push_token
     SET ${updates.join(', ')}
     WHERE id = $${deviceIdParam} AND user_id = $${userIdParam}
     RETURNING
       id,
       user_id as "userId",
       device_type as "deviceType",
       device_name as "deviceName",
       device_id as "deviceId",
       push_token as "pushToken",
       endpoint,
       is_active as "isActive",
       environment,
       last_used_at as "lastUsedAt",
       created_at as "createdAt",
       updated_at as "updatedAt"`,
    values
  );
}

/**
 * Update last_used_at timestamp for a device (called after successful notification)
 */
export async function updateDeviceLastUsed(deviceId: string): Promise<void> {
  await query(
    `UPDATE device_push_token
     SET last_used_at = NOW()
     WHERE id = $1`,
    [deviceId]
  );
}

/**
 * Delete a device registration
 */
export async function deleteDevice(deviceId: string, userId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM device_push_token
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [deviceId, userId]
  );
  return result.length > 0;
}

/**
 * Count active devices for a user
 */
export async function countActiveDevices(userId: string): Promise<number> {
  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM device_push_token
     WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  return parseInt(result?.count ?? '0', 10);
}
