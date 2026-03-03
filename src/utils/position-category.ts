import { MeasureMethod } from '../types';

export type PositionCategory = 'savings' | 'fixed-income' | 'rewards';

/**
 * Map a measureMethod value to its semantic position category.
 * Single authoritative place for this classification.
 * The raw measureMethod is retained in DB and adapters for backward compatibility.
 */
export function getPositionCategory(measureMethod: MeasureMethod | string): PositionCategory {
  switch (measureMethod) {
    case 'fixed-income': return 'fixed-income';
    case 'rewards':      return 'rewards';
    case 'balance':
    case 'exchangeRate':
    case 'rebaseIndex':
    case 'subgraph':
    case 'lp-position':
    default:             return 'savings';
  }
}
