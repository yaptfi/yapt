let mockModule: { balanceOf: jest.Mock; positions: jest.Mock };
let mockScanProvider: { getBlockNumber: jest.Mock; getLogs: jest.Mock } | null;
let mockScanState: { scannedFromBlock: number | null; scannedToBlock: number | null; foundKeys: string[] };

jest.mock('../../src/utils/ethereum', () => {
  const { ethers } = jest.requireActual('ethers');
  return {
    ETHEREUM_CHAIN_ID: 1,
    formatUnits: (value: bigint, decimals: number) => ethers.formatUnits(value, decimals),
    getContract: jest.fn(() => mockModule),
    getScanCapableProviderForChain: jest.fn(() => mockScanProvider),
    rpcThrottle: jest.fn().mockResolvedValue(undefined),
    toChecksumAddress: (address: string) => ethers.getAddress(address),
  };
});

jest.mock('../../src/utils/async', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/models/wallet-log-scan-state', () => ({
  getWalletLogScanState: jest.fn(async () => ({ ...mockScanState, foundKeys: [...mockScanState.foundKeys] })),
  saveWalletLogScanState: jest.fn(async (_wallet: string, _chain: number, _key: string, state: typeof mockScanState) => {
    mockScanState = { ...state, foundKeys: [...state.foundKeys] };
  }),
}));

import type { Log } from 'ethers';
import {
  InfinifiUnwindingAdapter,
  epochToTimestamp,
  extractUnwindingTimestamps,
  getUnwindingId,
} from '../../src/adapters/infinifi-unwinding';
import { saveWalletLogScanState } from '../../src/models/wallet-log-scan-state';
import { Position } from '../../src/types';

const WALLET = '0x80D0d54050C15971b21e877D95441800f5AA9ee8';
const MODULE = '0x7092a43ae5407666c78dbea657a1891f42b3dfcc';
const START_TS = '1795180415';

// PositionRemoved log from tx 0xadbadda1…b696 (startUnwinding of 250,000 iUSD, 4 epochs).
const POSITION_REMOVED_LOG = {
  address: '0x1d95cc100d6cd9c7bbdbd7cb328d99b3d6037ff7',
  topics: [
    '0xbf3fa14675f05849ac4d7547863114244029774d47c7f763094735898aa54158',
    '0x000000000000000000000000000000000000000000000000000000006b00477f',
    '0x00000000000000000000000080d0d54050c15971b21e877d95441800f5aa9ee8',
    '0x0000000000000000000000000000000000000000000000000000000000000004',
  ],
  data: '0x0000000000000000000000000000000000000000000034f086f3b33b6843109e',
  blockNumber: 26456532,
} as unknown as Log;

const BALANCE_250K = 250_000n * 10n ** 18n;

describe('Infinifi unwinding helpers', () => {
  it('derives the on-chain unwinding id as keccak256(abi.encode(user, timestamp))', () => {
    // Verified against UnwindingModule.positions(id) on mainnet: fromEpoch 2968, toEpoch 2972.
    expect(getUnwindingId(WALLET, BigInt(START_TS))).toBe(
      '0x9ef595f5056946678e837e45c4f61295f8c2bbdbbf33a058990ff1f6508be363'
    );
    expect(getUnwindingId(WALLET.toLowerCase(), BigInt(START_TS))).toBe(getUnwindingId(WALLET, BigInt(START_TS)));
  });

  it('converts epochs to timestamps using 1-week epochs offset by 3 days', () => {
    expect(new Date(Number(epochToTimestamp(2972n)) * 1000).toISOString()).toBe('2026-12-20T00:00:00.000Z');
  });

  it('extracts start timestamps from PositionRemoved logs for the wallet only', () => {
    const otherUserLog = {
      ...POSITION_REMOVED_LOG,
      topics: [...POSITION_REMOVED_LOG.topics.slice(0, 2), '0x' + '00'.repeat(31) + '01', POSITION_REMOVED_LOG.topics[3]],
    } as unknown as Log;
    const unrelatedLog = { ...POSITION_REMOVED_LOG, topics: ['0x' + '11'.repeat(32)] } as unknown as Log;

    expect(
      extractUnwindingTimestamps([POSITION_REMOVED_LOG, POSITION_REMOVED_LOG, otherUserLog, unrelatedLog], WALLET)
    ).toEqual([START_TS]);
  });
});

describe('InfinifiUnwindingAdapter', () => {
  const adapter = new InfinifiUnwindingAdapter();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockScanState = { scannedFromBlock: null, scannedToBlock: null, foundKeys: [] };
    mockScanProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(26_460_000),
      getLogs: jest.fn().mockResolvedValue([POSITION_REMOVED_LOG]),
    };
    mockModule = {
      balanceOf: jest.fn().mockResolvedValue(BALANCE_250K),
      positions: jest.fn().mockResolvedValue({ toEpoch: 2972n }),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('discovers a live unwinding position and persists scan progress', async () => {
    const positions = await adapter.discover(WALLET);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      protocolPositionKey: `${MODULE}:${START_TS}`,
      displayName: 'Infinifi iUSD unwinding (unlocks 2026-12-20)',
      baseAsset: 'iUSD',
      measureMethod: 'balance',
      metadata: {
        unwindingModule: MODULE,
        startUnwindingTimestamp: START_TS,
        unlockTimestamp: String(epochToTimestamp(2972n)),
        decimals: 18,
      },
    });
    expect(mockModule.balanceOf).toHaveBeenCalledWith(WALLET, BigInt(START_TS));
    expect(mockModule.positions).toHaveBeenCalledWith(getUnwindingId(WALLET, BigInt(START_TS)));
    expect(mockScanState).toEqual({ scannedFromBlock: 22540451, scannedToBlock: 26_460_000, foundKeys: [START_TS] });

    const [filter] = mockScanProvider!.getLogs.mock.calls[0];
    expect(filter.topics[0]).toBe(POSITION_REMOVED_LOG.topics[0]);
    expect(filter.topics[2]).toBe(POSITION_REMOVED_LOG.topics[2]);
  });

  it('drops candidates that verify to a zero balance (withdrawn, cancelled or epoch extension)', async () => {
    mockModule.balanceOf.mockResolvedValue(0n);

    const positions = await adapter.discover(WALLET);

    expect(positions).toEqual([]);
    expect(mockScanState.foundKeys).toEqual([]);
    expect(mockModule.positions).not.toHaveBeenCalled();
  });

  it('re-verifies known positions without scanning when no scan-capable provider exists', async () => {
    mockScanProvider = null;
    mockScanState = { scannedFromBlock: 26_000_000, scannedToBlock: 26_456_532, foundKeys: [START_TS] };

    const positions = await adapter.discover(WALLET);

    expect(positions).toHaveLength(1);
    expect(mockScanState).toMatchObject({ scannedFromBlock: 26_000_000, scannedToBlock: 26_456_532 });
  });

  it('persists partial scan progress before rethrowing when nothing could be verified', async () => {
    mockScanProvider!.getLogs.mockRejectedValue(new Error('internal error'));

    await expect(adapter.discover(WALLET)).rejects.toThrow('log scan failed');
    expect(saveWalletLogScanState).toHaveBeenCalled();
  });

  it('propagates balance read failures instead of treating them as exits', async () => {
    mockModule.balanceOf.mockRejectedValue(new Error('missing revert data'));

    await expect(adapter.discover(WALLET)).rejects.toThrow('missing revert data');
    // Candidate was persisted before verification, so the next run retries it.
    expect(mockScanState.foundKeys).toEqual([START_TS]);
  });

  it('reads the current value from UnwindingModule.balanceOf', async () => {
    mockModule.balanceOf.mockResolvedValue(250_123_450_000_000_000_000_000n);
    const position = {
      metadata: {
        unwindingModule: MODULE,
        startUnwindingTimestamp: START_TS,
        decimals: 18,
        baseAsset: 'iUSD',
        walletAddress: WALLET,
      },
    } as unknown as Position;

    await expect(adapter.readCurrentValue(position)).resolves.toBeCloseTo(250_123.45, 2);
    expect(mockModule.balanceOf).toHaveBeenCalledWith(WALLET, BigInt(START_TS));
  });

  it('rejects invalid stored start timestamps', async () => {
    const position = {
      metadata: { unwindingModule: MODULE, startUnwindingTimestamp: 'abc', decimals: 18, walletAddress: WALLET },
    } as unknown as Position;

    await expect(adapter.readCurrentValue(position)).rejects.toThrow('Invalid Infinifi unwinding start timestamp');
  });
});
