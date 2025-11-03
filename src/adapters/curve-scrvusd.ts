import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

export class CurveScrvUSDAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'curve-scrvusd' as const;
  readonly protocolName = 'Curve Savings crvUSD';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['curve-scrvusd'];
    if (!config || !config.token) {
      throw new Error('Curve sCrvUSD config not found');
    }

    const positions: Partial<Position>[] = [];
    const erc20Abi = getAbi('ERC20');
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const sCrvUSDToken = getContract(config.token, erc20Abi);
      const balance = await sCrvUSDToken.balanceOf(checksumAddress);

      // Only create position if balance > 0
      if (balance > 0n) {
        const positionKey = this.createPositionKey(config.token, 'crvUSD');

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'Curve sCrvUSD',
          baseAsset: 'crvUSD',
          countingMode: 'count',
          measureMethod: config.type === 'vault' ? 'exchangeRate' : 'balance',
          metadata: {
            token: config.token,
            decimals: config.decimals,
            type: config.type,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering Curve sCrvUSD for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, decimals, walletAddress, type } = position.metadata;

    if (!token || decimals === undefined || !walletAddress) {
      throw new Error('Invalid Curve sCrvUSD position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('crvUSD', priceOverrides);

    // For vault tokens (ERC4626), convert shares to assets
    if (type === 'vault') {
      const vaultAbi = getAbi('ERC4626');
      const vaultContract = getContract(token, vaultAbi);

      // Get user's vault shares (sCrvUSD balance)
      await rpcThrottle();
      const shares = await vaultContract.balanceOf(walletAddress);

      // Early return for zero balance (position exited)
      if (shares === 0n) {
        console.log(`Curve sCrvUSD: Zero balance detected (position exited)`);
        return 0;
      }

      // Convert shares to underlying assets using utility function
      const assets = await sharesToAssets(token, shares);
      const assetsReadable = parseFloat(formatUnits(assets, decimals));

      console.log(`Curve sCrvUSD: ${formatUnits(shares, decimals)} shares → ${assetsReadable} crvUSD`);

      return assetsReadable * priceUsd;
    }

    // Fallback: treat as regular token (shouldn't happen for sCrvUSD)
    const erc20Abi = getAbi('ERC20');
    const tokenContract = getContract(token, erc20Abi);
    const balance = await tokenContract.balanceOf(walletAddress);
    const balanceReadable = parseFloat(formatUnits(balance, decimals));

    return balanceReadable * priceUsd;
  }

}
