import { ethers, Contract, Provider } from 'ethers';
import { getAbi } from './config';
import { getEnvVar } from './config';
import { RPC_MIN_INTERVAL_MS } from '../constants';
import { RPCProxyProvider, createManagedProvider } from './rpc-proxy-provider';
import { RPCProviderConfig } from './rpc-manager';

/**
 * Throttle RPC calls to respect provider rate limits
 *
 * NOTE: This function is kept for backward compatibility but is now a no-op.
 * Rate limiting is handled automatically by the RPCManager.
 *
 * Usage: Call this before any direct RPC operation (getBlockNumber, contract calls, etc.)
 * to ensure minimum spacing between requests. Configure via RPC_MIN_INTERVAL_MS env var.
 *
 * @example
 * await rpcThrottle();
 * const block = await provider.getBlockNumber();
 */
export async function rpcThrottle(): Promise<void> {
  // No-op - rate limiting now handled by RPCManager
  // Kept for backward compatibility
  return;
}

let provider: Provider | null = null;

/**
 * Initialize RPC providers from database or environment variables
 *
 * Priority order:
 * 1. Database (if providers exist)
 * 2. Environment variables (ETH_RPC_URLS, ETH_RPC_LIMITS)
 * 3. Single provider fallback (ETH_RPC_URL)
 */
async function initializeProvider(): Promise<Provider> {
  try {
    // Try to load from database first
    const { hasRPCProviders, getActiveRPCProviders } = await import('../models/rpc-provider');

    if (await hasRPCProviders()) {
      const dbProviders = await getActiveRPCProviders();

      if (dbProviders.length > 0) {
        console.log(`[Ethereum] Initialized with ${dbProviders.length} RPC provider(s) from database`);
        return createManagedProvider(dbProviders);
      }
    }
  } catch (error) {
    // Database not ready or migration not run yet, fall through to env
    console.log('[Ethereum] Database not available, using environment configuration');
  }

  // Try multi-provider env configuration
  const rpcUrls = process.env.ETH_RPC_URLS;
  const rpcLimits = process.env.ETH_RPC_LIMITS;

  if (rpcUrls && rpcUrls.includes(',')) {
    const urls = rpcUrls.split(',').map(u => u.trim()).filter(u => u.length > 0);
    const limits = rpcLimits
      ? rpcLimits.split(',').map(l => parseFloat(l.trim()))
      : urls.map(() => 10); // Default 10 calls/sec

    if (urls.length !== limits.length) {
      console.warn('[Ethereum] ETH_RPC_URLS and ETH_RPC_LIMITS length mismatch, using defaults');
    }

    const configs: RPCProviderConfig[] = urls.map((url, index) => ({
      name: `Provider ${index + 1}`,
      url,
      callsPerSecond: limits[index] || 10,
      priority: urls.length - index, // First URL gets highest priority
      isActive: true,
    }));

    console.log(`[Ethereum] Initialized with ${configs.length} RPC provider(s) from environment`);
    return createManagedProvider(configs);
  }

  // Fallback to single provider
  const singleUrl = getEnvVar('ETH_RPC_URL');
  const callsPerSecond = RPC_MIN_INTERVAL_MS > 0 ? 1000 / RPC_MIN_INTERVAL_MS : 10;

  const config: RPCProviderConfig = {
    name: 'Default Provider',
    url: singleUrl,
    callsPerSecond,
    priority: 0,
    isActive: true,
  };

  console.log('[Ethereum] Initialized with single RPC provider from ETH_RPC_URL');
  return createManagedProvider([config]);
}

export function getProvider(): Provider {
  if (!provider) {
    // Synchronously create a temporary provider for immediate use
    // The actual initialization happens asynchronously
    const tempUrl = getEnvVar('ETH_RPC_URL');
    provider = new ethers.JsonRpcProvider(tempUrl);

    // Replace with managed provider asynchronously
    initializeProvider()
      .then(managedProvider => {
        provider = managedProvider;
      })
      .catch(error => {
        console.error('[Ethereum] Failed to initialize managed provider:', error);
        // Keep using the temporary provider
      });
  }
  return provider;
}

/**
 * Force reload of RPC providers from database
 * Useful after adding/removing providers at runtime
 */
export async function reloadRPCProviders(): Promise<void> {
  provider = null;
  provider = await initializeProvider();
  console.log('[Ethereum] RPC providers reloaded');
}

/**
 * Get RPC manager status (for monitoring)
 * Returns null if not using managed provider
 */
export function getRPCStatus() {
  if (provider && provider instanceof RPCProxyProvider) {
    return (provider as RPCProxyProvider).getManagerStatus();
  }
  return null;
}

export function getContract(address: string, abi: any[]): Contract {
  return new ethers.Contract(address, abi, getProvider());
}

export function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

export function toChecksumAddress(address: string): string {
  return ethers.getAddress(address);
}

export function formatUnits(value: bigint, decimals: number): string {
  return ethers.formatUnits(value, decimals);
}

export function parseUnits(value: string, decimals: number): bigint {
  return ethers.parseUnits(value, decimals);
}

// Multicall3 helpers (optional optimization)
const DEFAULT_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

export function getMulticallContract(address?: string): Contract {
  const multicallAddress = address || process.env.MULTICALL3_ADDRESS || DEFAULT_MULTICALL3_ADDRESS;
  const abi = getAbi('Multicall3');
  return getContract(multicallAddress, abi);
}

export async function multicallTryAggregate(
  calls: Array<{ target: string; callData: string }>,
  requireSuccess = false
): Promise<Array<{ success: boolean; returnData: string }>> {
  await rpcThrottle();
  const multicall = getMulticallContract();
  // tryAggregate is a view function, use staticCall explicitly
  const results = await multicall.tryAggregate.staticCall(requireSuccess, calls);
  // Normalize to simple JSON types
  return results.map((r: any) => ({ success: Boolean(r.success), returnData: r.returnData as string }));
}

/**
 * Resolve ENS name to Ethereum address
 * @param ensName - ENS name (e.g., "vitalik.eth")
 * @returns Ethereum address or null if not found
 */
export async function resolveENS(ensName: string): Promise<string | null> {
  try {
    const provider = getProvider();

    // Get ENS-capable provider (bypasses round-robin to ensure ENS support)
    let ensProvider = provider;
    if (provider instanceof RPCProxyProvider) {
      const capableProvider = provider.getENSCapableProvider();
      if (!capableProvider) {
        console.warn('[ENS] No ENS-capable providers available');
        return null;
      }
      ensProvider = capableProvider;
    }

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 10000) // 10 second timeout
    );

    const resolvePromise = ensProvider.resolveName(ensName);

    const address = await Promise.race([resolvePromise, timeoutPromise]);
    return address;
  } catch (error: any) {
    console.error(`[ENS] Resolution failed for ${ensName}:`, error);
    return null;
  }
}

/**
 * Check if a string is an ENS name (ends with .eth)
 * @param input - Input string to check
 * @returns true if it's an ENS name
 */
export function isENSName(input: string): boolean {
  return input.toLowerCase().endsWith('.eth');
}

/**
 * Reverse-lookup ENS name from an Ethereum address
 * @param address - 0x-prefixed Ethereum address
 * @returns Primary ENS name or null
 */
export async function lookupEnsForAddress(address: string): Promise<string | null> {
  try {
    const provider = getProvider();

    // Get ENS-capable provider (bypasses round-robin to ensure ENS support)
    let ensProvider = provider;
    if (provider instanceof RPCProxyProvider) {
      const capableProvider = provider.getENSCapableProvider();
      if (!capableProvider) {
        console.warn('[ENS] No ENS-capable providers available');
        return null;
      }
      ensProvider = capableProvider;
    }

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 10000) // 10 second timeout
    );

    const lookupPromise = ensProvider.lookupAddress(address);

    const name = await Promise.race([lookupPromise, timeoutPromise]);
    return name || null;
  } catch (error: any) {
    console.error(`[ENS] Reverse lookup failed for ${address}:`, error);
    return null;
  }
}
