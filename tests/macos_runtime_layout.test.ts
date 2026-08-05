import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentRuntimePath,
  pruneMacosRuntimes,
  rollbackPendingMacosUpgrade,
  runtimeVersionPath,
  switchCurrentRuntime,
} from '../src/provider-node/macos-runtime-layout.js';
import { readUpgradeState, writeUpgradeState } from '../src/provider-node/upgrade-state.js';

const directories: string[] = [];

function fixture(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-runtime-layout-'));
  directories.push(dir);
  return { dir, configPath: join(dir, 'provider-node.json') };
}

function addRuntime(configPath: string, version: string): string {
  const path = runtimeVersionPath(configPath, version);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ version }));
  return path;
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('macOS versioned runtime layout', () => {
  it('switches current atomically and rolls a pending target back locally', () => {
    const { configPath } = fixture();
    const oldPath = addRuntime(configPath, '0.1.70');
    addRuntime(configPath, '0.1.71');
    switchCurrentRuntime(configPath, '0.1.70');
    writeUpgradeState(configPath, {
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      upgradedAt: new Date().toISOString(),
      startCount: 2,
      status: 'pending',
    });
    switchCurrentRuntime(configPath, '0.1.71');

    expect(rollbackPendingMacosUpgrade(configPath, 'crash_loop_detected')).toBe(true);
    expect(currentRuntimePath(configPath)).toBe(oldPath);
    expect(readUpgradeState(configPath)).toMatchObject({
      status: 'rolled_back',
      failureReason: 'crash_loop_detected',
    });
  });

  it('retains the active and rollback versions while pruning older runtimes', () => {
    const { configPath } = fixture();
    for (const version of ['0.1.68', '0.1.69', '0.1.70']) addRuntime(configPath, version);
    switchCurrentRuntime(configPath, '0.1.70');

    pruneMacosRuntimes(configPath, ['0.1.69', '0.1.70']);

    expect(currentRuntimePath(configPath)).toBe(runtimeVersionPath(configPath, '0.1.70'));
    expect(readlinkSync(join(dirname(configPath), 'runtime', 'current'))).toBe(join('versions', '0.1.70'));
    expect(() => readFileSync(join(runtimeVersionPath(configPath, '0.1.68'), 'package.json'))).toThrow();
  });
});
