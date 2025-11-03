import { query, queryOne } from '../utils/db';

/**
 * Remove wallets that have no users watching them, along with their positions and snapshots.
 * Returns aggregate counts of deleted entities.
 */
export async function cleanupUntrackedWallets(): Promise<{
  deletedWallets: number;
  deletedPositions: number;
  deletedSnapshots: number;
}> {
  // Find wallets with zero user links
  const wallets = await query<{ id: string }>(
    `SELECT w.id
     FROM wallet w
     LEFT JOIN user_wallet uw ON w.id = uw.wallet_id
     WHERE uw.wallet_id IS NULL`
  );

  if (wallets.length === 0) {
    return { deletedWallets: 0, deletedPositions: 0, deletedSnapshots: 0 };
  }

  let totalDeletedSnapshots = 0;
  let totalDeletedPositions = 0;
  let totalDeletedWallets = 0;

  for (const w of wallets) {
    // Compute counts for logging (optional)
    const stats = await queryOne<{ positions: string; snapshots: string }>(
      `SELECT
         COUNT(DISTINCT p.id) as positions,
         COUNT(DISTINCT ps.id) as snapshots
       FROM wallet w
       LEFT JOIN position p ON w.id = p.wallet_id
       LEFT JOIN position_snapshot ps ON p.id = ps.position_id
       WHERE w.id = $1
       GROUP BY w.id`,
      [w.id]
    );

    await query('BEGIN');
    try {
      await query(
        `DELETE FROM position_snapshot
         WHERE position_id IN (SELECT id FROM position WHERE wallet_id = $1)`,
        [w.id]
      );
      await query('DELETE FROM position WHERE wallet_id = $1', [w.id]);
      await query('DELETE FROM user_wallet WHERE wallet_id = $1', [w.id]);
      await query('DELETE FROM wallet WHERE id = $1', [w.id]);
      await query('COMMIT');

      totalDeletedSnapshots += stats ? parseInt(stats.snapshots, 10) : 0;
      totalDeletedPositions += stats ? parseInt(stats.positions, 10) : 0;
      totalDeletedWallets += 1;
    } catch (err) {
      await query('ROLLBACK');
      // Soft-fail on one wallet, continue
      // eslint-disable-next-line no-console
      console.error(`[cleanup] Failed to remove wallet ${w.id}:`, err);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[cleanup] Removed ${totalDeletedWallets} untracked wallet(s), ` +
      `${totalDeletedPositions} position(s), ${totalDeletedSnapshots} snapshot(s)`
  );

  return {
    deletedWallets: totalDeletedWallets,
    deletedPositions: totalDeletedPositions,
    deletedSnapshots: totalDeletedSnapshots,
  };
}

