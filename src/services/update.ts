import { getAdapter } from '../plugins/registry';
import { Position, ProtocolKey, PositionSnapshot } from '../types';
import { getLatestSnapshot, createSnapshot, getTotalYieldSince, getSnapshotNearTime, getMostRecentResetSnapshot } from '../models/snapshot';
import { computeApy } from '../utils/apy';
import { archivePosition } from '../models/position';
import {
  UPDATE_SLEEP_MS,
  APY_MIN_WINDOW_MINUTES,
  APY_MIN_BASE_USD,
  APY_MIN_BASE_RATIO,
} from '../constants';

/**
 * Sleep utility for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Flow detection removed: with hourly updates, yield deltas are small enough that
// deposits/withdrawals are obvious from magnitude. No need for expensive event scanning.


/**
 * Create a reset snapshot to mark the start of a new APY tracking period
 *
 * Reset snapshots are created when a position has a significant change
 * (partial exit or addition) that would corrupt APY calculations.
 *
 * @param positionId - Position ID
 * @param currentValue - Current value in USD (new baseline)
 * @param changeType - Type of change ('exit' for partial exit, 'addition' for position addition)
 */
async function createResetSnapshot(
  positionId: string,
  currentValue: number,
  changeType: 'exit' | 'addition'
): Promise<void> {
  const now = new Date();

  // Create snapshot with reset flag
  await createSnapshot(
    positionId,
    now,
    currentValue,
    0,           // netFlows = 0 (reset baseline)
    0,           // yieldDelta = 0 (no yield to measure yet)
    null,        // apy = null (no previous data)
    true         // is_reset = true
  );

  console.log(
    `Created reset snapshot for position ${positionId} (${changeType}: $${currentValue.toFixed(2)})`
  );
}

/**
 * Update a single position - fetch current value, compute flows, calculate APY
 * Handles complete exits, partial exits, and position additions
 * APY is calculated using a 4-hour lookback window for stability
 */
export async function updatePosition(position: Position): Promise<void> {
  const protocolKey = position.metadata.protocolKey || (position as any).protocol_key;
  if (!protocolKey) {
    console.error(`Position ${position.id} (${position.displayName}) missing protocol key. Metadata:`, JSON.stringify(position.metadata));
    return;
  }

  console.log(`Updating position ${position.id} (${position.displayName}) with protocol ${protocolKey}`);

  const adapter = getAdapter(protocolKey as ProtocolKey);
  // Capture a reference time for calculations; we'll stamp the snapshot with the actual write time
  const calcStartTime = new Date();

  try {
    // Get current value
    const currentValue = await adapter.readCurrentValue(position);

    // Get latest snapshot (for recent net flow detection)
    const latestSnapshot = await getLatestSnapshot(position.id);

    // CASE 1: Complete Exit Detection (value = $0)
    if (currentValue === 0 && latestSnapshot) {
      // Reward positions: zero value is normal (rewards claimed)
      if (position.measureMethod === 'rewards') {
        console.log(`  Reward position at $0 (rewards claimed) - creating normal snapshot`);
        await createSnapshot(position.id, new Date(), 0, 0, 0, null);
        return;
      }

      // Principal positions: RPC successfully returned zero balance -> archive immediately
      // (If RPC had failed, it would have thrown an error caught by try-catch above)
      console.log(`  Complete exit detected (verified zero balance) - archiving position`);
      await archivePosition(position.id, 'complete_exit');
      return;
    }

    // CASE 2: No previous snapshot - create initial snapshot
    if (!latestSnapshot) {
      console.log(`  Creating initial snapshot`);
      await createSnapshot(position.id, new Date(), currentValue, 0, 0, null);
      return;
    }

    // CASE 3: Reward positions – record yield-only snapshot with APY disabled
    if (position.measureMethod === 'rewards') {
      const latestValue = parseFloat(latestSnapshot.value_usd);
      const yieldDeltaUsd = currentValue - latestValue;

      await createSnapshot(
        position.id,
        new Date(),
        currentValue,
        0, // No flow detection needed with hourly updates
        yieldDeltaUsd,
        null, // APY disabled for rewards
        false
      );
      console.log(`Updated reward position ${position.id} (${position.displayName}): $${currentValue.toFixed(2)} (APY: N/A)`);
      return;
    }

    // CASE 4: Check for significant value changes (partial exit or addition)
    // Value changed >2% → must be deposit/withdrawal (no yield can be that high)
    const previousValue = parseFloat(latestSnapshot.value_usd);
    const valueChange = currentValue - previousValue;
    const relativeChange = Math.abs(valueChange) / Math.max(previousValue, 1);

    if (relativeChange > 0.02) {
      const changeType = valueChange > 0 ? 'addition' : 'exit';
      console.log(
        `  Significant ${changeType} detected: ` +
        `$${previousValue.toFixed(2)} → $${currentValue.toFixed(2)} (${(relativeChange * 100).toFixed(1)}%)`
      );
      await createResetSnapshot(position.id, currentValue, changeType);
      return;
    }

    // CASE 5: Normal update - simple value tracking with hourly updates
    // No flow detection needed - with hourly updates, deposits/withdrawals are obvious from magnitude

    // Get most recent reset snapshot to respect reset boundaries
    const mostRecentReset = await getMostRecentResetSnapshot(position.id);

    // Get snapshot closest to 4 hours ago (for APY calculation)
    const fourHoursAgo = new Date(calcStartTime.getTime() - 4 * 60 * 60 * 1000);
    const refSnapshot = await getSnapshotNearTime(position.id, fourHoursAgo, 59 / 60);

    // For APY calculation, use 4-hour reference snapshot if available
    // But ensure it's after the most recent reset
    let apyRefSnapshot = refSnapshot || latestSnapshot;
    if (mostRecentReset) {
      const resetTime = new Date(mostRecentReset.ts);
      const refTime = new Date(apyRefSnapshot.ts);

      // If reference snapshot is before reset, use the snapshot right after reset
      if (refTime < resetTime) {
        console.log(`  Reference snapshot is before reset, using post-reset baseline`);
        apyRefSnapshot = mostRecentReset;
      }
    }

    const refValue = parseFloat(apyRefSnapshot.value_usd);
    const refTime = new Date(apyRefSnapshot.ts);
    const elapsedMs = calcStartTime.getTime() - refTime.getTime();
    const elapsedMinutes = elapsedMs / (1000 * 60);

    let yieldDeltaUsd = 0;
    let apy: number | null = null;

    // Only compute APY if sufficient time has elapsed
    if (elapsedMinutes >= APY_MIN_WINDOW_MINUTES) {
      const windowHours = elapsedMinutes / 60;

      // With hourly updates and no deposits/withdrawals, flows are always 0
      // APY calculation simplified: just compare current value to reference value
      const apyResult = computeApy(currentValue, refValue, 0, windowHours);

      // Yield delta is calculated from latest snapshot (this hour's yield)
      const latestValue = parseFloat(latestSnapshot.value_usd);
      yieldDeltaUsd = currentValue - latestValue;

      apy = apyResult.apy;

      if (refSnapshot && refSnapshot !== latestSnapshot) {
        console.log(`  APY calculated using ${windowHours.toFixed(1)}h window (4h lookback)`);
      }
    } else {
      // Still compute yield delta without APY update
      const latestValue = parseFloat(latestSnapshot.value_usd);
      yieldDeltaUsd = currentValue - latestValue;
      apy = null;
    }

    // Create new snapshot (normal, not a reset)
    await createSnapshot(
      position.id,
      new Date(),
      currentValue,
      0, // No flow detection with hourly updates
      yieldDeltaUsd,
      apy,
      false  // is_reset = false
    );

    console.log(`Updated position ${position.id} (${position.displayName}): $${currentValue.toFixed(2)}, APY: ${apy ? (apy * 100).toFixed(2) + '%' : 'N/A'}`);
  } catch (error) {
    console.error(`Failed to update position ${position.id}:`, error);
  }
}

/**
 * Update all positions for a wallet
 * Rate-limited to 1 position per second to respect RPC provider limits
 */
export async function updateWallet(walletId: string, positions: Position[]): Promise<void> {
  console.log(`Updating ${positions.length} positions for wallet ${walletId} (rate-limited: 1 position/second)`);

  for (let i = 0; i < positions.length; i++) {
    const position = positions[i];

    if (position.isActive) {
      await updatePosition(position);

      // Add delay between positions to respect RPC rate limits
      // Skip delay after the last position
      if (i < positions.length - 1) {
        await sleep(UPDATE_SLEEP_MS);
      }
    }
  }

  console.log(`Completed updating ${positions.length} positions for wallet ${walletId}`);
}

/**
 * Get current metrics for a position including windowed APYs
 * For reward-based positions, also includes absolute yield metrics
 */
export async function getPositionMetrics(positionId: string, position?: Position) {
  const latestSnapshot = await getLatestSnapshot(positionId);

  if (!latestSnapshot) {
    return null;
  }

  // Check if this is a reward-based position (volatile principal, stable yield)
  const isRewardBased = position?.measureMethod === 'rewards';

  let absoluteYieldMetrics = null;

  if (isRewardBased) {
    // For reward positions, calculate absolute earnings rate
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Special handling for convex-cvxcrv: exclude low-value snapshots (after reward claims)
    // to maintain stable projected income
    const protocolKey = position?.metadata?.protocolKey as string;
    const isConvexCvxCrv = protocolKey === 'convex-cvxcrv';
    const currentValue = parseFloat(latestSnapshot.value_usd);

    let yieldHistory;
    if (isConvexCvxCrv && currentValue < 1.0) {
      // After reward claim: calculate projections using only snapshots with value >= $1
      // This preserves the pre-claim income projection
      const { queryOne } = await import('../utils/db');
      const result = await queryOne<{ total_yield: string; first_ts: Date; last_ts: Date }>(
        `SELECT
          COALESCE(SUM(yield_delta_usd), 0) as total_yield,
          MIN(ts) as first_ts,
          MAX(ts) as last_ts
         FROM position_snapshot
         WHERE position_id = $1 AND ts >= $2 AND value_usd >= 1.0`,
        [positionId, sevenDaysAgo]
      );

      if (result && result.first_ts && result.last_ts) {
        const daysCovered = (result.last_ts.getTime() - result.first_ts.getTime()) / (1000 * 60 * 60 * 24);
        yieldHistory = {
          totalYieldUsd: parseFloat(result.total_yield),
          daysCovered,
        };
      } else {
        yieldHistory = { totalYieldUsd: 0, daysCovered: 0 };
      }
    } else {
      // Normal calculation for other reward positions
      yieldHistory = await getTotalYieldSince(positionId, sevenDaysAgo);
    }

    if (yieldHistory.daysCovered > 0) {
      const dailyAvgYield = yieldHistory.totalYieldUsd / yieldHistory.daysCovered;

      absoluteYieldMetrics = {
        totalYield7d: yieldHistory.totalYieldUsd,
        avgDailyYield: dailyAvgYield,
        projectedMonthlyYield: dailyAvgYield * 30,
        projectedYearlyYield: dailyAvgYield * 365,
      };
    }
  }

  // Helper to compute APY between two snapshots (two‑point method)
  async function computeApyBetween(
    latest: PositionSnapshot,
    targetAgoMs: number,
    minAgeMinutes = 59
  ): Promise<number | null> {
    const nowTs = new Date(latest.ts).getTime();
    const targetTime = new Date(nowTs - targetAgoMs);
    // Nearest snapshot to the target time
    const candidate = await getSnapshotNearTime(positionId, targetTime, minAgeMinutes / 60);
    if (!candidate) return null;

    // If there's a reset after the candidate reference, anchor at the reset to avoid
    // crossing large partial exits/additions that invalidate longer-window APY.
    const mostRecentReset = await getMostRecentResetSnapshot(positionId);
    const toTime = new Date(latest.ts);
    let fromSnapshot = candidate;
    if (mostRecentReset && new Date(mostRecentReset.ts) > new Date(candidate.ts)) {
      fromSnapshot = mostRecentReset;
    }

    const fromTime = new Date(fromSnapshot.ts);
    // Ensure minimum window length
    if (toTime.getTime() - fromTime.getTime() < minAgeMinutes * 60 * 1000) {
      return null;
    }

    const refValue = parseFloat(fromSnapshot.value_usd);
    const curValue = parseFloat(latest.value_usd);
    // No flow tracking needed with hourly updates
    const flows = 0;

    // Compute base and guard against near-zero base (which causes absurd APYs)
    const base = refValue + flows;
    const minBase = Math.max(APY_MIN_BASE_USD, curValue * APY_MIN_BASE_RATIO);
    if (base <= 0 || base < minBase) {
      return null;
    }

    const windowHours = (toTime.getTime() - fromTime.getTime()) / (1000 * 60 * 60);

    // Debug logging for troubleshooting
    if (windowHours < 1 || windowHours > 8760) {
      console.warn(
        `[computeApyBetween] Unusual window detected:\n` +
        `  windowHours=${windowHours}\n` +
        `  toTime=${toTime.toISOString()}, fromTime=${fromTime.toISOString()}\n` +
        `  curValue=${curValue}, refValue=${refValue}, flows=${flows}`
      );
    }

    const r = computeApy(curValue, refValue, flows, windowHours);
    return r.apy;
  }

  // Two‑point APYs: 4h ("recent"), 7d, 30d — each compares latest vs nearest snapshot to target
  const apy4h = await computeApyBetween(latestSnapshot, 4 * 60 * 60 * 1000, 59);
  const apy7dRaw = await computeApyBetween(latestSnapshot, 7 * 24 * 60 * 60 * 1000, 59);
  const apy30dRaw = await computeApyBetween(latestSnapshot, 30 * 24 * 60 * 60 * 1000, 59);

  // Hide redundant values: 7d only if different from 4h (rounded to 2 decimals in percent)
  // 30d only if different from displayed 7d (or 4h if 7d hidden)
  const sameRounded = (a: number | null, b: number | null) => {
    if (a == null || b == null) return false;
    const pa = +(a * 100).toFixed(2);
    const pb = +(b * 100).toFixed(2);
    return pa === pb;
  };

  const apy = apy4h ?? null;
  let apy7d: number | null = apy7dRaw ?? null;
  if (sameRounded(apy7d, apy)) apy7d = null;
  let apy30d: number | null = apy30dRaw ?? null;
  const compareBasis = apy7d ?? apy;
  if (sameRounded(apy30d, compareBasis)) apy30d = null;

  return {
    valueUsd: parseFloat(latestSnapshot.value_usd),
    apy,
    apy7d,
    apy30d,
    lastUpdated: latestSnapshot.ts,
    // Include absolute yield metrics for reward-based positions
    ...(absoluteYieldMetrics && { absoluteYield: absoluteYieldMetrics }),
  };
}
