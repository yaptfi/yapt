import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

/**
 * Morpheus Gauntlet USDC Prime (gtUSDC) Adapter
 *
 * Treats gtUSDC as an ERC4626 vault:
 * - Shares held in `token` (gtUSDC)
 * - Underlying asset = USDC (6 decimals)
 * - Value = convertToAssets(shares) * $1.00
 */
export class MorpheusGtUsdcPrimeAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'morpheus-gtusdc-prime' as const;
  readonly protocolName = 'Morpheus Gauntlet USDC Prime (gtUSDC)';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.token) {
      throw new Error('Morpheus gtUSDC config not found');
    }

    const positions: Partial<Position>[] = [];
    const erc20Abi = getAbi('ERC20');
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const shareToken = getContract(config.token, erc20Abi);
      const balance = await shareToken.balanceOf(checksumAddress);

      if (balance > 0n) {
        const positionKey = this.createPositionKey(config.token, 'USDC');

        // Probe decimals robustly from chain to avoid config mistakes
        let shareDecimals = (config.shareDecimals ?? config.decimals) || 6;
        try {
          const d = await (shareToken as any).decimals();
          shareDecimals = parseInt(d.toString(), 10);
        } catch { void 0; }

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'Morpheus Gauntlet USDC Prime (gtUSDC)',
          baseAsset: 'USDC',
          countingMode: config.countingMode || 'count',
          measureMethod: config.type === 'vault' ? 'exchangeRate' : 'balance',
          metadata: {
            token: config.token,
            decimals: config.decimals ?? 6, // underlying (USDC)
            shareDecimals,
            type: config.type,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering Morpheus gtUSDC for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, walletAddress } = position.metadata;
    let assetDecimals: number = position.metadata.decimals;

    if (!token || !walletAddress) {
      throw new Error('Invalid Morpheus gtUSDC position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('USDC', priceOverrides);

    const vaultAbi = getAbi('ERC4626');
    const vault = getContract(token, vaultAbi);

    await rpcThrottle();
    const shares = await (vault as any).balanceOf(walletAddress);

    // Early return for zero balance (position exited)
    if (shares === 0n) {
      console.log(`Morpheus gtUSDC: Zero balance detected (position exited)`);
      return 0;
    }

    // Resolve underlying decimals from asset() if not provided
    if (assetDecimals === undefined) {
      try {
        const erc20Abi = getAbi('ERC20');
        await rpcThrottle();
        const underlyingAddr: string = await (vault as any).asset();
        const underlyingErc20 = getContract(underlyingAddr, erc20Abi);
        await rpcThrottle();
        assetDecimals = parseInt((await (underlyingErc20 as any).decimals()).toString(), 10);
      } catch { void 0; }
    }

    const assets = await sharesToAssets(token, shares);
    const assetsReadable = parseFloat(formatUnits(assets, assetDecimals));

    return assetsReadable * priceUsd;
  }

}
