import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { join } from 'node:path';
import type { PlatformUpgradeAvailable, ProviderUpgradePhase } from '../shared/protocol.js';
import { getProviderNodeBuildInfo } from './build-info.js';
import { pruneMacosRuntimes, rollbackPendingMacosUpgrade } from './macos-runtime-layout.js';
import { type UpgradeState, readUpgradeState, writeUpgradeState } from './upgrade-state.js';

const DRAIN_POLL_MS = 500;
const DRAIN_TIMEOUT_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;
const STABILITY_TIMEOUT_MS = 60_000;

export interface AutoUpgradeOptions {
  configPath: string;
  getInFlight: () => number;
  beginDrain?: () => void | Promise<void>;
  stopBridge: () => void;
  reportStatus?: (status: ProviderUpgradeStatusUpdate) => void | Promise<void>;
  log: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void };
}

export interface ProviderUpgradeStatusUpdate {
  rolloutId?: string;
  targetVersion: string;
  phase: ProviderUpgradePhase;
  reason?: string;
  retryable?: boolean;
  retryAfter?: string;
}

export function upgradeStatusFromState(state: UpgradeState): ProviderUpgradeStatusUpdate | undefined {
  if (state.status === 'pending') return undefined;
  return {
    ...(state.rolloutId ? { rolloutId: state.rolloutId } : {}),
    targetVersion: state.targetVersion,
    phase: state.status,
    ...(state.failureReason ? { reason: state.failureReason } : {}),
    ...(typeof state.retryable === 'boolean' ? { retryable: state.retryable } : {}),
    ...(state.retryAfter ? { retryAfter: state.retryAfter } : {}),
  };
}

function parseSemver(v: string): [number, number, number] | undefined {
  const match = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(target: string, current: string): boolean {
  const t = parseSemver(target);
  const c = parseSemver(current);
  if (!t || !c) return false;
  for (let i = 0; i < 3; i++) {
    const targetPart = t[i] ?? 0;
    const currentPart = c[i] ?? 0;
    if (targetPart > currentPart) return true;
    if (targetPart < currentPart) return false;
  }
  return false;
}

function platformKey(): string {
  return `${platform()}-${arch()}`;
}

function isDocker(): boolean {
  return process.env.PROVIDER_NODE_DOCKER === '1' || existsSync('/.dockerenv');
}

function commandExists(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function spawnUpdate(version: string, expectedSha256?: string): ChildProcess | undefined {
  const env = {
    ...process.env,
    WOKEY_PROVIDER_NODE_VERSION: version,
    ...(expectedSha256 ? { WOKEY_PROVIDER_NODE_EXPECTED_SHA256: expectedSha256 } : {}),
  };
  const plat = platform();
  let cmd: string;
  let args: string[];

  if (plat === 'darwin') {
    cmd = '/usr/local/wokey-provider-node/bin/provider-node';
    args = ['update', '--automatic'];
  } else if (plat === 'linux') {
    cmd = '/usr/local/bin/wokey-node';
    args = ['update'];
    // When the node runs as a systemd unit, the updater we spawn is a child in
    // this unit's cgroup. Installing the new .deb runs a postinst that restarts
    // wokey-provider-node.service; stopping the unit SIGKILLs the whole cgroup —
    // including the in-flight apt/dpkg — so the new version never lands and the
    // node restarts on the old one, re-triggering the upgrade in a loop. Run the
    // updater in a transient scope (a sibling cgroup) so the service restart
    // cannot kill it mid-install.
    if (process.env.INVOCATION_ID && commandExists('systemd-run')) {
      args = ['--user', '--scope', '--collect', '--quiet', '--', cmd, ...args];
      cmd = 'systemd-run';
    }
  } else if (plat === 'win32') {
    cmd = 'powershell.exe';
    const scriptPath = join(process.env.LOCALAPPDATA || '', 'WokeyProviderNode', 'bin', 'wokey-node.ps1');
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'update'];
  } else {
    return undefined;
  }

  return spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
}

function hasRootPrivileges(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function canRunPrivilegedInstallerNonInteractively(): boolean {
  if (hasRootPrivileges()) return true;
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
}

function updateReadiness(): { ok: true } | { ok: false; reason: string } {
  const plat = platform();
  if (plat !== 'darwin' && plat !== 'linux' && plat !== 'win32') {
    return { ok: false, reason: 'unsupported_platform' };
  }
  if (plat === 'linux' && !canRunPrivilegedInstallerNonInteractively()) {
    return { ok: false, reason: 'sudo_noninteractive_unavailable' };
  }
  return { ok: true };
}

function markUpgradeFailed(
  configPath: string,
  state: UpgradeState,
  currentVersion: string,
  reason: string,
  log: AutoUpgradeOptions['log'],
  detail?: string,
): void {
  writeUpgradeState(configPath, {
    ...state,
    status: 'failed',
    failureReason: reason,
    ...(detail ? { failureDetail: detail.slice(0, 1_000) } : {}),
    failedAt: new Date().toISOString(),
    retryable: false,
    observedVersion: currentVersion,
  });
  log.error({
    targetVersion: state.targetVersion,
    previousVersion: state.previousVersion,
    currentVersion,
    reason,
  }, 'auto-upgrade: upgrade target was not installed');
}

export class AutoUpgradeController {
  private upgradeInProgress = false;
  private readonly options: AutoUpgradeOptions;

  constructor(options: AutoUpgradeOptions) {
    this.options = options;
  }

  private async reportStatus(status: ProviderUpgradeStatusUpdate): Promise<void> {
    try {
      await this.options.reportStatus?.(status);
    } catch (err) {
      this.options.log.warn({ err, ...status }, 'auto-upgrade: failed to report upgrade status');
    }
  }

  private reportStatusInBackground(status: ProviderUpgradeStatusUpdate): void {
    void this.reportStatus(status);
  }

  async handleUpgradeAvailable(message: PlatformUpgradeAvailable): Promise<void> {
    const currentVersion = getProviderNodeBuildInfo().version;
    this.options.log.info({ targetVersion: message.version, currentVersion, urgent: message.urgent }, 'auto-upgrade: received upgrade_available');
    const statusBase = {
      ...(message.rolloutId ? { rolloutId: message.rolloutId } : {}),
      targetVersion: message.version,
    };
    this.reportStatusInBackground({ ...statusBase, phase: 'received' });

    if (isDocker()) {
      this.options.log.info({}, 'auto-upgrade: skipping in Docker environment');
      this.reportStatusInBackground({ ...statusBase, phase: 'skipped', reason: 'docker_environment' });
      return;
    }

    if (!isNewerVersion(message.version, currentVersion)) {
      this.options.log.info({}, 'auto-upgrade: target version is not newer, skipping');
      this.reportStatusInBackground({ ...statusBase, phase: 'skipped', reason: 'target_not_newer' });
      return;
    }

    const key = platformKey();
    const expectedHash = message.hashes[key];
    if (!expectedHash) {
      this.options.log.warn({ key, availableKeys: Object.keys(message.hashes) }, 'auto-upgrade: no hash for this platform');
      this.reportStatusInBackground({ ...statusBase, phase: 'skipped', reason: 'platform_hash_missing' });
      return;
    }
    this.options.log.info({ key, expectedHash }, 'auto-upgrade: platform-provided artifact hash selected for verification');

    const lastState = readUpgradeState(this.options.configPath);
    if (lastState?.status === 'failed' && lastState.targetVersion === message.version && lastState.retryable !== true) {
      this.options.log.warn({ targetVersion: message.version, failureReason: lastState.failureReason }, 'auto-upgrade: previous attempt for target failed, skipping retry');
      this.reportStatusInBackground({
        ...statusBase,
        phase: 'skipped',
        reason: lastState.failureReason || 'previous_attempt_failed',
        retryable: false,
      });
      return;
    }
    if (lastState?.status === 'failed' && lastState.targetVersion === message.version && lastState.retryable === true
      && lastState.retryAfter && Date.parse(lastState.retryAfter) > Date.now()) {
      this.options.log.warn({ targetVersion: message.version, retryAfter: lastState.retryAfter, failureDetail: lastState.failureDetail }, 'auto-upgrade: transient failure backoff is still active');
      this.reportStatusInBackground({
        ...statusBase,
        phase: 'skipped',
        reason: 'retry_backoff_active',
        retryable: true,
        retryAfter: lastState.retryAfter,
      });
      return;
    }
    if (lastState?.status === 'failed' && lastState.targetVersion === message.version && lastState.retryable === true) {
      this.options.log.info({ targetVersion: message.version, failureDetail: lastState.failureDetail }, 'auto-upgrade: retrying transient update failure');
    }

    const readiness = updateReadiness();
    if (!readiness.ok) {
      this.options.log.warn({ targetVersion: message.version, reason: readiness.reason }, 'auto-upgrade: cannot run update command non-interactively, skipping');
      this.reportStatusInBackground({ ...statusBase, phase: 'skipped', reason: readiness.reason });
      return;
    }

    if (this.upgradeInProgress) {
      this.options.log.info({}, 'auto-upgrade: upgrade already in progress, skipping');
      this.reportStatusInBackground({ ...statusBase, phase: 'skipped', reason: 'upgrade_in_progress' });
      return;
    }

    this.upgradeInProgress = true;
    try {
      await this.executeUpgrade(message.version, currentVersion, expectedHash, message.rolloutId);
    } catch (err) {
      this.options.log.error({ err }, 'auto-upgrade: upgrade failed');
      this.reportStatusInBackground({ ...statusBase, phase: 'failed', reason: 'upgrade_start_failed' });
      this.upgradeInProgress = false;
    }
  }

  private async executeUpgrade(
    targetVersion: string,
    currentVersion: string,
    expectedHash: string,
    rolloutId?: string,
  ): Promise<void> {
    this.options.log.info({ targetVersion }, 'auto-upgrade: quiescing bridge to reject new requests');
    await this.options.beginDrain?.();
    this.options.log.info({ targetVersion }, 'auto-upgrade: draining in-flight requests');
    await this.drain();

    const pendingState: UpgradeState = {
      ...(rolloutId ? { rolloutId } : {}),
      previousVersion: currentVersion,
      targetVersion,
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    };
    writeUpgradeState(this.options.configPath, pendingState);

    this.options.log.info({ targetVersion }, 'auto-upgrade: stopping drained bridge');
    this.options.stopBridge();

    this.options.log.info({ targetVersion }, 'auto-upgrade: spawning update process');
    const child = spawnUpdate(targetVersion, expectedHash);
    if (!child) {
      markUpgradeFailed(this.options.configPath, pendingState, currentVersion, 'spawn_update_unsupported_platform', this.options.log);
      process.exit(1);
      return;
    }

    let updaterStderr = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      updaterStderr = `${updaterStderr}${String(chunk)}`.slice(-4_000);
    });

    child.on('error', (err) => {
      const state = readUpgradeState(this.options.configPath);
      if (state?.status === 'pending') {
        markUpgradeFailed(this.options.configPath, state, currentVersion, 'spawn_update_failed', this.options.log, err instanceof Error ? err.message : String(err));
      }
      this.options.log.error({ err, targetVersion }, 'auto-upgrade: update process failed to start');
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      if (code === 0) {
        this.options.log.info({ targetVersion }, 'auto-upgrade: update process exited, restarting service');
        process.exit(0);
        return;
      }
      const state = readUpgradeState(this.options.configPath);
      if (state?.status === 'pending') {
        markUpgradeFailed(this.options.configPath, state, currentVersion, 'update_process_failed', this.options.log, updaterStderr.trim() || undefined);
      }
      this.options.log.error({ targetVersion, code, signal, updaterError: updaterStderr.trim() || undefined }, 'auto-upgrade: update process exited with failure');
      process.exit(1);
    });
  }

  private drain(): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      const check = () => {
        if (this.options.getInFlight() === 0 || Date.now() >= deadline) {
          if (Date.now() >= deadline && this.options.getInFlight() > 0) {
            this.options.log.warn({ inFlight: this.options.getInFlight() }, 'auto-upgrade: drain timeout, proceeding with upgrade');
          }
          resolve();
          return;
        }
        setTimeout(check, DRAIN_POLL_MS);
      };
      check();
    });
  }
}

export function checkCrashLoopOnStartup(configPath: string, log: AutoUpgradeOptions['log']): void {
  const state = readUpgradeState(configPath);
  if (state?.status !== 'pending') return;

  // The stable, root-owned macOS bootstrap checks the pending target and
  // increments the launch counter before it executes versioned runtime code.
  // This lets it recover even when the new server cannot be parsed or loaded.
  if (platform() === 'darwin' && process.env.PROVIDER_BOOTSTRAP_MANAGES_UPGRADE_START === '1') return;

  const currentVersion = getProviderNodeBuildInfo().version;
  if (currentVersion !== state.targetVersion) {
    markUpgradeFailed(configPath, state, currentVersion, 'target_version_not_installed', log);
    return;
  }

  state.startCount++;
  writeUpgradeState(configPath, state);

  if (state.startCount >= CRASH_LOOP_THRESHOLD) {
    log.error({ targetVersion: state.targetVersion, previousVersion: state.previousVersion, startCount: state.startCount },
      'auto-upgrade: crash-loop detected, rolling back');
    if (platform() === 'darwin') {
      rollbackPendingMacosUpgrade(configPath, 'crash_loop_detected');
    } else {
      writeUpgradeState(configPath, { ...state, status: 'rolled_back' });
      spawnUpdate(state.previousVersion);
    }
    process.exit(1);
  }

  log.info({ targetVersion: state.targetVersion, startCount: state.startCount }, 'auto-upgrade: post-upgrade startup check');
}

export function scheduleUpgradeVerification(
  configPath: string,
  log: AutoUpgradeOptions['log'],
  onStateChange?: (state: UpgradeState) => void,
): void {
  const state = readUpgradeState(configPath);
  if (state?.status !== 'pending') return;

  setTimeout(() => {
    const current = readUpgradeState(configPath);
    if (current && current.status === 'pending') {
      const currentVersion = getProviderNodeBuildInfo().version;
      if (currentVersion !== current.targetVersion) {
        markUpgradeFailed(configPath, current, currentVersion, 'target_version_not_installed', log);
        const failed = readUpgradeState(configPath);
        if (failed) onStateChange?.(failed);
        return;
      }
      const verified: UpgradeState = { ...current, status: 'verified' };
      writeUpgradeState(configPath, verified);
      onStateChange?.(verified);
      if (platform() === 'darwin') {
        pruneMacosRuntimes(configPath, [current.targetVersion, current.previousVersion]);
      }
      log.info({ targetVersion: current.targetVersion }, 'auto-upgrade: version verified stable');
    }
  }, STABILITY_TIMEOUT_MS);
}
