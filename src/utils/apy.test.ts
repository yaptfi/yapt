import {
  computeApy,
  computeWindowedApy,
  estimateDailyIncome,
  estimateMonthlyIncome,
  estimateYearlyIncome,
  computeAllTimeApy,
} from './apy';

describe('APY Calculations', () => {
  describe('computeApy', () => {
    it('should calculate APY correctly with positive yield', () => {
      const currentValue = 10100;
      const previousValue = 10000;
      const netFlows = 0;

      const result = computeApy(currentValue, previousValue, netFlows);

      // Positive growth in a short window
      expect(result.yieldDelta).toBe(100);
      expect(result.apy).toBeGreaterThan(0);
    });

    it('should handle deposits correctly', () => {
      const currentValue = 11000;
      const previousValue = 10000;
      const netFlows = 1000; // $1000 deposited

      const result = computeApy(currentValue, previousValue, netFlows);

      // No yield growth, just deposit
      expect(result.yieldDelta).toBe(0);
      expect(result.apy).toBe(0);
    });

    it('should handle withdrawals correctly', () => {
      const currentValue = 9000;
      const previousValue = 10000;
      const netFlows = -1000; // $1000 withdrawn

      const result = computeApy(currentValue, previousValue, netFlows);

      // No yield growth, just withdrawal
      expect(result.yieldDelta).toBe(0);
      expect(result.apy).toBe(0);
    });

    it('should handle negative yield', () => {
      const currentValue = 9900;
      const previousValue = 10000;
      const netFlows = 0;

      const result = computeApy(currentValue, previousValue, netFlows);

      expect(result.yieldDelta).toBe(-100);
      expect(result.apy).toBeLessThan(0);
    });

    it('should handle zero base gracefully', () => {
      const currentValue = 100;
      const previousValue = 0;
      const netFlows = 0;

      const result = computeApy(currentValue, previousValue, netFlows);

      expect(result.yieldDelta).toBe(100);
      expect(result.apy).toBe(0); // Edge case: no base to calculate from
    });
  });

  describe('computeWindowedApy', () => {
    it('should chain APY values correctly', () => {
      // All periods with 0.04 APY
      const apyValues = Array(28).fill(0.04); // 7 days

      const result = computeWindowedApy(apyValues);

      // Should be close to 4% since all periods are equal
      expect(result).toBeCloseTo(0.04, 2);
    });

    it('should handle empty array', () => {
      const result = computeWindowedApy([]);
      expect(result).toBe(0);
    });

    it('should handle varying APY values', () => {
      const apyValues = [0.05, 0.04, 0.06, 0.03];

      const result = computeWindowedApy(apyValues);

      // Should be somewhere around the average
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(1);
    });
  });

  describe('Income Projections', () => {
    const positionValue = 100000; // $100k
    const apy = 0.05; // 5%

    it('should calculate daily income correctly', () => {
      const daily = estimateDailyIncome(positionValue, apy);
      expect(daily).toBeCloseTo(100000 * 0.05 / 365, 2);
      expect(daily).toBeCloseTo(13.70, 2);
    });

    it('should calculate monthly income correctly', () => {
      const monthly = estimateMonthlyIncome(positionValue, apy);
      expect(monthly).toBeCloseTo(100000 * 0.05 / 365 * 30, 2);
      expect(monthly).toBeCloseTo(410.96, 2);
    });

    it('should calculate yearly income correctly', () => {
      const yearly = estimateYearlyIncome(positionValue, apy);
      expect(yearly).toBe(100000 * 0.05);
      expect(yearly).toBe(5000);
    });
  });

  describe('computeAllTimeApy', () => {
    it('should calculate all-time APY correctly', () => {
      const currentValue = 105000;
      const inceptionValue = 100000;
      const totalNetFlows = 0;
      const daysSinceInception = 365;

      const result = computeAllTimeApy(
        currentValue,
        inceptionValue,
        totalNetFlows,
        daysSinceInception
      );

      expect(result).toBeCloseTo(0.05, 2); // 5% over 1 year
    });

    it('should handle net flows correctly', () => {
      const currentValue = 110000;
      const inceptionValue = 100000;
      const totalNetFlows = 5000; // Added $5k
      const daysSinceInception = 365;

      const result = computeAllTimeApy(
        currentValue,
        inceptionValue,
        totalNetFlows,
        daysSinceInception
      );

      // Growth should be based on 110k - 105k (base + flows) = 5k / 105k
      expect(result).toBeCloseTo(0.0476, 2);
    });

    it('should annualize for different time periods', () => {
      const currentValue = 102500;
      const inceptionValue = 100000;
      const totalNetFlows = 0;
      const daysSinceInception = 180; // Half a year

      const result = computeAllTimeApy(
        currentValue,
        inceptionValue,
        totalNetFlows,
        daysSinceInception
      );

      // 2.5% over 6 months ≈ 5.06% APY
      expect(result).toBeCloseTo(0.0506, 2);
    });
  });
});
