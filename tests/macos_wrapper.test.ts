import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

function fixture(): { dir: string; home: string; installDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-macos-wrapper-'));
  directories.push(dir);
  const home = join(dir, 'home');
  const installDir = join(dir, 'install');
  const seed = join(installDir, 'seed', 'runtime');
  mkdirSync(join(seed, 'dist', 'provider-node'), { recursive: true });
  mkdirSync(join(installDir, 'bin'), { recursive: true });
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ version: '0.1.71' }));
  writeFileSync(join(seed, 'dist', 'provider-node', 'server.js'), '');
  writeFileSync(join(installDir, 'seed', 'VERSION'), '0.1.71\n');
  return { dir, home, installDir };
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('macOS stable wrapper', () => {
  it('lazily initializes a user runtime from the root-owned seed', () => {
    const { home, installDir } = fixture();
    const output = execFileSync('/bin/sh', ['packaging/macos/provider-node', 'version'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PROVIDER_NODE_INSTALL_DIR: installDir,
        PROVIDER_NODE_NODE: process.execPath,
      },
    }).trim();
    const runtimeRoot = join(home, 'Library', 'Application Support', 'Wokey Provider Node', 'runtime');

    expect(output).toBe('0.1.71');
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(join('versions', '0.1.71'));
    expect(existsSync(join(runtimeRoot, 'versions', '0.1.71', 'dist', 'provider-node', 'server.js'))).toBe(true);
  });

  it('skips an executable but unsupported Node hint', () => {
    const { dir, home, installDir } = fixture();
    const dataDir = join(home, 'Library', 'Application Support', 'Wokey Provider Node');
    const oldNode = join(dir, 'node-20');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(oldNode, '#!/bin/sh\nexit 1\n');
    chmodSync(oldNode, 0o755);
    writeFileSync(join(dataDir, 'node-path'), `${oldNode}\n`);

    const output = execFileSync('/bin/sh', ['packaging/macos/provider-node', 'doctor'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PROVIDER_NODE_INSTALL_DIR: installDir,
      },
    });

    expect(output).toMatch(/^node=.+$/m);
    expect(output).not.toContain(`node=${oldNode}`);
  });

  it('snapshots the legacy runtime before the package payload is replaced', () => {
    const { home, installDir } = fixture();
    const legacy = join(installDir, 'app');
    mkdirSync(join(legacy, 'dist', 'provider-node'), { recursive: true });
    writeFileSync(join(legacy, 'package.json'), JSON.stringify({ version: '0.1.57' }));
    writeFileSync(join(legacy, 'dist', 'provider-node', 'server.js'), '');

    execFileSync('/bin/sh', ['packaging/macos/scripts/preinstall'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROVIDER_NODE_INSTALL_DIR: installDir,
        PROVIDER_NODE_CONSOLE_USER: process.env.USER ?? '',
        PROVIDER_NODE_USER_HOME: home,
        PROVIDER_NODE_SKIP_SERVICE_CONTROL: '1',
      },
    });

    const runtimeRoot = join(home, 'Library', 'Application Support', 'Wokey Provider Node', 'runtime');
    expect(readlinkSync(join(runtimeRoot, 'current'))).toBe(join('versions', '0.1.57'));
    expect(existsSync(join(runtimeRoot, 'versions', '0.1.57', 'dist', 'provider-node', 'server.js'))).toBe(true);
  });
});
