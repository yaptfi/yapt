let mockPositionManager: {
  target: string;
  interface: import('ethers').Interface;
  filters: { Transfer: jest.Mock };
  balanceOf: jest.Mock;
  nextTokenId: jest.Mock;
  queryFilter: jest.Mock;
  ownerOf: jest.Mock;
  getPoolAndPositionInfo: jest.Mock;
};
let mockMulticall: {
  tryAggregate: { staticCall: jest.Mock };
};
let mockInventoryState: {
  tokenIds: string[];
  lastScannedBlock: number | null;
  nextTokenId: string | null;
  coldScanCursor: string | null;
  isComplete: boolean;
};

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: jest.fn(() => mockPositionManager),
    },
  };
});

jest.mock('../../src/utils/config', () => ({
  getAbi: jest.fn(() => []),
}));

jest.mock('../../src/utils/ethereum', () => ({
  getMulticallContract: jest.fn(() => mockMulticall),
  toChecksumAddress: (address: string) => address,
}));

jest.mock('../../src/utils/async', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/models/uniswap-v4-inventory', () => ({
  getUniswapV4InventoryState: jest.fn(async () => mockInventoryState),
  saveUniswapV4InventoryState: jest.fn(async (
    _wallet: string,
    _chainId: number,
    _positionManager: string,
    state: typeof mockInventoryState
  ) => {
    mockInventoryState = { ...state, tokenIds: [...state.tokenIds] };
  }),
}));

import { ethers } from 'ethers';
import { sleep } from '../../src/utils/async';
import {
  getUniswapV4InventoryState,
  saveUniswapV4InventoryState,
} from '../../src/models/uniswap-v4-inventory';
import {
  clearWalletUniswapV4InventoryCache,
  getWalletUniswapV4Inventory,
} from '../../src/utils/uniswap-v4-inventory';

const WALLET_ADDRESS = '0x80D0d54050C15971b21e877D95441800f5AA9ee8';
const OTHER_ADDRESS = '0x0000000000000000000000000000000000000001';
const POSITION_MANAGER_ADDRESS = '0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869';
const ARBITRUM_CHAIN_ID = 42161;

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
      currency0: '0x0000000000000000000000000000000000000000',
      currency1: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      fee: 500n,
      tickSpacing: 10n,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    0n,
  ];
}

describe('uniswap-v4 inventory', () => {
  let ownerByTokenId: Map<string, string>;

  beforeEach(() => {
    jest.clearAllMocks();
    clearWalletUniswapV4InventoryCache();
    ownerByTokenId = new Map([['1', WALLET_ADDRESS]]);
    const positionManagerInterface = new ethers.Interface([
      'function ownerOf(uint256 tokenId) view returns (address)',
    ]);

    mockInventoryState = {
      tokenIds: [],
      lastScannedBlock: null,
      nextTokenId: null,
      coldScanCursor: null,
      isComplete: false,
    };
    mockPositionManager = {
      target: POSITION_MANAGER_ADDRESS,
      interface: positionManagerInterface,
      filters: { Transfer: jest.fn().mockReturnValue({}) },
      balanceOf: jest.fn().mockResolvedValue(1n),
      nextTokenId: jest.fn().mockResolvedValue(2n),
      queryFilter: jest.fn().mockResolvedValue([]),
      ownerOf: jest.fn(async (tokenId: bigint | string) =>
        ownerByTokenId.get(tokenId.toString()) ?? OTHER_ADDRESS),
      getPoolAndPositionInfo: jest.fn().mockResolvedValue(createPoolAndPositionInfo()),
    };
    mockMulticall = {
      tryAggregate: {
        staticCall: jest.fn(async (_requireSuccess: boolean, calls: Array<{ callData: string }>) =>
          calls.map((call) => {
            const [tokenId] = positionManagerInterface.decodeFunctionData('ownerOf', call.callData);
            const owner = ownerByTokenId.get(tokenId.toString()) ?? OTHER_ADDRESS;
            return {
              success: true,
              returnData: positionManagerInterface.encodeFunctionResult('ownerOf', [owner]),
            };
          })),
      },
    };

    for (const name of [
      'UNISWAP_V4_SCAN_CHUNK_SIZE',
      'UNISWAP_V4_MAX_LOG_QUERIES',
      'UNISWAP_V4_SCAN_TIMEOUT_MS',
      'UNISWAP_V4_OWNER_BATCH_SIZE',
      'UNISWAP_V4_RECENT_TOKEN_WINDOW',
      'UNISWAP_V4_RECENT_SCAN_BLOCKS',
    ]) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('verifies a known old position and finds a newly minted position in one multicall', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(497_925_700) } as any;
    mockInventoryState.tokenIds = ['146749'];
    mockPositionManager.balanceOf.mockResolvedValue(2n);
    mockPositionManager.nextTokenId.mockResolvedValue(199208n);
    ownerByTokenId = new Map([
      ['146749', WALLET_ADDRESS],
      ['199076', WALLET_ADDRESS],
    ]);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      297_842_893,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['199076', '146749']);
    expect(mockPositionManager.ownerOf).toHaveBeenCalledWith('146749', { blockTag: 497_925_700 });
    expect(mockMulticall.tryAggregate.staticCall).toHaveBeenCalledTimes(1);
    expect(mockMulticall.tryAggregate.staticCall.mock.calls[0][1]).toHaveLength(500);
    expect(mockPositionManager.queryFilter).not.toHaveBeenCalled();
    expect(saveUniswapV4InventoryState).toHaveBeenLastCalledWith(
      WALLET_ADDRESS,
      ARBITRUM_CHAIN_ID,
      POSITION_MANAGER_ADDRESS,
      expect.objectContaining({
        tokenIds: ['199076', '146749'],
        lastScannedBlock: 497_925_700,
        nextTokenId: '199208',
        coldScanCursor: null,
        isComplete: true,
      })
    );
  });

  it('performs no enumeration or log scan when verified known IDs satisfy balanceOf', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(500) } as any;
    mockInventoryState = {
      tokenIds: ['20', '10'],
      lastScannedBlock: 400,
      nextTokenId: '21',
      coldScanCursor: null,
      isComplete: true,
    };
    mockPositionManager.balanceOf.mockResolvedValue(2n);
    mockPositionManager.nextTokenId.mockResolvedValue(30n);
    ownerByTokenId = new Map([
      ['20', WALLET_ADDRESS],
      ['10', WALLET_ADDRESS],
    ]);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['20', '10']);
    expect(mockMulticall.tryAggregate.staticCall).not.toHaveBeenCalled();
    expect(mockPositionManager.queryFilter).not.toHaveBeenCalled();
  });

  it('persists a complete empty checkpoint without scanning when balanceOf is zero', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(500) } as any;
    mockPositionManager.balanceOf.mockResolvedValue(0n);
    mockPositionManager.nextTokenId.mockResolvedValue(200n);

    await expect(getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    )).resolves.toEqual([]);

    expect(mockMulticall.tryAggregate.staticCall).not.toHaveBeenCalled();
    expect(mockPositionManager.queryFilter).not.toHaveBeenCalled();
    expect(saveUniswapV4InventoryState).toHaveBeenCalledWith(
      WALLET_ADDRESS,
      ARBITRUM_CHAIN_ID,
      POSITION_MANAGER_ADDRESS,
      expect.objectContaining({ isComplete: true, tokenIds: [], lastScannedBlock: 500 })
    );
  });

  it('uses incremental logs to find an older NFT transferred in after the checkpoint', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(200) } as any;
    mockInventoryState = {
      tokenIds: ['10'],
      lastScannedBlock: 100,
      nextTokenId: '100',
      coldScanCursor: null,
      isComplete: true,
    };
    mockPositionManager.nextTokenId.mockResolvedValue(100n);
    ownerByTokenId = new Map([['5', WALLET_ADDRESS]]);
    mockPositionManager.queryFilter.mockResolvedValue([{ args: { tokenId: 5n } }]);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(mockPositionManager.queryFilter).toHaveBeenCalledWith({}, 101, 200);
    expect(mockPositionManager.ownerOf).toHaveBeenCalledWith('5', { blockTag: 200 });
    expect(inventory.map((entry) => entry.tokenId)).toEqual(['5']);
  });

  it('adapts incremental logs to a provider-reported 6,250-block range', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(1_000_000) } as any;
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockInventoryState = {
      tokenIds: ['10'],
      lastScannedBlock: 100,
      nextTokenId: '100',
      coldScanCursor: null,
      isComplete: true,
    };
    mockPositionManager.nextTokenId.mockResolvedValue(100n);
    ownerByTokenId = new Map([['5', WALLET_ADDRESS]]);
    mockPositionManager.queryFilter
      .mockRejectedValueOnce({ error: { code: -32602, message: 'range exceeds limit of 6250' } })
      .mockResolvedValueOnce([{ args: { id: 5n } }]);

    await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(mockPositionManager.queryFilter).toHaveBeenNthCalledWith(1, {}, 500001, 1_000_000);
    expect(mockPositionManager.queryFilter).toHaveBeenNthCalledWith(2, {}, 993751, 1_000_000);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('6250 blocks'));
  });

  it('returns verified partial inventory and persists a resumable cold cursor at the query budget', async () => {
    process.env.UNISWAP_V4_OWNER_BATCH_SIZE = '100';
    process.env.UNISWAP_V4_MAX_LOG_QUERIES = '2';
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(500) } as any;
    mockPositionManager.balanceOf.mockResolvedValue(2n);
    mockPositionManager.nextTokenId.mockResolvedValue(1200n);
    ownerByTokenId = new Map([
      ['1100', WALLET_ADDRESS],
      ['850', WALLET_ADDRESS],
    ]);
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(first.map((entry) => entry.tokenId)).toEqual(['1100']);
    expect(mockInventoryState).toMatchObject({
      tokenIds: ['1100'],
      nextTokenId: '1200',
      coldScanCursor: '999',
      isComplete: false,
    });
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('returning verified positions'));

    clearWalletUniswapV4InventoryCache();
    const second = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(second.map((entry) => entry.tokenId)).toEqual(['1100', '850']);
    expect(mockInventoryState).toMatchObject({
      tokenIds: ['1100', '850'],
      coldScanCursor: null,
      isComplete: true,
    });
  });

  it('reduces rejected ownership multicall batches and retries the same IDs', async () => {
    process.env.UNISWAP_V4_OWNER_BATCH_SIZE = '100';
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(500) } as any;
    mockPositionManager.nextTokenId.mockResolvedValue(101n);
    ownerByTokenId = new Map([['75', WALLET_ADDRESS]]);
    const successfulImplementation = mockMulticall.tryAggregate.staticCall.getMockImplementation();
    mockMulticall.tryAggregate.staticCall
      .mockRejectedValueOnce(new Error('eth_call response too large'))
      .mockImplementation(successfulImplementation as any);
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['75']);
    expect(mockMulticall.tryAggregate.staticCall.mock.calls[0][1]).toHaveLength(100);
    expect(mockMulticall.tryAggregate.staticCall.mock.calls[1][1]).toHaveLength(50);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('reducing batches to 50'));
  });

  it('retries transient ownerOf failures while verifying persisted positions', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(50) } as any;
    mockInventoryState.tokenIds = ['1'];
    mockPositionManager.ownerOf
      .mockRejectedValueOnce({ code: -32005, message: 'Too Many Requests' })
      .mockResolvedValueOnce(WALLET_ADDRESS);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(mockPositionManager.ownerOf).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('recovers a failed direct known-ID check through the bounded ownership batch', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(50) } as any;
    mockInventoryState.tokenIds = ['1'];
    mockPositionManager.ownerOf.mockRejectedValueOnce(new Error('temporary call failure'));

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(mockMulticall.tryAggregate.staticCall).toHaveBeenCalledTimes(1);
    expect(mockInventoryState.isComplete).toBe(true);
  });

  it('retains readable positions when another verified NFT metadata read fails', async () => {
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(50) } as any;
    mockInventoryState.tokenIds = ['20', '10'];
    mockPositionManager.balanceOf.mockResolvedValue(2n);
    mockPositionManager.nextTokenId.mockResolvedValue(21n);
    ownerByTokenId = new Map([
      ['20', WALLET_ADDRESS],
      ['10', WALLET_ADDRESS],
    ]);
    mockPositionManager.getPoolAndPositionInfo.mockImplementation((tokenId: string) => {
      if (tokenId === '20') throw new Error('metadata RPC failed');
      return createPoolAndPositionInfo();
    });
    const warningSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const inventory = await getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );

    expect(inventory.map((entry) => entry.tokenId)).toEqual(['10']);
    expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('1/2 verified NFTs'));
  });

  it('shares an in-flight discovery even after the normal success TTL has elapsed', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const provider = { getBlockNumber: jest.fn().mockResolvedValue(50) } as any;
    let resolveState: ((state: typeof mockInventoryState) => void) | undefined;
    (getUniswapV4InventoryState as jest.Mock).mockImplementationOnce(() => new Promise((resolve) => {
      resolveState = resolve;
    }));

    const first = getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );
    await Promise.resolve();
    now += 120_000;
    const second = getWalletUniswapV4Inventory(
      WALLET_ADDRESS,
      POSITION_MANAGER_ADDRESS,
      1,
      provider,
      ARBITRUM_CHAIN_ID
    );
    resolveState?.(mockInventoryState);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(secondResult.map((entry) => entry.tokenId)).toEqual(['1']);
    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1);
  });
});
