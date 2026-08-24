import Fastify, { FastifyInstance } from 'fastify';
import walletRoutes from '../../src/routes/wallets';
import { getUserById } from '../../src/models/user';
import { getWalletById } from '../../src/models/wallet';
import { isWalletTrackedByUser } from '../../src/models/user-wallet';
import { discoverPositionsWithProgress } from '../../src/services/discovery';

jest.mock('../../src/models/user', () => ({
  getUserById: jest.fn(),
}));

jest.mock('../../src/models/wallet', () => ({
  getOrCreateWalletByAddress: jest.fn(),
  getWalletById: jest.fn(),
  getWalletByAddress: jest.fn(),
  setWalletEnsName: jest.fn(),
}));

jest.mock('../../src/models/user-wallet', () => ({
  getUserWallets: jest.fn(),
  addWalletToUser: jest.fn(),
  removeWalletFromUser: jest.fn(),
  isWalletTrackedByUser: jest.fn(),
}));

jest.mock('../../src/services/discovery', () => ({
  discoverPositionsWithProgress: jest.fn(),
}));

jest.mock('../../src/utils/ethereum', () => ({
  isValidAddress: jest.fn(),
  toChecksumAddress: jest.fn((address: string) => address),
  isENSName: jest.fn(() => false),
  resolveENS: jest.fn(),
  lookupEnsForAddress: jest.fn(),
}));

interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseSseEvents(payload: string): SseEvent[] {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

describe('wallet rescan route', () => {
  const mockGetUserById = getUserById as jest.MockedFunction<typeof getUserById>;
  const mockGetWalletById = getWalletById as jest.MockedFunction<typeof getWalletById>;
  const mockIsWalletTrackedByUser = isWalletTrackedByUser as jest.MockedFunction<typeof isWalletTrackedByUser>;
  const mockDiscoverPositionsWithProgress = discoverPositionsWithProgress as jest.MockedFunction<
    typeof discoverPositionsWithProgress
  >;

  let app: FastifyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      username: 'user',
      displayName: 'User',
      isAdmin: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    mockIsWalletTrackedByUser.mockResolvedValue(true);
    mockGetWalletById.mockResolvedValue({
      id: 'wallet-1',
      address: '0x1111111111111111111111111111111111111111',
      ensName: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.session = {
        userId: 'user-1',
        destroy: (callback: () => void) => callback(),
      } as unknown as typeof request.session;
    });
    await app.register(walletRoutes);
  });

  afterEach(async () => {
    consoleWarnSpy.mockRestore();
    await app.close();
  });

  test('immediately acknowledges an accepted rescan and streams progress to completion', async () => {
    mockDiscoverPositionsWithProgress.mockImplementation(async (_walletId, _walletAddress, onProgress) => {
      onProgress({ type: 'start', data: { totalProtocols: 1 } });
      onProgress({
        type: 'protocol_start',
        data: { protocol: 'Uniswap v4', index: 1, total: 1 },
      });
      onProgress({ type: 'complete', data: { totalPositions: 0, failedProtocols: [] } });
      return [];
    });

    const response = await app.inject({
      method: 'POST',
      url: '/wallet-1/scan',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = parseSseEvents(response.payload);
    expect(events.map((event) => event.type)).toEqual([
      'status',
      'start',
      'protocol_start',
      'complete',
    ]);
    expect(events[0]?.data.message).toBe('Scan accepted. Loading protocols…');
  });

  test('returns a visible SSE error when discovery fails after acceptance', async () => {
    mockDiscoverPositionsWithProgress.mockRejectedValue(new Error('RPC providers unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/wallet-1/scan',
    });

    expect(response.statusCode).toBe(200);
    const events = parseSseEvents(response.payload);
    expect(events.at(-1)).toEqual({
      type: 'error',
      data: { message: 'RPC providers unavailable' },
    });
  });

  test('returns an ordinary error response when the wallet is not tracked', async () => {
    mockIsWalletTrackedByUser.mockResolvedValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/wallet-1/scan',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Wallet not found' });
    expect(mockDiscoverPositionsWithProgress).not.toHaveBeenCalled();
  });
});
