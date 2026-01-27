import { BaseProtocolAdapter } from './base';
import { Position, ProtocolKey } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi } from '../utils/config';

/**
 * Pendle Principal Token (PT) Adapter
 *
 * PT tokens are fixed-income instruments that trade at a discount and converge
 * to par ($1.00) at maturity. They represent principal-only exposure to
 * yield-bearing assets.
 *
 * Value calculation:
 * - Get PT balance via ERC20 balanceOf()
 * - Fetch current USD price from Pendle API
 * - After maturity: PT = $1.00 (redeemable 1:1)
 *
 * This adapter is config-driven - each PT token gets its own protocol key
 * but uses the same adapter logic (same pattern as YearnV3Adapter).
 */
export class PendlePtAdapter extends BaseProtocolAdapter {
  readonly protocolKey: ProtocolKey;
  readonly protocolName: string;

  private static readonly PENDLE_API_BASE = 'https://api-v2.pendle.finance/core/v1';
  private static readonly CHAIN_ID = 1; // Ethereum mainnet

  constructor(protocolKey: ProtocolKey, protocolName: string) {
    super();
    this.protocolKey = protocolKey;
    this.protocolName = protocolName;
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.ptToken || !config.baseAsset) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const erc20Abi = getAbi('ERC20');
      const ptContract = getContract(config.ptToken, erc20Abi);

      await rpcThrottle();
      const balance = await ptContract.balanceOf(checksumAddress);

      if (balance > 0n) {
        const positionKey = this.createPositionKey(config.ptToken, config.baseAsset);

        positions.push({
          protocolPositionKey: positionKey,
          displayName: config.name,
          baseAsset: config.baseAsset,
          countingMode: config.countingMode || 'count',
          measureMethod: 'balance', // PT tokens use simple balance * price
          metadata: {
            walletAddress: checksumAddress,
            ptToken: config.ptToken,
            tokenAddress: config.ptToken, // For exit detection compatibility
            decimals: config.decimals ?? 18,
            maturityDate: config.maturityDate,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering ${this.protocolKey} for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { ptToken, decimals, walletAddress, maturityDate } = position.metadata;

    if (!ptToken || decimals === undefined || !walletAddress) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const erc20Abi = getAbi('ERC20');
    const ptContract = getContract(ptToken, erc20Abi);

    await rpcThrottle();

    let balance: bigint;
    try {
      balance = await ptContract.balanceOf(walletAddress);
    } catch (error: any) {
      console.error(`${this.protocolName}: RPC error reading balance:`, {
        ptToken,
        walletAddress,
        error: error.message || error,
      });
      throw new Error(`Failed to read balance for ${this.protocolName}: ${error.message || error}`);
    }

    // Early return for zero balance (position exited)
    if (balance === 0n) {
      console.warn(`${this.protocolName}: Zero balance detected - ptToken=${ptToken}, wallet=${walletAddress}`);
      return 0;
    }

    const tokenAmount = parseFloat(formatUnits(balance, decimals));

    // Get price from Pendle API (or use $1.00 if matured)
    const priceUsd = await this.getPtPrice(ptToken, maturityDate);

    console.log(
      `${this.protocolName}: ${tokenAmount.toFixed(2)} PT @ $${priceUsd.toFixed(4)} = $${(tokenAmount * priceUsd).toFixed(2)}`
    );

    return tokenAmount * priceUsd;
  }

  /**
   * Fetch PT price from Pendle API
   * Returns $1.00 if matured, 0.95 fallback on API failure
   */
  private async getPtPrice(ptToken: string, maturityDate?: string): Promise<number> {
    // Check if matured - PT is redeemable 1:1 after maturity
    if (maturityDate) {
      const maturity = new Date(maturityDate);
      if (Date.now() >= maturity.getTime()) {
        console.log(`${this.protocolName}: PT matured on ${maturityDate}, using $1.00`);
        return 1.0;
      }
    }

    try {
      const url = `${PendlePtAdapter.PENDLE_API_BASE}/prices/assets?ids=${PendlePtAdapter.CHAIN_ID}-${ptToken.toLowerCase()}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`${this.protocolName}: Pendle API returned ${response.status}, using fallback price`);
        return 0.95; // Conservative fallback
      }

      const data = (await response.json()) as { prices: Record<string, number> };

      // Response format: { prices: { "1-0xabc...": 0.987 } }
      const key = `${PendlePtAdapter.CHAIN_ID}-${ptToken.toLowerCase()}`;
      const price = data.prices?.[key];

      if (typeof price === 'number' && price > 0) {
        return price;
      }

      console.warn(`${this.protocolName}: Price not found in Pendle API response, using fallback`);
      return 0.95;
    } catch (error) {
      console.error(`${this.protocolName}: Failed to fetch price from Pendle API:`, error);
      return 0.95; // Conservative fallback on any error
    }
  }
}
