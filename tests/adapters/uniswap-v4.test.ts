import { UniswapV4Adapter } from '../../src/adapters/uniswap-v4';
import { getContract, formatUnits } from '../../src/utils/ethereum';
import { getAbi, getProtocolConfig } from '../../src/utils/config';
import { Position } from '../../src/types';

jest.mock('../../src/utils/ethereum', () => ({
  ETHEREUM_CHAIN_ID: 1,
  getContract: jest.fn(),
  getProviderForChain: jest.fn().mockReturnValue({}),
  getScanCapableProviderForChain: jest.fn(),
  normalizeAddress: jest.fn((address: string) => address),
  toChecksumAddress: jest.fn((address: string) => address),
  formatUnits: jest.fn(),
}));

jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn(),
  getProtocolConfig: jest.fn(() => ({
    'uniswap-v4-usdc-usdt': {
      positionManager: '0xPositionManager',
      currency0: '0xCurrency0',
      currency1: '0xCurrency1',
      fee: 10,
      chainId: 1,
      abiKeys: ['UniswapV4PositionManager', 'UniswapV4StateView'],
    },
  })),
}));

describe('UniswapV4Adapter', () => {
  const mockGetContract = getContract as jest.MockedFunction<typeof getContract>;
  const mockFormatUnits = formatUnits as jest.MockedFunction<typeof formatUnits>;
  const mockGetAbi = getAbi as jest.MockedFunction<typeof getAbi>;
  const mockGetProtocolConfig = getProtocolConfig as jest.MockedFunction<typeof getProtocolConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAbi.mockReturnValue([]);
    mockFormatUnits.mockReturnValue('0');
    mockGetProtocolConfig.mockReturnValue({
      'uniswap-v4-usdc-usdt': {
        positionManager: '0xPositionManager',
        currency0: '0xCurrency0',
        currency1: '0xCurrency1',
        fee: 10,
        chainId: 1,
        abiKeys: ['UniswapV4PositionManager', 'UniswapV4StateView'],
      },
    });
  });

  it('throws when liquidity valuation fails instead of returning zero', async () => {
    const contractLike = {
      getPositionInfo: jest.fn().mockResolvedValue([1n, 0n, 0n]),
      getFeeGrowthInside: jest.fn().mockResolvedValue([0n, 0n]),
      getSlot0: jest.fn().mockRejectedValue(new Error('slot0 RPC failure')),
    };

    mockGetContract.mockReturnValue(contractLike as never);

    const adapter = new UniswapV4Adapter();
    const position = {
      metadata: {
        tokenId: '1',
        stateView: '0xStateView',
        poolId: '0xPoolId',
        tickLower: -10,
        tickUpper: 10,
        chainId: 1,
        currency0Decimals: 6,
        currency1Decimals: 6,
        positionManager: '0xPositionManager',
      },
    } as unknown as Position;

    await expect(adapter.readCurrentValue(position)).rejects.toThrow(
      'Failed to estimate liquidity value for pool'
    );
  });
});
