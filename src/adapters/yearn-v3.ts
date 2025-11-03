import { BaseProtocolAdapter } from './base';
import { Position, ProtocolKey } from '../types';
import { getContract, toChecksumAddress, formatUnits, rpcThrottle } from '../utils/ethereum';
import { getProtocolConfig, getAbi, getStablePriceOverrides } from '../utils/config';
import { readShareAndAssetDecimals, sharesToAssets } from '../utils/erc4626';

/**
 * Generic Yearn V3 Vault Adapter
 *
 * Supports Yearn V3 vaults that follow the ERC4626 standard:
 * - Deposit stablecoins into the vault
 * - Receive vault tokens (shares) that represent underlying assets + yield
 * - convertToAssets() calculates current value including accrued yield
 *
 * This adapter is config-driven - each vault gets its own protocol key
 * but uses the same adapter logic.
 */
export class YearnV3Adapter extends BaseProtocolAdapter {
  readonly protocolKey: ProtocolKey;
  readonly protocolName: string;

  constructor(protocolKey: ProtocolKey, protocolName: string) {
    super();
    this.protocolKey = protocolKey;
    this.protocolName = protocolName;
  }

  async discover(walletAddress: string): Promise<Partial<Position>[]> {
    const config = getProtocolConfig()[this.protocolKey];
    if (!config || !config.vaultToken || !config.underlyingToken || !config.baseAsset) {
      throw new Error(`${this.protocolKey} config not found or incomplete`);
    }

    const positions: Partial<Position>[] = [];
    const checksumAddress = toChecksumAddress(walletAddress);

    try {
      const vaultAbi = getAbi('ERC4626');
      const erc20Abi = getAbi('ERC20');

      const vaultContract = getContract(config.vaultToken, vaultAbi);

      // Probe balances on vault shares and optional gauge shares
      const vaultBalance = await vaultContract.balanceOf(checksumAddress);

      let gaugeBalance = 0n;
      if (config.gaugeToken) {
        gaugeBalance = await getContract(config.gaugeToken, erc20Abi).balanceOf(checksumAddress);
      }

      const hasVault = vaultBalance > 0n;
      const hasGauge = gaugeBalance > 0n;

      if (hasVault || hasGauge) {
        const positionKey = this.createPositionKey(config.vaultToken, config.baseAsset);

        // Pick the share token we will track transfers on
        const chosenShare = hasGauge && config.gaugeToken ? config.gaugeToken : config.vaultToken;

        // Read decimals from blockchain using utility function
        let shareDecimals: number | undefined = undefined;
        let assetDecimals: number | undefined = undefined;
        try {
          const decimals = await readShareAndAssetDecimals(config.vaultToken);
          shareDecimals = decimals.shareDecimals;
          assetDecimals = decimals.assetDecimals;
        } catch {
          // Fallback to config values
          assetDecimals = config.decimals;
          shareDecimals = config.shareDecimals ?? config.decimals;
        }

        positions.push({
          protocolPositionKey: positionKey,
          displayName: config.name,
          baseAsset: config.baseAsset,
          countingMode: config.countingMode || 'count',
          measureMethod: 'exchangeRate',
          metadata: {
            walletAddress: checksumAddress,
            // Vault-level data
            vaultToken: config.vaultToken,
            underlyingToken: config.underlyingToken,
            decimals: assetDecimals, // underlying asset decimals
            // Share token data (vault shares or gauge shares)
            shareToken: chosenShare,
            tokenAddress: chosenShare, // for exit detection compatibility
            shareDecimals: shareDecimals,
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
    const { vaultToken, underlyingToken, decimals, walletAddress } = position.metadata;

    if (!vaultToken || !underlyingToken || decimals === undefined || !walletAddress) {
      throw new Error(`Invalid ${this.protocolKey} position metadata`);
    }

    const priceOverrides = getStablePriceOverrides();
    const priceUsd = this.getStablePrice(position.baseAsset, priceOverrides);

    // Read user's shares from whichever share token we're tracking (gauge or vault)
    const shareToken: string = position.metadata.shareToken || position.metadata.vaultToken;
    const erc20Abi = getAbi('ERC20');
    const shareErc20 = getContract(shareToken, erc20Abi);
    await rpcThrottle();
    const shares = await (shareErc20 as any).balanceOf(walletAddress);

    // Early return for zero balance (position exited)
    if (shares === 0n) {
      console.log(`${this.protocolName}: Zero balance detected (position exited)`);
      return 0;
    }

    // Convert vault shares to underlying assets using utility function
    const underlyingAssets = await sharesToAssets(vaultToken, shares);
    const underlyingAmount = parseFloat(formatUnits(underlyingAssets, decimals));

    const shareDecimals = (position.metadata.shareDecimals ?? decimals) as number;
    console.log(
      `${this.protocolName}: ${formatUnits(shares, shareDecimals)} shares → ${underlyingAmount.toFixed(2)} ${position.baseAsset}`
    );

    return underlyingAmount * priceUsd;
  }

}
