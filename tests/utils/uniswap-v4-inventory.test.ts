let mockContract: {
  filters: { Transfer: jest.Mock };
  balanceOf: jest.Mock;
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

jest.mock('../../src/utils/async', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

import { sleep } from '../../src/utils/async';
import {
  clearWalletUniswapV4InventoryCache,
  getWalletUniswapV4Inventory,
} from '../../src/utils/uniswap-v4-inventory';

const WALLET_ADDRESS = '0xwallet';
const POSITION_MANAGER_ADDRESS = '0xposition-manager';

function createPoolAndPositionInfo(): [
  {
    currency0: string;
    currency1: string;
    fee: bigint;
    tickSpacing: bigint;
    hooks: string;
  },
  bigint,
] {
  return [
    {
      currency0: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      currency1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      fee: 10n,
      tickSpacing: 1n,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    0n,
  ];
}

describe('uniswap-v4 inventory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearWalletUniswapV4InventoryCache();

    mockContract = {
      filters: {
        Transfer: jest.fn().mockReturnValue({}),
      },
      balanceOf: jest.fn().mockResolvedValue(1n),
      queryFilter: jest.fn().mockResolvedValue([{ args: { tokenId: 1n } }]),
      ownerOf: jest.fn().mockResolvedValue(WALLET_ADDRESS),
      getPoolAndPositionInfo: jest.fn().mockResolvedValue(createPoolAndPositionInfo()),
    };

    delete process.env.UNISWAP_V4_SCAN_CHUNK_SIZE;
    delete process.env.UNISWAP_V4_MAX_LOG_QUERIES;
    delete process.env.UNISWAP_V4_SCAN_TIMEOUT_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a nested RPC range limit and scans backward in 10,000-block chunks', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(25000),
    } as any;
    const rangeError = {
      code: 'UNKNOWN_ERROR',
      error: {
        code: -32602,
        message: 'range 1-25000 exceeds limit of 10000',
      },
      payload: {
        method: 'eth_getLogs',
        params: [],
      },
      shortMessage: 'could not coalesce error',
    };
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockContract.queryFilter
      .mockRejectedValueOnce(rangeError)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }]);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );

    expect(mockContract.balanceOf).toHaveBeenCalledWith(WALLET_ADDRESS, { blockTag: 25000 });
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, {}, 1, 25000);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, {}, 15001, 25000);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(3, {}, 5001, 15000);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(4, {}, 1, 5000);
    expect(mockContract.ownerOf).toHaveBeenCalledWith('1', { blockTag: 25000 });
    expect(inventory.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('10000 blocks'));
  });

  it('warns when an adapted range cannot cover full history within the query budget', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(6_000_000),
    } as any;
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockContract.queryFilter
      .mockRejectedValueOnce({
        error: { code: -32602, message: 'range exceeds limit of 10000' },
      })
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }]);

    await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );

    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('full history would require about 600 queries and this scan stops after 500')
    );
  });

  it('checks newest transfers first and stops once balanceOf NFTs are verified', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(350),
    } as any;

    mockContract.balanceOf.mockResolvedValue(2n);
    mockContract.queryFilter.mockResolvedValue([
      { args: { tokenId: 1n } },
      { args: { tokenId: 2n } },
      { args: { tokenId: 3n } },
    ]);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(1);
    expect(mockContract.queryFilter).toHaveBeenCalledWith({}, 251, 350);
    expect(mockContract.ownerOf.mock.calls.map(([tokenId]) => tokenId)).toEqual(['3', '2']);
    expect(inventory.map((entry) => entry.tokenId)).toEqual(['3', '2']);
    expect(mockContract.getPoolAndPositionInfo).toHaveBeenCalledWith('3', { blockTag: 350 });
    expect(mockContract.getPoolAndPositionInfo).toHaveBeenCalledWith('2', { blockTag: 350 });
  });

  it('does not scan logs when the wallet has no current position NFTs', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(500),
    } as any;
    mockContract.balanceOf.mockResolvedValue(0n);

    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).resolves.toEqual([]);

    expect(mockContract.balanceOf).toHaveBeenCalledWith(WALLET_ADDRESS, { blockTag: 500 });
    expect(mockContract.filters.Transfer).not.toHaveBeenCalled();
    expect(mockContract.queryFilter).not.toHaveBeenCalled();
  });

  it('ignores transferred-away and duplicate NFTs while continuing into older chunks', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(200),
    } as any;

    mockContract.queryFilter
      .mockResolvedValueOnce([
        { args: { tokenId: 7n } },
        { args: { tokenId: 7n } },
      ])
      .mockResolvedValueOnce([
        { args: { tokenId: 8n } },
        { args: { tokenId: 7n } },
      ]);
    mockContract.ownerOf
      .mockResolvedValueOnce('0xsomeone-else')
      .mockResolvedValueOnce(WALLET_ADDRESS);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );

    expect(mockContract.queryFilter.mock.calls.map(([, fromBlock, toBlock]) => [fromBlock, toBlock]))
      .toEqual([[101, 200], [1, 100]]);
    expect(mockContract.ownerOf.mock.calls.map(([tokenId]) => tokenId)).toEqual(['7', '8']);
    expect(inventory.map((entry) => entry.tokenId)).toEqual(['8']);
  });

  it('retries transient rate limits for the same block range', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(50),
    } as any;
    const rateLimitError = {
      code: 'UNKNOWN_ERROR',
      error: { message: 'rate limit exceeded; try again' },
      shortMessage: 'could not coalesce error',
    };

    mockContract.queryFilter
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }]);

    await getWalletUniswapV4Inventory(WALLET_ADDRESS, POSITION_MANAGER_ADDRESS, 1, provider);

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(3);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, {}, 1, 50);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, {}, 1, 50);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(3, {}, 1, 50);
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  it('retries transient ownerOf failures instead of silently losing the candidate NFT', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(50),
    } as any;
    const rateLimitError = {
      code: -32005,
      message: 'Too Many Requests',
    };
    mockContract.ownerOf
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(WALLET_ADDRESS);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(mockContract.ownerOf).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it('stops immediately when ownerOf fails ambiguously instead of scanning older history', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(200),
    } as any;
    mockContract.ownerOf.mockRejectedValue(new Error('missing revert data'));

    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).rejects.toThrow('Failed to verify ownerOf(1)');

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(1);
  });

  it('retries Infura rate limits nested in an ethers BAD_DATA batch response', async () => {
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(42161),
    } as any;
    const batchRateLimitError = {
      code: 'BAD_DATA',
      value: [
        { jsonrpc: '2.0', id: 37, result: '0xa4b1' },
        {
          code: -32005,
          message: 'Too Many Requests',
          data: { see: 'https://infura.io/dashboard' },
        },
      ],
      info: {
        payload: {
          id: 38,
          jsonrpc: '2.0',
          method: 'eth_getLogs',
          params: [],
        },
      },
      shortMessage: 'missing response for request',
    };

    mockContract.queryFilter
      .mockRejectedValueOnce(batchRateLimitError)
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }]);

    await getWalletUniswapV4Inventory(WALLET_ADDRESS, POSITION_MANAGER_ADDRESS, 1, provider);

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(2);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, {}, 1, 42161);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, {}, 1, 42161);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('halves a rejected range when the provider does not report its limit', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
    } as any;
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockContract.queryFilter
      .mockRejectedValueOnce(new Error('requested block range is too large'))
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }]);

    await getWalletUniswapV4Inventory(WALLET_ADDRESS, POSITION_MANAGER_ADDRESS, 1, provider);

    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(1, {}, 1, 100);
    expect(mockContract.queryFilter).toHaveBeenNthCalledWith(2, {}, 51, 100);
    expect(warningSpy).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('50 blocks'));
  });

  it('caches a terminal history mismatch long enough for sibling adapters to reuse it', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(120),
    } as any;

    mockContract.balanceOf.mockResolvedValue(2n);
    mockContract.queryFilter
      .mockResolvedValueOnce([{ args: { tokenId: 1n } }])
      .mockResolvedValueOnce([]);

    const expectedMessage = 'found 1 of 2 NFTs reported by balanceOf';
    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).rejects.toThrow(expectedMessage);
    now += 120_000;
    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).rejects.toThrow(expectedMessage);

    expect(mockContract.balanceOf).toHaveBeenCalledTimes(1);
    expect(mockContract.queryFilter).toHaveBeenCalledTimes(2);
    expect(mockContract.getPoolAndPositionInfo).not.toHaveBeenCalled();
  });

  it('stops at the configured log-query budget', async () => {
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    process.env.UNISWAP_V4_MAX_LOG_QUERIES = '2';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(500),
    } as any;
    mockContract.queryFilter.mockResolvedValue([]);

    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).rejects.toThrow('query budget of 2 exhausted');

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(2);
    expect(mockContract.queryFilter.mock.calls.map(([, fromBlock, toBlock]) => [fromBlock, toBlock]))
      .toEqual([[401, 500], [301, 400]]);
  });

  it('stops at the configured elapsed-time budget between log queries', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    process.env.UNISWAP_V4_SCAN_CHUNK_SIZE = '100';
    process.env.UNISWAP_V4_SCAN_TIMEOUT_MS = '1';
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(500),
    } as any;
    mockContract.queryFilter.mockImplementation(async () => {
      now += 2;
      return [];
    });

    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    )).rejects.toThrow('time budget of 1ms exhausted');

    expect(mockContract.queryFilter).toHaveBeenCalledTimes(1);
  });

  it('shares a still-running scan even after its normal success TTL would have elapsed', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const provider = {
      getBlockNumber: jest.fn().mockResolvedValue(50),
    } as any;
    let resolveLogs: ((logs: Array<{ args: { tokenId: bigint } }>) => void) | undefined;
    mockContract.queryFilter.mockImplementation(() => new Promise((resolve) => {
      resolveLogs = resolve;
    }));

    const firstInventory = getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );
    await Promise.resolve();
    await Promise.resolve();
    now += 120_000;
    const secondInventory = getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider
    );
    resolveLogs?.([{ args: { tokenId: 1n } }]);

    const [first, second] = await Promise.all([firstInventory, secondInventory]);
    expect(first.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(second.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(mockContract.balanceOf).toHaveBeenCalledTimes(1);
    expect(mockContract.queryFilter).toHaveBeenCalledTimes(1);
  });
});
