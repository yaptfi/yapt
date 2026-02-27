/**
 * Tests for processWalletsSequentially isolation behavior.
 *
 * The function is added to scheduler.ts in C1. Before that change, importing
 * it yields `undefined` and the tests fail — that is the expected "red" state.
 */

// Mocks must be declared before any imports that reference them.
const mockGetPositionsByWallet = jest.fn();
const mockUpdateWallet = jest.fn();
const mockCheckAndSendNotifications = jest.fn();

jest.mock('../../src/models/wallet', () => ({
  getAllWallets: jest.fn(),
  getWalletById: jest.fn(),
}));

jest.mock('../../src/models/position', () => ({
  getPositionsByWallet: mockGetPositionsByWallet,
}));

jest.mock('../../src/services/update', () => ({
  updateWallet: mockUpdateWallet,
}));

jest.mock('../../src/services/discovery', () => ({
  discoverPositions: jest.fn(),
}));

jest.mock('../../src/services/cleanup', () => ({
  cleanupUntrackedWallets: jest.fn(),
}));

jest.mock('../../src/services/notificationChecker', () => ({
  checkAndSendNotifications: mockCheckAndSendNotifications,
}));

jest.mock('../../src/utils/config', () => ({
  getEnvVar: jest.fn().mockReturnValue('redis://localhost:6379'),
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn(),
    getRepeatableJobs: jest.fn().mockResolvedValue([]),
    close: jest.fn(),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
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
    mockGetPositionsByWallet.mockResolvedValue([]);
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
