import { ethers, Provider, ZeroAddress } from 'ethers';
import { getAbi } from './config';
import { getContract, normalizeAddress } from './ethereum';
import { getUniswapV3PositionField, RawUniswapV3PositionInfo } from './uniswap-v3-inventory';

interface UniswapV3PositionInfo {
  token0: string;
  token1: string;
  fee: bigint | number;
  tickLower?: bigint | number | string;
  tickUpper?: bigint | number | string;
  liquidity?: bigint | number | string;
}

interface UniswapV3PositionManagerContract {
  positions(tokenId: bigint): Promise<UniswapV3PositionInfo>;
  factory(): Promise<string>;
}

interface UniswapV3FactoryContract {
  getPool(token0: string, token1: string, fee: bigint): Promise<string>;
}

interface UniswapV3PoolContract {
  slot0(): Promise<[bigint, number, ...unknown[]]>;
}

interface UniswapV4StateViewContract {
  getPositionInfo(
    poolId: string,
    owner: string,
    tickLower: number,
    tickUpper: number,
    salt: string
  ): Promise<[bigint, bigint, bigint]>;
  getSlot0(poolId: string): Promise<[bigint, number, bigint, bigint]>;
}

export function isTickInRange(currentTick: number, tickLower: number, tickUpper: number): boolean {
  return currentTick >= tickLower && currentTick < tickUpper;
}

export async function isUniswapV3PositionInRange(
  provider: Provider,
  positionManagerAddress: string,
  tokenId: bigint | string,
  poolAddress?: string
): Promise<boolean> {
  const positionManager = getContract(
    positionManagerAddress,
    getAbi('UniswapV3NonfungiblePositionManager'),
    provider
  ) as unknown as UniswapV3PositionManagerContract;

  const tokenIdBigInt = typeof tokenId === 'bigint' ? tokenId : BigInt(tokenId);
  const positionInfo = await positionManager.positions(tokenIdBigInt);
  const rawPositionInfo = positionInfo as unknown as RawUniswapV3PositionInfo;

  const liquidity = BigInt((getUniswapV3PositionField(rawPositionInfo, 7, 'liquidity') ?? 0n) as bigint | number | string);
  if (liquidity === 0n) {
    return false;
  }

  const tickLower = Number(getUniswapV3PositionField(rawPositionInfo, 5, 'tickLower') ?? 0);
  const tickUpper = Number(getUniswapV3PositionField(rawPositionInfo, 6, 'tickUpper') ?? 0);
  const token0 = String(getUniswapV3PositionField(rawPositionInfo, 2, 'token0') ?? positionInfo.token0);
  const token1 = String(getUniswapV3PositionField(rawPositionInfo, 3, 'token1') ?? positionInfo.token1);
  const fee = BigInt((getUniswapV3PositionField(rawPositionInfo, 4, 'fee') ?? positionInfo.fee) as bigint | number | string);

  let resolvedPoolAddress = poolAddress;
  if (!resolvedPoolAddress) {
    const factoryAddress = await positionManager.factory();
    const factory = getContract(
      normalizeAddress(factoryAddress),
      getAbi('UniswapV3Factory'),
      provider
    ) as unknown as UniswapV3FactoryContract;

    resolvedPoolAddress = await factory.getPool(token0, token1, fee);
  }

  if (!resolvedPoolAddress || resolvedPoolAddress === ZeroAddress) {
    return false;
  }

  const pool = getContract(
    normalizeAddress(resolvedPoolAddress),
    getAbi('UniswapV3Pool'),
    provider
  ) as unknown as UniswapV3PoolContract;
  const slot0 = await pool.slot0();
  const currentTick = Number(slot0[1]);

  return isTickInRange(currentTick, tickLower, tickUpper);
}

export async function isUniswapV4PositionInRange(
  provider: Provider,
  stateViewAddress: string,
  positionManagerAddress: string,
  poolId: string,
  tickLower: number,
  tickUpper: number,
  tokenId: bigint | string
): Promise<boolean> {
  const stateView = getContract(
    normalizeAddress(stateViewAddress),
    getAbi('UniswapV4StateView'),
    provider
  ) as unknown as UniswapV4StateViewContract;

  const salt = ethers.zeroPadValue(
    ethers.toBeHex(typeof tokenId === 'bigint' ? tokenId : BigInt(tokenId)),
    32
  );

  const [liquidity] = await stateView.getPositionInfo(
    poolId,
    normalizeAddress(positionManagerAddress),
    tickLower,
    tickUpper,
    salt
  );
  if (BigInt(liquidity) === 0n) {
    return false;
  }

  const [, currentTick] = await stateView.getSlot0(poolId);
  return isTickInRange(Number(currentTick), tickLower, tickUpper);
}
