import { query, queryOne } from '../utils/db';
import { Stablecoin } from '../types';

/**
 * Get all stablecoins
 */
export async function getAllStablecoins(): Promise<Stablecoin[]> {
  return query<Stablecoin>(
    `SELECT
      id,
      symbol,
      name,
      coingecko_id as "coingeckoId",
      decimals,
      created_at as "createdAt"
     FROM stablecoin
     ORDER BY symbol ASC`
  );
}

/**
 * Get a stablecoin by symbol
 */
export async function getStablecoinBySymbol(symbol: string): Promise<Stablecoin | null> {
  return queryOne<Stablecoin>(
    `SELECT
      id,
      symbol,
      name,
      coingecko_id as "coingeckoId",
      decimals,
      created_at as "createdAt"
     FROM stablecoin
     WHERE symbol = $1`,
    [symbol]
  );
}

/**
 * Get a stablecoin by ID
 */
export async function getStablecoinById(id: string): Promise<Stablecoin | null> {
  return queryOne<Stablecoin>(
    `SELECT
      id,
      symbol,
      name,
      coingecko_id as "coingeckoId",
      decimals,
      created_at as "createdAt"
     FROM stablecoin
     WHERE id = $1`,
    [id]
  );
}

/**
 * Create a new stablecoin
 */
export async function createStablecoin(data: {
  symbol: string;
  name: string;
  coingeckoId?: string | null;
  decimals?: number;
}): Promise<Stablecoin> {
  const result = await queryOne<Stablecoin>(
    `INSERT INTO stablecoin (symbol, name, coingecko_id, decimals)
     VALUES ($1, $2, $3, $4)
     RETURNING
      id,
      symbol,
      name,
      coingecko_id as "coingeckoId",
      decimals,
      created_at as "createdAt"`,
    [data.symbol, data.name, data.coingeckoId || null, data.decimals || 18]
  );

  if (!result) {
    throw new Error('Failed to create stablecoin');
  }

  return result;
}

/**
 * Update a stablecoin
 */
export async function updateStablecoin(
  id: string,
  data: {
    symbol?: string;
    name?: string;
    coingeckoId?: string | null;
    decimals?: number;
  }
): Promise<Stablecoin | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.symbol !== undefined) {
    updates.push(`symbol = $${paramIndex++}`);
    values.push(data.symbol);
  }
  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.coingeckoId !== undefined) {
    updates.push(`coingecko_id = $${paramIndex++}`);
    values.push(data.coingeckoId);
  }
  if (data.decimals !== undefined) {
    updates.push(`decimals = $${paramIndex++}`);
    values.push(data.decimals);
  }

  if (updates.length === 0) {
    return getStablecoinById(id);
  }

  values.push(id);

  return queryOne<Stablecoin>(
    `UPDATE stablecoin
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING
      id,
      symbol,
      name,
      coingecko_id as "coingeckoId",
      decimals,
      created_at as "createdAt"`,
    values
  );
}
