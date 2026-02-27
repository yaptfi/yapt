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

    it('normalizes legacy 1e27 config scale to WAD', () => {
      expect(parseRateScale('1000000000000000000000000000')).toBe(10n ** 18n);
    });

    it('parses valid positive non-legacy scale strings', () => {
      expect(parseRateScale('1000000000000000000')).toBe(10n ** 18n);
    });

    it('falls back to default for invalid values', () => {
      expect(parseRateScale('abc')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
      expect(parseRateScale('0')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
      expect(parseRateScale('-1')).toBe(INFINIFI_RATE_SCALE_DEFAULT);
    });
  });

  describe('applyScaledExchangeRate', () => {
    it('applies WAD-scaled exchange rates', () => {
      const shares = 100n * 10n ** 18n;
      const exchangeRate = 105n * 10n ** 16n; // 1.05 * 1e18

      const result = applyScaledExchangeRate(shares, exchangeRate);

      expect(result).toBe(105n * 10n ** 18n);
    });

    it('prevents liUSD-4w false-dust valuation with legacy scale config', () => {
      const shares = 448657456403722497879675n;
      const exchangeRate = 1172518912412415121n; // from on-chain exchangeRate(4)
      const scale = parseRateScale('1000000000000000000000000000'); // legacy 1e27

      const result = applyScaledExchangeRate(shares, exchangeRate, scale);

      // Should be near 526k iUSD (not near-zero dust)
      expect(result).toBe(526059352828213255134092n);
    });

    it('throws when scale is non-positive', () => {
      expect(() => applyScaledExchangeRate(1n, 1n, 0n)).toThrow('Rate scale must be positive');
    });
  });
});
