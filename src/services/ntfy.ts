import { NotificationSeverity } from '../types';

const NTFY_BASE_URL = 'https://ntfy.sh';

/**
 * Priority mapping to ntfy priority levels
 * ntfy supports: 1 (min), 2 (low), 3 (default), 4 (high), 5 (max/urgent)
 */
function severityToNtfyPriority(severity: NotificationSeverity): number {
  const priorityMap: Record<NotificationSeverity, number> = {
    min: 1,
    low: 2,
    default: 3,
    high: 4,
    urgent: 5,
  };
  return priorityMap[severity] || 3; // Default to 3 if invalid
}

/**
 * Icon mapping for different notification types
 */
function getIconForNotificationType(type: 'depeg' | 'apy_drop'): string {
  const iconMap = {
    depeg: '\u26A0\uFE0F', // Warning sign
    apy_drop: '\uD83D\uDCC9', // Chart decreasing
  };
  return iconMap[type];
}

/**
 * HTTP header values in undici must be ByteString (<= 0xFF per char) and avoid emojis.
 * Strip characters with code point > 255 to prevent ByteString errors.
 */
function sanitizeHeaderValue(value: string): string {
  return Array.from(value)
    .filter((ch) => ch.codePointAt(0)! <= 255)
    .join('');
}

/**
 * Send a notification via ntfy.sh
 */
export async function sendNtfyNotification(params: {
  topic: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  notificationType: 'depeg' | 'apy_drop';
  tags?: string[];
  actions?: Array<{
    action: string;
    label: string;
    url?: string;
  }>;
}): Promise<boolean> {
  try {
    const icon = getIconForNotificationType(params.notificationType);
    const priority = severityToNtfyPriority(params.severity);

    // Build tags (comma-separated per ntfy spec)
    const tags = Array.from(new Set([...(params.tags || []), params.notificationType]));

    // Optional Actions header (ntfy expects a JSON array string)
    // Important: Do NOT include emojis in headers (undici ByteString restriction)
    const headers: Record<string, string> = {
      Title: sanitizeHeaderValue(params.title),
      Priority: String(priority),
      Tags: sanitizeHeaderValue(tags.join(',')),
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (params.actions && params.actions.length > 0) {
      headers['Actions'] = sanitizeHeaderValue(JSON.stringify(params.actions));
    }

    // Move icon into the body prefix to keep nice UX without breaking headers
    const bodyWithIcon = icon ? `${icon} ${params.message}` : params.message;

    const response = await fetch(`${NTFY_BASE_URL}/${params.topic}`, {
      method: 'POST',
      headers,
      body: bodyWithIcon,
    });

    if (!response.ok) {
      console.error(`Failed to send ntfy notification: ${response.status} ${response.statusText}`);
      return false;
    }

    console.log(`Sent ntfy notification to topic ${params.topic}: ${params.title}`);
    return true;
  } catch (error) {
    console.error('Error sending ntfy notification:', error);
    return false;
  }
}

/**
 * Send a stablecoin depeg notification
 */
export async function sendDepegNotification(params: {
  topic: string;
  stablecoinSymbol: string;
  currentPrice: number;
  threshold: number;
  isUpper: boolean;
  severity: NotificationSeverity;
  dashboardUrl?: string;
}): Promise<boolean> {
  const direction = params.isUpper ? 'above' : 'below';
  const title = `${params.stablecoinSymbol} depegged!`;
  const message = `${params.stablecoinSymbol} is trading at $${params.currentPrice.toFixed(4)}, ${direction} your threshold of $${params.threshold.toFixed(4)}`;

  const actions = params.dashboardUrl
    ? [
        {
          action: 'view',
          label: 'View Dashboard',
          url: params.dashboardUrl,
        },
      ]
    : undefined;

  return sendNtfyNotification({
    topic: params.topic,
    title,
    message,
    severity: params.severity,
    notificationType: 'depeg',
    tags: ['warning', params.stablecoinSymbol.toLowerCase()],
    actions,
  });
}

/**
 * Send an APY drop notification
 */
export async function sendApyDropNotification(params: {
  topic: string;
  positionName: string;
  currentApy: number;
  threshold: number;
  severity: NotificationSeverity;
  dashboardUrl?: string;
}): Promise<boolean> {
  const title = `Low APY Alert: ${params.positionName}`;
  const message = `4h APY dropped to ${(params.currentApy * 100).toFixed(2)}%, below your threshold of ${(params.threshold * 100).toFixed(2)}%`;

  const actions = params.dashboardUrl
    ? [
        {
          action: 'view',
          label: 'View Position',
          url: params.dashboardUrl,
        },
      ]
    : undefined;

  return sendNtfyNotification({
    topic: params.topic,
    title,
    message,
    severity: params.severity,
    notificationType: 'apy_drop',
    tags: ['apy', 'low_yield'],
    actions,
  });
}
