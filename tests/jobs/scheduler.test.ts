/**
 * Tests for processWalletsSequentially isolation behavior.
 *
 * The function is added to scheduler.ts in C1. Before that change, importing
 * it yields `undefined` and the tests fail — that is the expected "red" state.
 */

// Mocks must be declared before any imports that reference them.
const mockGetAllWallets = jest.fn();
const mockGetTrackedWallets = jest.fn();
const mockGetWalletById = jest.fn();
const mockGetPositionsByWallet = jest.fn();
const mockUpdateWallet = jest.fn();
const mockDiscoverPositions = jest.fn();
const mockCleanupUntrackedWallets = jest.fn();
const mockCheckAndSendNotifications = jest.fn();
const mockBullmqState = {
  add: jest.fn(),
  getRepeatableJobs: jest.fn().mockResolvedValue([]),
  queueClose: jest.fn(),
  workerOn: jest.fn(),
  workerClose: jest.fn(),
  processor: null as null | ((job: { id?: string; name: string; data?: unknown }) => Promise<void>),
};

jest.mock('../../src/models/wallet', () => ({
  getAllWallets: mockGetAllWallets,
  getTrackedWallets: mockGetTrackedWallets,
  getWalletById: mockGetWalletById,
}));

jest.mock('../../src/models/position', () => ({
  getPositionsByWallet: mockGetPositionsByWallet,
}));

jest.mock('../../src/services/update', () => ({
  updateWallet: mockUpdateWallet,
}));

jest.mock('../../src/services/discovery', () => ({
  discoverPositions: mockDiscoverPositions,
}));

jest.mock('../../src/services/cleanup', () => ({
  cleanupUntrackedWallets: mockCleanupUntrackedWallets,
}));

jest.mock('../../src/services/notificationChecker', () => ({
  checkAndSendNotifications: mockCheckAndSendNotifications,
}));

jest.mock('../../src/utils/config', () => ({
  getEnvVar: jest.fn().mockReturnValue('redis://localhost:6379'),
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockBullmqState.add,
    getRepeatableJobs: mockBullmqState.getRepeatableJobs,
    close: mockBullmqState.queueClose,
  })),
  Worker: jest.fn().mockImplementation((_queueName, processor) => {
    mockBullmqState.processor = processor;
    return {
      on: mockBullmqState.workerOn,
      close: mockBullmqState.workerClose,
    };
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const schedulerModule = require('../../src/jobs/scheduler') as Record<string, unknown>;

const WALLETS = [
  { id: 'wallet-1', address: '0x1' },
  { id: 'wallet-2', address: '0x2' },
  { id: 'wallet-3', address: '0x3' },
];

describe('processWalletsSequentially', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetAllWallets.mockReset();
    mockGetTrackedWallets.mockReset();
    mockGetWalletById.mockReset();
    mockGetPositionsByWallet.mockResolvedValue([]);
    mockDiscoverPositions.mockReset();
    mockCleanupUntrackedWallets.mockReset();
    mockBullmqState.add.mockReset();
    mockBullmqState.getRepeatableJobs.mockReset();
    mockBullmqState.getRepeatableJobs.mockResolvedValue([]);
    mockBullmqState.queueClose.mockReset();
    mockBullmqState.workerOn.mockReset();
    mockBullmqState.workerClose.mockReset();
    mockBullmqState.processor = null;
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    jest.clearAllMocks();
  });

  it('is exported from the scheduler module', () => {
    expect(typeof schedulerModule['processWalletsSequentially']).toBe('function');
  });

  it('processes all wallets even when one throws', async () => {
    mockUpdateWallet
      .mockResolvedValueOnce(undefined)           // wallet-1: success
      .mockRejectedValueOnce(new Error('boom'))   // wallet-2: fail
      .mockResolvedValueOnce(undefined);          // wallet-3: success

    const processWalletsSequentially = schedulerModule['processWalletsSequentially'] as (w: typeof WALLETS) => Promise<void>;
    const promise = processWalletsSequentially(WALLETS);
    await jest.runAllTimersAsync();
    await promise;

    expect(mockGetPositionsByWallet).toHaveBeenCalledTimes(3);
    expect(mockUpdateWallet).toHaveBeenCalledTimes(3);
  });

  it('logs an error for the failing wallet', async () => {
    const err = new Error('RPC failure');
    mockUpdateWallet
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(undefined);

    const processWalletsSequentially = schedulerModule['processWalletsSequentially'] as (w: typeof WALLETS) => Promise<void>;
    const promise = processWalletsSequentially(WALLETS);
    await jest.runAllTimersAsync();
    await promise;

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('wallet-2'),
      err,
    );
  });

  it('does not throw when all wallets fail', async () => {
    mockUpdateWallet.mockRejectedValue(new Error('all fail'));

    const processWalletsSequentially = schedulerModule['processWalletsSequentially'] as (w: typeof WALLETS) => Promise<void>;
    const promise = processWalletsSequentially(WALLETS);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
  });
});

describe('weekly cleanup job', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockBullmqState.add.mockReset();
    mockBullmqState.getRepeatableJobs.mockReset();
    mockBullmqState.getRepeatableJobs.mockResolvedValue([]);
    mockBullmqState.processor = null;
    mockCleanupUntrackedWallets.mockReset();
    mockGetTrackedWallets.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('queues discovery for tracked wallets after weekly cleanup', async () => {
    const initializeScheduler = schedulerModule['initializeScheduler'] as () => Promise<void>;

    mockCleanupUntrackedWallets.mockResolvedValue({
      deletedWallets: 1,
      deletedPositions: 2,
      deletedSnapshots: 3,
    });
    mockGetTrackedWallets.mockResolvedValue([
      { id: 'wallet-1', address: '0x1' },
      { id: 'wallet-3', address: '0x3' },
    ]);

    await initializeScheduler();
    mockBullmqState.add.mockClear();

    expect(mockBullmqState.processor).not.toBeNull();

    await mockBullmqState.processor!({
      id: 'job-weekly-cleanup',
      name: 'cleanup-untracked-wallets',
      data: {},
    });

    expect(mockCleanupUntrackedWallets).toHaveBeenCalledTimes(1);
    expect(mockGetTrackedWallets).toHaveBeenCalledTimes(1);
    expect(mockBullmqState.add).toHaveBeenNthCalledWith(1, 'discover-wallet', { walletId: 'wallet-1' });
    expect(mockBullmqState.add).toHaveBeenNthCalledWith(2, 'discover-wallet', { walletId: 'wallet-3' });
    expect(mockBullmqState.add).toHaveBeenCalledTimes(2);
  });
});
