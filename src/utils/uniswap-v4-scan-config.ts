const DEFAULT_SCAN_CHUNK_SIZE = 500_000;
const DEFAULT_MAX_LOG_QUERIES = 500;
const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

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
