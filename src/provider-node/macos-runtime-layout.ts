import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readUpgradeState, writeUpgradeState } from './upgrade-state.js';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface MacosRuntimeLayout {
  root: string;
  versions: string;
  current: string;
  lock: string;
}

export function assertRuntimeVersion(version: string): string {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid runtime version: ${version}`);
  return version;
}

export function macosRuntimeLayout(configPath: string): MacosRuntimeLayout {
  const root = join(dirname(configPath), 'runtime');
  return {
    root,
    versions: join(root, 'versions'),
    current: join(root, 'current'),
    lock: join(root, 'update.lock'),
  };
}

export function runtimeVersionPath(configPath: string, version: string): string {
  return join(macosRuntimeLayout(configPath).versions, assertRuntimeVersion(version));
}

export function readRuntimeVersion(runtimePath: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(runtimePath, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof value.version === 'string' && VERSION_PATTERN.test(value.version) ? value.version : undefined;
  } catch {
    return undefined;
  }
}

export function currentRuntimePath(configPath: string): string | undefined {
  const layout = macosRuntimeLayout(configPath);
  try {
    if (!lstatSync(layout.current).isSymbolicLink()) return undefined;
    const target = resolve(layout.root, readlinkSync(layout.current));
    const versionsRoot = `${resolve(layout.versions)}/`;
    if (!target.startsWith(versionsRoot) || !existsSync(target)) return undefined;
    return target;
  } catch {
    return undefined;
  }
}

export function switchCurrentRuntime(configPath: string, version: string): void {
  const layout = macosRuntimeLayout(configPath);
  const versionPath = runtimeVersionPath(configPath, version);
  if (!existsSync(versionPath)) throw new Error(`runtime version is not installed: ${version}`);
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const temporaryLink = join(layout.root, `.current-${process.pid}-${Date.now()}`);
  rmSync(temporaryLink, { force: true });
  symlinkSync(join('versions', version), temporaryLink, 'dir');
  renameSync(temporaryLink, layout.current);
}

export function rollbackPendingMacosUpgrade(configPath: string, reason: string): boolean {
  const state = readUpgradeState(configPath);
  if (state?.status !== 'pending') return false;
  const previousPath = runtimeVersionPath(configPath, state.previousVersion);
  if (!existsSync(previousPath) || readRuntimeVersion(previousPath) !== state.previousVersion) {
    writeUpgradeState(configPath, {
      ...state,
      status: 'failed',
      failureReason: `${reason}:previous_runtime_missing`,
    });
    return false;
  }
  switchCurrentRuntime(configPath, state.previousVersion);
  writeUpgradeState(configPath, {
    ...state,
    status: 'rolled_back',
    failureReason: reason,
  });
  return true;
}

export function pruneMacosRuntimes(configPath: string, keepVersions: string[]): void {
  const layout = macosRuntimeLayout(configPath);
  if (!existsSync(layout.versions)) return;
  const keep = new Set(keepVersions.filter((version) => VERSION_PATTERN.test(version)));
  for (const entry of readdirSync(layout.versions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !VERSION_PATTERN.test(entry.name) || keep.has(entry.name)) continue;
    rmSync(join(layout.versions, entry.name), { recursive: true, force: true });
  }
}
