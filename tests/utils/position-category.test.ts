import { getPositionCategory } from '../../src/utils/position-category';

describe('getPositionCategory', () => {
  it.each(['balance', 'exchangeRate', 'rebaseIndex', 'subgraph', 'lp-position', 'unknown-future'])(
    'maps %s to savings', (m) => expect(getPositionCategory(m)).toBe('savings')
  );
  it('maps rewards to rewards', () => expect(getPositionCategory('rewards')).toBe('rewards'));
  it('maps fixed-income to fixed-income', () => expect(getPositionCategory('fixed-income')).toBe('fixed-income'));
});
