import { JsonRpcProvider, Network } from 'ethers';
import { RPCManager } from './rpc-manager';

/**
 * RPC Proxy Provider
 *
 * A custom ethers.js provider that routes all RPC calls through the RPCManager
 * for load balancing, rate limiting, and automatic failover.
 *
 * This provider is a drop-in replacement for ethers.JsonRpcProvider and works
 * transparently with all existing code including contracts, multicall, etc.
 */
export class RPCProxyProvider extends JsonRpcProvider {
  private rpcManager: RPCManager;
  private readonly configuredNetwork?: Network;
  private readonly scanOnly: boolean;
  private scanProvider?: RPCProxyProvider;

  constructor(rpcManager: RPCManager, network?: Network, scanOnly = false) {
    // Use the first provider's URL for the parent class
    // This allows ethers' internal network detection to work
    // IMPORTANT: Use getConfigs() not getStatus() - getStatus() truncates URLs for display
    const firstProviderUrl = rpcManager.getConfigs()[0]?.url || 'http://localhost';
    super(firstProviderUrl, network, { batchMaxCount: 1 });
    this.rpcManager = rpcManager;
    this.configuredNetwork = network;
    this.scanOnly = scanOnly;
  }

  /**
   * Override send() to route RPC calls through RPCManager
   * This is called by ethers for most RPC operations
   */
  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    const paramsArray = Array.isArray(params) ? params : [params];
    return this.scanOnly
      ? await this.rpcManager.sendScan(method, paramsArray)
      : await this.rpcManager.send(method, paramsArray);
  }

  /**
   * Return a stable provider view that routes every call only through
   * scan-capable managed providers.
   */
  getScanCapableProvider(): RPCProxyProvider | null {
    if (!this.rpcManager.hasScanCapableProviders()) {
      return null;
    }

    if (!this.scanProvider) {
      this.scanProvider = new RPCProxyProvider(this.rpcManager, this.configuredNetwork, true);
    }
    return this.scanProvider;
  }

  /**
   * Get RPC manager status (for monitoring/debugging)
   */
  getManagerStatus() {
    return {
      providers: this.rpcManager.getStatus(),
      queue: this.rpcManager.getQueueStatus(),
    };
  }

  /**
   * Get ENS-capable provider for direct ENS resolution
   * Bypasses the queue and uses a provider that supports ENS
   */
  getENSCapableProvider() {
    return this.rpcManager.getENSCapableProvider();
  }

  /**
   * Get underlying RPC manager instance
   */
  getRPCManager(): RPCManager {
    return this.rpcManager;
  }
}

/**
 * Create an RPCProxyProvider from a list of provider configs
 */
export function createManagedProvider(
  configs: Array<{
    id?: number;
    name: string;
    url: string;
    arbitrumUrl?: string;
    callsPerSecond: number;
    callsPerDay?: number;
    priority: number;
    isActive: boolean;
    supportsEthereum?: boolean;
    supportsArbitrum?: boolean;
    supportsLargeBlockScans?: boolean;
    supportsENS?: boolean;
  }>,
  options?: {
    network?: Network;
    maxQueueSize?: number;
    maxConcurrency?: number;
  }
): RPCProxyProvider {
  const rpcManager = new RPCManager(configs, {
    maxQueueSize: options?.maxQueueSize,
    maxConcurrency: options?.maxConcurrency,
    network: options?.network,
  });

  return new RPCProxyProvider(rpcManager, options?.network);
}
