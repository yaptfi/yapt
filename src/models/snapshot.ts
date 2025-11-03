import { query, queryOne } from '../utils/db';
import { PositionSnapshot } from '../types';

export async function createSnapshot(
  positionId: string,
  ts: Date,
  valueUsd: number,
  netFlowsUsd: number,
  yieldDeltaUsd: number,
  apy: number | null,
  isReset: boolean = false
): Promise<PositionSnapshot> {
  const result = await queryOne<PositionSnapshot>(
    `INSERT INTO position_snapshot (
      position_id, ts, value_usd, net_flows_usd, yield_delta_usd, apy, is_reset
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (position_id, ts) DO UPDATE SET
      value_usd = EXCLUDED.value_usd,
      net_flows_usd = EXCLUDED.net_flows_usd,
      yield_delta_usd = EXCLUDED.yield_delta_usd,
      apy = EXCLUDED.apy,
      is_reset = EXCLUDED.is_reset
    RETURNING *`,
    [positionId, ts, valueUsd.toString(), netFlowsUsd.toString(), yieldDeltaUsd.toString(), apy?.toString() || null, isReset]
  );

  if (!result) {
    throw new Error('Failed to create snapshot');
  }

  return result;
}

export async function getLatestSnapshot(positionId: string): Promise<PositionSnapshot | null> {
  return queryOne<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1
     ORDER BY ts DESC
     LIMIT 1`,
    [positionId]
  );
}

/**
 * Get snapshot closest to a target time in the past (e.g., 4 hours ago)
 * Returns the snapshot closest to the target time, but at least minHours old
 */
export async function getSnapshotNearTime(
  positionId: string,
  targetTime: Date,
  minHours: number = 1
): Promise<PositionSnapshot | null> {
  const now = new Date();
  const minTime = new Date(now.getTime() - minHours * 60 * 60 * 1000);

  return queryOne<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1
       AND ts < $2
       AND ts <= $3
     ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $4)))
     LIMIT 1`,
    [positionId, now, minTime, targetTime]
  );
}

export async function getSnapshotsSince(
  positionId: string,
  since: Date
): Promise<PositionSnapshot[]> {
  return query<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1 AND ts >= $2
     ORDER BY ts ASC`,
    [positionId, since]
  );
}

export async function getSnapshotsInRange(
  positionId: string,
  from: Date,
  to: Date
): Promise<PositionSnapshot[]> {
  return query<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1 AND ts >= $2 AND ts <= $3
     ORDER BY ts ASC`,
    [positionId, from, to]
  );
}

export async function getRecentApyValues(
  positionId: string,
  count: number
): Promise<number[]> {
  // Find most recent reset snapshot
  const resetSnapshot = await getMostRecentResetSnapshot(positionId);
  const cutoffTime = resetSnapshot ? resetSnapshot.ts : new Date(0);

  const snapshots = await query<{ apy: string | null }>(
    `SELECT apy FROM position_snapshot
     WHERE position_id = $1
       AND apy IS NOT NULL
       AND is_reset = false
       AND ts > $2
     ORDER BY ts DESC
     LIMIT $3`,
    [positionId, cutoffTime, count]
  );

  return snapshots
    .filter(s => s.apy !== null)
    .map(s => parseFloat(s.apy!))
    .reverse(); // Oldest to newest for chaining
}

export async function getSnapshotAtBlock(
  positionId: string,
  _blockNumber: number
): Promise<PositionSnapshot | null> {
  // This is a simplified version - in production you'd need to correlate timestamps with blocks
  return queryOne<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1
     ORDER BY ts DESC
     LIMIT 1`,
    [positionId]
  );
}

/**
 * Get recent yield delta values for calculating absolute earnings rate
 * Used for reward-based positions where absolute stablecoin earnings matter more than APY
 */
export async function getRecentYieldDeltas(
  positionId: string,
  count: number
): Promise<Array<{ yieldDeltaUsd: number; ts: Date }>> {
  const snapshots = await query<{ yield_delta_usd: string; ts: Date }>(
    `SELECT yield_delta_usd, ts FROM position_snapshot
     WHERE position_id = $1
     ORDER BY ts DESC
     LIMIT $2`,
    [positionId, count]
  );

  return snapshots
    .map(s => ({
      yieldDeltaUsd: parseFloat(s.yield_delta_usd),
      ts: s.ts,
    }))
    .reverse(); // Oldest to newest
}

/**
 * Get total earnings and time period for absolute yield calculation
 */
export async function getTotalYieldSince(
  positionId: string,
  since: Date
): Promise<{ totalYieldUsd: number; daysCovered: number }> {
  const result = await queryOne<{ total_yield: string; first_ts: Date; last_ts: Date }>(
    `SELECT
      COALESCE(SUM(yield_delta_usd), 0) as total_yield,
      MIN(ts) as first_ts,
      MAX(ts) as last_ts
     FROM position_snapshot
     WHERE position_id = $1 AND ts >= $2`,
    [positionId, since]
  );

  if (!result || !result.first_ts || !result.last_ts) {
    return { totalYieldUsd: 0, daysCovered: 0 };
  }

  const daysCovered = (result.last_ts.getTime() - result.first_ts.getTime()) / (1000 * 60 * 60 * 24);

  return {
    totalYieldUsd: parseFloat(result.total_yield),
    daysCovered,
  };
}

/**
 * Sum all net flows between two timestamps (exclusive of fromTime, inclusive of toTime)
 * Used for calculating APY over longer windows
 */
export async function getTotalNetFlowsBetween(
  positionId: string,
  fromTime: Date,
  toTime: Date
): Promise<number> {
  const result = await queryOne<{ total_flows: string }>(
    `SELECT COALESCE(SUM(net_flows_usd), 0) as total_flows
     FROM position_snapshot
     WHERE position_id = $1 AND ts > $2 AND ts <= $3`,
    [positionId, fromTime, toTime]
  );

  return result ? parseFloat(result.total_flows) : 0;
}

/**
 * Get the most recent reset snapshot for a position
 * Reset snapshots mark the start of a new APY tracking period (after partial exit/addition)
 * Returns null if no reset snapshot exists (using all historical data)
 */
export async function getMostRecentResetSnapshot(positionId: string): Promise<PositionSnapshot | null> {
  return queryOne<PositionSnapshot>(
    `SELECT * FROM position_snapshot
     WHERE position_id = $1 AND is_reset = true
     ORDER BY ts DESC
     LIMIT 1`,
    [positionId]
  );
}

/**
 * Get 4-hour APY values for a position
 * Returns the most recent 4 APY values (excluding resets)
 */
export async function get4hApyValues(positionId: string): Promise<number[]> {
  return getRecentApyValues(positionId, 4);
}
