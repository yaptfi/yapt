import { query } from '../utils/db';

export interface UniswapRewardSnapshotRow {
  positionId: string;
  protocolKey: string;
  measureMethod: string;
  metadata: Record<string, unknown>;
  ts: Date;
  valueUsd: number;
  yieldDeltaUsd: number;
}

export interface UniswapFeeSnapshotRow {
  ts: Date;
  valueUsd: number;
}

interface UniswapRewardSnapshotDbRow {
  positionId: string;
  protocolKey: string;
  measureMethod: string;
  metadata: Record<string, unknown>;
  ts: Date;
  valueUsd: string;
  yieldDeltaUsd: string;
}

interface UniswapFeeSnapshotDbRow {
  ts: Date;
  valueUsd: string;
}

/** Load one position's live forecast window plus its immediately prior baseline. */
export async function getPositionUniswapFeeSnapshotHistory(
  positionId: string,
  from: Date,
  to: Date
): Promise<UniswapFeeSnapshotRow[]> {
  const rows = await query<UniswapFeeSnapshotDbRow>(
    `WITH window_snapshots AS (
       SELECT ts, value_usd AS "valueUsd"
       FROM position_snapshot
       WHERE position_id = $1 AND ts >= $2 AND ts <= $3
     ),
     prior_snapshot AS (
       SELECT ts, value_usd AS "valueUsd"
       FROM position_snapshot
       WHERE position_id = $1 AND ts < $2
       ORDER BY ts DESC
       LIMIT 1
     )
     SELECT * FROM window_snapshots
     UNION ALL
     SELECT * FROM prior_snapshot
     ORDER BY ts ASC`,
    [positionId, from, to]
  );

  return rows.map((row) => ({
    ts: row.ts,
    valueUsd: parseFloat(row.valueUsd),
  }));
}

/**
 * Load Uniswap snapshots for forecasting, including the last snapshot before
 * the requested window so the first interval can be measured accurately.
 * Active and archived positions are intentionally combined for cohort learning.
 */
export async function getUniswapRewardSnapshotHistory(
  from: Date,
  to: Date
): Promise<UniswapRewardSnapshotRow[]> {
  const rows = await query<UniswapRewardSnapshotDbRow>(
    `WITH all_snapshots AS (
       SELECT
         p.id AS "positionId",
         pr.key AS "protocolKey",
         p.measure_method AS "measureMethod",
         p.metadata,
         ps.ts,
         ps.value_usd AS "valueUsd",
         ps.yield_delta_usd AS "yieldDeltaUsd"
       FROM position p
       JOIN protocol pr ON pr.id = p.protocol_id
       JOIN position_snapshot ps ON ps.position_id = p.id
       WHERE LOWER(pr.key) LIKE 'uniswap-%'

       UNION ALL

       SELECT
         pa.id AS "positionId",
         pr.key AS "protocolKey",
         pa.measure_method AS "measureMethod",
         pa.metadata,
         psa.ts,
         psa.value_usd AS "valueUsd",
         psa.yield_delta_usd AS "yieldDeltaUsd"
       FROM position_archive pa
       JOIN protocol pr ON pr.id = pa.protocol_id
       JOIN position_snapshot_archive psa ON psa.position_id = pa.id
       WHERE LOWER(pr.key) LIKE 'uniswap-%'
     ),
     window_snapshots AS (
       SELECT *
       FROM all_snapshots
       WHERE ts >= $1 AND ts <= $2
     ),
     prior_snapshots AS (
       SELECT DISTINCT ON ("positionId") *
       FROM all_snapshots
       WHERE ts < $1
       ORDER BY "positionId", ts DESC
     )
     SELECT * FROM window_snapshots
     UNION ALL
     SELECT * FROM prior_snapshots
     ORDER BY "positionId", ts ASC`,
    [from, to]
  );

  return rows.map((row) => ({
    ...row,
    valueUsd: parseFloat(row.valueUsd),
    yieldDeltaUsd: parseFloat(row.yieldDeltaUsd),
  }));
}
