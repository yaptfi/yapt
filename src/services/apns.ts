import apn from 'apn';
import { getEnvVar } from '../utils/config';
import { NotificationSeverity } from '../types';
import { updateDeviceLastUsed } from '../models/device';

/**
 * APNs provider instance (singleton)
 * Initialized lazily when first notification is sent
 */
let apnsProvider: apn.Provider | null = null;

/**
 * Initialize APNs provider with configuration from environment variables
 */
function getApnsProvider(): apn.Provider | null {
  // Return existing provider if already initialized
  if (apnsProvider) {
    return apnsProvider;
  }

  // Check if APNs is configured
  const keyPath = getEnvVar('APNS_KEY_PATH', '');
  const keyId = getEnvVar('APNS_KEY_ID', '');
  const teamId = getEnvVar('APNS_TEAM_ID', '');

  if (!keyPath || !keyId || !teamId) {
    console.warn('[APNs] Configuration missing - notifications will not be sent to iOS devices');
    console.warn('[APNs] Set APNS_KEY_PATH, APNS_KEY_ID, and APNS_TEAM_ID environment variables');
    return null;
  }

  try {
    apnsProvider = new apn.Provider({
      token: {
        key: keyPath,
        keyId: keyId,
        teamId: teamId,
      },
      production: true, // Use production APNs servers by default
    });

    console.log('[APNs] Provider initialized successfully');
    return apnsProvider;
  } catch (error) {
    console.error('[APNs] Failed to initialize provider:', error);
    return null;
  }
}

/**
 * Priority mapping to APNs priority levels
 * APNs supports: 5 (immediate), 10 (conserve power)
 */
function severityToApnsPriority(severity: NotificationSeverity): number {
  const priorityMap: Record<NotificationSeverity, number> = {
    min: 10,
    low: 10,
    default: 10,
    high: 5,
    urgent: 5,
  };
  return priorityMap[severity] || 10;
}

/**
 * Sound mapping for different severities
 */
function severityToSound(severity: NotificationSeverity): string {
  const soundMap: Record<NotificationSeverity, string> = {
    min: 'default',
    low: 'default',
    default: 'default',
    high: 'default',
    urgent: 'default', // iOS app can define custom sounds
  };
  return soundMap[severity] || 'default';
}

/**
 * Send a notification to an iOS device via APNs
 */
export async function sendApnsNotification(params: {
  deviceToken: string;
  deviceId: string; // Database ID for updating last_used_at
  environment: 'production' | 'sandbox';
  title: string;
  message: string;
  severity: NotificationSeverity;
  badge?: number;
  data?: Record<string, any>;
}): Promise<boolean> {
  const provider = getApnsProvider();

  if (!provider) {
    console.warn('[APNs] Provider not available - skipping notification');
    return false;
  }

  try {
    // Get bundle ID from environment
    const bundleId = getEnvVar('APNS_BUNDLE_ID', 'com.yapt.app');

    // Create notification
    const notification = new apn.Notification();

    // Alert (title + body)
    notification.alert = {
      title: params.title,
      body: params.message,
    };

    // Badge (optional - can show unread count on app icon)
    if (params.badge !== undefined) {
      notification.badge = params.badge;
    }

    // Sound
    notification.sound = severityToSound(params.severity);

    // Priority
    notification.priority = severityToApnsPriority(params.severity);

    // Topic (bundle ID)
    notification.topic = bundleId;

    // Custom data payload (for app to handle)
    if (params.data) {
      notification.payload = params.data;
    }

    // Send notification
    const result = await provider.send(notification, params.deviceToken);

    // Check for errors
    if (result.failed.length > 0) {
      const failure = result.failed[0];
      console.error(`[APNs] Failed to send notification to device ${params.deviceToken.slice(-8)}:`, failure.response);

      // Handle specific error cases
      if (failure.status === '410' || failure.response?.reason === 'Unregistered') {
        console.warn(`[APNs] Device token is invalid or unregistered - device should be marked inactive`);
        // TODO: Mark device as inactive in database
      }

      return false;
    }

    if (result.sent.length > 0) {
      console.log(`[APNs] Successfully sent notification to device ${params.deviceToken.slice(-8)}`);

      // Update last_used_at timestamp
      await updateDeviceLastUsed(params.deviceId);

      return true;
    }

    console.warn(`[APNs] Unexpected result - neither sent nor failed:`, result);
    return false;
  } catch (error) {
    console.error('[APNs] Error sending notification:', error);
    return false;
  }
}

/**
 * Send a stablecoin depeg notification to iOS device
 */
export async function sendApnsDepegNotification(params: {
  deviceToken: string;
  deviceId: string;
  environment: 'production' | 'sandbox';
  stablecoinSymbol: string;
  currentPrice: number;
  threshold: number;
  isUpper: boolean;
  severity: NotificationSeverity;
  positionId?: string;
}): Promise<boolean> {
  const direction = params.isUpper ? 'above' : 'below';
  const title = `${params.stablecoinSymbol} Depegged`;
  const message = `Trading at $${params.currentPrice.toFixed(4)}, ${direction} your threshold of $${params.threshold.toFixed(4)}`;

  return sendApnsNotification({
    deviceToken: params.deviceToken,
    deviceId: params.deviceId,
    environment: params.environment,
    title,
    message,
    severity: params.severity,
    data: {
      type: 'depeg',
      stablecoin: params.stablecoinSymbol,
      price: params.currentPrice,
      threshold: params.threshold,
      isUpper: params.isUpper,
      positionId: params.positionId,
    },
  });
}

/**
 * Send an APY drop notification to iOS device
 */
export async function sendApnsApyDropNotification(params: {
  deviceToken: string;
  deviceId: string;
  environment: 'production' | 'sandbox';
  positionName: string;
  positionId: string;
  currentApy: number;
  threshold: number;
  severity: NotificationSeverity;
}): Promise<boolean> {
  const title = `Low APY: ${params.positionName}`;
  const message = `4h APY dropped to ${(params.currentApy * 100).toFixed(2)}%, below ${(params.threshold * 100).toFixed(2)}%`;

  return sendApnsNotification({
    deviceToken: params.deviceToken,
    deviceId: params.deviceId,
    environment: params.environment,
    title,
    message,
    severity: params.severity,
    data: {
      type: 'apy_drop',
      positionId: params.positionId,
      positionName: params.positionName,
      currentApy: params.currentApy,
      threshold: params.threshold,
    },
  });
}

/**
 * Shutdown APNs provider (call on server shutdown)
 */
export async function shutdownApnsProvider(): Promise<void> {
  if (apnsProvider) {
    await apnsProvider.shutdown();
    apnsProvider = null;
    console.log('[APNs] Provider shutdown complete');
  }
}
