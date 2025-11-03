import { query, queryOne } from '../utils/db';
import { NotificationSettings, NotificationSeverity } from '../types';
import { randomBytes } from 'crypto';

/**
 * Get notification settings for a user
 */
export async function getNotificationSettings(userId: string): Promise<NotificationSettings | null> {
  return queryOne<NotificationSettings>(
    `SELECT
      id,
      user_id as "userId",
      depeg_enabled as "depegEnabled",
      depeg_severity as "depegSeverity",
      depeg_lower_threshold::text as "depegLowerThreshold",
      depeg_upper_threshold::text as "depegUpperThreshold",
      depeg_symbols as "depegSymbols",
      apy_enabled as "apyEnabled",
      apy_severity as "apySeverity",
      apy_threshold::text as "apyThreshold",
      ntfy_topic as "ntfyTopic",
      created_at as "createdAt",
      updated_at as "updatedAt"
     FROM notification_settings
     WHERE user_id = $1`,
    [userId]
  );
}

/**
 * Get all notification settings (for monitoring/jobs)
 */
export async function getAllNotificationSettings(): Promise<NotificationSettings[]> {
  return query<NotificationSettings>(
    `SELECT
      id,
      user_id as "userId",
      depeg_enabled as "depegEnabled",
      depeg_severity as "depegSeverity",
      depeg_lower_threshold::text as "depegLowerThreshold",
      depeg_upper_threshold::text as "depegUpperThreshold",
      depeg_symbols as "depegSymbols",
      apy_enabled as "apyEnabled",
      apy_severity as "apySeverity",
      apy_threshold::text as "apyThreshold",
      ntfy_topic as "ntfyTopic",
      created_at as "createdAt",
      updated_at as "updatedAt"
     FROM notification_settings
     WHERE depeg_enabled = true OR apy_enabled = true`
  );
}

/**
 * Generate a unique ntfy topic for a user
 */
function generateNtfyTopic(): string {
  // Generate a random topic like: yapt-a3f7c9d2
  const randomPart = randomBytes(4).toString('hex');
  return `yapt-${randomPart}`;
}

/**
 * Ensure ntfy topic exists for user (create if missing)
 */
async function ensureNtfyTopic(userId: string): Promise<string> {
  const settings = await getNotificationSettings(userId);

  if (settings?.ntfyTopic) {
    return settings.ntfyTopic;
  }

  // Generate new unique topic for this user
  const topic = generateNtfyTopic();

  await query(
    `UPDATE notification_settings
     SET ntfy_topic = $1, updated_at = NOW()
     WHERE user_id = $2`,
    [topic, userId]
  );

  return topic;
}

/**
 * Create or update notification settings for a user
 */
export async function upsertNotificationSettings(
  userId: string,
  data: {
    depegEnabled?: boolean;
    depegSeverity?: NotificationSeverity;
    depegLowerThreshold?: string;
    depegUpperThreshold?: string | null;
    depegSymbols?: string[] | null;
    apyEnabled?: boolean;
    apySeverity?: NotificationSeverity;
    apyThreshold?: string;
  }
): Promise<NotificationSettings> {
  // Auto-generate ntfy topic if enabling notifications for the first time
  let ntfyTopic: string | null = null;
  if (data.depegEnabled || data.apyEnabled) {
    ntfyTopic = await ensureNtfyTopic(userId);
  }

  // Normalize severities: map legacy 'medium' -> 'default'; set defaults when missing
  const normalizedDepegSeverity: NotificationSeverity | undefined =
    ((data.depegSeverity as unknown as string) === 'medium') ? 'default' : (data.depegSeverity ?? 'default');
  const normalizedApySeverity: NotificationSeverity | undefined =
    ((data.apySeverity as unknown as string) === 'medium') ? 'default' : (data.apySeverity ?? 'default');

  const depegSymbolsProvided = Object.prototype.hasOwnProperty.call(data, 'depegSymbols');

  const result = await queryOne<NotificationSettings>(
    `INSERT INTO notification_settings (
      user_id,
      depeg_enabled,
      depeg_severity,
      depeg_lower_threshold,
      depeg_upper_threshold,
      depeg_symbols,
      apy_enabled,
      apy_severity,
      apy_threshold,
      ntfy_topic
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (user_id)
    DO UPDATE SET
      depeg_enabled = COALESCE($2, notification_settings.depeg_enabled),
      depeg_severity = COALESCE($3, notification_settings.depeg_severity),
      depeg_lower_threshold = COALESCE($4, notification_settings.depeg_lower_threshold),
      depeg_upper_threshold = CASE WHEN $5 IS NOT NULL THEN $5::numeric ELSE notification_settings.depeg_upper_threshold END,
      depeg_symbols = CASE WHEN $11::boolean IS TRUE THEN $6 ELSE notification_settings.depeg_symbols END,
      apy_enabled = COALESCE($7, notification_settings.apy_enabled),
      apy_severity = COALESCE($8, notification_settings.apy_severity),
      apy_threshold = COALESCE($9, notification_settings.apy_threshold),
      ntfy_topic = COALESCE($10, notification_settings.ntfy_topic),
      updated_at = NOW()
    RETURNING
      id,
      user_id as "userId",
      depeg_enabled as "depegEnabled",
      depeg_severity as "depegSeverity",
      depeg_lower_threshold::text as "depegLowerThreshold",
      depeg_upper_threshold::text as "depegUpperThreshold",
      depeg_symbols as "depegSymbols",
      apy_enabled as "apyEnabled",
      apy_severity as "apySeverity",
      apy_threshold::text as "apyThreshold",
      ntfy_topic as "ntfyTopic",
      created_at as "createdAt",
      updated_at as "updatedAt"`,
    [
      userId,
      data.depegEnabled,
      normalizedDepegSeverity,
      data.depegLowerThreshold,
      data.depegUpperThreshold,
      data.depegSymbols ?? null,
      data.apyEnabled,
      normalizedApySeverity,
      data.apyThreshold,
      ntfyTopic,
      depegSymbolsProvided,
    ]
  );

  if (!result) {
    throw new Error('Failed to upsert notification settings');
  }

  return result;
}

/**
 * Delete notification settings for a user
 */
export async function deleteNotificationSettings(userId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM notification_settings WHERE user_id = $1 RETURNING id`,
    [userId]
  );
  return result.length > 0;
}
