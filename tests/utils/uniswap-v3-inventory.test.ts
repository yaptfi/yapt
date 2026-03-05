jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn(() => []),
}));

jest.mock('../../src/utils/ethereum', () => ({
  getContract: jest.fn(),
  toChecksumAddress: (address: string) => address,
}));

import { getContract } from '../../src/utils/ethereum';
import {
  clearWalletUniswapV3InventoryCache,
  getWalletUniswapV3Inventory,
} from '../../src/utils/uniswap-v3-inventory';

describe('uniswap-v3 inventory cache', () => {
  beforeEach(() => {
    clearWalletUniswapV3InventoryCache();
    jest.clearAllMocks();
  });

  it('normalizes tuple-indexed positions and deduplicates concurrent reads', async () => {
    const contract = {
      balanceOf: jest.fn().mockResolvedValue(2n),
      tokenOfOwnerByIndex: jest.fn().mockResolvedValueOnce(100n).mockResolvedValueOnce(101n),
      positions: jest.fn()
        .mockResolvedValueOnce({
          2: '0xTokenA',
          3: '0xTokenB',
          4: 500,
          5: -120,
          6: 120,
          7: 10n,
          10: 0n,
          11: 1n,
        })
        .mockResolvedValueOnce({
          token0: '0xTokenC',
          token1: '0xTokenD',
          fee: 3000,
          tickLower: -60,
          tickUpper: 60,
          liquidity: 20n,
          tokensOwed0: 2n,
          tokensOwed1: 3n,
        }),
    };

    const provider = {} as any;
    (getContract as jest.Mock).mockReturnValue(contract);

    const [first, second] = await Promise.all([
      getWalletUniswapV3Inventory(42161, '0xwallet', '0xposition-manager', provider),
      getWalletUniswapV3Inventory(42161, '0xwallet', '0xposition-manager', provider),
    ]);

    expect(getContract).toHaveBeenCalledTimes(1);
    expect(contract.balanceOf).toHaveBeenCalledTimes(1);
    expect(contract.tokenOfOwnerByIndex).toHaveBeenCalledTimes(2);
    expect(contract.positions).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        tokenId: 100n,
        token0: '0xTokenA',
        token1: '0xTokenB',
        fee: 500n,
        tickLower: -120,
        tickUpper: 120,
        liquidity: 10n,
        tokensOwed0: 0n,
        tokensOwed1: 1n,
      },
      {
        tokenId: 101n,
        token0: '0xTokenC',
        token1: '0xTokenD',
        fee: 3000n,
        tickLower: -60,
        tickUpper: 60,
        liquidity: 20n,
        tokensOwed0: 2n,
        tokensOwed1: 3n,
      },
    ]);
  });
});
