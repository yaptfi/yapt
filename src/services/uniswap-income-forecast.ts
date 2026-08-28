import {
  getPositionUniswapFeeSnapshotHistory,
  getUniswapRewardSnapshotHistory,
  UniswapFeeSnapshotRow,
  UniswapRewardSnapshotRow,
} from '../models/uniswap-income';
import { Position } from '../types';
import { getPositionCategory } from '../utils/position-category';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const POSITION_WINDOW_DAYS = 28;
const COHORT_WINDOW_DAYS = 84;
const MAX_INTERVAL_MS = 6 * HOUR_MS;
const POSITION_HALF_LIFE_DAYS = 14;
const COHORT_HALF_LIFE_DAYS = 28;
const PROFILE_CACHE_MS = HOUR_MS;
const MIN_CONTRIBUTOR_DAYS = 14;
const MIN_COHORT_OBSERVATIONS = 28;
const SPARSE_WEEKDAY_OBSERVATIONS = 8;
const MAD_SCALE = 1.4826;
const MAD_CLIP_MULTIPLIER = 3;

export type ProjectionMaturity = 'collecting' | 'early' | 'developing' | 'mature';
export type WeekdayProfileSource = 'pool' | 'uniswap' | 'neutral';

export interface UniswapProjectionMetadata {
  model: 'uniswap-weekday-v1';
  maturity: ProjectionMaturity;
  observedDays: number;
  weekdayProfileSource: WeekdayProfileSource;
}

export interface DailyFeeObservation {
  day: Date;
  weekday: number;
  earningsUsd: number;
  coverageDays: number;
  dailyRateUsd: number;
}

export interface WeekdayProfile {
  factors: [number, number, number, number, number, number, number];
  source: WeekdayProfileSource;
}

export interface UniswapIncomeForecast {
  dailyRateUsd: number;
  weightedMeanDailyRateUsd: number;
  conservativeDailyRateUsd: number;
  metadata: UniswapProjectionMetadata;
}

interface WeightedValue {
  value: number;
  weight: number;
}

interface ProfileCacheEntry {
  expiresAt: number;
  promise: Promise<WeekdayProfile>;
}

const NEUTRAL_FACTORS: WeekdayProfile['factors'] = [1, 1, 1, 1, 1, 1, 1];

let historyCache: {
  expiresAt: number;
  promise: Promise<UniswapRewardSnapshotRow[]>;
} | null = null;
const profileCache = new Map<string, ProfileCacheEntry>();
const positionHistoryCache = new Map<string, {
  expiresAt: number;
  promise: Promise<UniswapFeeSnapshotRow[]>;
}>();

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Convert claimable-balance snapshots into UTC-day fee observations. Claim
 * intervals, invalid values, and gaps too long to annualize are discarded.
 */
export function buildDailyFeeObservations(
  snapshots: Array<Pick<UniswapRewardSnapshotRow, 'ts' | 'valueUsd'>>,
  from: Date,
  to: Date
): DailyFeeObservation[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    return [];
  }

  const sorted = [...snapshots].sort((left, right) => left.ts.getTime() - right.ts.getTime());
  const daily = new Map<number, { earningsUsd: number; coverageDays: number }>();

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const startMs = previous.ts.getTime();
    const endMs = current.ts.getTime();
    const intervalMs = endMs - startMs;

    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      !isFiniteNonNegative(previous.valueUsd) ||
      !isFiniteNonNegative(current.valueUsd) ||
      intervalMs <= 0 ||
      intervalMs > MAX_INTERVAL_MS ||
      current.valueUsd < previous.valueUsd
    ) {
      continue;
    }

    const overlapStart = Math.max(startMs, fromMs);
    const overlapEnd = Math.min(endMs, toMs);
    if (overlapStart >= overlapEnd) {
      continue;
    }

    const intervalEarnings = current.valueUsd - previous.valueUsd;
    let segmentStart = overlapStart;
    while (segmentStart < overlapEnd) {
      const dayStart = utcDayStart(segmentStart);
      const segmentEnd = Math.min(overlapEnd, dayStart + DAY_MS);
      const segmentMs = segmentEnd - segmentStart;
      const existing = daily.get(dayStart) ?? { earningsUsd: 0, coverageDays: 0 };
      existing.earningsUsd += intervalEarnings * (segmentMs / intervalMs);
      existing.coverageDays += segmentMs / DAY_MS;
      daily.set(dayStart, existing);
      segmentStart = segmentEnd;
    }
  }

  return [...daily.entries()]
    .sort(([left], [right]) => left - right)
    .map(([dayStart, observation]) => ({
      day: new Date(dayStart),
      weekday: new Date(dayStart).getUTCDay(),
      earningsUsd: observation.earningsUsd,
      coverageDays: observation.coverageDays,
      dailyRateUsd: observation.earningsUsd / observation.coverageDays,
    }));
}

export function weightedQuantile(values: WeightedValue[], quantile: number): number {
  const valid = values
    .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0)
    .sort((left, right) => left.value - right.value);
  if (valid.length === 0) {
    return 0;
  }

  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  const target = Math.min(1, Math.max(0, quantile)) * totalWeight;
  let cumulative = 0;
  for (const entry of valid) {
    cumulative += entry.weight;
    if (cumulative >= target) {
      return entry.value;
    }
  }
  return valid[valid.length - 1].value;
}

function constrainedMeanOne(
  values: WeekdayProfile['factors']
): WeekdayProfile['factors'] {
  let low = 0.5 - Math.max(...values) - 1;
  let high = 1.5 - Math.min(...values) + 1;
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const offset = (low + high) / 2;
    const mean = values.reduce(
      (sum, value) => sum + Math.min(1.5, Math.max(0.5, value + offset)),
      0
    ) / 7;
    if (mean < 1) {
      low = offset;
    } else {
      high = offset;
    }
  }
  const offset = (low + high) / 2;
  return values.map((value) => Math.min(1.5, Math.max(0.5, value + offset))) as WeekdayProfile['factors'];
}

function getPoolIdentity(protocolKey: string, metadata: Record<string, unknown>): string {
  const candidates = [metadata.poolId, metadata.poolAddress];
  const pool = candidates.find((candidate) => typeof candidate === 'string' && candidate.length > 0);
  return `${protocolKey.toLowerCase()}|${typeof pool === 'string' ? pool.toLowerCase() : 'protocol'}`;
}

function groupRowsByPosition(
  rows: UniswapRewardSnapshotRow[]
): Map<string, UniswapRewardSnapshotRow[]> {
  const grouped = new Map<string, UniswapRewardSnapshotRow[]>();
  for (const row of rows) {
    if (getPositionCategory(row.measureMethod) !== 'rewards') {
      continue;
    }
    const existing = grouped.get(row.positionId) ?? [];
    existing.push(row);
    grouped.set(row.positionId, existing);
  }
  return grouped;
}

function calculateProfileForRows(
  rows: UniswapRewardSnapshotRow[],
  cutoff: Date
): WeekdayProfile['factors'] | null {
  const from = new Date(cutoff.getTime() - COHORT_WINDOW_DAYS * DAY_MS);
  const normalized: Array<WeightedValue & { weekday: number }> = [];

  for (const positionRows of groupRowsByPosition(rows).values()) {
    const observations = buildDailyFeeObservations(positionRows, from, cutoff);
    const observedDays = observations.reduce((sum, observation) => sum + observation.coverageDays, 0);
    if (observedDays < MIN_CONTRIBUTOR_DAYS - 1e-9) {
      continue;
    }

    const medianRate = weightedQuantile(
      observations.map((observation) => ({
        value: observation.dailyRateUsd,
        weight: observation.coverageDays,
      })),
      0.5
    );
    if (!Number.isFinite(medianRate) || medianRate <= 0) {
      continue;
    }

    for (const observation of observations) {
      const ageDays = Math.max(0, (cutoff.getTime() - (observation.day.getTime() + DAY_MS / 2)) / DAY_MS);
      normalized.push({
        weekday: observation.weekday,
        value: observation.dailyRateUsd / medianRate,
        weight: observation.coverageDays * Math.pow(0.5, ageDays / COHORT_HALF_LIFE_DAYS),
      });
    }
  }

  if (normalized.length < MIN_COHORT_OBSERVATIONS) {
    return null;
  }

  const rawFactors = NEUTRAL_FACTORS.map((_, weekday) => {
    const weekdayValues = normalized.filter((entry) => entry.weekday === weekday);
    if (weekdayValues.length === 0) {
      return null;
    }
    const median = weightedQuantile(weekdayValues, 0.5);
    const coverageWeight = weekdayValues.reduce((sum, entry) => sum + entry.weight, 0);
    const shrinkage = Math.min(1, coverageWeight / SPARSE_WEEKDAY_OBSERVATIONS);
    return 1 + (median - 1) * shrinkage;
  });
  if (rawFactors.some((factor) => factor === null)) {
    return null;
  }

  return constrainedMeanOne(rawFactors as WeekdayProfile['factors']);
}

export function selectWeekdayProfile(
  rows: UniswapRewardSnapshotRow[],
  protocolKey: string,
  metadata: Record<string, unknown>,
  cutoff: Date
): WeekdayProfile {
  const targetPool = getPoolIdentity(protocolKey, metadata);
  const poolRows = rows.filter(
    (row) => getPoolIdentity(row.protocolKey, row.metadata) === targetPool
  );
  const poolFactors = calculateProfileForRows(poolRows, cutoff);
  if (poolFactors) {
    return { factors: poolFactors, source: 'pool' };
  }

  const uniswapFactors = calculateProfileForRows(rows, cutoff);
  if (uniswapFactors) {
    return { factors: uniswapFactors, source: 'uniswap' };
  }

  return { factors: [...NEUTRAL_FACTORS], source: 'neutral' };
}

export function winsorizeRates(
  rates: WeightedValue[],
  observedDays: number
): WeightedValue[] {
  if (observedDays < 3 || rates.length < 3) {
    return rates.map((entry) => ({ ...entry }));
  }

  const median = weightedQuantile(rates, 0.5);
  const mad = weightedQuantile(
    rates.map((entry) => ({ value: Math.abs(entry.value - median), weight: entry.weight })),
    0.5
  );
  const spread = MAD_CLIP_MULTIPLIER * MAD_SCALE * mad;
  const lower = Math.max(0, median - spread);
  const upper = median + spread;

  return rates.map((entry) => ({
    value: Math.min(upper, Math.max(lower, entry.value)),
    weight: entry.weight,
  }));
}

export function getProjectionMaturity(
  observations: DailyFeeObservation[]
): ProjectionMaturity {
  const observedDays = observations.reduce((sum, observation) => sum + observation.coverageDays, 0);
  if (observedDays === 0) {
    return 'collecting';
  }
  if (observedDays < 2 - 1e-9) {
    return 'early';
  }

  const weekdayCounts = NEUTRAL_FACTORS.map((_, weekday) =>
    observations.filter((observation) => observation.weekday === weekday).length
  );
  if (observedDays < 28 - 1e-9 || weekdayCounts.some((count) => count < 3)) {
    return 'developing';
  }
  return 'mature';
}

export function calculateUniswapIncomeForecast(
  positionRows: Array<Pick<UniswapRewardSnapshotRow, 'ts' | 'valueUsd'>>,
  profile: WeekdayProfile,
  cutoff: Date
): UniswapIncomeForecast {
  const from = new Date(cutoff.getTime() - POSITION_WINDOW_DAYS * DAY_MS);
  const observations = buildDailyFeeObservations(positionRows, from, cutoff);
  const observedDays = observations.reduce((sum, observation) => sum + observation.coverageDays, 0);
  const maturity = getProjectionMaturity(observations);
  const metadata: UniswapProjectionMetadata = {
    model: 'uniswap-weekday-v1',
    maturity,
    observedDays,
    weekdayProfileSource: profile.source,
  };

  if (observedDays === 0) {
    return {
      dailyRateUsd: 0,
      weightedMeanDailyRateUsd: 0,
      conservativeDailyRateUsd: 0,
      metadata,
    };
  }

  const rates = observations.map((observation) => {
    const ageDays = Math.max(0, (cutoff.getTime() - (observation.day.getTime() + DAY_MS / 2)) / DAY_MS);
    return {
      value: observation.dailyRateUsd / profile.factors[observation.weekday],
      weight: observation.coverageDays * Math.pow(0.5, ageDays / POSITION_HALF_LIFE_DAYS),
    };
  });
  const clippedRates = winsorizeRates(rates, observedDays);
  const totalWeight = clippedRates.reduce((sum, entry) => sum + entry.weight, 0);
  const weightedMean = totalWeight === 0
    ? 0
    : clippedRates.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / totalWeight;
  const conservative = weightedQuantile(clippedRates, 0.25);
  const conservativeBlend = Math.min(1, Math.max(0, (observedDays - 1) / 13));
  const dailyRate = weightedMean + (conservative - weightedMean) * conservativeBlend;

  return {
    dailyRateUsd: Math.max(0, dailyRate),
    weightedMeanDailyRateUsd: Math.max(0, weightedMean),
    conservativeDailyRateUsd: Math.max(0, conservative),
    metadata,
  };
}

async function getCachedPositionHistory(
  positionId: string,
  cutoff: Date
): Promise<UniswapFeeSnapshotRow[]> {
  const key = `${positionId}|${cutoff.toISOString()}`;
  const cacheNow = Date.now();
  const cached = positionHistoryCache.get(key);
  if (cached && cached.expiresAt > cacheNow) {
    return cached.promise;
  }

  const from = new Date(cutoff.getTime() - POSITION_WINDOW_DAYS * DAY_MS);
  const promise = getPositionUniswapFeeSnapshotHistory(positionId, from, cutoff);
  positionHistoryCache.set(key, { expiresAt: cacheNow + PROFILE_CACHE_MS, promise });
  promise.catch(() => {
    if (positionHistoryCache.get(key)?.promise === promise) {
      positionHistoryCache.delete(key);
    }
  });

  for (const [cachedKey, entry] of positionHistoryCache) {
    if (entry.expiresAt <= cacheNow) {
      positionHistoryCache.delete(cachedKey);
    }
  }
  return promise;
}

async function getCachedHistory(now: Date): Promise<UniswapRewardSnapshotRow[]> {
  const cacheNow = Date.now();
  if (historyCache && historyCache.expiresAt > cacheNow) {
    return historyCache.promise;
  }

  const from = new Date(now.getTime() - COHORT_WINDOW_DAYS * DAY_MS);
  const promise = getUniswapRewardSnapshotHistory(from, now);
  historyCache = { expiresAt: cacheNow + PROFILE_CACHE_MS, promise };
  promise.catch(() => {
    if (historyCache?.promise === promise) {
      historyCache = null;
    }
  });
  return promise;
}

async function getCachedWeekdayProfile(
  rowsPromise: Promise<UniswapRewardSnapshotRow[]>,
  protocolKey: string,
  metadata: Record<string, unknown>,
  now: Date
): Promise<WeekdayProfile> {
  const key = getPoolIdentity(protocolKey, metadata);
  const cacheNow = Date.now();
  const cached = profileCache.get(key);
  if (cached && cached.expiresAt > cacheNow) {
    return cached.promise;
  }

  const promise = rowsPromise.then((rows) => selectWeekdayProfile(rows, protocolKey, metadata, now));
  profileCache.set(key, { expiresAt: cacheNow + PROFILE_CACHE_MS, promise });
  promise.catch(() => {
    if (profileCache.get(key)?.promise === promise) {
      profileCache.delete(key);
    }
  });
  return promise;
}

export function isUniswapProtocol(protocolKey: string | undefined): boolean {
  return typeof protocolKey === 'string' && protocolKey.toLowerCase().startsWith('uniswap-');
}

export async function getUniswapIncomeForecast(
  position: Position,
  protocolKey: string,
  cutoff: Date
): Promise<UniswapIncomeForecast> {
  const now = new Date();
  const rowsPromise = getCachedHistory(now);
  const [positionRows, profile] = await Promise.all([
    getCachedPositionHistory(position.id, cutoff),
    getCachedWeekdayProfile(rowsPromise, protocolKey, position.metadata, now),
  ]);
  return calculateUniswapIncomeForecast(positionRows, profile, cutoff);
}

export function clearUniswapIncomeForecastCache(): void {
  historyCache = null;
  profileCache.clear();
  positionHistoryCache.clear();
}
