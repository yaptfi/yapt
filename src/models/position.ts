import { query, queryOne } from '../utils/db';
import { Position, CountingMode } from '../types';

export async function createPosition(
  walletId: string,
  protocolKey: string,
  positionData: Partial<Position>
): Promise<Position> {
  // First, get protocol ID
  const protocol = await queryOne<{ id: string }>(
    'SELECT id FROM protocol WHERE key = $1',
    [protocolKey]
  );

  if (!protocol) {
    throw new Error(`Protocol not found: ${protocolKey}`);
  }

  // Get stablecoin ID from symbol (baseAsset)
  const stablecoin = await queryOne<{ id: string }>(
    'SELECT id FROM stablecoin WHERE symbol = $1',
    [positionData.baseAsset]
  );

  if (!stablecoin) {
    throw new Error(`Stablecoin not found: ${positionData.baseAsset}`);
  }

  const result = await queryOne<Position>(
    `INSERT INTO position (
      wallet_id, protocol_id, protocol_position_key, display_name,
      base_asset, stablecoin_id, counting_mode, measure_method, metadata, is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (wallet_id, protocol_position_key)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      base_asset = EXCLUDED.base_asset,
      stablecoin_id = EXCLUDED.stablecoin_id,
      counting_mode = EXCLUDED.counting_mode,
      measure_method = EXCLUDED.measure_method,
      metadata = EXCLUDED.metadata,
      is_active = EXCLUDED.is_active
    RETURNING
      id,
      wallet_id as "walletId",
      protocol_id as "protocolId",
      protocol_position_key as "protocolPositionKey",
      display_name as "displayName",
      base_asset as "baseAsset",
      stablecoin_id as "stablecoinId",
      counting_mode as "countingMode",
      measure_method as "measureMethod",
      metadata,
      is_active as "isActive",
      created_at as "createdAt"`,
    [
      walletId,
      protocol.id,
      positionData.protocolPositionKey,
      positionData.displayName,
      positionData.baseAsset,
      stablecoin.id,
      positionData.countingMode || 'count',
      positionData.measureMethod,
      JSON.stringify(positionData.metadata || {}),
      positionData.isActive !== undefined ? positionData.isActive : true,
    ]
  );

  if (!result) {
    throw new Error('Failed to create position');
  }

  return result;
}

export async function getPositionsByWallet(walletId: string): Promise<Position[]> {
  return query<Position>(
    `SELECT
      p.id,
      p.wallet_id as "walletId",
      p.protocol_id as "protocolId",
      p.protocol_position_key as "protocolPositionKey",
      p.display_name as "displayName",
      p.base_asset as "baseAsset",
      p.stablecoin_id as "stablecoinId",
      p.counting_mode as "countingMode",
      p.measure_method as "measureMethod",
      p.metadata,
      p.is_active as "isActive",
      p.created_at as "createdAt",
      pr.key as protocol_key,
      pr.name as protocol_name
     FROM position p
     JOIN protocol pr ON p.protocol_id = pr.id
     WHERE p.wallet_id = $1 AND p.is_active = true
     ORDER BY p.created_at DESC`,
    [walletId]
  );
}

export async function getPositionById(id: string): Promise<Position | null> {
  return queryOne<Position>(
    `SELECT
      p.id,
      p.wallet_id as "walletId",
      p.protocol_id as "protocolId",
      p.protocol_position_key as "protocolPositionKey",
      p.display_name as "displayName",
      p.base_asset as "baseAsset",
      p.stablecoin_id as "stablecoinId",
      p.counting_mode as "countingMode",
      p.measure_method as "measureMethod",
      p.metadata,
      p.is_active as "isActive",
      p.created_at as "createdAt",
      pr.key as protocol_key,
      pr.name as protocol_name
     FROM position p
     JOIN protocol pr ON p.protocol_id = pr.id
     WHERE p.id = $1`,
    [id]
  );
}

export async function updatePositionCountingMode(
  id: string,
  countingMode: CountingMode
): Promise<Position | null> {
  return queryOne<Position>(
    `UPDATE position
     SET counting_mode = $1
     WHERE id = $2
     RETURNING
      id,
      wallet_id as "walletId",
      protocol_id as "protocolId",
      protocol_position_key as "protocolPositionKey",
      display_name as "displayName",
      base_asset as "baseAsset",
      stablecoin_id as "stablecoinId",
      counting_mode as "countingMode",
      measure_method as "measureMethod",
      metadata,
      is_active as "isActive",
      created_at as "createdAt"`,
    [countingMode, id]
  );
}

export async function updatePositionActiveStatus(
  id: string,
  isActive: boolean
): Promise<Position | null> {
  return queryOne<Position>(
    `UPDATE position
     SET is_active = $1
     WHERE id = $2
     RETURNING
      id,
      wallet_id as "walletId",
      protocol_id as "protocolId",
      protocol_position_key as "protocolPositionKey",
      display_name as "displayName",
      base_asset as "baseAsset",
      stablecoin_id as "stablecoinId",
      counting_mode as "countingMode",
      measure_method as "measureMethod",
      metadata,
      is_active as "isActive",
      created_at as "createdAt"`,
    [isActive, id]
  );
}

export async function getAllActivePositions(): Promise<Position[]> {
  return query<Position>(
    `SELECT
      p.id,
      p.wallet_id as "walletId",
      p.protocol_id as "protocolId",
      p.protocol_position_key as "protocolPositionKey",
      p.display_name as "displayName",
      p.base_asset as "baseAsset",
      p.stablecoin_id as "stablecoinId",
      p.counting_mode as "countingMode",
      p.measure_method as "measureMethod",
      p.metadata,
      p.is_active as "isActive",
      p.created_at as "createdAt",
      pr.key as protocol_key,
      pr.name as protocol_name
     FROM position p
     JOIN protocol pr ON p.protocol_id = pr.id
     WHERE p.is_active = true
     ORDER BY p.created_at DESC`
  );
}

export async function getActivePositionsByWallets(walletIds: string[]): Promise<Position[]> {
  if (walletIds.length === 0) {
    return [];
  }

  return query<Position>(
    `SELECT
      p.id,
      p.wallet_id as "walletId",
      p.protocol_id as "protocolId",
      p.protocol_position_key as "protocolPositionKey",
      p.display_name as "displayName",
      p.base_asset as "baseAsset",
      p.stablecoin_id as "stablecoinId",
      p.counting_mode as "countingMode",
      p.measure_method as "measureMethod",
      p.metadata,
      p.is_active as "isActive",
      p.created_at as "createdAt",
      pr.key as protocol_key,
      pr.name as protocol_name
     FROM position p
     JOIN protocol pr ON p.protocol_id = pr.id
     WHERE p.is_active = true AND p.wallet_id = ANY($1::uuid[])
     ORDER BY p.created_at DESC`,
    [walletIds]
  );
}

/**
 * Archive a position and all its snapshots
 * Moves position and snapshot data to archive tables and deletes from main tables
 *
 * @param positionId - Position to archive
 * @param exitReason - Reason for archiving (e.g., 'complete_exit', 'user_archived')
 */
export async function archivePosition(positionId: string, exitReason: string): Promise<void> {
  // Step 1: Copy position to archive table
  await query(
    `INSERT INTO position_archive
      (id, wallet_id, protocol_id, protocol_position_key, display_name,
       base_asset, counting_mode, measure_method, metadata, is_active,
       created_at, exit_reason)
    SELECT id, wallet_id, protocol_id, protocol_position_key, display_name,
           base_asset, counting_mode, measure_method, metadata, is_active,
           created_at, $2
    FROM position WHERE id = $1`,
    [positionId, exitReason]
  );

  // Step 2: Copy all snapshots to archive table
  await query(
    `INSERT INTO position_snapshot_archive
      (position_id, ts, value_usd, net_flows_usd, yield_delta_usd, apy)
    SELECT position_id, ts, value_usd, net_flows_usd, yield_delta_usd, apy
    FROM position_snapshot WHERE position_id = $1`,
    [positionId]
  );

  // Step 3: Delete from main tables (CASCADE will delete snapshots)
  await query('DELETE FROM position WHERE id = $1', [positionId]);

  console.log(`Archived position ${positionId} (reason: ${exitReason})`);
}
