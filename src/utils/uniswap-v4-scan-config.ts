const DEFAULT_SCAN_CHUNK_SIZE = 500_000;
const DEFAULT_MAX_LOG_QUERIES = 500;
const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_OWNER_BATCH_SIZE = 500;
const DEFAULT_RECENT_TOKEN_WINDOW = 10_000;
const DEFAULT_RECENT_SCAN_BLOCKS = 500_000;

function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) return defaultValue;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

export function getUniswapV4ScanChunkSize(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_SCAN_CHUNK_SIZE', DEFAULT_SCAN_CHUNK_SIZE);
}

export function getUniswapV4MaxLogQueries(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_MAX_LOG_QUERIES', DEFAULT_MAX_LOG_QUERIES);
}

export function getUniswapV4ScanTimeoutMs(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_SCAN_TIMEOUT_MS', DEFAULT_SCAN_TIMEOUT_MS);
}

export function getUniswapV4OwnerBatchSize(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_OWNER_BATCH_SIZE', DEFAULT_OWNER_BATCH_SIZE);
}

export function getUniswapV4RecentTokenWindow(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_RECENT_TOKEN_WINDOW', DEFAULT_RECENT_TOKEN_WINDOW);
}

export function getUniswapV4RecentScanBlocks(): number {
  return getPositiveIntegerEnv('UNISWAP_V4_RECENT_SCAN_BLOCKS', DEFAULT_RECENT_SCAN_BLOCKS);
}
