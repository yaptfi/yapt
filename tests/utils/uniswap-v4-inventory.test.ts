let mockContract: {
  filters: { Transfer: jest.Mock };
  queryFilter: jest.Mock;
  ownerOf: jest.Mock;
  getPoolAndPositionInfo: jest.Mock;
};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: jest.fn(() => mockContract),
    },
  };
});

jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn(() => []),
}));

jest.mock('../../src/utils/ethereum', () => ({
  toChecksumAddress: (address: string) => address,
}));

import {
  clearWalletUniswapV4InventoryCache,
  getWalletUniswapV4Inventory,
} from '../../src/utils/uniswap-v4-inventory';

describe('uniswap-v4 inventory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearWalletUniswapV4InventoryCache();

    mockContract = {
      filters: {
        Transfer: jest.fn().mockReturnValue({}),
      },
      queryFilter: jest.fn(),
      ownerOf: jest.fn(),
      getPoolAndPositionInfo: jest.fn(),
    };

    delete process.env.UNISWAP_V4_SCAN_CHUNK_SIZE;
  });

  it('chunks historical transfer scans across large block ranges', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(100050),
    } as any;

    mockContract.queryFilter
      .mockRejectedValueOnce(new Error('eth_getLogs query returned more than the allowed block range'))
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ args: { tokenId: 2n } }]);
    mockContract.ownerOf.mockResolvedValue('0xwallet');
    mockContract.getPoolAndPositionInfo
      .mockResolvedValueOnce([
        {
          currency0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          currency1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          fee: 10n,
          tickSpacing: 1n,
          hooks: '0x0000000000000000000000000000000000000000',
        },
        0n,
      ])
      .mockResolvedValueOnce([
        {
          currency0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          currency1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          fee: 10n,
          tickSpacing: 1n,
          hooks: '0x0000000000000000000000000000000000000000',
        },
        0n,
      ]);

    const inventory = await getWalletUniswapV4Inventory('0xwallet', '0xposition-manager', 1, provider);

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(4);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, {}, 1, 100050);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, {}, 1, 50000);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(3, {}, 50001, 100000);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(4, {}, 100001, 100050);
    expect(inventory.map((entry) => entry.tokenId)).toEqual(['1', '2']);
  });

  it('keeps positions that were received multiple times and are currently owned by the wallet', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';

    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(120),
    } as any;

    mockContract.queryFilter.mockResolvedValue([
      { args: { tokenId: 7n } },
      { args: { tokenId: 7n } },
    ]);
    mockContract.ownerOf.mockResolvedValue('0xwallet');
    mockContract.getPoolAndPositionInfo.mockResolvedValue([
      {
        currency0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        currency1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        fee: 10n,
        tickSpacing: 1n,
        hooks: '0x0000000000000000000000000000000000000000',
      },
      0n,
    ]);

    const inventory = await getWalletUniswapV4Inventory('0xwallet', '0xposition-manager', 1, provider);

    expect(inventory).toHaveLength(1);
    expect(inventory[0]?.tokenId).toBe('7');
    expect(mockContract.ownerOf).toHaveBeenCalledTimes(1);
  });
});
