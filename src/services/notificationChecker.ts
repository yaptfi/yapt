import { getAllNotificationSettings } from '../models/notificationSettings';
import { createNotificationLog, getRecentNotifications } from '../models/notificationLog';
import { sendDepegNotification, sendApyDropNotification } from './ntfy';
import { sendApnsDepegNotification, sendApnsApyDropNotification } from './apns';
import { getActiveDevices } from '../models/device';
import { fetchStablecoinPrices, isDepegged } from './stablecoinPriceMonitor';
import { getActivePositionsByWallets } from '../models/position';
import { get4hApyValues } from '../models/snapshot';
import { compute4hApy } from '../utils/apy';
import { getPositionMetrics } from './update';
import { getUserWallets } from '../models/user-wallet';
import type { Wallet, ApyWindow } from '../types';
import { DEPEG_COOLDOWN_MINUTES, APY_DROP_COOLDOWN_MINUTES } from '../constants';

/**
 * Check all users' notification settings and send alerts if needed
 * Called by the hourly job after wallet updates
 */
export async function checkAndSendNotifications(): Promise<void> {
  console.log('[notifications] Checking notification conditions...');

  try {
    // Get all users with notifications enabled
    const settings = await getAllNotificationSettings();

    if (settings.length === 0) {
      console.log('[notifications] No users have notifications enabled');
      return;
    }

    console.log(`[notifications] Checking notifications for ${settings.length} users`);

    // Check depeg notifications
    await checkDepegNotifications(settings);

    // Check APY drop notifications
    await checkApyDropNotifications(settings);

    console.log('[notifications] Notification check completed');
  } catch (error) {
    console.error('[notifications] Error checking notifications:', error);
  }
}

/**
 * Check stablecoin depeg conditions and send notifications
 */
async function checkDepegNotifications(settings: any[]): Promise<void> {
  // Filter users with depeg alerts enabled
  const depegSettings = settings.filter((s) => s.depegEnabled);

  if (depegSettings.length === 0) {
    return;
  }

  console.log(`[notifications] Checking depeg alerts for ${depegSettings.length} users`);

  // Fetch current stablecoin prices
  let prices: Record<string, number>;
  try {
    prices = await fetchStablecoinPrices();
  } catch (error) {
    console.error('[notifications] Failed to fetch stablecoin prices:', error);
    return;
  }

  // Check each user's settings
  for (const setting of depegSettings) {
    const lowerThreshold = parseFloat(setting.depegLowerThreshold);
    const upperThreshold = setting.depegUpperThreshold
      ? parseFloat(setting.depegUpperThreshold)
      : null;

    // Check each stablecoin price
    for (const [symbol, price] of Object.entries(prices)) {
      // If user selected a subset of symbols, filter others out
      if (Array.isArray(setting.depegSymbols) && setting.depegSymbols.length > 0) {
        const sel = setting.depegSymbols.map((s: string) => s.toUpperCase());
        if (!sel.includes(symbol.toUpperCase())) {
          continue;
        }
      }
      const depegCheck = isDepegged(price, lowerThreshold, upperThreshold);

      if (!depegCheck.depegged) {
        continue;
      }

      // Check spam prevention
      const recentNotifications = await getRecentNotifications(
        setting.userId,
        'depeg',
        DEPEG_COOLDOWN_MINUTES
      );

      // Check if we already sent a notification for this stablecoin recently
      const alreadySent = recentNotifications.some(
        (n) => n.metadata?.stablecoin === symbol
      );

      if (alreadySent) {
        console.log(
          `[notifications] Skipping depeg alert for ${symbol} (already sent recently)`
        );
        continue;
      }

      // Send notification via ntfy.sh (if configured)
      const threshold = depegCheck.isUpper ? upperThreshold! : lowerThreshold;
      let sentViaAnyChannel = false;

      if (setting.ntfyTopic) {
        const sent = await sendDepegNotification({
          topic: setting.ntfyTopic,
          stablecoinSymbol: symbol,
          currentPrice: price,
          threshold,
          isUpper: depegCheck.isUpper,
          severity: setting.depegSeverity,
        });

        if (sent) {
          sentViaAnyChannel = true;
        }
      }

      // Send to iOS devices (APNs)
      const devices = await getActiveDevices(setting.userId);
      const iosDevices = devices.filter((d) => d.deviceType === 'ios');

      for (const device of iosDevices) {
        const sent = await sendApnsDepegNotification({
          deviceToken: device.pushToken,
          deviceId: device.id,
          environment: device.environment || 'production',
          stablecoinSymbol: symbol,
          currentPrice: price,
          threshold,
          isUpper: depegCheck.isUpper,
          severity: setting.depegSeverity,
        });

        if (sent) {
          sentViaAnyChannel = true;
        }
      }

      if (sentViaAnyChannel) {
        // Log the notification
        await createNotificationLog({
          userId: setting.userId,
          notificationType: 'depeg',
          severity: setting.depegSeverity,
          title: `${symbol} depegged!`,
          message: `${symbol} is trading at $${price.toFixed(4)}, ${
            depegCheck.isUpper ? 'above' : 'below'
          } your threshold of $${threshold.toFixed(4)}`,
          metadata: {
            stablecoin: symbol,
            price,
            threshold,
            isUpper: depegCheck.isUpper,
          },
        });

        console.log(
          `[notifications] Sent depeg alert for ${symbol} to user ${setting.userId}`
        );
      }
    }
  }
}

/**
 * Check APY drop conditions and send notifications
 */
async function checkApyDropNotifications(settings: any[]): Promise<void> {
  // Filter users with APY alerts enabled
  const apySettings = settings.filter((s) => s.apyEnabled);

  if (apySettings.length === 0) {
    return;
  }

  console.log(`[notifications] Checking APY alerts for ${apySettings.length} users`);

  // Check each user's positions
  for (const setting of apySettings) {
    const threshold = parseFloat(setting.apyThreshold);

    // Get user's wallets
    const userWallets = await getUserWallets(setting.userId);
    const walletIds = userWallets.map((wallet: Wallet) => wallet.id);

    // Get all active positions for user's wallets
    const allPositions = await getActivePositionsByWallets(walletIds);

    const apyWindow: ApyWindow = setting.apyWindow || '7d';

    // Check each position's APY using configured window
    for (const position of allPositions) {
      if (!position.isActive) {
        continue;
      }

      // Get APY based on user's configured window
      let currentApy: number | null = null;

      if (apyWindow === '7d') {
        const metrics = await getPositionMetrics(position.id, position);
        if (!metrics) continue;
        currentApy = metrics.apy7d;
        // Fall back to 4h if 7d not available yet (insufficient data)
        if (currentApy === null || currentApy === undefined) {
          currentApy = metrics.apy;
        }
        if (currentApy === null || currentApy === undefined) continue;
      } else {
        // 4h window — use existing geometric chain method
        const apyValues = await get4hApyValues(position.id);
        if (apyValues.length < 4) continue;
        currentApy = compute4hApy(apyValues);
      }

      // Check if below threshold
      if (currentApy >= threshold) {
        continue; // APY is above threshold, no alert needed
      }

      // Check spam prevention
      const recentNotifications = await getRecentNotifications(
        setting.userId,
        'apy_drop',
        APY_DROP_COOLDOWN_MINUTES
      );

      // Check if we already sent a notification for this position recently
      const alreadySent = recentNotifications.some(
        (n) => n.metadata?.positionId === position.id
      );

      if (alreadySent) {
        console.log(
          `[notifications] Skipping APY alert for ${position.displayName} (already sent recently)`
        );
        continue;
      }

      // Send notification via ntfy.sh (if configured)
      let sentViaAnyChannel = false;

      if (setting.ntfyTopic) {
        const sent = await sendApyDropNotification({
          topic: setting.ntfyTopic,
          positionName: position.displayName,
          currentApy,
          threshold,
          severity: setting.apySeverity,
          apyWindow,
        });

        if (sent) {
          sentViaAnyChannel = true;
        }
      }

      // Send to iOS devices (APNs)
      const devices = await getActiveDevices(setting.userId);
      const iosDevices = devices.filter((d) => d.deviceType === 'ios');

      for (const device of iosDevices) {
        const sent = await sendApnsApyDropNotification({
          deviceToken: device.pushToken,
          deviceId: device.id,
          environment: device.environment || 'production',
          positionName: position.displayName,
          positionId: position.id,
          currentApy,
          threshold,
          severity: setting.apySeverity,
          apyWindow,
        });

        if (sent) {
          sentViaAnyChannel = true;
        }
      }

      const windowLabel = apyWindow === '7d' ? '7d' : '4h';

      if (sentViaAnyChannel) {
        // Log the notification
        await createNotificationLog({
          userId: setting.userId,
          notificationType: 'apy_drop',
          severity: setting.apySeverity,
          title: `Low APY Alert: ${position.displayName}`,
          message: `${windowLabel} APY dropped to ${(currentApy * 100).toFixed(2)}%, below your threshold of ${(threshold * 100).toFixed(2)}%`,
          metadata: {
            positionId: position.id,
            positionName: position.displayName,
            currentApy,
            threshold,
            apyWindow,
          },
        });

        console.log(
          `[notifications] Sent ${windowLabel} APY alert for ${position.displayName} to user ${setting.userId}`
        );
      }
    }
  }
}
