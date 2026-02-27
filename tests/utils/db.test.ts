const mockConnect = jest.fn();
const mockOn = jest.fn();
const mockEnd = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    on: mockOn,
    end: mockEnd,
  })),
}));

import { withTransaction, closePool } from '../../src/utils/db';

describe('withTransaction', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await closePool();
  });

  test('commits transaction when callback succeeds', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(client);

    const result = await withTransaction(async (txClient) => {
      await txClient.query('SELECT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'SELECT 1',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back transaction when callback throws', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    mockConnect.mockResolvedValue(client);

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
