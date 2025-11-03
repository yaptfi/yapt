import { getContract, formatUnits, rpcThrottle } from './ethereum';
import { getAbi } from './config';

/**
 * ERC4626 Vault Utilities
 *
 * Common helper functions for ERC4626 vault adapters to reduce code duplication.
 * All functions include RPC throttling and robust error handling.
 */

export interface VaultDecimals {
  shareDecimals: number;
  assetDecimals: number;
}

/**
 * Probe vault and underlying asset decimals from blockchain
 *
 * @param vaultAddress - ERC4626 vault contract address
 * @returns Object with shareDecimals and assetDecimals
 * @throws Error if unable to read decimals from chain
 */
export async function readShareAndAssetDecimals(vaultAddress: string): Promise<VaultDecimals> {
  const erc20Abi = getAbi('ERC20');
  const vaultAbi = getAbi('ERC4626');

  try {
    const vaultContract = getContract(vaultAddress, vaultAbi);
    const shareErc20 = getContract(vaultAddress, erc20Abi);

    // Read share token decimals
    await rpcThrottle();
    const shareDecimals = parseInt((await (shareErc20 as any).decimals()).toString(), 10);

    // Read underlying asset address and its decimals
    await rpcThrottle();
    const assetAddress: string = await (vaultContract as any).asset();
    const assetErc20 = getContract(assetAddress, erc20Abi);

    await rpcThrottle();
    const assetDecimals = parseInt((await (assetErc20 as any).decimals()).toString(), 10);

    return { shareDecimals, assetDecimals };
  } catch (error) {
    throw new Error(`Failed to read decimals for vault ${vaultAddress}: ${error}`);
  }
}

/**
 * Convert vault shares to underlying assets using convertToAssets()
 *
 * @param vaultAddress - ERC4626 vault contract address
 * @param shares - Number of shares (as bigint)
 * @returns Underlying asset amount (as bigint)
 */
export async function sharesToAssets(vaultAddress: string, shares: bigint): Promise<bigint> {
  const vaultAbi = getAbi('ERC4626');
  const vaultContract = getContract(vaultAddress, vaultAbi);

  await rpcThrottle();
  const assets: bigint = await vaultContract.convertToAssets(shares);

  return assets;
}

/**
 * Estimate current share price in USD for net flow calculations
 *
 * Uses the vault's exchange rate (totalAssets / totalSupply) to approximate
 * the USD value of one share. This is used to convert share transfers to USD flows.
 *
 * @param vaultAddress - ERC4626 vault contract address
 * @param underlyingPriceUsd - USD price of the underlying asset
 * @param shareDecimals - (Optional) Share token decimals (will probe if not provided)
 * @param assetDecimals - (Optional) Asset decimals (will probe if not provided)
 * @returns Share price in USD
 */
export async function estimateSharePriceUsd(
  vaultAddress: string,
  underlyingPriceUsd: number,
  shareDecimals?: number,
  assetDecimals?: number
): Promise<number> {
  const vaultAbi = getAbi('ERC4626');
  const vaultContract = getContract(vaultAddress, vaultAbi);

  try {
    // Probe decimals if not provided
    let finalShareDecimals = shareDecimals;
    let finalAssetDecimals = assetDecimals;

    if (finalShareDecimals === undefined || finalAssetDecimals === undefined) {
      const decimals = await readShareAndAssetDecimals(vaultAddress);
      finalShareDecimals = finalShareDecimals ?? decimals.shareDecimals;
      finalAssetDecimals = finalAssetDecimals ?? decimals.assetDecimals;
    }

    // Get vault's total assets and total supply
    await rpcThrottle();
    const totalAssets: bigint = await (vaultContract as any).totalAssets();

    await rpcThrottle();
    const totalSupply: bigint = await (vaultContract as any).totalSupply();

    // Convert to readable numbers
    const assetsReadable = parseFloat(formatUnits(totalAssets, finalAssetDecimals));
    const sharesReadable = parseFloat(formatUnits(totalSupply, finalShareDecimals));

    // Calculate exchange rate (assets per share)
    const exchangeRate = sharesReadable > 0 ? assetsReadable / sharesReadable : 1.0;

    // Convert to USD
    return exchangeRate * underlyingPriceUsd;
  } catch {
    console.warn(`Failed to estimate share price for ${vaultAddress}, using underlying price as fallback`);
    return underlyingPriceUsd; // Fallback: 1 share ≈ 1 unit of underlying
  }
}
