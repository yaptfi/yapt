/**
 * Helpers for classifying JSON-RPC errors surfaced through ethers.
 *
 * Provider errors are frequently nested (`error`, `info`, `value[]`, ...);
 * e.g. Infura throttles have appeared as BAD_DATA with -32005 inside `value[]`.
 * These helpers walk the nested payload recursively before matching.
 */

export function getErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<object>();

  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      messages.push(value);
      return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;

    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of [
      'shortMessage',
      'message',
      'reason',
      'code',
      'cause',
      'error',
      'info',
      'data',
      'body',
      'value',
      'response',
    ]) {
      visit(record[key], depth + 1);
    }
  };

  visit(error, 0);
  return messages;
}

export function getCombinedErrorMessage(error: unknown): string {
  return getErrorMessages(error).join(' ').toLowerCase();
}

export function isRetryableQueryError(error: unknown): boolean {
  const message = getCombinedErrorMessage(error);
  return (
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('temporarily unavailable') ||
    message.includes('service unavailable') ||
    message.includes('timeout') ||
    message.includes('-32005')
  );
}

export function isBlockRangeError(error: unknown): boolean {
  const message = getCombinedErrorMessage(error);
  return (
    message.includes('block range') ||
    message.includes('query returned more than') ||
    message.includes('response size exceeded') ||
    /range.{0,120}exceeds.{0,40}limit/s.test(message) ||
    (message.includes('eth_getlogs') && (
      message.includes('range') || message.includes('limit') || message.includes('exceed')
    ))
  );
}

export function getReportedBlockRangeLimit(error: unknown): number | null {
  const patterns = [
    /(?:block\s+)?range[^.\n]{0,120}?exceeds(?:\s+the)?\s+limit(?:\s+of)?\s+([\d,]+)/i,
    /(?:maximum|max)(?:\s+allowed)?\s+(?:block\s+)?range(?:\s+is|\s+of|:)?\s+([\d,]+)/i,
    /(?:block\s+)?range\s+(?:is\s+)?limited\s+to\s+(?:a\s+)?([\d,]+)/i,
    /limited\s+to\s+(?:a\s+)?([\d,]+)\s+blocks?/i,
    /limit(?:ed)?\s+(?:of|to)\s+([\d,]+)\s+blocks?/i,
    /up\s+to\s+(?:a\s+)?([\d,]+)\s+blocks?/i,
  ];

  for (const message of getErrorMessages(error)) {
    const normalizedMessage = message.replace(/,/g, '');
    for (const pattern of patterns) {
      const match = normalizedMessage.match(pattern);
      const limit = match?.[1] ? Number(match[1]) : Number.NaN;
      if (Number.isSafeInteger(limit) && limit > 0) return limit;
    }
  }
  return null;
}
