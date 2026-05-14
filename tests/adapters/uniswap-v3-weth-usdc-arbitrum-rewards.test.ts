import { UniswapV3WethUsdcArbitrumRewardsAdapter } from '../../src/adapters/uniswap-v3-weth-usdc-arbitrum-rewards';
import { Position } from '../../src/types';

const PROTOCOL_KEY = 'uniswap-v3-weth-usdc-arbitrum-rewards';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

jest.mock('../../src/utils/config', () => ({
  getProtocolConfig: jest.fn(),
  getAbi: jest.fn().mockReturnValue([]),
  getStablePriceOverrides: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  ARBITRUM_CHAIN_ID: 42161,
  getContract: jest.fn(),
  getProviderForChain: jest.fn(),
  toChecksumAddress: (a: string) => a,
  formatUnits: jest.fn(),
}));

import { getProtocolConfig, getStablePriceOverrides } from '../../src/utils/config';
import { getContract, getProviderForChain, formatUnits } from '../../src/utils/ethereum';

const CONFIG = {
  [PROTOCOL_KEY]: {
    name: 'Uniswap v3 WETH/USDC (Arbitrum)',
    positionManager: POSITION_MANAGER,
    currency0: WETH,
    currency1: USDC,
    currency0Symbol: 'WETH',
    currency1Symbol: 'USDC',
    rewardToken: USDC,
    rewardDecimals: 6,
    countingMode: 'partial',
    abiKeys: ['UniswapV3NonfungiblePositionManager'],
  },
};

const POSITION: Position = {
  id: 'position-1',
  walletId: 'wallet-1',
  protocolId: 'protocol-1',
  protocolPositionKey: `${POSITION_MANAGER}:456`,
  displayName: 'Uniswap v3 WETH/USDC (Arbitrum) #456',
  baseAsset: 'USDC',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: {
    walletAddress: '0xabc0000000000000000000000000000000000000',
    tokenId: '456',
    positionManager: POSITION_MANAGER,
    rewardDecimals: 6,
    rewardTokenIndex: 1,
  },
  isActive: true,
  createdAt: new Date(),
};

describe('UniswapV3WethUsdcArbitrumRewardsAdapter', () => {
  beforeEach(() => {
    (getProviderForChain as jest.Mock).mockReturnValue({});
    (getProtocolConfig as jest.Mock).mockReturnValue(CONFIG);
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ USDC: 1.0 });
    (formatUnits as jest.Mock).mockReturnValue('0');
    jest.clearAllMocks();
  });

  it('discovers only matching WETH/USDC positions and marks them as rewards-based', async () => {
    const manager = {
      balanceOf: jest.fn().mockResolvedValue(2n),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValueOnce(456n).mockResolvedValueOnce(789n),
      positions: jest.fn()
        .mockResolvedValueOnce({
          token0: WETH,
          token1: USDC,
          fee: 3000n,
          liquidity: 1n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
        })
        .mockResolvedValueOnce({ token0: WETH, token1: '0x0000000000000000000000000000000000000001', fee: 3000n }),
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      protocolPositionKey: `${POSITION_MANAGER}:456`,
      baseAsset: 'USDC',
      countingMode: 'partial',
      measureMethod: 'rewards',
      isActive: true,
    });
    expect(discovered[0]?.metadata).toMatchObject({
      rewardToken: USDC,
      rewardDecimals: 6,
      rewardTokenIndex: 1,
      allowZeroValueDiscovery: true,
    });
  });

  it('skips fully exhausted matching NFTs during discovery', async () => {
    const manager = {
      balanceOf: jest.fn().mockResolvedValue(2n),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValueOnce(456n).mockResolvedValueOnce(457n),
      positions: jest.fn()
        .mockResolvedValueOnce({
          token0: WETH,
          token1: USDC,
          fee: 3000n,
          liquidity: 0n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
        })
        .mockResolvedValueOnce({
          token0: WETH,
          token1: USDC,
          fee: 3000n,
          liquidity: 1n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
        }),
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.protocolPositionKey).toBe(`${POSITION_MANAGER}:457`);
  });

  it('discovers positions when positions() output is tuple-indexed', async () => {
    const manager = {
      balanceOf: jest.fn().mockResolvedValue(1n),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValue(456n),
      positions: jest.fn().mockResolvedValue({
        2: WETH,
        3: USDC,
        4: 3000n,
        7: 1n,
        10: 0n,
        11: 0n,
      }),
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.protocolPositionKey).toBe(`${POSITION_MANAGER}:456`);
  });

  it('returns empty discovery results when Arbitrum provider is unavailable', async () => {
    (getProviderForChain as jest.Mock).mockImplementation(() => {
      throw new Error('provider unavailable');
    });

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toEqual([]);
    expect(getContract).not.toHaveBeenCalled();
  });

  it('reads only USDC claimable rewards and applies stable price overrides', async () => {
    const collectStaticCall = jest.fn().mockResolvedValue([500000000000000000n, 1250000n]); // 0.5 WETH side, 1.25 USDC side
    const manager = {
      collect: {
        staticCall: collectStaticCall,
      },
    };

    (getContract as jest.Mock).mockReturnValue(manager);
    (formatUnits as jest.Mock).mockImplementation((amount: bigint) => {
      if (amount === 1250000n) {
        return '1.25';
      }
      return '0';
    });
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ USDC: 0.999 });

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const value = await adapter.readCurrentValue(POSITION);

    expect(value).toBeCloseTo(1.24875, 6);
    expect(collectStaticCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 456n,
        recipient: '0xabc0000000000000000000000000000000000000',
      }),
      {
        from: '0xabc0000000000000000000000000000000000000',
      }
    );
  });

  it('does not mark position as closed when liquidity is still present', async () => {
    const collectStaticCall = jest.fn();
    const manager = {
      ownerOf: jest.fn().mockResolvedValue('0xabc0000000000000000000000000000000000000'),
      positions: jest.fn().mockResolvedValue({ liquidity: 1n }),
      collect: {
        staticCall: collectStaticCall,
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(false);
    expect(collectStaticCall).not.toHaveBeenCalled();
  });

  it('marks position as closed when liquidity is zero', async () => {
    const collectStaticCall = jest.fn();
    const manager = {
      ownerOf: jest.fn().mockResolvedValue('0xabc0000000000000000000000000000000000000'),
      positions: jest.fn().mockResolvedValue({ liquidity: 0n }),
      collect: {
        staticCall: collectStaticCall,
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(true);
    expect(collectStaticCall).not.toHaveBeenCalled();
  });

  it('marks position as closed even when non-reward dust remains', async () => {
    // Regression: previously, residual tokensOwed on the non-reward token leg
    // (e.g., 1 wei of WETH after a sub-MAX collect) kept the position active
    // forever. Once liquidity is 0, no future fees can accrue, so the
    // position must be archivable regardless of leftover dust.
    const collectStaticCall = jest.fn();
    const manager = {
      ownerOf: jest.fn().mockResolvedValue('0xabc0000000000000000000000000000000000000'),
      positions: jest.fn().mockResolvedValue({ liquidity: 0n, tokensOwed0: 12345n, tokensOwed1: 0n }),
      collect: {
        staticCall: collectStaticCall,
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(true);
    expect(collectStaticCall).not.toHaveBeenCalled();
  });

  it('marks position as closed when the NFT token no longer exists', async () => {
    const manager = {
      ownerOf: jest.fn().mockRejectedValue(Object.assign(new Error('ERC721: invalid token ID'), { code: 'CALL_EXCEPTION' })),
      positions: jest.fn(),
      collect: {
        staticCall: jest.fn(),
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(true);
    expect(manager.positions).not.toHaveBeenCalled();
  });

  it('returns false (inconclusive) instead of throwing when positions() fails', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const manager = {
      ownerOf: jest.fn().mockResolvedValue('0xabc0000000000000000000000000000000000000'),
      positions: jest.fn().mockRejectedValue(new Error('RPC timeout')),
      collect: {
        staticCall: jest.fn(),
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('throws when Arbitrum provider is unavailable during value reads', async () => {
    (getProviderForChain as jest.Mock).mockImplementation(() => {
      throw new Error('provider unavailable');
    });

    const adapter = new UniswapV3WethUsdcArbitrumRewardsAdapter();

    await expect(adapter.readCurrentValue(POSITION)).rejects.toThrow('Arbitrum RPC provider is required');
  });
});
