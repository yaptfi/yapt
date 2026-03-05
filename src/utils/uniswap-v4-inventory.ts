import { ethers, Provider } from 'ethers';
import { getAbi } from './config';
import { toChecksumAddress } from './ethereum';

export interface WalletUniswapV4Position {
  tokenId: string;
  poolKey: {
    currency0: string;
    currency1: string;
    fee: bigint;
    tickSpacing: bigint;
    hooks: string;
  };
  tickLower: number;
  tickUpper: number;
  poolId: string;
}

const INVENTORY_CACHE_TTL_MS = 60000;

// Cache key: walletAddress:positionManagerAddress:fromBlock
const inventoryCache = new Map<Provider, Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV4Position[]> }>>();

export function clearWalletUniswapV4InventoryCache(): void {
  inventoryCache.clear();
}

function getCacheKey(walletAddress: string, positionManagerAddress: string, fromBlock: number): string {
  return `${walletAddress.toLowerCase()}:${positionManagerAddress.toLowerCase()}:${fromBlock}`;
}

async function loadWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  scanProvider: Provider
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const positionManagerAbi = getAbi('UniswapV4PositionManager');
  const positionManager = new ethers.Contract(positionManagerAddress, positionManagerAbi, scanProvider);

  const receivedFilter = positionManager.filters.Transfer(null, checksumAddress);
  const sentFilter = positionManager.filters.Transfer(checksumAddress, null);

  const [receivedEvents, sentEvents] = await Promise.all([
    positionManager.queryFilter(receivedFilter, fromBlock),
    positionManager.queryFilter(sentFilter, fromBlock),
  ]);

  const sentTokenIds = new Set((sentEvents as any[]).map((e) => e.args.tokenId.toString()));

  const positions: WalletUniswapV4Position[] = [];

  for (const event of receivedEvents as any[]) {
    const tokenId = event.args.tokenId.toString();
    if (sentTokenIds.has(tokenId)) {
      continue;
    }

    try {
      const currentOwner = await positionManager.ownerOf(tokenId);
      if (currentOwner.toLowerCase() !== checksumAddress.toLowerCase()) {
        continue;
      }
    } catch {
      continue;
    }

    const [poolKey, positionInfoRaw] = await positionManager.getPoolAndPositionInfo(tokenId);

    const info = BigInt(positionInfoRaw);
    const tickLowerUint = Number((info >> 8n) & 0xFFFFFFn);
    const tickUpperUint = Number((info >> 32n) & 0xFFFFFFn);
    const tickLower = tickLowerUint >= (1 << 23) ? tickLowerUint - (1 << 24) : tickLowerUint;
    const tickUpper = tickUpperUint >= (1 << 23) ? tickUpperUint - (1 << 24) : tickUpperUint;

    const poolId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
      )
    );

    positions.push({
      tokenId,
      poolKey: {
        currency0: poolKey.currency0,
        currency1: poolKey.currency1,
        fee: BigInt(poolKey.fee),
        tickSpacing: BigInt(poolKey.tickSpacing),
        hooks: poolKey.hooks,
      },
      tickLower,
      tickUpper,
      poolId,
    });
  }

  return positions;
}

/**
 * Returns all Uniswap v4 positions currently owned by walletAddress for the given
 * positionManager. Results are cached for 60s and deduplicated — multiple adapters
 * scanning the same wallet share one eth_getLogs round-trip.
 */
export async function getWalletUniswapV4Inventory(
  walletAddress: string,
  positionManagerAddress: string,
  fromBlock: number,
  scanProvider: Provider
): Promise<WalletUniswapV4Position[]> {
  const checksumAddress = toChecksumAddress(walletAddress);
  const cacheKey = getCacheKey(checksumAddress, positionManagerAddress, fromBlock);

  const providerCache = inventoryCache.get(scanProvider) ?? new Map<string, { expiresAtMs: number; promise: Promise<WalletUniswapV4Position[]> }>();
  inventoryCache.set(scanProvider, providerCache);

  const existing = providerCache.get(cacheKey);
  const now = Date.now();
  if (existing && existing.expiresAtMs > now) {
    return existing.promise;
  }

  const promise = loadWalletUniswapV4Inventory(checksumAddress, positionManagerAddress, fromBlock, scanProvider)
    .catch((error) => {
      providerCache.delete(cacheKey);
      throw error;
    });

  providerCache.set(cacheKey, { expiresAtMs: now + INVENTORY_CACHE_TTL_MS, promise });
  return promise;
}
