import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

export class InfinifiSiusdAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'infinifi-siusd' as const;
  readonly protocolName = 'Infinifi Staked iUSD';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['infinifi-siusd'];
    if (!config || !config.token) {
      throw new Error('Infinifi siUSD config not found');
    }

    const positions: Partial<Position>[] = [];
    const erc20Abi = getAbi('ERC20');
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const siUSDToken = getContract(config.token, erc20Abi);
      const balance = await siUSDToken.balanceOf(checksumAddress);

      // Only create position if balance > 0
      if (balance > 0n) {
        // Keep position key stable to avoid duplicate rows
        const positionKey = this.createPositionKey(config.token, 'USD');

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'Infinifi siUSD',
          baseAsset: 'iUSD',
          countingMode: config.countingMode || 'count',
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
      console.error(`Error discovering Infinifi siUSD for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, decimals, walletAddress, type } = position.metadata;

    if (!token || decimals === undefined || !walletAddress) {
      throw new Error('Invalid Infinifi siUSD position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('iUSD', priceOverrides);

    // For vault tokens (ERC4626), convert shares to assets
    if (type === 'vault') {
      const vaultAbi = getAbi('ERC4626');
      const vaultContract = getContract(token, vaultAbi);

      // Get user's vault shares (siUSD balance)
      await rpcThrottle();
      const shares = await vaultContract.balanceOf(walletAddress);

      // Early return for zero balance (position exited)
      if (shares === 0n) {
        console.log(`Infinifi siUSD: Zero balance detected (position exited)`);
        return 0;
      }

      // Convert shares to underlying assets using utility function
      const assets = await sharesToAssets(token, shares);
      const assetsReadable = parseFloat(formatUnits(assets, decimals));

      console.log(
        `Infinifi siUSD: ${formatUnits(shares, decimals)} shares → ${assetsReadable.toFixed(2)} iUSD`
      );

      return assetsReadable * priceUsd;
    }

    // Fallback: treat as regular token (shouldn't happen for siUSD)
    const erc20Abi = getAbi('ERC20');
    const tokenContract = getContract(token, erc20Abi);
    const balance = await tokenContract.balanceOf(walletAddress);
    const balanceReadable = parseFloat(formatUnits(balance, decimals));

    return balanceReadable * priceUsd;
  }

}
