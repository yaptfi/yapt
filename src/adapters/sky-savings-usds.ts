import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { sharesToAssets } from '../utils/erc4626';

export class SkySavingsUsdsAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'sky-savings-usds' as const;
  readonly protocolName = 'Sky Savings USDS';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['sky-savings-usds'];
    if (!config || !config.token) {
      throw new Error('Sky Savings USDS config not found');
    }

    const positions: Partial<Position>[] = [];
    const erc20Abi = getAbi('ERC20');
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      // sUSDC (shares) token address under the Sky Savings USDS vault
      const sToken = getContract(config.token, erc20Abi);
      const balance = await sToken.balanceOf(checksumAddress);

      // Only create position if balance > 0
      if (balance > 0n) {
        // Position key derived from the shares token + base asset
        const positionKey = this.createPositionKey(config.token, 'USDS');

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'Sky Savings USDS',
          baseAsset: 'USDS',
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
      console.error(`Error discovering Sky Savings USDS for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, decimals, walletAddress, type } = position.metadata;

    if (!token || decimals === undefined || !walletAddress) {
      throw new Error('Invalid Sky Savings USDS position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('USDS', priceOverrides);

    // For ERC4626 vault tokens, convert shares (sUSDC) to underlying assets (USDS)
    if (type === 'vault') {
      const vaultAbi = getAbi('ERC4626');
      const vaultContract = getContract(token, vaultAbi);

      await rpcThrottle();
      const shares = await vaultContract.balanceOf(walletAddress);

      // Early return for zero balance (position exited)
      if (shares === 0n) {
        console.log(`Sky Savings USDS: Zero balance detected (position exited)`);
        return 0;
      }

      const assets = await sharesToAssets(token, shares);
      const assetsReadable = parseFloat(formatUnits(assets, decimals));

      console.log(
        `Sky Savings USDS: ${formatUnits(shares, decimals)} shares → ${assetsReadable.toFixed(6)} USDS`
      );

      return assetsReadable * priceUsd;
    }

    // Fallback: treat as regular token (unlikely for this vault)
    const erc20Abi = getAbi('ERC20');
    const tokenContract = getContract(token, erc20Abi);
    const balance = await tokenContract.balanceOf(walletAddress);
    const balanceReadable = parseFloat(formatUnits(balance, decimals));
    return balanceReadable * priceUsd;
  }

}

