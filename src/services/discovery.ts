import { getAllAdapters, getAdapter } from '../plugins/registry';
import { IProtocolAdapter } from '../sdk/adapter';
import { createPosition } from '../models/position';
import { Position, ProtocolKey } from '../types';
import { createSnapshot, getLatestSnapshot } from '../models/snapshot';
import { toChecksumAddress } from '../utils/ethereum';
import { sleep } from '../utils/async';
import { DISCOVERY_SLEEP_MS } from '../constants';
import { getPositionCategory } from '../utils/position-category';
import { refreshFutureIncomeProjection } from './update';

export type DiscoveryProgressEvent =
  | { type: 'status'; data: { message: string } }
  | { type: 'start'; data: { totalProtocols: number } }
  | { type: 'protocol_start'; data: { protocol: string; index: number; total: number } }
  | { type: 'position_found'; data: { protocol: string; displayName: string; baseAsset: string; valueUsd: number } }
  | { type: 'protocol_error'; data: { protocol: string; message: string } }
  | { type: 'protocol_complete'; data: { protocol: string; positionsFound: number } }
  | {
      type: 'complete';
      data: {
        totalPositions: number;
        failedProtocols: Array<{ protocol: string; message: string }>;
      };
    }
  | { type: 'error'; data: { message: string } };

export type DiscoveryProgressCallback = (event: DiscoveryProgressEvent) => void;

type DiscoveryChain = 'ethereum' | 'arbitrum' | 'other';

interface DiscoveryRuntimeConfig {
  parallelEnabled: boolean;
  maxConcurrency: number;
  chainConcurrency: Record<DiscoveryChain, number>;
  logMetrics: boolean;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  discoverTimeoutMs: number;
  readTimeoutMs: number;
  circuitBreakerEnabled: boolean;
  circuitBreakerFailureThreshold: number;
  circuitBreakerCooldownMs: number;
}

interface AdapterTaskContext {
  adapter: IProtocolAdapter;
  index: number;
  total: number;
  chain: DiscoveryChain;
}

interface AdapterTaskResult {
  index: number;
  protocolKey: string;
  protocolName: string;
  chain: DiscoveryChain;
  discoveredPositions: Position[];
  positionsFound: number;
  durationMs: number;
  errorMessage?: string;
}

interface ChainCircuitBreakerState {
  failureCount: number;
  openUntilMs: number;
  lastErrorMessage: string | null;
}

interface InFlightWalletDiscovery {
  promise: Promise<Position[]>;
  progressCallbacks: Set<DiscoveryProgressCallback>;
  startedAtMs: number;
  latestProgressEvent?: DiscoveryProgressEvent;
}

const chainCircuitBreakers: Record<DiscoveryChain, ChainCircuitBreakerState> = {
  ethereum: { failureCount: 0, openUntilMs: 0, lastErrorMessage: null },
  arbitrum: { failureCount: 0, openUntilMs: 0, lastErrorMessage: null },
  other: { failureCount: 0, openUntilMs: 0, lastErrorMessage: null },
};
const inFlightWalletDiscoveries = new Map<string, InFlightWalletDiscovery>();

export function __resetDiscoveryCircuitBreakersForTests(): void {
  chainCircuitBreakers.ethereum = { failureCount: 0, openUntilMs: 0, lastErrorMessage: null };
  chainCircuitBreakers.arbitrum = { failureCount: 0, openUntilMs: 0, lastErrorMessage: null };
  chainCircuitBreakers.other = { failureCount: 0, openUntilMs: 0, lastErrorMessage: null };
  inFlightWalletDiscoveries.clear();
}

class DiscoveryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryTimeoutError';
  }
}

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}

function parsePositiveIntEnv(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }
  return parsed;
}

function parseNonNegativeIntEnv(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

function getDiscoveryRuntimeConfig(): DiscoveryRuntimeConfig {
  return {
    parallelEnabled: parseBooleanEnv(process.env.DISCOVERY_PARALLEL_ENABLED, false),
    maxConcurrency: parsePositiveIntEnv(process.env.DISCOVERY_MAX_CONCURRENCY, 3),
    chainConcurrency: {
      ethereum: parsePositiveIntEnv(process.env.DISCOVERY_ETHEREUM_MAX_CONCURRENCY, 2),
      arbitrum: parsePositiveIntEnv(process.env.DISCOVERY_ARBITRUM_MAX_CONCURRENCY, 1),
      other: parsePositiveIntEnv(process.env.DISCOVERY_OTHER_MAX_CONCURRENCY, 1),
    },
    logMetrics: parseBooleanEnv(process.env.DISCOVERY_LOG_METRICS, false),
    retryMaxAttempts: parsePositiveIntEnv(process.env.DISCOVERY_RETRY_MAX_ATTEMPTS, 1),
    retryBaseDelayMs: parseNonNegativeIntEnv(process.env.DISCOVERY_RETRY_BASE_DELAY_MS, 200),
    retryMaxDelayMs: parsePositiveIntEnv(process.env.DISCOVERY_RETRY_MAX_DELAY_MS, 2000),
    discoverTimeoutMs: parseNonNegativeIntEnv(process.env.DISCOVERY_DISCOVER_TIMEOUT_MS, 0),
    readTimeoutMs: parseNonNegativeIntEnv(process.env.DISCOVERY_READ_TIMEOUT_MS, 0),
    circuitBreakerEnabled: parseBooleanEnv(process.env.DISCOVERY_CIRCUIT_BREAKER_ENABLED, false),
    circuitBreakerFailureThreshold: parsePositiveIntEnv(process.env.DISCOVERY_CIRCUIT_BREAKER_FAILURE_THRESHOLD, 3),
    circuitBreakerCooldownMs: parsePositiveIntEnv(process.env.DISCOVERY_CIRCUIT_BREAKER_COOLDOWN_MS, 60000),
  };
}

function getAdapterChain(protocolKey: string): DiscoveryChain {
  const normalized = protocolKey.toLowerCase();
  if (normalized.includes('arbitrum')) {
    return 'arbitrum';
  }
  if (
    normalized.includes('base') ||
    normalized.includes('optimism') ||
    normalized.includes('polygon') ||
    normalized.includes('avalanche')
  ) {
    return 'other';
  }
  return 'ethereum';
}

function getDustThreshold(measureMethod: Position['measureMethod'] | undefined): number {
  return getPositionCategory(measureMethod ?? 'balance') === 'rewards' ? 0 : 10;
}

function allowsZeroValueDiscovery(positionData: Partial<Position>): boolean {
  const metadata = positionData.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  return (metadata as Record<string, unknown>).allowZeroValueDiscovery === true;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof DiscoveryTimeoutError) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();

  const nonRetryablePatterns = [
    'invalid argument',
    'invalid params',
    'missing argument',
    'out of gas',
    'protocol not found',
    'stablecoin not found',
    'unsupported',
  ];
  if (nonRetryablePatterns.some((pattern) => message.includes(pattern))) {
    return false;
  }

  const retryablePatterns = [
    'timeout',
    'timed out',
    '429',
    'rate limit',
    'too many requests',
    'temporarily unavailable',
    'unavailable',
    'service unavailable',
    'gateway timeout',
    'bad gateway',
    'network',
    'socket hang up',
    'econnreset',
    'etimedout',
    'enotfound',
    'ehostunreach',
    'server error',
  ];

  return retryablePatterns.some((pattern) => message.includes(pattern));
}

function getRetryDelayMs(attempt: number, config: DiscoveryRuntimeConfig): number {
  if (config.retryBaseDelayMs <= 0) {
    return 0;
  }

  const exponentialDelay = config.retryBaseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  const cappedDelay = Math.min(exponentialDelay, config.retryMaxDelayMs);
  const jitter = Math.floor(Math.random() * 50);
  return cappedDelay + jitter;
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation();
  }

  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new DiscoveryTimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    void operation()
      .then((result) => resolve(result))
      .catch((error) => reject(error))
      .finally(() => clearTimeout(timeoutId));
  });
}

async function withRetry<T>(
  label: string,
  context: AdapterTaskContext,
  config: DiscoveryRuntimeConfig,
  operation: () => Promise<T>
): Promise<T> {
  const maxAttempts = Math.max(1, config.retryMaxAttempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable = isRetryableError(error);
      const isLastAttempt = attempt >= maxAttempts;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt, config);
      console.warn(
        `[discovery] Retrying ${label} for ${context.adapter.protocolKey} ` +
        `(attempt ${attempt + 1}/${maxAttempts}, delay=${delayMs}ms): ${getErrorMessage(error)}`
      );
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw new Error(`[discovery] ${label} retry loop exhausted unexpectedly`);
}

function isChainCircuitOpen(chain: DiscoveryChain, config: DiscoveryRuntimeConfig): boolean {
  if (!config.circuitBreakerEnabled) {
    return false;
  }
  return chainCircuitBreakers[chain].openUntilMs > Date.now();
}

function recordChainFailure(
  chain: DiscoveryChain,
  error: unknown,
  context: AdapterTaskContext,
  config: DiscoveryRuntimeConfig
): void {
  if (!config.circuitBreakerEnabled) {
    return;
  }

  const state = chainCircuitBreakers[chain];
  state.failureCount += 1;
  state.lastErrorMessage = getErrorMessage(error);

  if (state.failureCount >= config.circuitBreakerFailureThreshold) {
    state.openUntilMs = Date.now() + config.circuitBreakerCooldownMs;
    console.warn(
      `[discovery] Opened ${chain} circuit breaker for ${config.circuitBreakerCooldownMs}ms ` +
      `after ${state.failureCount} failure(s). Last protocol=${context.adapter.protocolKey}`
    );
  }
}

function recordChainSuccess(chain: DiscoveryChain, config: DiscoveryRuntimeConfig): void {
  if (!config.circuitBreakerEnabled) {
    return;
  }
  chainCircuitBreakers[chain].failureCount = 0;
  chainCircuitBreakers[chain].openUntilMs = 0;
  chainCircuitBreakers[chain].lastErrorMessage = null;
}

function getCircuitOpenRemainingMs(chain: DiscoveryChain): number {
  return Math.max(0, chainCircuitBreakers[chain].openUntilMs - Date.now());
}

function createAdapterTaskResult(
  context: AdapterTaskContext,
  startedAtMs: number,
  discoveredPositions: Position[],
  positionsFound: number,
  errorMessage?: string
): AdapterTaskResult {
  return {
    index: context.index,
    protocolKey: context.adapter.protocolKey,
    protocolName: context.adapter.protocolName,
    chain: context.chain,
    discoveredPositions,
    positionsFound,
    durationMs: Date.now() - startedAtMs,
    errorMessage,
  };
}

async function discoverSingleAdapter(
  context: AdapterTaskContext,
  walletId: string,
  checksumAddress: string,
  config: DiscoveryRuntimeConfig,
  onProgress?: DiscoveryProgressCallback
): Promise<AdapterTaskResult> {
  const startedAtMs = Date.now();
  const discoveredPositions: Position[] = [];
  let positionsFoundForProtocol = 0;
  let errorMessage: string | undefined;
  const { adapter } = context;

  if (onProgress) {
    onProgress({
      type: 'protocol_start',
      data: {
        protocol: adapter.protocolName,
        index: context.index + 1,
        total: context.total,
      },
    });
  } else {
    console.log(`[${context.index + 1}/${context.total}] Discovering ${adapter.protocolName}...`);
  }

  if (isChainCircuitOpen(context.chain, config)) {
    const remainingMs = getCircuitOpenRemainingMs(context.chain);
    errorMessage = `${context.chain} RPC circuit breaker is open (${remainingMs}ms remaining)`;
    console.warn(
      `[discovery] Skipping ${adapter.protocolName} on ${context.chain} ` +
      `because circuit breaker is open (${remainingMs}ms remaining)`
    );
    if (onProgress) {
      onProgress({
        type: 'protocol_error',
        data: {
          protocol: adapter.protocolName,
          message: errorMessage,
        },
      });
      onProgress({
        type: 'protocol_complete',
        data: {
          protocol: adapter.protocolName,
          positionsFound: 0,
        },
      });
    }
    return createAdapterTaskResult(
      context,
      startedAtMs,
      discoveredPositions,
      positionsFoundForProtocol,
      errorMessage
    );
  }

  try {
    const positions = await withRetry(
      'adapter.discover',
      context,
      config,
      () => withTimeout(`${adapter.protocolName} discover`, config.discoverTimeoutMs, () => adapter.discover(checksumAddress))
    );

    for (const positionData of positions) {
      try {
        // Add wallet address and protocol key to metadata for use in updates
        const enrichedMetadata = {
          ...positionData.metadata,
          walletAddress: checksumAddress,
          protocolKey: adapter.protocolKey,
        };

        // Create a temporary position object to check value before persisting
        const tempPosition = {
          ...positionData,
          metadata: enrichedMetadata,
        } as Position;

        // Read current value before creating position to filter out dust
        const currentValue = await withRetry(
          `adapter.readCurrentValue:${positionData.protocolPositionKey ?? 'unknown-position'}`,
          context,
          config,
          () => withTimeout(
            `${adapter.protocolName} readCurrentValue`,
            config.readTimeoutMs,
            () => adapter.readCurrentValue(tempPosition)
          )
        );

        // Skip positions below the dust threshold. Rewards positions track unclaimed
        // fees only — any positive value is live, but exactly $0 means closed/burned.
        // Savings/fixed-income positions use a $10 floor to filter residual dust.
        const dustThreshold = getDustThreshold(positionData.measureMethod);
        const isRewards = getPositionCategory(positionData.measureMethod ?? 'balance') === 'rewards';
        const keepZeroValueRewards = isRewards && currentValue === 0 && allowsZeroValueDiscovery(positionData);

        if (!keepZeroValueRewards && currentValue <= dustThreshold) {
          console.log(
            `Skipping ${adapter.protocolName} position ${positionData.protocolPositionKey ?? 'unknown'} ` +
            `with dust value $${currentValue.toFixed(2)}`
          );
          continue;
        }

        const position = await createPosition(walletId, adapter.protocolKey, {
          ...positionData,
          metadata: enrichedMetadata,
        });

        discoveredPositions.push(position);
        positionsFoundForProtocol++;

        // Only create initial snapshot if position doesn't already have one
        // (prevents daily discovery from overwriting APY-containing snapshots)
        const existingSnapshot = await getLatestSnapshot(position.id);

        if (!existingSnapshot) {
          try {
            await createSnapshot(
              position.id,
              new Date(),
              currentValue,
              0, // Initial snapshot has no net flows
              0, // Initial snapshot has no yield delta
              null // No APY for first snapshot
            );

            // Seed the future-income projection cache so API metrics reflect
            // correct shouldProjectFutureIncome before the first hourly update.
            await refreshFutureIncomeProjection(position, adapter.protocolKey, adapter);

            // Notify about found position if callback provided
            if (onProgress) {
              onProgress({
                type: 'position_found',
                data: {
                  protocol: adapter.protocolName,
                  displayName: position.displayName,
                  baseAsset: position.baseAsset,
                  valueUsd: currentValue,
                },
              });
            }
          } catch (error) {
            console.error(`Failed to create initial snapshot for position ${position.id}:`, error);
          }
        } else {
          console.log(`Position ${position.id} already has snapshots - skipping initial snapshot creation`);
        }
      } catch (error) {
        console.error(`Failed to create position for ${adapter.protocolName}:`, error);
      }
    }
    recordChainSuccess(context.chain, config);
  } catch (error) {
    errorMessage = getErrorMessage(error);
    console.error(`Discovery failed for ${adapter.protocolName}:`, error);
    if (onProgress) {
      onProgress({
        type: 'protocol_error',
        data: { protocol: adapter.protocolName, message: errorMessage },
      });
    }
    if (isRetryableError(error)) {
      recordChainFailure(context.chain, error, context, config);
    }
  } finally {
    // Notify protocol complete (always)
    if (onProgress) {
      onProgress({
        type: 'protocol_complete',
        data: {
          protocol: adapter.protocolName,
          positionsFound: positionsFoundForProtocol,
        },
      });
    }
  }

  const result = createAdapterTaskResult(
    context,
    startedAtMs,
    discoveredPositions,
    positionsFoundForProtocol,
    errorMessage
  );

  if (config.logMetrics) {
    console.log(
      `[discovery] protocol=${result.protocolKey} chain=${result.chain} positions=${result.positionsFound} durationMs=${result.durationMs}`
    );
  }

  return result;
}

async function runAdaptersSequentially(
  tasks: AdapterTaskContext[],
  walletId: string,
  checksumAddress: string,
  config: DiscoveryRuntimeConfig,
  onProgress?: DiscoveryProgressCallback
): Promise<AdapterTaskResult[]> {
  const results: AdapterTaskResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const result = await discoverSingleAdapter(tasks[i], walletId, checksumAddress, config, onProgress);
    results.push(result);

    // Add delay between protocols to respect RPC rate limits.
    // Skip delay after the last protocol.
    if (i < tasks.length - 1) {
      await sleep(DISCOVERY_SLEEP_MS);
    }
  }

  return results;
}

async function runAdaptersInParallel(
  tasks: AdapterTaskContext[],
  walletId: string,
  checksumAddress: string,
  config: DiscoveryRuntimeConfig,
  onProgress?: DiscoveryProgressCallback
): Promise<AdapterTaskResult[]> {
  const pending = [...tasks];
  const results: AdapterTaskResult[] = [];
  const activeByChain: Record<DiscoveryChain, number> = {
    ethereum: 0,
    arbitrum: 0,
    other: 0,
  };
  let activeTotal = 0;

  return new Promise((resolve) => {
    if (pending.length === 0) {
      resolve(results);
      return;
    }

    const finishTask = () => {
      if (results.length === tasks.length) {
        resolve(results);
        return;
      }
      schedule();
    };

    const startTask = (task: AdapterTaskContext) => {
      activeTotal++;
      activeByChain[task.chain]++;

      void discoverSingleAdapter(task, walletId, checksumAddress, config, onProgress)
        .then((result) => {
          results.push(result);
        })
        .catch((error) => {
          console.error(`[discovery] Adapter task crashed unexpectedly for ${task.adapter.protocolName}:`, error);
          results.push(createAdapterTaskResult(task, Date.now(), [], 0));
        })
        .finally(() => {
          activeTotal--;
          activeByChain[task.chain]--;
          finishTask();
        });
    };

    const schedule = () => {
      while (activeTotal < config.maxConcurrency && pending.length > 0) {
        const nextTaskIndex = pending.findIndex(
          (task) => activeByChain[task.chain] < config.chainConcurrency[task.chain]
        );

        if (nextTaskIndex === -1) {
          break;
        }

        const [nextTask] = pending.splice(nextTaskIndex, 1);
        startTask(nextTask);
      }

      // Deadlock safety guard in case all chain caps are misconfigured.
      if (activeTotal === 0 && pending.length > 0) {
        const [nextTask] = pending.splice(0, 1);
        startTask(nextTask);
      }
    };

    schedule();
  });
}

/**
 * Core discovery logic - discovers positions with optional progress callbacks
 * Supports both sequential and bounded-parallel execution modes.
 * Sequential mode remains the default for safe rollout.
 */
async function discoverPositionsCore(
  walletId: string,
  walletAddress: string,
  onProgress?: DiscoveryProgressCallback
): Promise<Position[]> {
  const runtimeConfig = getDiscoveryRuntimeConfig();
  const checksumAddress = toChecksumAddress(walletAddress);
  const adapters = getAllAdapters();
  const tasks: AdapterTaskContext[] = adapters.map((adapter, index) => ({
    adapter,
    index,
    total: adapters.length,
    chain: getAdapterChain(adapter.protocolKey),
  }));
  const useParallel = runtimeConfig.parallelEnabled && runtimeConfig.maxConcurrency > 1 && tasks.length > 1;
  const startedAtMs = Date.now();

  // Notify start if callback provided
  if (onProgress) {
    onProgress({ type: 'start', data: { totalProtocols: adapters.length } });
  } else {
    if (useParallel) {
      console.log(
        `Discovering positions for ${adapters.length} protocols ` +
        `(parallel mode: global=${runtimeConfig.maxConcurrency}, ` +
        `ethereum=${runtimeConfig.chainConcurrency.ethereum}, ` +
        `arbitrum=${runtimeConfig.chainConcurrency.arbitrum}, ` +
        `other=${runtimeConfig.chainConcurrency.other})...`
      );
    } else {
      console.log(`Discovering positions for ${adapters.length} protocols (sequential mode)...`);
    }
  }

  const taskResults = useParallel
    ? await runAdaptersInParallel(tasks, walletId, checksumAddress, runtimeConfig, onProgress)
    : await runAdaptersSequentially(tasks, walletId, checksumAddress, runtimeConfig, onProgress);

  const discoveredPositions = taskResults
    .sort((a, b) => a.index - b.index)
    .flatMap((result) => result.discoveredPositions);

  if (runtimeConfig.logMetrics) {
    const durationMs = Date.now() - startedAtMs;
    console.log(
      `[discovery] mode=${useParallel ? 'parallel' : 'sequential'} ` +
      `protocols=${tasks.length} positions=${discoveredPositions.length} durationMs=${durationMs}`
    );
  }

  // Notify completion
  if (onProgress) {
    onProgress({
      type: 'complete',
      data: {
        totalPositions: discoveredPositions.length,
        failedProtocols: taskResults.flatMap((result) => result.errorMessage === undefined
          ? []
          : [{ protocol: result.protocolName, message: result.errorMessage }]),
      },
    });
  } else {
    console.log(`Discovery complete: found ${discoveredPositions.length} positions`);
  }

  return discoveredPositions;
}

async function discoverPositionsDeduped(
  walletId: string,
  walletAddress: string,
  onProgress?: DiscoveryProgressCallback
): Promise<Position[]> {
  const existing = inFlightWalletDiscoveries.get(walletId);
  if (existing) {
    if (onProgress) {
      existing.progressCallbacks.add(onProgress);
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - existing.startedAtMs) / 1000));
      const latestEvent = existing.latestProgressEvent;
      const currentProtocol = latestEvent?.type === 'protocol_start'
        ? ` Currently checking ${latestEvent.data.protocol} (${latestEvent.data.index}/${latestEvent.data.total}).`
        : '';

      try {
        onProgress({
          type: 'status',
          data: {
            message: `A discovery is already running for this wallet; joined it after ${elapsedSeconds}s.${currentProtocol}`,
          },
        });
      } catch (error) {
        console.error('[discovery] Progress callback failed while joining in-flight discovery:', error);
      }
    }
    console.info(
      `[discovery] Joined in-flight wallet discovery walletId=${walletId} ` +
      `elapsedMs=${Date.now() - existing.startedAtMs}`
    );
    return existing.promise.finally(() => {
      if (onProgress) {
        existing.progressCallbacks.delete(onProgress);
      }
    });
  }

  const progressCallbacks = new Set<DiscoveryProgressCallback>();
  if (onProgress) {
    progressCallbacks.add(onProgress);
  }

  const discoveryState: InFlightWalletDiscovery = {
    promise: Promise.resolve([]),
    progressCallbacks,
    startedAtMs: Date.now(),
  };

  const fanoutProgress: DiscoveryProgressCallback = (event) => {
    discoveryState.latestProgressEvent = event;
    for (const callback of progressCallbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('[discovery] Progress callback failed:', error);
      }
    }
  };

  const discoveryPromise = discoverPositionsCore(walletId, walletAddress, fanoutProgress)
    .finally(() => {
      inFlightWalletDiscoveries.delete(walletId);
    });

  discoveryState.promise = discoveryPromise;
  inFlightWalletDiscoveries.set(walletId, discoveryState);

  return discoveryPromise.finally(() => {
    if (onProgress) {
      progressCallbacks.delete(onProgress);
    }
  });
}

/**
 * Discover all positions for a wallet across all protocols
 * Uses sequential mode by default, or bounded parallel mode when enabled.
 */
export async function discoverPositions(
  walletId: string,
  walletAddress: string
): Promise<Position[]> {
  return discoverPositionsDeduped(walletId, walletAddress);
}

/**
 * Discover all positions for a wallet with progress callbacks
 * Used for SSE streaming to frontend
 */
export async function discoverPositionsWithProgress(
  walletId: string,
  walletAddress: string,
  onProgress: DiscoveryProgressCallback
): Promise<Position[]> {
  return discoverPositionsDeduped(walletId, walletAddress, onProgress);
}

/**
 * Discover positions for a specific protocol
 */
export async function discoverPositionsForProtocol(
  walletId: string,
  walletAddress: string,
  protocolKey: ProtocolKey
): Promise<Position[]> {
  const runtimeConfig = getDiscoveryRuntimeConfig();
  const checksumAddress = toChecksumAddress(walletAddress);
  const adapter = getAdapter(protocolKey);
  const context: AdapterTaskContext = {
    adapter,
    index: 0,
    total: 1,
    chain: getAdapterChain(adapter.protocolKey),
  };

  const result = await discoverSingleAdapter(
    context,
    walletId,
    checksumAddress,
    runtimeConfig,
    undefined
  );

  return result.discoveredPositions;
}
