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

  constructor(rpcManager: RPCManager, network?: Network) {
    // Use the first provider's URL for the parent class
    // This allows ethers' internal network detection to work
    // IMPORTANT: Use getConfigs() not getStatus() - getStatus() truncates URLs for display
    const firstProviderUrl = rpcManager.getConfigs()[0]?.url || 'http://localhost';
    super(firstProviderUrl, network);
    this.rpcManager = rpcManager;
  }

  /**
   * Override send() to route RPC calls through RPCManager
   * This is called by ethers for most RPC operations
   */
  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    const paramsArray = Array.isArray(params) ? params : [params];
    return await this.rpcManager.send(method, paramsArray);
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
    name: string;
    url: string;
    callsPerSecond: number;
    callsPerDay?: number;
    priority: number;
    isActive: boolean;
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
  });

  return new RPCProxyProvider(rpcManager, options?.network);
}
