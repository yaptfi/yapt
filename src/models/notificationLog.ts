import { query, queryOne } from '../utils/db';
import { NotificationLog, NotificationType, NotificationSeverity } from '../types';

/**
 * Create a notification log entry
 */
export async function createNotificationLog(data: {
  userId: string;
  notificationType: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}): Promise<NotificationLog> {
  const result = await queryOne<NotificationLog>(
    `INSERT INTO notification_log (
      user_id,
      notification_type,
      severity,
      title,
      message,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING
      id,
      user_id as "userId",
      notification_type as "notificationType",
      severity,
      title,
      message,
      metadata,
      sent_at as "sentAt"`,
    [
      data.userId,
      data.notificationType,
      data.severity,
      data.title,
      data.message,
      data.metadata ? JSON.stringify(data.metadata) : null,
    ]
  );

  if (!result) {
    throw new Error('Failed to create notification log');
  }

  return result;
}

/**
 * Get notification logs for a user
 */
export async function getNotificationLogs(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    notificationType?: NotificationType;
  }
): Promise<NotificationLog[]> {
  const limit = options?.limit || 50;
  const offset = options?.offset || 0;

  let whereClause = 'WHERE user_id = $1';
  const params: any[] = [userId];

  if (options?.notificationType) {
    whereClause += ' AND notification_type = $2';
    params.push(options.notificationType);
  }

  return query<NotificationLog>(
    `SELECT
      id,
      user_id as "userId",
      notification_type as "notificationType",
      severity,
      title,
      message,
      metadata,
      sent_at as "sentAt"
     FROM notification_log
     ${whereClause}
     ORDER BY sent_at DESC
     LIMIT ${limit}
     OFFSET ${offset}`,
    params
  );
}

/**
 * Get recent notification logs within a time window (to prevent spam)
 */
export async function getRecentNotifications(
  userId: string,
  notificationType: NotificationType,
  minutesAgo: number
): Promise<NotificationLog[]> {
  return query<NotificationLog>(
    `SELECT
      id,
      user_id as "userId",
      notification_type as "notificationType",
      severity,
      title,
      message,
      metadata,
      sent_at as "sentAt"
     FROM notification_log
     WHERE user_id = $1
       AND notification_type = $2
       AND sent_at > NOW() - INTERVAL '${minutesAgo} minutes'
     ORDER BY sent_at DESC`,
    [userId, notificationType]
  );
}

/**
 * Delete old notification logs (cleanup)
 */
export async function deleteOldNotificationLogs(daysOld: number): Promise<number> {
  const result = await query(
    `DELETE FROM notification_log
     WHERE sent_at < NOW() - INTERVAL '${daysOld} days'
     RETURNING id`
  );
  return result.length;
}
