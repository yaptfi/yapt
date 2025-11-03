import { getAllStablecoins } from '../models/stablecoin';
import { COINGECKO_CACHE_DURATION_MS, COINGECKO_TIMEOUT_MS } from '../constants';

// Cache prices to avoid hitting rate limits
let priceCache: { prices: Record<string, number>; timestamp: number } | null = null;

/**
 * Fetch current stablecoin prices from CoinGecko
 * Returns a map of stablecoin symbol -> USD price
 */
export async function fetchStablecoinPrices(): Promise<Record<string, number>> {
  const now = Date.now();

  // Return cached prices if still fresh
  if (priceCache && (now - priceCache.timestamp) < COINGECKO_CACHE_DURATION_MS) {
    return priceCache.prices;
  }

  // Fetch stablecoins from database
  const stablecoins = await getAllStablecoins();

  // Build CoinGecko ID mapping from database
  const stablecoinMap: Record<string, string> = {};
  for (const stable of stablecoins) {
    if (stable.coingeckoId) {
      stablecoinMap[stable.symbol] = stable.coingeckoId;
    }
  }

  // Fetch fresh prices from CoinGecko with timeout and fallback
  const ids = Object.values(stablecoinMap).join(',');

  if (!ids) {
    // No stablecoins configured with CoinGecko IDs, return empty or cached
    return priceCache?.prices || {};
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&precision=4`;

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), COINGECKO_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Yapt/1.0',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`CoinGecko API returned ${response.status}`);
    }

    const data = await response.json() as Record<string, { usd?: number }>;

    // Map CoinGecko IDs back to our symbols
    const prices: Record<string, number> = {};
    for (const [symbol, geckoId] of Object.entries(stablecoinMap)) {
      if (data[geckoId] && data[geckoId].usd !== undefined) {
        prices[symbol] = data[geckoId].usd as number;
      }
    }

    // Update cache with small jitter to avoid synchronized refreshes across instances
    const jitter = Math.random() * 30000; // 0-30 seconds
    priceCache = {
      prices,
      timestamp: now + jitter,
    };

    return prices;
  } catch (error: any) {
    // On fetch failure, return cached prices if available
    console.error('[stablecoin-prices] Failed to fetch from CoinGecko:', error.message || error);

    if (priceCache && priceCache.prices) {
      console.warn('[stablecoin-prices] Using cached prices (age: ' +
        Math.round((now - priceCache.timestamp) / 1000) + 's)');
      return priceCache.prices;
    }

    // No cache available, throw error
    throw new Error('Failed to fetch stablecoin prices and no cache available');
  }
}

/**
 * Check if a stablecoin price is depegged according to thresholds
 */
export function isDepegged(
  price: number,
  lowerThreshold: number,
  upperThreshold: number | null
): { depegged: boolean; isUpper: boolean } {
  if (price < lowerThreshold) {
    return { depegged: true, isUpper: false };
  }

  if (upperThreshold !== null && price > upperThreshold) {
    return { depegged: true, isUpper: true };
  }

  return { depegged: false, isUpper: false };
}
