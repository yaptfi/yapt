import { Pool, PoolClient } from 'pg';

let pool: Pool | null = null;
export type DBClient = PoolClient;

export function getPool(): Pool {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString: databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1);
    });
  }

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function withClient<T>(fn: (client: DBClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function queryOnClient<T = any>(
  client: DBClient,
  text: string,
  params?: any[]
): Promise<T[]> {
  const result = await client.query(text, params);
  return result.rows;
}

export async function queryOneOnClient<T = any>(
  client: DBClient,
  text: string,
  params?: any[]
): Promise<T | null> {
  const rows = await queryOnClient<T>(client, text, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function withTransaction<T>(fn: (client: DBClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to rollback transaction', rollbackError);
      }
      throw error;
    }
  });
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  return withClient((client) => queryOnClient<T>(client, text, params));
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  return withClient((client) => queryOneOnClient<T>(client, text, params));
}
