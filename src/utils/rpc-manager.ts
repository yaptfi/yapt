import { ethers } from 'ethers';

/**
 * RPC Provider Configuration
 */
export interface RPCProviderConfig {
  id?: number;
  name: string;
  url: string;
  callsPerSecond: number;
  callsPerDay?: number;
  priority: number;
  isActive: boolean;
  supportsLargeBlockScans?: boolean; // Can handle eth_getLogs with large block ranges (10k+ blocks)
  supportsENS?: boolean; // Can handle ENS resolution (resolveName, lookupAddress)
}

/**
 * Token Bucket for rate limiting
 * Allows burst traffic up to bucket capacity while maintaining average rate
 */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillRate: number // tokens per second
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token from the bucket
   * Returns true if successful, false if no tokens available
   */
  tryConsume(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Get time in ms until next token is available
   */
  getTimeUntilNextToken(): number {
    this.refill();

    if (this.tokens >= 1) {
      return 0;
    }

    const tokensNeeded = 1 - this.tokens;
    return (tokensNeeded / this.refillRate) * 1000;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    const tokensToAdd = elapsedSeconds * this.refillRate;

    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  /**
   * Get current token count (for debugging/monitoring)
   */
  getTokenCount(): number {
    this.refill();
    return this.tokens;
  }
}

/**
 * Provider state tracking
 */
interface ProviderState {
  config: RPCProviderConfig;
  provider: ethers.JsonRpcProvider;
  tokenBucket: TokenBucket;
  dailyCallCount: number;
  dailyResetTime: number; // midnight UTC timestamp
  consecutiveErrors: number;
  lastErrorTime?: number;
  isHealthy: boolean;
}

/**
 * Queued RPC call
 */
interface QueuedCall<T> {
  method: string;
  params: any[];
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  enqueueTime: number;
}

/**
 * RPC Manager
 * Manages multiple RPC providers with rate limiting, load balancing, and failover
 */
export class RPCManager {
  private providers: ProviderState[] = [];
  private queue: QueuedCall<any>[] = [];
  private activeRequests = 0;
  private roundRobinIndex = 0;
  private readonly maxQueueSize: number;
  private readonly maxConcurrency: number;
  private readonly maxConsecutiveErrors = 3;
  private readonly errorBackoffMs = 60000; // 1 minute

  constructor(
    configs: RPCProviderConfig[],
    options?: {
      maxQueueSize?: number;
      maxConcurrency?: number;
    }
  ) {
    this.maxQueueSize = options?.maxQueueSize || 1000;
    this.maxConcurrency = options?.maxConcurrency || 50;

    // Initialize providers sorted by priority (highest first)
    const sortedConfigs = [...configs]
      .filter(c => c.isActive)
      .sort((a, b) => b.priority - a.priority);

    for (const config of sortedConfigs) {
      this.providers.push(this.createProviderState(config));
    }

    if (this.providers.length === 0) {
      throw new Error('No active RPC providers configured');
    }

    console.log(`[RPCManager] Initialized with ${this.providers.length} provider(s)`);
  }

  /**
   * Create provider state with token bucket
   */
  private createProviderState(config: RPCProviderConfig): ProviderState {
    const provider = new ethers.JsonRpcProvider(config.url);
    const tokenBucket = new TokenBucket(
      config.callsPerSecond * 2, // Allow burst up to 2 seconds worth
      config.callsPerSecond
    );

    return {
      config,
      provider,
      tokenBucket,
      dailyCallCount: 0,
      dailyResetTime: this.getNextMidnightUTC(),
      consecutiveErrors: 0,
      isHealthy: true,
    };
  }

  /**
   * Get next midnight UTC timestamp
   */
  private getNextMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.getTime();
  }

  /**
   * Reset daily counters if needed
   */
  private resetDailyCountersIfNeeded(state: ProviderState): void {
    const now = Date.now();
    if (now >= state.dailyResetTime) {
      state.dailyCallCount = 0;
      state.dailyResetTime = this.getNextMidnightUTC();
    }
  }

  /**
   * Check if provider is available (healthy + not rate limited)
   */
  private isProviderAvailable(state: ProviderState): boolean {
    // Check if in error backoff period
    if (!state.isHealthy && state.lastErrorTime) {
      const backoffRemaining = (state.lastErrorTime + this.errorBackoffMs) - Date.now();
      if (backoffRemaining > 0) {
        return false;
      }
      // Backoff period over, reset error count
      state.consecutiveErrors = 0;
      state.isHealthy = true;
    }

    // Check daily limit
    this.resetDailyCountersIfNeeded(state);
    if (state.config.callsPerDay && state.dailyCallCount >= state.config.callsPerDay) {
      return false;
    }

    // Check token bucket
    return state.tokenBucket.tryConsume();
  }

  /**
   * Get next available provider using round-robin with health checks
   */
  private async getNextProvider(): Promise<ProviderState | null> {
    if (this.providers.length === 0) {
      return null;
    }

    let attempts = 0;

    while (attempts < this.providers.length) {
      const state = this.providers[this.roundRobinIndex];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.providers.length;
      attempts++;

      if (this.isProviderAvailable(state)) {
        return state;
      }
    }

    // No provider available immediately, find the one with shortest wait time
    let shortestWait = Infinity;
    let bestProvider: ProviderState | null = null;

    for (const state of this.providers) {
      if (!state.isHealthy) continue;

      this.resetDailyCountersIfNeeded(state);
      if (state.config.callsPerDay && state.dailyCallCount >= state.config.callsPerDay) {
        continue; // Skip providers at daily limit
      }

      const waitTime = state.tokenBucket.getTimeUntilNextToken();
      if (waitTime < shortestWait) {
        shortestWait = waitTime;
        bestProvider = state;
      }
    }

    if (bestProvider && shortestWait < 5000) { // Max wait 5 seconds
      await new Promise(resolve => setTimeout(resolve, shortestWait));
      bestProvider.tokenBucket.tryConsume();
      return bestProvider;
    }

    return null;
  }

  /**
   * Mark provider as failed and update health status
   */
  private markProviderError(state: ProviderState, error: Error): void {
    state.consecutiveErrors++;
    state.lastErrorTime = Date.now();

    if (state.consecutiveErrors >= this.maxConsecutiveErrors) {
      state.isHealthy = false;
      console.error(
        `[RPCManager] Provider "${state.config.name}" marked unhealthy after ${state.consecutiveErrors} consecutive errors. ` +
        `Will retry after ${this.errorBackoffMs}ms. Last error:`,
        error.message
      );
    } else {
      console.warn(
        `[RPCManager] Provider "${state.config.name}" error (${state.consecutiveErrors}/${this.maxConsecutiveErrors}):`,
        error.message
      );
    }
  }

  /**
   * Mark provider as successful (reset error count)
   */
  private markProviderSuccess(state: ProviderState): void {
    if (state.consecutiveErrors > 0) {
      state.consecutiveErrors = 0;
    }
    if (!state.isHealthy) {
      state.isHealthy = true;
      console.log(`[RPCManager] Provider "${state.config.name}" recovered and marked healthy`);
    }
    state.dailyCallCount++;
  }

  /**
   * Execute an RPC call with automatic failover
   */
  private async executeCall<T>(method: string, params: any[]): Promise<T> {
    let lastError: Error | null = null;
    const maxRetries = this.providers.length;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const providerState = await this.getNextProvider();

      if (!providerState) {
        // All providers exhausted or rate limited
        throw new Error(
          `All RPC providers exhausted or rate limited. Last error: ${lastError?.message || 'unknown'}`
        );
      }

      try {
        // Execute the RPC call
        const result = await providerState.provider.send(method, params);
        this.markProviderSuccess(providerState);
        return result;
      } catch (error) {
        lastError = error as Error;
        this.markProviderError(providerState, error as Error);

        // If it's not a provider error (e.g., invalid params), don't retry
        if (this.isNonRetryableError(error as Error)) {
          throw error;
        }

        // Continue to next provider
        console.log(`[RPCManager] Retrying with next provider (attempt ${attempt + 1}/${maxRetries})`);
      }
    }

    throw lastError || new Error('Failed to execute RPC call after all retries');
  }

  /**
   * Check if error is non-retryable (e.g., invalid params, not provider failure)
   */
  private isNonRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('invalid argument') ||
      message.includes('invalid params') ||
      message.includes('missing argument') ||
      message.includes('out of gas')
    );
  }

  /**
   * Queue a call for execution
   */
  async send<T = any>(method: string, params: any[]): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.queue.length >= this.maxQueueSize) {
        reject(new Error(`RPC queue full (max: ${this.maxQueueSize})`));
        return;
      }

      this.queue.push({
        method,
        params,
        resolve,
        reject,
        enqueueTime: Date.now(),
      });

      this.processQueue();
    });
  }

  /**
   * Process queued calls concurrently
   * Spawns workers up to maxConcurrency limit to process queue items in parallel
   */
  private async processQueue(): Promise<void> {
    // Spawn workers up to concurrency limit
    while (this.activeRequests < this.maxConcurrency && this.queue.length > 0) {
      this.processNextCall();
    }
  }

  /**
   * Process a single call from the queue
   * This runs as an independent worker that processes one call then exits
   */
  private async processNextCall(): Promise<void> {
    const call = this.queue.shift();
    if (!call) {
      return;
    }

    this.activeRequests++;

    try {
      const result = await this.executeCall(call.method, call.params);
      call.resolve(result);
    } catch (error) {
      call.reject(error as Error);
    } finally {
      this.activeRequests--;

      // If there are more items in queue, spawn another worker
      if (this.queue.length > 0 && this.activeRequests < this.maxConcurrency) {
        this.processNextCall();
      }
    }
  }

  /**
   * Get configs of all providers (full URLs, no truncation)
   */
  getConfigs(): RPCProviderConfig[] {
    return this.providers.map(state => state.config);
  }

  /**
   * Get status of all providers (for monitoring)
   */
  getStatus() {
    return this.providers.map(state => {
      this.resetDailyCountersIfNeeded(state);

      return {
        name: state.config.name,
        url: state.config.url.substring(0, 50) + '...', // Truncate for display
        priority: state.config.priority,
        callsPerSecond: state.config.callsPerSecond,
        callsPerDay: state.config.callsPerDay,
        dailyCallCount: state.dailyCallCount,
        availableTokens: state.tokenBucket.getTokenCount(),
        consecutiveErrors: state.consecutiveErrors,
        isHealthy: state.isHealthy,
        nextTokenIn: state.tokenBucket.getTimeUntilNextToken(),
      };
    });
  }

  /**
   * Get queue status
   */
  getQueueStatus() {
    return {
      queueLength: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      activeRequests: this.activeRequests,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /**
   * Get a provider that supports large block scans
   * Returns a direct ethers provider (not proxied through queue)
   * Used for operations like eth_getLogs that may scan 100k+ blocks
   */
  getScanCapableProvider(): ethers.JsonRpcProvider | null {
    // Filter to only providers that support large block scans
    const scanCapableProviders = this.providers.filter(
      state => state.config.supportsLargeBlockScans === true && state.isHealthy
    );

    if (scanCapableProviders.length === 0) {
      console.warn('[RPCManager] No scan-capable providers available');
      return null;
    }

    // Return the highest priority scan-capable provider
    // (providers are already sorted by priority)
    return scanCapableProviders[0].provider;
  }

  /**
   * Get a provider that supports ENS resolution
   * Returns a direct ethers provider (not proxied through queue)
   * Used for resolveName() and lookupAddress() operations
   */
  getENSCapableProvider(): ethers.JsonRpcProvider | null {
    // Filter to only providers that support ENS
    const ensCapableProviders = this.providers.filter(
      state => state.config.supportsENS !== false && state.isHealthy
    );

    if (ensCapableProviders.length === 0) {
      console.warn('[RPCManager] No ENS-capable providers available');
      return null;
    }

    // Return the highest priority ENS-capable provider
    // (providers are already sorted by priority)
    return ensCapableProviders[0].provider;
  }

  /**
   * Add a new provider at runtime
   */
  addProvider(config: RPCProviderConfig): void {
    if (!config.isActive) {
      return;
    }

    const state = this.createProviderState(config);
    this.providers.push(state);

    // Re-sort by priority
    this.providers.sort((a, b) => b.config.priority - a.config.priority);

    console.log(`[RPCManager] Added provider "${config.name}"`);
  }

  /**
   * Remove a provider by name
   */
  removeProvider(name: string): boolean {
    const index = this.providers.findIndex(p => p.config.name === name);
    if (index >= 0) {
      this.providers.splice(index, 1);
      console.log(`[RPCManager] Removed provider "${name}"`);
      return true;
    }
    return false;
  }
}
