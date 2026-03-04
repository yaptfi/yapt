import { UniswapV3PaxgUsdcEthereumRewardsAdapter } from '../../src/adapters/uniswap-v3-paxg-usdc-ethereum-rewards';
import { Position } from '../../src/types';

const PROTOCOL_KEY = 'uniswap-v3-paxg-usdc-ethereum-rewards';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const PAXG = '0x45804880De22913dAFE09f4980848ECE6EcbAf78';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

jest.mock('../../src/utils/config', () => ({
  getProtocolConfig: jest.fn(),
  getAbi: jest.fn().mockReturnValue([]),
  getStablePriceOverrides: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  getContract: jest.fn(),
  toChecksumAddress: (a: string) => a,
  formatUnits: jest.fn(),
}));

import { getProtocolConfig, getStablePriceOverrides } from '../../src/utils/config';
import { getContract, formatUnits } from '../../src/utils/ethereum';

const CONFIG = {
  [PROTOCOL_KEY]: {
    name: 'Uniswap v3 PAXG/USDC (Ethereum)',
    positionManager: POSITION_MANAGER,
    currency0: PAXG,
    currency1: USDC,
    currency0Symbol: 'PAXG',
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
  protocolPositionKey: `${POSITION_MANAGER}:123`,
  displayName: 'Uniswap v3 PAXG/USDC (Ethereum) #123',
  baseAsset: 'USDC',
  stablecoinId: 'stablecoin-1',
  countingMode: 'partial',
  measureMethod: 'rewards',
  metadata: {
    walletAddress: '0xabc0000000000000000000000000000000000000',
    tokenId: '123',
    positionManager: POSITION_MANAGER,
    rewardDecimals: 6,
    rewardTokenIndex: 1,
  },
  isActive: true,
  createdAt: new Date(),
};

describe('UniswapV3PaxgUsdcEthereumRewardsAdapter', () => {
  const originalEthRpc = process.env.ETH_RPC_URL;

  beforeEach(() => {
    process.env.ETH_RPC_URL = 'http://localhost:8545';
    (getProtocolConfig as jest.Mock).mockReturnValue(CONFIG);
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ USDC: 1.0 });
    (formatUnits as jest.Mock).mockReturnValue('0');
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalEthRpc === undefined) {
      delete process.env.ETH_RPC_URL;
    } else {
      process.env.ETH_RPC_URL = originalEthRpc;
    }
  });

  it('discovers only matching PAXG/USDC positions and marks them as rewards-based', async () => {
    const manager = {
      balanceOf: jest.fn().mockResolvedValue(2n),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValueOnce(111n).mockResolvedValueOnce(222n),
      positions: jest.fn()
        .mockResolvedValueOnce({ token0: PAXG, token1: USDC, fee: 3000n })
        .mockResolvedValueOnce({ token0: PAXG, token1: '0x0000000000000000000000000000000000000001', fee: 3000n }),
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      protocolPositionKey: `${POSITION_MANAGER}:111`,
      baseAsset: 'USDC',
      countingMode: 'partial',
      measureMethod: 'rewards',
      isActive: true,
    });
    expect(discovered[0]?.metadata).toMatchObject({
      rewardToken: USDC,
      rewardDecimals: 6,
      rewardTokenIndex: 1,
      chainId: 1,
    });
  });

  it('returns empty discovery results when ETH_RPC_URL is missing', async () => {
    delete process.env.ETH_RPC_URL;

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const discovered = await adapter.discover('0xabc0000000000000000000000000000000000000');

    expect(discovered).toEqual([]);
    expect(getContract).not.toHaveBeenCalled();
  });

  it('reads only USDC claimable rewards and applies stable price overrides', async () => {
    const collectStaticCall = jest.fn().mockResolvedValue([2500000000000000000n, 1250000n]); // 2.5 PAXG side, 1.25 USDC side
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
    (getStablePriceOverrides as jest.Mock).mockReturnValue({ USDC: 0.99 });

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const value = await adapter.readCurrentValue(POSITION);

    expect(value).toBeCloseTo(1.2375, 6);
    expect(collectStaticCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: 123n,
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

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(false);
    expect(collectStaticCall).not.toHaveBeenCalled();
  });

  it('marks position as closed when liquidity and claimable fees are zero', async () => {
    const collectStaticCall = jest.fn().mockResolvedValue([0n, 0n]);
    const manager = {
      ownerOf: jest.fn().mockResolvedValue('0xabc0000000000000000000000000000000000000'),
      positions: jest.fn().mockResolvedValue({ liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n }),
      collect: {
        staticCall: collectStaticCall,
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(true);
  });

  it('marks position as closed when the NFT token no longer exists', async () => {
    const manager = {
      ownerOf: jest.fn().mockRejectedValue(new Error('ERC721: invalid token ID')),
      positions: jest.fn(),
      collect: {
        staticCall: jest.fn(),
      },
    };
    (getContract as jest.Mock).mockReturnValue(manager);

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();
    const isClosed = await adapter.isPositionClosed(POSITION);

    expect(isClosed).toBe(true);
    expect(manager.positions).not.toHaveBeenCalled();
  });

  it('throws when ETH_RPC_URL is missing during value reads', async () => {
    delete process.env.ETH_RPC_URL;

    const adapter = new UniswapV3PaxgUsdcEthereumRewardsAdapter();

    await expect(adapter.readCurrentValue(POSITION)).rejects.toThrow('ETH_RPC_URL is required');
  });
});
