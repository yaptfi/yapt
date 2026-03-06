import {
  isUniswapV3PositionInRange,
  isUniswapV4PositionInRange,
} from '../../src/utils/uniswap-range';

jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/utils/ethereum', () => ({
  getContract: jest.fn(),
  normalizeAddress: jest.fn((address: string) => address),
}));

import { getContract } from '../../src/utils/ethereum';

describe('uniswap range helpers', () => {
  const mockGetContract = getContract as jest.MockedFunction<typeof getContract>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the provided v3 pool address to determine when a position is in range', async () => {
    const positionManager = {
      positions: jest.fn().mockResolvedValue({
        token0: '0xToken0',
        token1: '0xToken1',
        fee: 3000n,
        tickLower: -100,
        tickUpper: 100,
        liquidity: 5n,
      }),
      factory: jest.fn(),
    };
    const pool = {
      slot0: jest.fn().mockResolvedValue([0n, 0]),
    };

    mockGetContract.mockImplementation((address: string) => {
      if (address === '0xPositionManager') {
        return positionManager as never;
      }
      if (address === '0xPool') {
        return pool as never;
      }
      throw new Error(`Unexpected contract ${address}`);
    });

    await expect(
      isUniswapV3PositionInRange({} as never, '0xPositionManager', '1', '0xPool')
    ).resolves.toBe(true);
    expect(positionManager.factory).not.toHaveBeenCalled();
  });

  it('derives the v3 pool via the factory and returns false when the current tick is out of range', async () => {
    const positionManager = {
      positions: jest.fn().mockResolvedValue({
        token0: '0xToken0',
        token1: '0xToken1',
        fee: 3000n,
        tickLower: -100,
        tickUpper: 100,
        liquidity: 5n,
      }),
      factory: jest.fn().mockResolvedValue('0xFactory'),
    };
    const factory = {
      getPool: jest.fn().mockResolvedValue('0xDerivedPool'),
    };
    const pool = {
      slot0: jest.fn().mockResolvedValue([0n, 150]),
    };

    mockGetContract.mockImplementation((address: string) => {
      if (address === '0xPositionManager') {
        return positionManager as never;
      }
      if (address === '0xFactory') {
        return factory as never;
      }
      if (address === '0xDerivedPool') {
        return pool as never;
      }
      throw new Error(`Unexpected contract ${address}`);
    });

    await expect(
      isUniswapV3PositionInRange({} as never, '0xPositionManager', '1')
    ).resolves.toBe(false);
    expect(positionManager.factory).toHaveBeenCalledTimes(1);
    expect(factory.getPool).toHaveBeenCalledWith('0xToken0', '0xToken1', 3000n);
  });

  it('returns false for v4 positions that currently have no active in-range liquidity', async () => {
    const stateView = {
      getPositionInfo: jest.fn().mockResolvedValue([5n, 0n, 0n]),
      getSlot0: jest.fn().mockResolvedValue([0n, 25, 0n, 0n]),
    };

    mockGetContract.mockReturnValue(stateView as never);

    await expect(
      isUniswapV4PositionInRange(
        {} as never,
        '0xStateView',
        '0xPositionManager',
        '0xPoolId',
        -10,
        10,
        '123'
      )
    ).resolves.toBe(false);
  });
});
