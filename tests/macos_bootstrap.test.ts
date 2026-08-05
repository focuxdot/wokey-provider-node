import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stable macOS bootstrap', () => {
  it('rolls back before launching a target for the third time', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wokey-bootstrap-'));
    directories.push(dataDir);
    const runtimeRoot = join(dataDir, 'runtime');
    const versions = join(runtimeRoot, 'versions');
    for (const version of ['0.1.70', '0.1.71']) {
      const path = join(versions, version);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify({ version }));
    }
    symlinkSync(join('versions', '0.1.71'), join(runtimeRoot, 'current'));
    writeFileSync(join(dataDir, 'upgrade-state.json'), JSON.stringify({
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      upgradedAt: new Date().toISOString(),
      startCount: 2,
      status: 'pending',
    }));

    execFileSync(process.execPath, ['packaging/macos/bootstrap.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, PROVIDER_CONFIG_PATH: join(dataDir, 'provider-node.json') },
    });

    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(join('versions', '0.1.70'));
    expect(JSON.parse(readFileSync(join(dataDir, 'upgrade-state.json'), 'utf8'))).toMatchObject({
      status: 'rolled_back',
      failureReason: 'crash_loop_detected',
      startCount: 3,
    });
  });
});
