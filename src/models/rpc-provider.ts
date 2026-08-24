import { query, queryOne } from '../utils/db';
import { RPCProviderConfig } from '../utils/rpc-manager';
import { RPCChainProbeResult, RPCProviderProbeResult } from '../types/rpc-provider';

/**
 * Database row type (snake_case)
 */
interface RPCProviderRow {
  id: number;
  name: string;
  url: string;
  arbitrum_url: string | null;
  calls_per_second: string; // NUMERIC comes back as string
  calls_per_day: number | null;
  priority: number;
  is_active: boolean;
  supports_ethereum: boolean;
  supports_arbitrum: boolean;
  supports_large_block_scans: boolean;
  supports_ethereum_block_scans: boolean;
  supports_arbitrum_block_scans: boolean;
  supports_ens: boolean;
  ethereum_probe: RPCChainProbeResult | null;
  arbitrum_probe: RPCChainProbeResult | null;
  created_at: Date;
  updated_at: Date;
}

type RPCProviderUpdates =
  Partial<Omit<RPCProviderConfig, 'id' | 'arbitrumUrl' | 'callsPerDay'>> & {
    arbitrumUrl?: string | null;
    callsPerDay?: number | null;
  };

function hasArbitrumUrl(row: RPCProviderRow): boolean {
  return row.arbitrum_url !== null && row.arbitrum_url.trim().length > 0;
}

function normalizeOptionalUrl(url: string | null | undefined): string | null {
  if (url === undefined || url === null) {
    return null;
  }
  const normalized = url.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Convert database row to RPCProviderConfig
 */
function rowToConfig(row: RPCProviderRow, chainId?: number): RPCProviderConfig {
  const arbitrumUrl = normalizeOptionalUrl(row.arbitrum_url);
  const effectiveUrl = chainId === 42161 && arbitrumUrl ? arbitrumUrl : row.url;

  const supportsEthereumBlockScans = row.supports_ethereum_block_scans;
  const supportsArbitrumBlockScans = row.supports_arbitrum_block_scans;
  const supportsLargeBlockScans = chainId === 42161
    ? supportsArbitrumBlockScans
    : chainId === 1
      ? supportsEthereumBlockScans
      : supportsEthereumBlockScans || supportsArbitrumBlockScans;

  return {
    id: row.id,
    name: row.name,
    url: effectiveUrl,
    arbitrumUrl: arbitrumUrl ?? undefined,
    callsPerSecond: parseFloat(row.calls_per_second),
    callsPerDay: row.calls_per_day ?? undefined,
    priority: row.priority,
    isActive: row.is_active,
    supportsEthereum: true,
    supportsArbitrum: hasArbitrumUrl(row),
    supportsLargeBlockScans,
    supportsEthereumBlockScans,
    supportsArbitrumBlockScans,
    supportsENS: row.supports_ens,
    ethereumProbe: row.ethereum_probe,
    arbitrumProbe: row.arbitrum_probe,
  };
}

const PROVIDER_SELECT = `SELECT
  id,
  name,
  url,
  arbitrum_url,
  calls_per_second,
  calls_per_day,
  priority,
  is_active,
  supports_ethereum,
  supports_arbitrum,
  supports_large_block_scans,
  supports_ethereum_block_scans,
  supports_arbitrum_block_scans,
  supports_ens,
  ethereum_probe,
  arbitrum_probe,
  created_at,
  updated_at
 FROM rpc_provider`;

/**
 * Get all RPC providers (active and inactive)
 */
export async function getAllRPCProviders(): Promise<RPCProviderConfig[]> {
  const rows = await query<RPCProviderRow>(
    `${PROVIDER_SELECT}
     ORDER BY priority DESC, created_at ASC`
  );

  return rows.map((row) => rowToConfig(row));
}

/**
 * Get only active RPC providers
 */
export async function getActiveRPCProviders(): Promise<RPCProviderConfig[]> {
  const rows = await query<RPCProviderRow>(
    `${PROVIDER_SELECT}
     WHERE is_active = true
     ORDER BY priority DESC, created_at ASC`
  );

  return rows.map((row) => rowToConfig(row));
}

/**
 * Get RPC provider by ID
 */
export async function getRPCProviderById(id: number): Promise<RPCProviderConfig | null> {
  const row = await queryOne<RPCProviderRow>(
    `${PROVIDER_SELECT}
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
    `${PROVIDER_SELECT}
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
  const normalizedArbitrumUrl = normalizeOptionalUrl(config.arbitrumUrl);
  const supportsEthereumBlockScans = config.supportsEthereumBlockScans
    ?? config.supportsLargeBlockScans
    ?? false;
  const supportsArbitrumBlockScans = normalizedArbitrumUrl !== null && (
    config.supportsArbitrumBlockScans
      ?? config.supportsLargeBlockScans
      ?? false
  );

  const row = await queryOne<RPCProviderRow>(
    `INSERT INTO rpc_provider (
       name,
       url,
       arbitrum_url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_ethereum,
       supports_arbitrum,
       supports_large_block_scans,
       supports_ethereum_block_scans,
       supports_arbitrum_block_scans,
       supports_ens,
       ethereum_probe,
       arbitrum_probe
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING
       id,
       name,
       url,
       arbitrum_url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_ethereum,
       supports_arbitrum,
       supports_large_block_scans,
       supports_ethereum_block_scans,
       supports_arbitrum_block_scans,
       supports_ens,
       ethereum_probe,
       arbitrum_probe,
       created_at,
       updated_at`,
    [
      config.name,
      config.url,
      normalizedArbitrumUrl,
      config.callsPerSecond,
      config.callsPerDay ?? null,
      config.priority,
      config.isActive,
      true,
      normalizedArbitrumUrl !== null,
      supportsEthereumBlockScans || supportsArbitrumBlockScans,
      supportsEthereumBlockScans,
      supportsArbitrumBlockScans,
      config.supportsENS ?? true,
      config.ethereumProbe ?? null,
      config.arbitrumProbe ?? null,
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
  updates: RPCProviderUpdates
): Promise<RPCProviderConfig | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.url !== undefined) {
    fields.push(`url = $${paramIndex++}`);
    values.push(updates.url);
  }
  if (updates.arbitrumUrl !== undefined) {
    const normalizedArbitrumUrl = normalizeOptionalUrl(updates.arbitrumUrl);
    fields.push(`arbitrum_url = $${paramIndex++}`);
    values.push(normalizedArbitrumUrl);
    fields.push(`supports_arbitrum = $${paramIndex++}`);
    values.push(normalizedArbitrumUrl !== null);
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
    if (updates.supportsEthereumBlockScans === undefined) {
      fields.push(`supports_ethereum_block_scans = $${paramIndex++}`);
      values.push(updates.supportsLargeBlockScans);
    }
    if (updates.supportsArbitrumBlockScans === undefined) {
      fields.push(`supports_arbitrum_block_scans = $${paramIndex++}`);
      values.push(updates.supportsLargeBlockScans);
    }
  }
  if (updates.supportsEthereumBlockScans !== undefined) {
    fields.push(`supports_ethereum_block_scans = $${paramIndex++}`);
    values.push(updates.supportsEthereumBlockScans);
  }
  if (updates.supportsArbitrumBlockScans !== undefined) {
    fields.push(`supports_arbitrum_block_scans = $${paramIndex++}`);
    values.push(updates.supportsArbitrumBlockScans);
  }
  if (updates.supportsENS !== undefined) {
    fields.push(`supports_ens = $${paramIndex++}`);
    values.push(updates.supportsENS);
  }
  if (updates.ethereumProbe !== undefined) {
    fields.push(`ethereum_probe = $${paramIndex++}`);
    values.push(updates.ethereumProbe);
  }
  if (updates.arbitrumProbe !== undefined) {
    fields.push(`arbitrum_probe = $${paramIndex++}`);
    values.push(updates.arbitrumProbe);
  }

  if (fields.length === 0) {
    return getRPCProviderById(id);
  }

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const row = await queryOne<RPCProviderRow>(
    `UPDATE rpc_provider
     SET ${fields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING
       id,
       name,
       url,
       arbitrum_url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_ethereum,
       supports_arbitrum,
       supports_large_block_scans,
       supports_ethereum_block_scans,
       supports_arbitrum_block_scans,
       supports_ens,
       ethereum_probe,
       arbitrum_probe,
       created_at,
       updated_at`,
    values
  );

  return row ? rowToConfig(row) : null;
}

/**
 * Persist sanitized per-chain capability probes and keep routing flags in sync.
 */
export async function updateRPCProviderProbeResults(
  id: number,
  probes: RPCProviderProbeResult
): Promise<RPCProviderConfig | null> {
  const ethereumScanCompatible = probes.ethereum.blockScan.compatible;
  const arbitrumScanCompatible = probes.arbitrum?.blockScan.compatible ?? false;
  const ethereumScanConclusive = probes.ethereum.blockScan.conclusive;
  const arbitrumScanConclusive = probes.arbitrum?.blockScan.conclusive ?? true;
  const row = await queryOne<RPCProviderRow>(
    `UPDATE rpc_provider
     SET ethereum_probe = $2,
         arbitrum_probe = $3,
         supports_ethereum_block_scans = CASE WHEN $4 THEN $5 ELSE supports_ethereum_block_scans END,
         supports_arbitrum_block_scans = CASE WHEN $6 THEN $7 ELSE supports_arbitrum_block_scans END,
         supports_large_block_scans = (
           CASE WHEN $4 THEN $5 ELSE supports_ethereum_block_scans END
           OR CASE WHEN $6 THEN $7 ELSE supports_arbitrum_block_scans END
         ),
         updated_at = NOW()
     WHERE id = $1
     RETURNING
       id,
       name,
       url,
       arbitrum_url,
       calls_per_second,
       calls_per_day,
       priority,
       is_active,
       supports_ethereum,
       supports_arbitrum,
       supports_large_block_scans,
       supports_ethereum_block_scans,
       supports_arbitrum_block_scans,
       supports_ens,
       ethereum_probe,
       arbitrum_probe,
       created_at,
       updated_at`,
    [
      id,
      probes.ethereum,
      probes.arbitrum,
      ethereumScanConclusive,
      ethereumScanCompatible,
      arbitrumScanConclusive,
      arbitrumScanCompatible,
    ]
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
  return result ? parseInt(result.count, 10) > 0 : false;
}

/**
 * Get active providers that support a specific chain.
 * Supported chain IDs:
 * - 1: Ethereum mainnet
 * - 42161: Arbitrum One
 */
export async function getActiveRPCProvidersForChain(chainId: number): Promise<RPCProviderConfig[]> {
  let chainFilter = '1 = 1';
  if (chainId === 42161) {
    chainFilter = `arbitrum_url IS NOT NULL AND length(trim(arbitrum_url)) > 0`;
  } else if (chainId !== 1) {
    return [];
  }

  const rows = await query<RPCProviderRow>(
    `${PROVIDER_SELECT}
     WHERE is_active = true
       AND ${chainFilter}
     ORDER BY priority DESC, created_at ASC`
  );

  return rows.map((row) => rowToConfig(row, chainId));
}
