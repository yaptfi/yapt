import {
  INFINIFI_RATE_SCALE_DEFAULT,
  parseRateScale,
  applyScaledExchangeRate,
} from './infinifi-liusd-4w';

describe('Infinifi liUSD-4w helpers', () => {
  describe('parseRateScale', () => {
    it('returns default scale when undefined', () => {
      expect(parseRateScale()).toBe(INFINIFI_RATE_SCALE_DEFAULT);
    });

    it('parses valid positive scale strings', () => {
      expect(parseRateScale('1000000000000000000000000000')).toBe(10n ** 27n);
    });

    it('falls back to default for invalid values', () => {
      expect(parseRateScale('abc')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
      expect(parseRateScale('0')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
      expect(parseRateScale('-1')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
    });
  });

  describe('applyScaledExchangeRate', () => {
    it('applies RAY-scaled exchange rates', () => {
      const shares = 100n * 10n ** 18n;
      const exchangeRate = 105n * 10n ** 25n; // 1.05 * 1e27

      const result = applyScaledExchangeRate(shares, exchangeRate);

      expect(result).toBe(105n * 10n ** 18n);
    });

    it('throws when scale is non-positive', () => {
      expect(() => applyScaledExchangeRate(1n, 1n, 0n)).toThrow('Rate scale must be positive');
    });
  });
});

