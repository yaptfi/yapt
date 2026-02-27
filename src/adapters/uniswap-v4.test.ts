import { UniswapV4Adapter } from './uniswap-v4';
import { getContract, formatUnits } from '../utils/ethereum';
import { getAbi } from '../utils/config';
import { Position } from '../types';

jest.mock('../utils/ethereum', () => ({
  getContract: jest.fn(),
  toChecksumAddress: jest.fn((address: string) => address),
  formatUnits: jest.fn(),
}));

jest.mock('../utils/config', () => ({
  getAbi: jest.fn(),
  getProtocolConfig: jest.fn(() => ({})),
}));

describe('UniswapV4Adapter', () => {
  const mockGetContract = getContract as jest.MockedFunction<typeof getContract>;
  const mockFormatUnits = formatUnits as jest.MockedFunction<typeof formatUnits>;
  const mockGetAbi = getAbi as jest.MockedFunction<typeof getAbi>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAbi.mockReturnValue([]);
    mockFormatUnits.mockReturnValue('0');
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
