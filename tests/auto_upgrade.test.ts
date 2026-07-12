import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  arch: vi.fn(() => 'x64'),
  platform: vi.fn(() => 'linux'),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0 })),
  version: '0.1.37',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn, spawnSync: mocks.spawnSync };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, arch: mocks.arch, platform: mocks.platform };
});

vi.mock('../src/provider-node/build-info.js', () => ({
  getProviderNodeBuildInfo: () => ({ version: mocks.version }),
}));

const {
  AutoUpgradeController,
  checkCrashLoopOnStartup,
  scheduleUpgradeVerification,
} = await import('../src/provider-node/auto-upgrade.js');

class FakeChild extends EventEmitter {
  pid = 1234;
}

function tempConfigPath(): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-auto-upgrade-'));
  return { dir, configPath: join(dir, 'provider-node.json') };
}

function statePath(configPath: string): string {
  return join(configPath, '..', 'upgrade-state.json');
}

function readState(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(configPath), 'utf8')) as Record<string, unknown>;
}

function writeState(configPath: string, state: Record<string, unknown>): void {
  writeFileSync(statePath(configPath), JSON.stringify(state, null, 2), 'utf8');
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('AutoUpgradeController', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let getuidSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.arch.mockReturnValue('x64');
    mocks.platform.mockReturnValue('linux');
    mocks.spawn.mockReset();
    mocks.spawnSync.mockReset();
    mocks.spawnSync.mockReturnValue({ status: 0 });
    mocks.version = '0.1.37';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(1000);
    delete process.env.INVOCATION_ID;
  });

  afterEach(() => {
    exitSpy.mockRestore();
    getuidSpy.mockRestore();
    delete process.env.INVOCATION_ID;
    vi.useRealTimers();
  });

  it('does not stop the bridge when Linux cannot run sudo non-interactively', async () => {
    mocks.spawnSync.mockReturnValue({ status: 1 });
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    const stopBridge = vi.fn();
    try {
      const controller = new AutoUpgradeController({
        configPath,
        getInFlight: () => 0,
        stopBridge,
        log,
      });

      await controller.handleUpgradeAvailable({
        type: 'platform.upgrade_available',
        version: '0.1.38',
        hashes: { 'linux-x64': 'hash' },
        urgent: false,
      });

      expect(stopBridge).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        { targetVersion: '0.1.38', reason: 'sudo_noninteractive_unavailable' },
        'auto-upgrade: cannot run update command non-interactively, skipping',
      );
      expect(existsSync(statePath(configPath))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the service process alive until the updater exits, then records failure', async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    const stopBridge = vi.fn();
    try {
      const controller = new AutoUpgradeController({
        configPath,
        getInFlight: () => 0,
        stopBridge,
        log,
      });

      await controller.handleUpgradeAvailable({
        type: 'platform.upgrade_available',
        version: '0.1.38',
        hashes: { 'linux-x64': 'hash' },
        urgent: false,
      });

      expect(stopBridge).toHaveBeenCalledTimes(1);
      expect(mocks.spawn).toHaveBeenCalledWith(
        '/usr/local/bin/wokey-node',
        ['update'],
        expect.objectContaining({
          env: expect.objectContaining({ WOKEY_PROVIDER_NODE_VERSION: '0.1.38' }),
          stdio: 'ignore',
        }),
      );
      expect(exitSpy).not.toHaveBeenCalled();

      child.emit('exit', 1, null);

      expect(readState(configPath)).toMatchObject({
        status: 'failed',
        failureReason: 'update_process_failed',
        observedVersion: '0.1.37',
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs the Linux updater in a detached systemd scope when running as a unit', async () => {
    process.env.INVOCATION_ID = 'unit-abc';
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    const stopBridge = vi.fn();
    try {
      const controller = new AutoUpgradeController({
        configPath,
        getInFlight: () => 0,
        stopBridge,
        log,
      });

      await controller.handleUpgradeAvailable({
        type: 'platform.upgrade_available',
        version: '0.1.38',
        hashes: { 'linux-x64': 'hash' },
        urgent: false,
      });

      // Detached into a transient scope (sibling cgroup) so the .deb postinst's
      // `systemctl --user restart` cannot SIGKILL the in-flight installer.
      expect(mocks.spawn).toHaveBeenCalledWith(
        'systemd-run',
        ['--user', '--scope', '--collect', '--quiet', '--', '/usr/local/bin/wokey-node', 'update'],
        expect.objectContaining({
          env: expect.objectContaining({ WOKEY_PROVIDER_NODE_VERSION: '0.1.38' }),
          stdio: 'ignore',
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a platform retry for the same failed target version', async () => {
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    const stopBridge = vi.fn();
    try {
      writeState(configPath, {
        previousVersion: '0.1.37',
        targetVersion: '0.1.38',
        upgradedAt: new Date().toISOString(),
        startCount: 0,
        status: 'failed',
        failureReason: 'update_process_failed',
      });

      const controller = new AutoUpgradeController({
        configPath,
        getInFlight: () => 0,
        stopBridge,
        log,
      });

      await controller.handleUpgradeAvailable({
        type: 'platform.upgrade_available',
        version: '0.1.38',
        hashes: { 'linux-x64': 'hash' },
        urgent: false,
      });

      expect(stopBridge).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        { targetVersion: '0.1.38', failureReason: 'update_process_failed' },
        'auto-upgrade: previous attempt for target failed, skipping retry',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auto-upgrade startup state', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.version = '0.1.37';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.useRealTimers();
  });

  it('marks a pending upgrade failed when the restarted binary is still the old version', () => {
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    try {
      writeState(configPath, {
        previousVersion: '0.1.37',
        targetVersion: '0.1.38',
        upgradedAt: new Date().toISOString(),
        startCount: 0,
        status: 'pending',
      });

      checkCrashLoopOnStartup(configPath, log);

      expect(readState(configPath)).toMatchObject({
        status: 'failed',
        failureReason: 'target_version_not_installed',
        observedVersion: '0.1.37',
      });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only verifies stability when the running binary matches the target version', async () => {
    vi.useFakeTimers();
    mocks.version = '0.1.38';
    const { dir, configPath } = tempConfigPath();
    const log = logger();
    try {
      writeState(configPath, {
        previousVersion: '0.1.37',
        targetVersion: '0.1.38',
        upgradedAt: new Date().toISOString(),
        startCount: 1,
        status: 'pending',
      });

      scheduleUpgradeVerification(configPath, log);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(readState(configPath)).toMatchObject({ status: 'verified' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
