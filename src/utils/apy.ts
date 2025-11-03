/**
 * APY calculation utilities following the PRD specification
 */

export interface ApyCalculation {
  apy: number;
  yieldDelta: number;
}

/**
 * Compute annualized APY from a single snapshot window.
 *
 * Formula:
 * - g = (V_t - (V_{t-Δ} + F)) / (V_{t-Δ} + F)
 * - APY = (1 + g)^(hours_per_year / window_hours) - 1
 *
 * @param currentValue V_t - current position value in USD
 * @param previousValue V_{t-Δ} - previous value in USD
 * @param netFlows F - net flows between t-Δ and t (deposits +, withdrawals -)
 * @returns APY as decimal (e.g., 0.045 for 4.5%)
 */
// Hours in a (non-leap) year
const HOURS_PER_YEAR = 365 * 24;

/**
 * Compute annualized APY for a given snapshot window.
 */
export function computeApy(
  currentValue: number,
  previousValue: number,
  netFlows: number,
  windowHours: number = 1
): ApyCalculation {
  const base = previousValue + netFlows;

  // Yield-only growth
  const yieldDelta = currentValue - base;

  // Handle edge cases
  if (base <= 0) {
    return { apy: 0, yieldDelta };
  }

  const growthRate = yieldDelta / base;

  // Cap growth rate to prevent overflow
  // Maximum realistic per-window growth rate: 10% (already extreme)
  const cappedGrowthRate = Math.max(-0.99, Math.min(0.10, growthRate));

  if (growthRate !== cappedGrowthRate) {
    console.warn(`APY calculation: growth rate ${(growthRate * 100).toFixed(2)}% capped to ${(cappedGrowthRate * 100).toFixed(2)}% (base: ${base}, yieldDelta: ${yieldDelta})`);
  }

  // Annualize: (1 + g)^(hours_per_year / window_hours) - 1
  const periodsPerYear = HOURS_PER_YEAR / Math.max(1, windowHours);
  let apy = Math.pow(1 + cappedGrowthRate, periodsPerYear) - 1;

  // Prevent Infinity, NaN, or absurd values
  // Cap to a generous upper bound to avoid exploding UI/income projections
  const MAX_APY = 10; // 1000%
  if (!isFinite(apy) || Math.abs(apy) > MAX_APY) {
    console.warn(
      `APY calculation: result ${apy} is invalid or exceeds limits, capping\n` +
      `  Inputs: currentValue=${currentValue}, previousValue=${previousValue}, netFlows=${netFlows}, windowHours=${windowHours}\n` +
      `  Computed: base=${base}, yieldDelta=${yieldDelta}, growthRate=${growthRate}, periodsPerYear=${periodsPerYear}`
    );
    apy = cappedGrowthRate > 0 ? MAX_APY : -0.99;
  }

  return { apy, yieldDelta };
}

/**
 * Compute windowed APY (7d or 30d) using geometric chaining
 *
 * Takes sequential per-snapshot APY values and chains them together
 *
 * @param apyValues Array of per-snapshot APY values for the window
 * @returns Annualized APY for the window period
 */
export function computeWindowedApy(apyValues: number[], periodsPerYear: number = HOURS_PER_YEAR): number {
  if (apyValues.length === 0) {
    return 0;
  }

  // Convert APY back to per-period rates, compound them, then re-annualize
  // r_period = (1 + APY)^(1/periods_per_year) - 1
  let compoundedValue = 1;
  for (const apy of apyValues) {
    const periodRate = Math.pow(1 + apy, 1 / periodsPerYear) - 1;
    compoundedValue *= (1 + periodRate);
  }

  // Re-annualize: (1 + r_total)^(periods_per_year / num_periods) - 1
  const numPeriods = apyValues.length;
  const annualizedApy = Math.pow(compoundedValue, periodsPerYear / numPeriods) - 1;

  return annualizedApy;
}

/**
 * Compute 7-day APY from snapshots
 */
export function compute7dApy(apyValues: number[]): number {
  return computeWindowedApy(apyValues, HOURS_PER_YEAR);
}

/**
 * Compute 30-day APY from snapshots
 */
export function compute30dApy(apyValues: number[]): number {
  return computeWindowedApy(apyValues, HOURS_PER_YEAR);
}

/**
 * Compute 4-hour APY from snapshots
 */
export function compute4hApy(apyValues: number[]): number {
  return computeWindowedApy(apyValues, HOURS_PER_YEAR);
}

/**
 * Compute EMA-smoothed APY
 *
 * @param currentApy Most recent APY value
 * @param previousEma Previous EMA value
 * @param alpha Smoothing factor (default 0.2)
 * @returns New EMA value
 */
export function computeEmaApy(
  currentApy: number,
  previousEma: number | null,
  alpha: number = 0.2
): number {
  if (previousEma === null) {
    return currentApy;
  }

  return alpha * currentApy + (1 - alpha) * previousEma;
}

/**
 * Calculate daily income projection
 *
 * @param positionValue Current position value in USD
 * @param currentApy Current APY as decimal
 * @returns Estimated daily income in USD
 */
export function estimateDailyIncome(positionValue: number, currentApy: number): number {
  return (positionValue * currentApy) / 365;
}

/**
 * Calculate monthly income projection
 */
export function estimateMonthlyIncome(positionValue: number, currentApy: number): number {
  return estimateDailyIncome(positionValue, currentApy) * 30;
}

/**
 * Calculate yearly income projection
 */
export function estimateYearlyIncome(positionValue: number, currentApy: number): number {
  return positionValue * currentApy;
}

/**
 * Compute all-time APY from inception
 *
 * @param currentValue Current position value
 * @param inceptionValue Initial position value at creation
 * @param totalNetFlows Sum of all net flows since inception
 * @param daysSinceInception Number of days since position was created
 * @returns Annualized APY since inception
 */
export function computeAllTimeApy(
  currentValue: number,
  inceptionValue: number,
  totalNetFlows: number,
  daysSinceInception: number
): number {
  const base = inceptionValue + totalNetFlows;

  if (base <= 0 || daysSinceInception <= 0) {
    return 0;
  }

  const totalGrowth = (currentValue - base) / base;

  // Annualize based on actual time elapsed
  const yearsElapsed = daysSinceInception / 365;
  const apy = Math.pow(1 + totalGrowth, 1 / yearsElapsed) - 1;

  return apy;
}
