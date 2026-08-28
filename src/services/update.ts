import { getAdapter } from '../plugins/registry';
import { BaseProtocolAdapter } from '../sdk/adapter';
import { Position, ProtocolKey, PositionSnapshot } from '../types';
import { getLatestSnapshot, createSnapshot, getTotalYieldSince, getSnapshotNearTime, getMostRecentResetSnapshot, getSnapshotsSince } from '../models/snapshot';
import { computeApy } from '../utils/apy';
import { archivePosition, updatePositionFutureIncomeProjection } from '../models/position';
import { sleep } from '../utils/async';
import { getPositionCategory } from '../utils/position-category';
import {
  UPDATE_SLEEP_MS,
  APY_MIN_WINDOW_MINUTES,
  APY_MIN_BASE_USD,
  APY_MIN_BASE_RATIO,
} from '../constants';
import {
  getUniswapIncomeForecast,
  isUniswapProtocol,
  UniswapProjectionMetadata,
} from './uniswap-income-forecast';

// Flow detection removed: with hourly updates, yield deltas are small enough that
// deposits/withdrawals are obvious from magnitude. No need for expensive event scanning.

export interface AbsoluteYieldMetrics {
  totalYield7d: number;
  avgDailyYield: number;
  projectedMonthlyYield: number;
  projectedYearlyYield: number;
}

export interface PositionMetrics {
  valueUsd: number;
  apy: number | null;
  apy7d: number | null;
  apy30d: number | null;
  lastUpdated: Date;
  shouldProjectFutureIncome: boolean;
  absoluteYield?: AbsoluteYieldMetrics;
  projection?: UniswapProjectionMetadata;
}

const SLOW_PROJECTION_CHECK_MS = 200;
const SLOW_POSITION_METRICS_MS = 500;

// Stale-rewards archive thresholds (Part 2 snapshot-history fallback).
const STALE_REWARD_WINDOW_HOURS = 24;
const STALE_REWARD_MIN_SNAPSHOTS = 6;

async function isStaleZeroValueRewards(positionId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - STALE_REWARD_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = await getSnapshotsSince(positionId, since);
  if (recent.length < STALE_REWARD_MIN_SNAPSHOTS) {
    return false;
  }
  return recent.every((snapshot) => parseFloat(snapshot.value_usd) === 0);
}

interface FutureIncomeProjectionMetadata {
  shouldProject: boolean;
  checkedAt?: string;
}

function getProtocolKeyFromPosition(position?: Position): string | undefined {
  if (!position) {
    return undefined;
  }

  const metadata = position.metadata as Record<string, unknown>;
  const metadataProtocolKey = typeof metadata.protocolKey === 'string' ? metadata.protocolKey : undefined;
  const row = position as Position & { protocol_key?: string; protocolKey?: string };
  const rowProtocolKey = row.protocol_key || row.protocolKey;

  return metadataProtocolKey || rowProtocolKey;
}

function getCachedFutureIncomeProjection(position?: Position): boolean | null {
  if (!position || !position.metadata || typeof position.metadata !== 'object') {
    return null;
  }

  const metadata = position.metadata as Record<string, unknown>;
  const projection = metadata.futureIncomeProjection;
  if (!projection || typeof projection !== 'object') {
    return null;
  }

  const { shouldProject } = projection as FutureIncomeProjectionMetadata;
  return typeof shouldProject === 'boolean' ? shouldProject : null;
}

export async function refreshFutureIncomeProjection(
  position: Position,
  protocolKey: string,
  adapter: ReturnType<typeof getAdapter>
): Promise<boolean | null> {
  if (
    typeof adapter.shouldProjectFutureIncome !== 'function' ||
    adapter.shouldProjectFutureIncome === BaseProtocolAdapter.prototype.shouldProjectFutureIncome
  ) {
    return null;
  }

  try {
    const projectionCheckStart = Date.now();
    const shouldProjectFutureIncome = await adapter.shouldProjectFutureIncome(position);
    const projectionCheckDurationMs = Date.now() - projectionCheckStart;
    if (projectionCheckDurationMs >= SLOW_PROJECTION_CHECK_MS) {
      console.warn(
        `[metrics] Slow future-income projection check for ${position.id} (${protocolKey}): ${projectionCheckDurationMs}ms`
      );
    }

    await updatePositionFutureIncomeProjection(position.id, shouldProjectFutureIncome, new Date());
    return shouldProjectFutureIncome;
  } catch (error) {
    console.warn(
      `[metrics] Failed to refresh future-income projection status for ${position.id} (${protocolKey}):`,
      error
    );
    return null;
  }
}


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
  const protocolKey = getProtocolKeyFromPosition(position);
  if (!protocolKey) {
    console.error(`Position ${position.id} (${position.displayName}) missing protocol key. Metadata:`, JSON.stringify(position.metadata));
    return;
  }

  console.log(`Updating position ${position.id} (${position.displayName}) with protocol ${protocolKey}`);

  const adapter = getAdapter(protocolKey as ProtocolKey);
  const positionCategory = getPositionCategory(position.measureMethod);
  // Capture a reference time for calculations; we'll stamp the snapshot with the actual write time
  const calcStartTime = new Date();

  const maybeArchiveClosedRewardPosition = async (currentValue: number | null): Promise<boolean> => {
    if (positionCategory !== 'rewards' || typeof adapter.isPositionClosed !== 'function') {
      return false;
    }

    // Keep this check lightweight: only probe closure when value is near-zero
    // (or value fetch failed and we have no value at all).
    if (currentValue !== null && currentValue >= 1.0) {
      return false;
    }

    try {
      const isClosed = await adapter.isPositionClosed(position);
      if (isClosed) {
        console.log(`  Reward position is terminally closed - archiving position`);
        await archivePosition(position.id, 'complete_exit');
        return true;
      }
    } catch (closeCheckError) {
      // Failures here keep stuck-but-closed positions alive forever, so log
      // loudly with enough context to triage. Conservative path: don't archive
      // on uncertainty; rely on the snapshot-history fallback in CASE 1.
      console.error(
        `  Failed to verify reward position closure for ${position.id} ` +
        `(protocol=${protocolKey}, currentValue=${currentValue}):`,
        closeCheckError
      );
    }

    return false;
  };

  try {
    // Get current value
    const currentValue = await adapter.readCurrentValue(position);

    // Get latest snapshot (for recent net flow detection)
    const latestSnapshot = await getLatestSnapshot(position.id);

    // Rewards positions can be legitimately $0 after claim.
    // Archive only if adapter confirms the position is truly closed.
    if (await maybeArchiveClosedRewardPosition(currentValue)) {
      return;
    }

    await refreshFutureIncomeProjection(position, protocolKey, adapter);

    // CASE 1: Complete Exit Detection (value < $10 threshold)
    if (currentValue < 10 && latestSnapshot) {
      // Reward positions: zero value is normal (rewards claimed)
      if (positionCategory === 'rewards') {
        // Safety net for the on-chain closure probe: if a rewards position has
        // been at $0 for the full STALE_REWARD_WINDOW_HOURS window, archive it
        // regardless of whether isPositionClosed could confirm closure. This
        // catches NFTs whose closure probe keeps failing on transient RPC
        // errors, and abandoned positions with dust liquidity sitting in the
        // pool. Requires a minimum snapshot count so we don't archive newly
        // discovered positions before they've had a chance to accrue.
        if (currentValue === 0 && await isStaleZeroValueRewards(position.id, calcStartTime)) {
          console.log(
            `  Reward position at $0 for >=${STALE_REWARD_WINDOW_HOURS}h ` +
            `(min ${STALE_REWARD_MIN_SNAPSHOTS} snapshots) - archiving as stale`
          );
          await archivePosition(position.id, 'complete_exit');
          return;
        }
        console.log(`  Reward position at $${currentValue.toFixed(2)} (rewards claimed) - creating normal snapshot`);
        await createSnapshot(position.id, new Date(), currentValue, 0, 0, null);
        return;
      }

      // Principal positions: RPC successfully returned near-zero balance -> archive
      // If RPC had failed, it would have thrown an error caught by try-catch below
      const previousValue = parseFloat(latestSnapshot.value_usd);
      console.log(`  Complete exit detected (value $${currentValue.toFixed(2)} < $10 threshold, previous: $${previousValue.toFixed(2)}) - archiving position`);
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
    if (positionCategory === 'rewards') {
      const latestValue = parseFloat(latestSnapshot.value_usd);
      // A rewards position tracks currently claimable stablecoin fees, not
      // cumulative earnings. A decrease means rewards were claimed; it is not
      // negative yield. Earnings that accrued between the previous snapshot
      // and the claim cannot be recovered without transaction-level flow data,
      // so record a conservative zero for that interval.
      const yieldDeltaUsd = Math.max(0, currentValue - latestValue);

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
    // Value changed >0.1% → must be deposit/withdrawal (no yield can be that high in 1 hour)
    // 0.1% threshold provides safety margin above observed natural volatility (fxSAVE: 0.059% worst case)
    // Skip this check for fixed-income positions which use accrual-based valuation (no market volatility)
    const previousValue = parseFloat(latestSnapshot.value_usd);
    const valueChange = currentValue - previousValue;
    const relativeChange = Math.abs(valueChange) / Math.max(previousValue, 1);

    if (positionCategory !== 'fixed-income' && relativeChange > 0.001) {
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
    // If value read fails for a rewards position (e.g., burned NFT),
    // attempt terminal-close detection before giving up.
    if (await maybeArchiveClosedRewardPosition(null)) {
      return;
    }
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
 * Compute yield-to-maturity APY for a fixed-income (Pendle PT) position.
 *
 * YTM = annualized return from current accrued price to $1.00 at maturity.
 * Formula: (1.0 / currentAccruedPrice)^(365 / daysRemaining) - 1
 */
function computeFixedIncomeYtm(position: Position): number | null {
  const { initialPtPrice, discoveryTime, maturityDate } = position.metadata;
  if (!initialPtPrice || !discoveryTime || !maturityDate) return null;

  const now = Date.now();
  const maturity = new Date(maturityDate).getTime();
  if (now >= maturity) return 0;

  const discovery = new Date(discoveryTime).getTime();
  const totalDuration = maturity - discovery;
  const elapsed = now - discovery;
  const progress = elapsed > 0 ? Math.min(elapsed / totalDuration, 1.0) : 0;

  const currentAccruedPrice = initialPtPrice + (1.0 - initialPtPrice) * progress;
  if (currentAccruedPrice >= 1.0) return 0;

  const daysRemaining = (maturity - now) / (1000 * 60 * 60 * 24);
  if (daysRemaining <= 0) return 0;

  const totalReturn = (1.0 - currentAccruedPrice) / currentAccruedPrice;
  return Math.pow(1 + totalReturn, 365 / daysRemaining) - 1;
}

/**
 * Get current metrics for a position including windowed APYs
 * For reward-based positions, also includes absolute yield metrics
 */
export async function getPositionMetrics(positionId: string, position?: Position): Promise<PositionMetrics | null> {
  const metricsStart = Date.now();
  const latestSnapshot = await getLatestSnapshot(positionId);

  if (!latestSnapshot) {
    return null;
  }

  // Check if this is a reward-based position (volatile principal, stable yield)
  const isRewardBased = getPositionCategory(position?.measureMethod ?? '') === 'rewards';
  const protocolKey = getProtocolKeyFromPosition(position);

  let absoluteYieldMetrics: AbsoluteYieldMetrics | undefined;
  let projection: UniswapProjectionMetadata | undefined;

  if (isRewardBased) {
    // For reward positions, calculate absolute earnings rate
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const yieldHistory = await getTotalYieldSince(positionId, sevenDaysAgo, {
      // Historical snapshots may contain claim events recorded as negative
      // deltas. They are withdrawals of accrued rewards, never negative yield.
      positiveOnly: true,
    });

    if (isUniswapProtocol(protocolKey) && position && protocolKey) {
      const forecast = await getUniswapIncomeForecast(position, protocolKey, new Date(latestSnapshot.ts));
      const totalYieldUsd = Math.max(0, yieldHistory.totalYieldUsd);
      const observedDailyYield = yieldHistory.daysCovered > 0
        ? totalYieldUsd / yieldHistory.daysCovered
        : 0;
      absoluteYieldMetrics = {
        totalYield7d: totalYieldUsd,
        avgDailyYield: observedDailyYield,
        projectedMonthlyYield: forecast.dailyRateUsd * 30,
        projectedYearlyYield: forecast.dailyRateUsd * 365,
      };
      projection = forecast.metadata;
    } else if (yieldHistory.daysCovered > 0) {
      // Preserve the rewards-category invariant at the service boundary too,
      // even if malformed or legacy data reaches this path.
      const totalYieldUsd = Math.max(0, yieldHistory.totalYieldUsd);
      const dailyAvgYield = totalYieldUsd / yieldHistory.daysCovered;

      absoluteYieldMetrics = {
        totalYield7d: totalYieldUsd,
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
  ): Promise<{ apy: number; windowHours: number } | null> {
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
    return { apy: r.apy, windowHours };
  }

  // Skip APY calculations for reward-based positions (they use absolute yield metrics instead)
  let apy = null;
  let apy7d = null;
  let apy30d = null;
  const cachedProjection = getCachedFutureIncomeProjection(position);
  const shouldProjectFutureIncome = cachedProjection ?? true;

  const isFixedIncome = getPositionCategory(position?.measureMethod ?? '') === 'fixed-income';

  if (isFixedIncome && position) {
    // For fixed-maturity instruments (e.g. Pendle PT), yield-to-maturity is the correct metric.
    // It is deterministic, always positive before maturity, and unaffected by snapshot history.
    // All three windows return the same value — the guaranteed annualized return to maturity.
    const ytm = computeFixedIncomeYtm(position);
    apy = ytm;
    apy7d = ytm;
    apy30d = ytm;
  } else if (!isRewardBased) {
    // Two‑point APYs: 4h ("recent"), 7d, 30d — each compares latest vs nearest snapshot to target
    const result4h = await computeApyBetween(latestSnapshot, 4 * 60 * 60 * 1000, 59);
    const result7d = await computeApyBetween(latestSnapshot, 7 * 24 * 60 * 60 * 1000, 59);
    const result30d = await computeApyBetween(latestSnapshot, 30 * 24 * 60 * 60 * 1000, 59);

    // Time-based visibility rules:
    // - Always show 4h APY (no restrictions)
    // - Only show 7d APY if we have more than 1 day (24 hours) of data
    // - Only show 30d APY if we have more than 10 days (240 hours) of data
    apy = result4h?.apy ?? null;
    apy7d = (result7d && result7d.windowHours > 24) ? result7d.apy : null;
    apy30d = (result30d && result30d.windowHours > 240) ? result30d.apy : null;
  }

  const result: PositionMetrics = {
    valueUsd: parseFloat(latestSnapshot.value_usd),
    apy,
    apy7d,
    apy30d,
    lastUpdated: latestSnapshot.ts,
    shouldProjectFutureIncome,
    // Include absolute yield metrics for reward-based positions
    ...(absoluteYieldMetrics && { absoluteYield: absoluteYieldMetrics }),
    ...(projection && { projection }),
  };

  const metricsDurationMs = Date.now() - metricsStart;
  if (metricsDurationMs >= SLOW_POSITION_METRICS_MS) {
    console.warn(
      `[metrics] Slow getPositionMetrics for ${positionId} (${protocolKey ?? 'unknown'}): ${metricsDurationMs}ms`
    );
  }

  return result;
}
