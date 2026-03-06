import { ethers, Contract, Provider } from 'ethers';
import { getAbi, getEnvVar } from './config';
import { RPC_MIN_INTERVAL_MS } from '../constants';
import { RPCProxyProvider, createManagedProvider } from './rpc-proxy-provider';
import { RPCProviderConfig } from './rpc-manager';

export const ETHEREUM_CHAIN_ID = 1;
export const ARBITRUM_CHAIN_ID = 42161;

const SUPPORTED_CHAIN_IDS = [ETHEREUM_CHAIN_ID, ARBITRUM_CHAIN_ID] as const;

/**
 * Throttle RPC calls to respect provider rate limits
 *
 * NOTE: This function is kept for backward compatibility but is now a no-op.
 * Rate limiting is handled automatically by the RPCManager.
 */
export async function rpcThrottle(): Promise<void> {
  return;
}

const providersByChain = new Map<number, Provider>();
const initializationByChain = new Map<number, Promise<void>>();

function getChainLabel(chainId: number): string {
  if (chainId === ETHEREUM_CHAIN_ID) return 'Ethereum';
  if (chainId === ARBITRUM_CHAIN_ID) return 'Arbitrum';
  return `chain:${chainId}`;
}

function getSingleRpcEnvKey(chainId: number): string {
  if (chainId === ETHEREUM_CHAIN_ID) return 'ETH_RPC_URL';
  if (chainId === ARBITRUM_CHAIN_ID) return 'ARBITRUM_RPC_URL';
  return `RPC_URL_${chainId}`;
}

function getMultiRpcEnvKeys(chainId: number): { urlsKey: string; limitsKey: string } {
  if (chainId === ETHEREUM_CHAIN_ID) {
    return { urlsKey: 'ETH_RPC_URLS', limitsKey: 'ETH_RPC_LIMITS' };
  }
  if (chainId === ARBITRUM_CHAIN_ID) {
    return { urlsKey: 'ARBITRUM_RPC_URLS', limitsKey: 'ARBITRUM_RPC_LIMITS' };
  }
  return {
    urlsKey: `RPC_URLS_${chainId}`,
    limitsKey: `RPC_LIMITS_${chainId}`,
  };
}

function getSingleRpcCapabilityEnvKeys(chainId: number): {
  supportsLargeBlockScansKey: string;
  supportsENSKey: string;
} {
  if (chainId === ETHEREUM_CHAIN_ID) {
    return {
      supportsLargeBlockScansKey: 'ETH_RPC_SUPPORTS_LARGE_BLOCK_SCANS',
      supportsENSKey: 'ETH_RPC_SUPPORTS_ENS',
    };
  }
  if (chainId === ARBITRUM_CHAIN_ID) {
    return {
      supportsLargeBlockScansKey: 'ARBITRUM_RPC_SUPPORTS_LARGE_BLOCK_SCANS',
      supportsENSKey: 'ARBITRUM_RPC_SUPPORTS_ENS',
    };
  }
  return {
    supportsLargeBlockScansKey: `RPC_SUPPORTS_LARGE_BLOCK_SCANS_${chainId}`,
    supportsENSKey: `RPC_SUPPORTS_ENS_${chainId}`,
  };
}

function getMultiRpcCapabilityEnvKeys(chainId: number): {
  scanCapabilitiesKey: string;
  ensCapabilitiesKey: string;
} {
  if (chainId === ETHEREUM_CHAIN_ID) {
    return {
      scanCapabilitiesKey: 'ETH_RPC_SCAN_CAPABILITIES',
      ensCapabilitiesKey: 'ETH_RPC_ENS_CAPABILITIES',
    };
  }
  if (chainId === ARBITRUM_CHAIN_ID) {
    return {
      scanCapabilitiesKey: 'ARBITRUM_RPC_SCAN_CAPABILITIES',
      ensCapabilitiesKey: 'ARBITRUM_RPC_ENS_CAPABILITIES',
    };
  }
  return {
    scanCapabilitiesKey: `RPC_SCAN_CAPABILITIES_${chainId}`,
    ensCapabilitiesKey: `RPC_ENS_CAPABILITIES_${chainId}`,
  };
}

function getSingleProviderUrlFromEnv(chainId: number): string | null {
  const key = getSingleRpcEnvKey(chainId);
  const value = process.env[key];
  if (!value || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return defaultValue;
}

function parseBooleanListEnv(
  rawValue: string | undefined,
  expectedLength: number,
  defaultValue: boolean,
  valueLabel: string
): boolean[] {
  if (!rawValue) {
    return Array.from({ length: expectedLength }, () => defaultValue);
  }

  const rawValues = rawValue.split(',').map((value) => value.trim()).filter((value) => value.length > 0);
  if (rawValues.length !== expectedLength) {
    console.warn(`[${valueLabel}] length mismatch, using defaults`);
    return Array.from({ length: expectedLength }, () => defaultValue);
  }

  return rawValues.map((value) => parseBooleanEnv(value, defaultValue));
}

function parseMultiProviderEnv(chainId: number): Array<{
  url: string;
  callsPerSecond: number;
  supportsLargeBlockScans: boolean;
  supportsENS: boolean;
}> {
  const { urlsKey, limitsKey } = getMultiRpcEnvKeys(chainId);
  const { scanCapabilitiesKey, ensCapabilitiesKey } = getMultiRpcCapabilityEnvKeys(chainId);
  const rawUrls = process.env[urlsKey];
  if (!rawUrls) {
    return [];
  }

  const urls = rawUrls.split(',').map((url) => url.trim()).filter((url) => url.length > 0);
  if (urls.length === 0) {
    return [];
  }

  const rawLimits = process.env[limitsKey];
  const limits = rawLimits
    ? rawLimits.split(',').map((limit) => parseFloat(limit.trim()))
    : urls.map(() => 10);

  if (rawLimits && limits.length !== urls.length) {
    console.warn(`[${getChainLabel(chainId)}] ${urlsKey} and ${limitsKey} length mismatch, using defaults`);
  }

  const scanCapabilities = parseBooleanListEnv(
    process.env[scanCapabilitiesKey],
    urls.length,
    true,
    `${getChainLabel(chainId)} ${scanCapabilitiesKey}`
  );
  const ensCapabilities = parseBooleanListEnv(
    process.env[ensCapabilitiesKey],
    urls.length,
    true,
    `${getChainLabel(chainId)} ${ensCapabilitiesKey}`
  );

  return urls.map((url, index) => ({
    url,
    callsPerSecond: Number.isFinite(limits[index]) && limits[index] > 0 ? limits[index] : 10,
    supportsLargeBlockScans: scanCapabilities[index] ?? true,
    supportsENS: ensCapabilities[index] ?? true,
  }));
}

function getFirstMultiProviderUrlFromEnv(chainId: number): string | null {
  const configs = parseMultiProviderEnv(chainId);
  if (configs.length === 0) {
    return null;
  }
  return configs[0].url;
}

/**
 * Initialize providers for a specific chain from database or environment.
 *
 * Priority order:
 * 1. Database providers filtered by chain capability
 * 2. Chain-specific environment multi-provider config
 * 3. Chain-specific single provider fallback
 */
async function initializeProviderForChain(chainId: number): Promise<Provider> {
  const chainLabel = getChainLabel(chainId);

  try {
    const { hasRPCProviders, getActiveRPCProvidersForChain } = await import('../models/rpc-provider');

    if (await hasRPCProviders()) {
      const dbProviders = await getActiveRPCProvidersForChain(chainId);
      if (dbProviders.length > 0) {
        console.log(`[${chainLabel}] Initialized with ${dbProviders.length} RPC provider(s) from database`);
        return createManagedProvider(dbProviders);
      }
    }
  } catch {
    console.log(`[${chainLabel}] Database not available, using environment configuration`);
  }

  const envMultiProviders = parseMultiProviderEnv(chainId);
  if (envMultiProviders.length > 0) {
    const configs: RPCProviderConfig[] = envMultiProviders.map((entry, index) => ({
      name: `${chainLabel} Provider ${index + 1}`,
      url: entry.url,
      callsPerSecond: entry.callsPerSecond,
      priority: envMultiProviders.length - index,
      isActive: true,
      supportsEthereum: chainId === ETHEREUM_CHAIN_ID,
      supportsArbitrum: chainId === ARBITRUM_CHAIN_ID,
      supportsLargeBlockScans: entry.supportsLargeBlockScans,
      supportsENS: entry.supportsENS,
    }));

    console.log(`[${chainLabel}] Initialized with ${configs.length} RPC provider(s) from environment`);
    return createManagedProvider(configs);
  }

  const singleUrl = getSingleProviderUrlFromEnv(chainId);
  if (singleUrl) {
    const callsPerSecond = RPC_MIN_INTERVAL_MS > 0 ? 1000 / RPC_MIN_INTERVAL_MS : 10;
    const { supportsLargeBlockScansKey, supportsENSKey } = getSingleRpcCapabilityEnvKeys(chainId);
    const config: RPCProviderConfig = {
      name: `${chainLabel} Default Provider`,
      url: singleUrl,
      callsPerSecond,
      priority: 0,
      isActive: true,
      supportsEthereum: chainId === ETHEREUM_CHAIN_ID,
      supportsArbitrum: chainId === ARBITRUM_CHAIN_ID,
      supportsLargeBlockScans: parseBooleanEnv(process.env[supportsLargeBlockScansKey], true),
      supportsENS: parseBooleanEnv(process.env[supportsENSKey], true),
    };

    console.log(`[${chainLabel}] Initialized with single RPC provider from ${getSingleRpcEnvKey(chainId)}`);
    return createManagedProvider([config]);
  }

  throw new Error(
    `[${chainLabel}] No provider configured. Set ${getSingleRpcEnvKey(chainId)} or ${getMultiRpcEnvKeys(chainId).urlsKey}, ` +
    `or configure chain-capable providers in rpc_provider table.`
  );
}

async function ensureChainInitialized(chainId: number): Promise<void> {
  const existingInit = initializationByChain.get(chainId);
  if (existingInit) {
    await existingInit;
    return;
  }

  const initPromise = initializeProviderForChain(chainId)
    .then((provider) => {
      providersByChain.set(chainId, provider);
    })
    .finally(() => {
      initializationByChain.delete(chainId);
    });

  initializationByChain.set(chainId, initPromise);
  await initPromise;
}

/**
 * Eagerly initialize all supported chain providers.
 *
 * Intended for server startup. Failures are logged per-chain to keep boot resilient.
 */
export async function initializeRPCProviders(): Promise<void> {
  const initResults = await Promise.allSettled(
    SUPPORTED_CHAIN_IDS.map((chainId) => ensureChainInitialized(chainId))
  );

  initResults.forEach((result, index) => {
    const chainId = SUPPORTED_CHAIN_IDS[index];
    if (result.status === 'rejected') {
      console.warn(`[${getChainLabel(chainId)}] RPC manager initialization failed: ${result.reason}`);
    }
  });
}

/**
 * Get a provider for a specific chain.
 * Defaults to managed providers when initialized, otherwise falls back to env URLs.
 */
export function getProviderForChain(chainId: number): Provider {
  const existing = providersByChain.get(chainId);
  if (existing) {
    return existing;
  }

  // Attempt asynchronous managed initialization in the background.
  void ensureChainInitialized(chainId).catch((error) => {
    console.error(`[${getChainLabel(chainId)}] Failed to initialize managed provider:`, error);
  });

  const tempUrl = getSingleProviderUrlFromEnv(chainId) || getFirstMultiProviderUrlFromEnv(chainId);
  if (!tempUrl) {
    throw new Error(
      `[${getChainLabel(chainId)}] RPC provider is not initialized and no environment fallback is set. ` +
      `Set ${getSingleRpcEnvKey(chainId)} or initialize chain-aware providers in database.`
    );
  }

  const temporaryProvider = new ethers.JsonRpcProvider(tempUrl, chainId);
  providersByChain.set(chainId, temporaryProvider);
  return temporaryProvider;
}

export function getProvider(): Provider {
  return getProviderForChain(ETHEREUM_CHAIN_ID);
}

export function getScanCapableProviderForChain(chainId: number): Provider | null {
  const provider = getProviderForChain(chainId);
  if ('getRPCManager' in provider && typeof provider.getRPCManager === 'function') {
    return provider.getRPCManager().getScanCapableProvider();
  }
  return provider;
}

/**
 * Force reload of RPC providers for all supported chains.
 */
export async function reloadRPCProviders(): Promise<void> {
  providersByChain.clear();
  await initializeRPCProviders();
  console.log('[Ethereum] RPC providers reloaded for all configured chains');
}

function getRPCStatusForChain(chainId: number) {
  const provider = providersByChain.get(chainId);
  if (provider && provider instanceof RPCProxyProvider) {
    return (provider as RPCProxyProvider).getManagerStatus();
  }
  return null;
}

/**
 * Get RPC manager status by chain.
 */
export function getRPCStatus() {
  return {
    ethereum: getRPCStatusForChain(ETHEREUM_CHAIN_ID),
    arbitrum: getRPCStatusForChain(ARBITRUM_CHAIN_ID),
  };
}

export function getContract(address: string, abi: any[], providerOverride?: Provider): Contract {
  return new ethers.Contract(address, abi, providerOverride || getProvider());
}

export function isValidAddress(address: string): boolean {
  return ethers.isAddress(address);
}

export function toChecksumAddress(address: string): string {
  return ethers.getAddress(address);
}

export function normalizeAddress(address: string): string {
  return ethers.getAddress(address.toLowerCase());
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

// Backwards-compatible required env helpers for scripts that still rely on explicit values
export function getEthereumRpcUrlOrThrow(): string {
  return getEnvVar('ETH_RPC_URL');
}

export function getArbitrumRpcUrlOrThrow(): string {
  return getEnvVar('ARBITRUM_RPC_URL');
}
