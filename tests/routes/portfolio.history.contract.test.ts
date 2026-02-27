import Fastify, { FastifyInstance } from 'fastify';
import portfolioRoutes from '../../src/routes/portfolio';
import { getUserById } from '../../src/models/user';
import { getUserWallets } from '../../src/models/user-wallet';
import { query } from '../../src/utils/db';

jest.mock('../../src/models/user', () => ({
  getUserById: jest.fn(),
}));

jest.mock('../../src/models/user-wallet', () => ({
  getUserWallets: jest.fn(),
}));

jest.mock('../../src/utils/db', () => ({
  query: jest.fn(),
}));

describe('portfolio history route', () => {
  const mockGetUserById = getUserById as jest.MockedFunction<typeof getUserById>;
  const mockGetUserWallets = getUserWallets as jest.MockedFunction<typeof getUserWallets>;
  const mockQuery = query as jest.MockedFunction<typeof query>;

  let app: FastifyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockGetUserById.mockResolvedValue({
      id: 'user-1',
      username: 'user',
      displayName: 'User',
      isAdmin: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    mockGetUserWallets.mockResolvedValue([
      { id: 'wallet-1', address: '0x1111111111111111111111111111111111111111', createdAt: new Date('2025-01-01T00:00:00.000Z') },
      { id: 'wallet-2', address: '0x2222222222222222222222222222222222222222', createdAt: new Date('2025-01-02T00:00:00.000Z') },
    ]);

    mockQuery.mockResolvedValue([
      {
        date: '2026-02-27',
        totalValueUsd: '1700000.50',
        timestamp: new Date('2026-02-27T12:00:00.000Z'),
      },
    ] as any);

    app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      request.session = {
        userId: 'user-1',
        destroy: (cb: () => void) => cb(),
      } as unknown as typeof request.session;
    });

    await app.register(portfolioRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test('aggregates history from active and archived snapshots', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/history',
    });

    expect(response.statusCode).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('position_snapshot ps');
    expect(sql).toContain('position_snapshot_archive psa');
    expect(sql).toContain('JOIN position_archive pa');
    expect(params).toEqual([['wallet-1', 'wallet-2']]);

    const payload = response.json() as {
      history: Array<{ totalValueUsd: number }>;
    };
    expect(payload.history).toHaveLength(1);
    expect(payload.history[0].totalValueUsd).toBeCloseTo(1700000.5);
  });

  test('filters walletIds to only user-owned wallets', async () => {
    await app.inject({
      method: 'GET',
      url: '/history?walletIds=wallet-2,not-owned',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([['wallet-2']]);
  });
});
