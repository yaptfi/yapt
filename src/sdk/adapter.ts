import { Position, NetFlowResult, ProtocolKey } from '../types';

/**
 * Base protocol adapter interface
 * All protocol implementations must implement these methods
 */
export interface IProtocolAdapter {
  /**
   * The protocol key identifier
   */
  readonly protocolKey: ProtocolKey;

  /**
   * The protocol display name
   */
  readonly protocolName: string;

  /**
   * Discover all positions for a given wallet address
   *
   * @param walletAddress - The wallet address to scan
   * @returns Array of discovered positions (without wallet_id or position_id)
   */
  discover(walletAddress: string): Promise<Partial<Position>[]>;

  /**
   * Read the current value of a position
   *
   * @param position - The position to measure
   * @returns Current value in USD
   */
  readCurrentValue(position: Position): Promise<number>;

  /**
   * Calculate net flows (deposits/withdrawals) for a position
   * within a specific block range
   *
   * DEPRECATED: Flow detection removed - with hourly updates, deposits/withdrawals
   * are obvious from value changes. This method is optional and defaults to 0 flows.
   *
   * @param position - The position to analyze
   * @param fromBlock - Starting block number
   * @param toBlock - Ending block number (or 'latest')
   * @returns Net flows in USD (positive = deposit, negative = withdrawal)
   */
  calcNetFlows?(
    position: Position,
    fromBlock: number,
    toBlock: number | 'latest'
  ): Promise<NetFlowResult>;
}

/**
 * Abstract base class with common utilities
 */
export abstract class BaseProtocolAdapter implements IProtocolAdapter {
  abstract readonly protocolKey: ProtocolKey;
  abstract readonly protocolName: string;

  abstract discover(walletAddress: string): Promise<Partial<Position>[]>;
  abstract readCurrentValue(position: Position): Promise<number>;

  /**
   * Optional: Calculate net flows (deprecated - returns 0 by default)
   */
  async calcNetFlows(
    _position: Position,
    fromBlock: number,
    toBlock: number | 'latest'
  ): Promise<NetFlowResult> {
    // Default implementation: no flow tracking needed with hourly updates
    const provider = (await import('../utils/ethereum')).getProvider();
    const latestBlock = toBlock === 'latest' ? await provider.getBlockNumber() : toBlock;
    return {
      netFlowsUsd: 0,
      fromBlock,
      toBlock: latestBlock,
    };
  }

  /**
   * Helper to create a protocol position key
   * This should be unique per protocol position type
   */
  protected createPositionKey(...parts: string[]): string {
    return parts.join(':');
  }

  /**
   * Helper to get stable price (with override support)
   */
  protected getStablePrice(asset: string, priceOverrides: Record<string, number>): number {
    return priceOverrides[asset] || 1.0;
  }
}

