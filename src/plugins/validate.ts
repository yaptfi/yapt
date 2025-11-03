import type { PluginManifest } from './types';

const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function validatePluginManifest(manifest: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['manifest is not an object'] };
  }
  const m = manifest as PluginManifest;
  if (!m.key || typeof m.key !== 'string' || !KEY_RE.test(m.key)) {
    errors.push('manifest.key must be kebab-case string');
  }
  if (!m.name || typeof m.name !== 'string' || m.name.trim().length === 0) {
    errors.push('manifest.name must be non-empty string');
  }
  if (m.version && (typeof m.version !== 'string' || !SEMVER_RE.test(m.version))) {
    errors.push('manifest.version must be semver X.Y.Z when provided');
  }
  if (m.sdkVersion && typeof m.sdkVersion !== 'string') {
    errors.push('manifest.sdkVersion must be string when provided');
  }
  return { valid: errors.length === 0, errors };
}

