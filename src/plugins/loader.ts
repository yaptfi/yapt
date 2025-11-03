import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { registerPlugin } from './registry';
import type { ProtocolPlugin } from './types';
import { validatePluginManifest } from './validate';
import { isSdkVersionCompatible } from './version';
import { registerAbi } from './abi-registry';

function isProtocolPlugin(x: unknown): x is ProtocolPlugin {
  if (typeof x !== 'object' || x === null) return false;
  const maybe = x as { createAdapter?: unknown; manifest?: unknown };
  if (typeof maybe.createAdapter !== 'function') return false;
  if (typeof maybe.manifest !== 'object' || maybe.manifest === null) return false;
  const man = maybe.manifest as { key?: unknown; name?: unknown };
  return typeof man.key === 'string' && typeof man.name === 'string';
}

function tryFile(pathname: string): boolean {
  try {
    return statSync(pathname).isFile();
  } catch {
    return false;
  }
}

async function loadBuiltinPlugins(baseDir: string): Promise<number> {
  let loaded = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(baseDir);
  } catch {
    return 0;
  }

  for (const name of entries) {
    const dirPath = join(baseDir, name);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      // Prefer relative module specifiers so dev (tsx) can resolve TS files
      let mod: any;
      try {
        mod = await import(`./builtin/${name}/index.js`);
      } catch {
        try {
          mod = await import(`./builtin/${name}/index.ts`);
        } catch {
          // Fallback to absolute file path resolution if needed
          const entryJs = join(dirPath, 'index.js');
          const entryTs = join(dirPath, 'index.ts');
          const entry = tryFile(entryJs) ? entryJs : tryFile(entryTs) ? entryTs : null;
          if (!entry) continue;
          mod = await import(pathToFileURL(entry).href);
        }
      }
      const candidate = (mod?.default ?? mod?.plugin ?? mod) as unknown;
      if (!isProtocolPlugin(candidate)) continue;
      const { valid, errors } = validatePluginManifest(candidate.manifest);
      if (!valid) {
        // eslint-disable-next-line no-console
        console.warn(`Skipping plugin in ${dirPath}: invalid manifest: ${errors.join(', ')}`);
        continue;
      }
      if (candidate.manifest.sdkVersion && !isSdkVersionCompatible(candidate.manifest.sdkVersion)) {
        // eslint-disable-next-line no-console
        console.warn(`Skipping plugin ${candidate.manifest.key}: SDK version ${candidate.manifest.sdkVersion} incompatible`);
        continue;
      }
      // Optional plugin setup before creating adapter (e.g., register ABIs)
      try {
        if (typeof candidate.setup === 'function') {
          candidate.setup({ registerAbi });
        }
      } catch {
        // ignore setup errors; plugin may still function without ABIs
      }
      const adapter = candidate.createAdapter();
      // Optional: ensure keys match; if not, still register but prefer manifest key
      if (adapter.protocolKey !== candidate.manifest.key) {
        // eslint-disable-next-line no-console
        console.warn(`Plugin key mismatch: manifest=${candidate.manifest.key}, adapter=${adapter.protocolKey}`);
      }
      registerPlugin(adapter, { key: candidate.manifest.key, name: candidate.manifest.name, source: 'builtin' });
      loaded++;
    } catch {
      // Soft-fail: skip broken plugin
      continue;
    }
  }

  return loaded;
}

/** Initialize and load protocol plugins */
export async function initPlugins(): Promise<void> {
  // Load built-in plugins compiled under dist/plugins/builtin/*
  const builtinDir = join(__dirname, 'builtin');
  const loadedBuiltins = await loadBuiltinPlugins(builtinDir);
  // eslint-disable-next-line no-console
  console.log(`[plugins] built-ins loaded: ${loadedBuiltins}`);

  // Optionally load third-party plugins from config/plugins.json
  if (process.env.ENABLE_THIRD_PARTY_PLUGINS === 'true') {
    const configPath = join(__dirname, '../../config/plugins.json');
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const cfg = JSON.parse(raw) as { thirdParty?: string[] };
      const specs = Array.isArray(cfg.thirdParty) ? cfg.thirdParty : [];
      for (const spec of specs) {
        try {
          const loaded = await loadThirdPartyPlugin(spec);
          if (!loaded) {
            // eslint-disable-next-line no-console
            console.warn(`Failed to load plugin from spec: ${spec}`);
          }
        } catch {
          // eslint-disable-next-line no-console
          console.warn(`Error while loading third-party plugin: ${spec}`);
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[plugins] third-party loaded: ${specs.length}`);
    } catch {
      // Missing or invalid config is tolerated; no third-party plugins loaded.
    }
  }
}

async function loadThirdPartyPlugin(spec: string): Promise<boolean> {
  // If spec is a path to a directory, try index.js
  try {
    const asDir = statSync(spec);
    if (asDir.isDirectory()) {
      // Try module specifiers relative to this file first (dev), then fallback to path
      let mod: any;
      try {
        mod = await import(`${spec}/index.js`);
      } catch {
        try {
          mod = await import(`${spec}/index.ts`);
        } catch {
          const entryJs = join(spec, 'index.js');
          const entryTs = join(spec, 'index.ts');
          const entry = tryFile(entryJs) ? entryJs : tryFile(entryTs) ? entryTs : null;
          if (!entry) return false;
          mod = await import(pathToFileURL(entry).href);
        }
      }
      const candidate = (mod?.default ?? mod?.plugin ?? mod) as unknown;
      if (!isProtocolPlugin(candidate)) return false;
      const { valid } = validatePluginManifest(candidate.manifest);
      if (!valid) return false;
      if (candidate.manifest.sdkVersion && !isSdkVersionCompatible(candidate.manifest.sdkVersion)) return false;
      try {
        if (typeof candidate.setup === 'function') {
          candidate.setup({ registerAbi });
        }
      } catch {
        // ignore setup errors
      }
      const adapter = candidate.createAdapter();
      registerPlugin(adapter, { key: candidate.manifest.key, name: candidate.manifest.name, source: 'third-party' });
      return true;
    }
  } catch {
    // Not a directory; fall through to module import
  }

  // Attempt to import as a module name or file
  try {
    const mod = await import(spec);
    const candidate = (mod?.default ?? mod?.plugin ?? mod) as unknown;
    if (!isProtocolPlugin(candidate)) return false;
    const { valid } = validatePluginManifest(candidate.manifest);
    if (!valid) return false;
    if (candidate.manifest.sdkVersion && !isSdkVersionCompatible(candidate.manifest.sdkVersion)) return false;
    try {
      if (typeof candidate.setup === 'function') {
        candidate.setup({ registerAbi });
      }
    } catch {
      // ignore setup errors
    }
    const adapter = candidate.createAdapter();
    registerPlugin(adapter, { key: candidate.manifest.key, name: candidate.manifest.name, source: 'third-party' });
    return true;
  } catch {
    return false;
  }
}
