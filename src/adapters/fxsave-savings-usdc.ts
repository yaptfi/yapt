import { BaseProtocolAdapter } from './base';
import { Position } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { readShareAndAssetDecimals, sharesToAssets } from '../utils/erc4626';

export class FxsaveSavingsUsdcAdapter extends BaseProtocolAdapter {
  readonly protocolKey = 'fxsave-savings-usdc' as const;
  readonly protocolName = 'f(x) fxSAVE (USDC)';

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()['fxsave-savings-usdc'];
    if (!config || !config.token) {
      throw new Error('fxSAVE config not found');
    }

    const positions: Partial<Position>[] = [];
    const erc20Abi = getAbi('ERC20');
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const sToken = getContract(config.token, erc20Abi);
      const balance = await sToken.balanceOf(checksumAddress);

      if (balance > 0n) {
        const positionKey = this.createPositionKey(config.token, 'USDC');

        // Probe decimals robustly from chain using utility function
        let shareDecimals = 6;
        let underlyingDecimals = 6;
        try {
          const decimals = await readShareAndAssetDecimals(config.token);
          shareDecimals = decimals.shareDecimals;
          underlyingDecimals = decimals.assetDecimals;
        } catch {
          // Fallback to config values
          shareDecimals = (config as any).shareDecimals ?? config.decimals ?? 6;
          underlyingDecimals = config.decimals ?? 6;
        }

        positions.push({
          protocolPositionKey: positionKey,
          displayName: 'fxSAVE (USDC)',
          baseAsset: 'USDC',
          countingMode: config.countingMode || 'count',
          measureMethod: config.type === 'vault' ? 'exchangeRate' : 'balance',
          metadata: {
            token: config.token,
            decimals: underlyingDecimals,
            shareDecimals: shareDecimals,
            type: config.type,
          },
          isActive: true,
        });
      }
    } catch (error) {
      console.error(`Error discovering fxSAVE for ${walletAddress}:`, error);
    }

    return positions;
  }

  async readCurrentValue(position: Position): Promise<number> {
    const { token, walletAddress, type } = position.metadata;

    if (!token || !walletAddress) {
      throw new Error('Invalid fxSAVE position metadata');
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice('USDC', priceOverrides);

    // Resolve decimals at runtime using utility function
    // ERC4626 asset() returns the fxSP token; convertToAssets() yields fxSP units with assetDecimals.
    // The vault share token has its own decimals (shareDecimals).
    const vaultAbi = getAbi('ERC4626');
    const vaultContract = getContract(token, vaultAbi);

    const { shareDecimals, assetDecimals } = await readShareAndAssetDecimals(token);

    await rpcThrottle();
    const fxspAddr: string = await (vaultContract as any).asset();

    if (type === 'vault') {
      await rpcThrottle();
      const shares = await vaultContract.balanceOf(walletAddress);

      // Early return for zero balance (position exited)
      if (shares === 0n) {
        console.log(`fxSAVE (USDC): Zero balance detected (position exited)`);
        return 0;
      }

      const fxspAmount = await sharesToAssets(token, shares);
      const fxspAmountReadable = parseFloat(formatUnits(fxspAmount, assetDecimals));

      // Get fxSP contract address and NAV
      // We already resolved fxSP address above
      const fxspContract = getContract(fxspAddr, ['function nav() view returns (uint256)']);
      await rpcThrottle();
      const nav = await (fxspContract as any).nav();
      const navPerToken = parseFloat(formatUnits(nav, 18)); // NAV is always in 18 decimals

      const usdcValue = fxspAmountReadable * navPerToken;

      console.log(
        `fxSAVE (USDC): ${formatUnits(shares, shareDecimals)} shares → ${fxspAmountReadable.toFixed(6)} fxSP @ ${navPerToken.toFixed(6)} = ${usdcValue.toFixed(6)} USDC`
      );

      return usdcValue * priceUsd;
    }

    // Fallback: treat as regular token (unlikely for this vault)
    const erc20Abi = getAbi('ERC20');
    const tokenContract = getContract(token, erc20Abi);
    await rpcThrottle();
    const balance = await tokenContract.balanceOf(walletAddress);
    const balanceReadable = parseFloat(formatUnits(balance, assetDecimals));
    return balanceReadable * priceUsd;
  }

}
