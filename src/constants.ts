/**
 * Application constants and configuration values
 * Centralizes magic numbers and thresholds for easy tuning
 */

/**
 * RPC Throttling
 * Minimum time between RPC calls to respect provider rate limits
 */
export const RPC_MIN_INTERVAL_MS = parseInt(process.env.RPC_MIN_INTERVAL_MS || '1000', 10);

/**
 * Rate Limiting Delays
 * NOTE: RPC manager now handles all rate limiting via token buckets
 * These delays are set to 0 to maximize throughput while respecting provider limits
 */
export const DISCOVERY_SLEEP_MS = 0; // No artificial delay - RPC manager handles rate limiting
export const UPDATE_SLEEP_MS = 0;    // No artificial delay - RPC manager handles rate limiting

/**
 * Notification Cooldowns
 * Minimum time between sending the same type of notification to prevent spam
 */
export const DEPEG_COOLDOWN_MINUTES = 60;     // 1 hour between depeg notifications
export const APY_DROP_COOLDOWN_MINUTES = 240; // 4 hours between APY drop notifications

/**
 * External API Configuration
 * Cache durations and timeout settings for external services
 */
export const COINGECKO_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
export const COINGECKO_TIMEOUT_MS = 8000;                 // 8 seconds

/**
 * APY Calculation Windows
 * Time windows for APY calculation and minimum data requirements
 */
export const APY_MIN_WINDOW_MINUTES = 59;        // Minimum elapsed time for APY calculation
export const APY_REFERENCE_WINDOW_HOURS = 4;     // Default lookback window for APY
export const APY_MIN_BASE_USD = 100;             // Minimum position value for APY calculation
export const APY_MIN_BASE_RATIO = 0.01;          // Minimum base as ratio of current value (1%)
