import { query, queryOne } from '../utils/db';
import { RPCProviderConfig } from '../utils/rpc-manager';

/**
 * Database row type (snake_case)
 */
interface RPCProviderRow {
  id: number;
  name: string;
  url: string;
  calls_per_second: string; // NUMERIC comes back as string
  calls_per_day: number | null;
  priority: number;
  is_active: boolean;
  supports_large_block_scans: boolean;
  supports_ens: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert database row to RPCProviderConfig
 */
function rowToConfig(row: RPCProviderRow): RPCProviderConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    callsPerSecond: parseFloat(row.calls_per_second),
    callsPerDay: row.calls_per_day ?? undefined,
    priority: row.priority,
    isActive: row.is_active,
    supportsLargeBlockScans: row.supports_large_block_scans,
    supportsENS: row.supports_ens,
  };
}

/**
 * Get all RPC providers (active and inactive)
 */
export async function getAllRPCProviders(): Promise<RPCProviderConfig[]> {
  const rows = await query<RPCProviderRow>(
    `SELECT
      id,
      name,
      url,
      calls_per_second,
      calls_per_day,
      priority,
      is_active,
      supports_large_block_scans,
      supports_ens,
      created_at,
      updated_at
     FROM rpc_provider
     ORDER BY priority DESC, created_at ASC`
  );

  return rows.map(rowToConfig);
}

/**
 * Get only active RPC providers
 */
export async function getActiveRPCProviders(): Promise<RPCProviderConfig[]> {
  const rows = await query<RPCProviderRow>(
    `SELECT
      id,
      name,
      url,
      calls_per_second,
      calls_per_day,
      priority,
      is_active,
      supports_large_block_scans,
      supports_ens,
      created_at,
      updated_at
     FROM rpc_provider
     WHERE is_active = true
     ORDER BY priority DESC, created_at ASC`
  );

  return rows.map(rowToConfig);
}

/**
 * Get RPC provider by ID
 */
export async function getRPCProviderById(id: number): Promise<RPCProviderConfig | null> {
  const row = await queryOne<RPCProviderRow>(
    `SELECT
      id,
      name,
      url,
      calls_per_second,
      calls_per_day,
      priority,
      is_active,
      supports_large_block_scans,
      supports_ens,
      created_at,
      updated_at
     FROM rpc_provider
     WHERE id = $1`,
    [id]
  );

  return row ? rowToConfig(row) : null;
}

/**
 * Get RPC provider by name
 */
export async function getRPCProviderByName(name: string): Promise<RPCProviderConfig | null> {
  const row = await queryOne<RPCProviderRow>(
    `SELECT
      id,
      name,
      url,
      calls_per_second,
      calls_per_day,
      priority,
      is_active,
      supports_large_block_scans,
      supports_ens,
      created_at,
      updated_at
     FROM rpc_provider
     WHERE name = $1`,
    [name]
  );

  return row ? rowToConfig(row) : null;
}

/**
 * Create a new RPC provider
 */
export async function createRPCProvider(
  config: Omit<RPCProviderConfig, 'id'>
): Promise<RPCProviderConfig> {
  const row = await queryOne<RPCProviderRow>(
    `INSERT INTO rpc_provider (name, url, calls_per_second, calls_per_day, priority, is_active, supports_large_block_scans, supports_ens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       id,
       name,
       url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_large_block_scans,
       supports_ens,
       created_at,
       updated_at`,
    [
      config.name,
      config.url,
      config.callsPerSecond,
      config.callsPerDay ?? null,
      config.priority,
      config.isActive,
      config.supportsLargeBlockScans ?? true,
      config.supportsENS ?? true,
    ]
  );

  if (!row) {
    throw new Error('Failed to create RPC provider');
  }

  return rowToConfig(row);
}

/**
 * Update an RPC provider
 */
export async function updateRPCProvider(
  id: number,
  updates: Partial<Omit<RPCProviderConfig, 'id'>>
): Promise<RPCProviderConfig | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.url !== undefined) {
    fields.push(`url = $${paramIndex++}`);
    values.push(updates.url);
  }
  if (updates.callsPerSecond !== undefined) {
    fields.push(`calls_per_second = $${paramIndex++}`);
    values.push(updates.callsPerSecond);
  }
  if (updates.callsPerDay !== undefined) {
    fields.push(`calls_per_day = $${paramIndex++}`);
    values.push(updates.callsPerDay ?? null);
  }
  if (updates.priority !== undefined) {
    fields.push(`priority = $${paramIndex++}`);
    values.push(updates.priority);
  }
  if (updates.isActive !== undefined) {
    fields.push(`is_active = $${paramIndex++}`);
    values.push(updates.isActive);
  }
  if (updates.supportsLargeBlockScans !== undefined) {
    fields.push(`supports_large_block_scans = $${paramIndex++}`);
    values.push(updates.supportsLargeBlockScans);
  }
  if (updates.supportsENS !== undefined) {
    fields.push(`supports_ens = $${paramIndex++}`);
    values.push(updates.supportsENS);
  }

  if (fields.length === 0) {
    // No updates provided
    return getRPCProviderById(id);
  }

  // Add updated_at
  fields.push(`updated_at = NOW()`);

  // Add WHERE clause parameter
  values.push(id);

  const row = await queryOne<RPCProviderRow>(
    `UPDATE rpc_provider
     SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING
       id,
       name,
       url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_large_block_scans,
       supports_ens,
       created_at,
       updated_at`,
    values
  );

  return row ? rowToConfig(row) : null;
}

/**
 * Delete an RPC provider
 */
export async function deleteRPCProvider(id: number): Promise<boolean> {
  const result = await query(
    `DELETE FROM rpc_provider WHERE id = $1 RETURNING id`,
    [id]
  );
  return result.length > 0;
}

/**
 * Set active status for an RPC provider
 */
export async function setRPCProviderActive(id: number, isActive: boolean): Promise<boolean> {
  const result = await query(
    `UPDATE rpc_provider
     SET is_active = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [id, isActive]
  );
  return result.length > 0;
}

/**
 * Check if any RPC providers exist in the database
 */
export async function hasRPCProviders(): Promise<boolean> {
  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM rpc_provider`
  );
  return result ? parseInt(result.count) > 0 : false;
}
