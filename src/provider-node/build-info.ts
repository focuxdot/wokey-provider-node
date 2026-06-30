import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProviderNodeBuildInfo {
  version: string;
  buildHash: string;
  gitCommit?: string;
  dirty?: boolean;
  builtAt?: string;
}

const FALLBACK_VERSION = '0.1.0';
const FALLBACK_BUILD_HASH = 'dev-build';

export function getProviderNodeBuildInfo(): ProviderNodeBuildInfo {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const generated = readJson<Partial<ProviderNodeBuildInfo>>(resolve(moduleDir, 'build-info.json')) || {};
  const pkg = readJson<{ version?: string }>(resolve(moduleDir, '..', '..', 'package.json')) || {};
  const version = process.env.PROVIDER_NODE_VERSION || generated.version || pkg.version || FALLBACK_VERSION;
  const buildHash = process.env.PROVIDER_NODE_BUILD_HASH || generated.buildHash || generated.gitCommit || FALLBACK_BUILD_HASH;

  return {
    version,
    buildHash,
    gitCommit: generated.gitCommit,
    dirty: generated.dirty,
    builtAt: generated.builtAt,
  };
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
