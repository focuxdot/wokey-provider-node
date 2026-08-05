import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentRuntimePath, runtimeVersionPath, switchCurrentRuntime } from '../src/provider-node/macos-runtime-layout.js';
import { readUpgradeState, writeUpgradeState } from '../src/provider-node/upgrade-state.js';

const mocks = vi.hoisted(() => ({ verify: vi.fn(async () => undefined) }));
vi.mock('sigstore', () => ({ verify: mocks.verify }));

const { installMacosRuntime } = await import('../src/provider-node/macos-runtime-updater.js');
const directories: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.verify.mockClear();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('macOS runtime updater verification', () => {
  it('stages and atomically activates a verified user-scoped runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wokey-runtime-updater-'));
    directories.push(dir);
    const configPath = join(dir, 'provider-node.json');
    const current = runtimeVersionPath(configPath, '0.1.70');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'package.json'), JSON.stringify({ version: '0.1.70' }));
    switchCurrentRuntime(configPath, '0.1.70');
    writeUpgradeState(configPath, {
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    });

    const archiveSource = join(dir, 'archive-source');
    mkdirSync(join(archiveSource, 'dist', 'provider-node'), { recursive: true });
    mkdirSync(join(archiveSource, 'bin'), { recursive: true });
    writeFileSync(join(archiveSource, 'package.json'), JSON.stringify({ version: '0.1.71' }));
    writeFileSync(join(archiveSource, 'dist', 'provider-node', 'server.js'), '');
    writeFileSync(join(archiveSource, 'dist', 'provider-node', 'macos-runtime-updater.js'), '');
    writeFileSync(join(archiveSource, 'bin', 'provider-node-cli.mjs'), '');
    const archivePath = join(dir, 'runtime.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', archiveSource, '.']);
    const archive = readFileSync(archivePath);
    const archiveHash = createHash('sha256').update(archive).digest('hex');
    const assetName = 'WokeyProviderNode-macos-runtime-x64-0.1.71.tar.gz';
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/checksums.txt')) return new Response(`${archiveHash}  ${assetName}\n`, { status: 200 });
      if (url.endsWith('/checksums.txt.sigstore.json')) return new Response('{}', { status: 200 });
      if (url.endsWith(`/${assetName}`)) return new Response(archive, { status: 200 });
      throw new Error(`unexpected download: ${url}`);
    }));

    const result = await installMacosRuntime({
      configPath,
      targetVersion: '0.1.71',
      expectedSha256: archiveHash,
      architecture: 'x64',
      releaseBaseUrl: 'https://example.test/release',
      allowTestReleaseBaseUrl: true,
    });

    expect(result).toEqual({ previousVersion: '0.1.70', targetVersion: '0.1.71' });
    expect(currentRuntimePath(configPath)).toBe(runtimeVersionPath(configPath, '0.1.71'));
    expect(readUpgradeState(configPath)).toMatchObject({
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      status: 'pending',
      startCount: 0,
    });
  });

  it('does not switch current when the Platform hash disagrees with the signed manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wokey-runtime-updater-'));
    directories.push(dir);
    const configPath = join(dir, 'provider-node.json');
    const current = runtimeVersionPath(configPath, '0.1.70');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'package.json'), JSON.stringify({ version: '0.1.70' }));
    switchCurrentRuntime(configPath, '0.1.70');
    writeUpgradeState(configPath, {
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    });
    const assetName = 'WokeyProviderNode-macos-runtime-x64-0.1.71.tar.gz';
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/checksums.txt')) {
        return new Response(`${'a'.repeat(64)}  ${assetName}\n`, { status: 200 });
      }
      if (url.endsWith('/checksums.txt.sigstore.json')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected download: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(installMacosRuntime({
      configPath,
      targetVersion: '0.1.71',
      expectedSha256: 'b'.repeat(64),
      architecture: 'x64',
      releaseBaseUrl: 'https://example.test/release',
      allowTestReleaseBaseUrl: true,
    })).rejects.toThrow('Platform artifact hash does not match the signed release manifest');

    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(currentRuntimePath(configPath)).toBe(current);
    expect(readUpgradeState(configPath)).toMatchObject({
      status: 'failed',
      failureReason: 'runtime_update_rejected',
      failureDetail: expect.stringContaining('Platform artifact hash does not match'),
      retryable: false,
    });
  });

  it('records download failures as retryable with their diagnostic detail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wokey-runtime-updater-'));
    directories.push(dir);
    const configPath = join(dir, 'provider-node.json');
    const current = runtimeVersionPath(configPath, '0.1.70');
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'package.json'), JSON.stringify({ version: '0.1.70' }));
    switchCurrentRuntime(configPath, '0.1.70');
    writeUpgradeState(configPath, {
      previousVersion: '0.1.70',
      targetVersion: '0.1.71',
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));

    await expect(installMacosRuntime({
      configPath,
      targetVersion: '0.1.71',
      architecture: 'x64',
      releaseBaseUrl: 'https://example.test/release',
      allowTestReleaseBaseUrl: true,
    })).rejects.toThrow('download failed (503)');

    expect(readUpgradeState(configPath)).toMatchObject({
      status: 'failed',
      failureReason: 'runtime_update_retryable',
      failureDetail: expect.stringContaining('download failed (503)'),
      retryAfter: expect.any(String),
      retryable: true,
    });
  });
});
