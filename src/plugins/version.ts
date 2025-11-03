export const SDK_VERSION = '0.1.0';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(v: string): Semver | null {
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Minimal caret range support for SDK semver compatibility.
 * - "^X.Y.Z": >=X.Y.Z and <(X+1).0.0 when X>0
 * - For X=0: >=0.Y.Z and <0.(Y+1).0
 * - Exact version (no prefix) must equal.
 */
export function isSdkVersionCompatible(range: string, current: string = SDK_VERSION): boolean {
  const cur = parseSemver(current);
  if (!cur) return false;

  const r = range.trim();
  if (r.startsWith('^')) {
    const baseStr = r.slice(1);
    const base = parseSemver(baseStr);
    if (!base) return false;
    if (base.major === 0) {
      const upper: Semver = { major: 0, minor: base.minor + 1, patch: 0 };
      return cmp(cur, base) >= 0 && cmp(cur, upper) < 0;
    } else {
      const upper: Semver = { major: base.major + 1, minor: 0, patch: 0 };
      return cmp(cur, base) >= 0 && cmp(cur, upper) < 0;
    }
  }

  const exact = parseSemver(r);
  if (!exact) return false;
  return cmp(cur, exact) === 0;
}

