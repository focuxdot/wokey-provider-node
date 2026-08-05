import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface UpgradeState {
  previousVersion: string;
  targetVersion: string;
  upgradedAt: string;
  startCount: number;
  status: 'pending' | 'verified' | 'rolled_back' | 'failed';
  failureReason?: string;
  failureDetail?: string;
  failedAt?: string;
  retryAfter?: string;
  retryable?: boolean;
  observedVersion?: string;
}

export function upgradeStatePath(configPath: string): string {
  return join(dirname(configPath), 'upgrade-state.json');
}

export function readUpgradeState(configPath: string): UpgradeState | undefined {
  const path = upgradeStatePath(configPath);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as UpgradeState;
  } catch {
    return undefined;
  }
}

export function writeUpgradeState(configPath: string, state: UpgradeState): void {
  const path = upgradeStatePath(configPath);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryPath, path);
}
