import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import type { PlatformUpgradeAvailable } from '../shared/protocol.js';
import { getProviderNodeBuildInfo } from './build-info.js';

const DRAIN_POLL_MS = 500;
const DRAIN_TIMEOUT_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;
const STABILITY_TIMEOUT_MS = 60_000;

interface UpgradeState {
  previousVersion: string;
  targetVersion: string;
  upgradedAt: string;
  startCount: number;
  status: 'pending' | 'verified' | 'rolled_back';
}

export interface AutoUpgradeOptions {
  configPath: string;
  getInFlight: () => number;
  stopBridge: () => void;
  log: { info: (obj: Record<string, unknown>, msg: string) => void; warn: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void };
}

function upgradeStatePath(configPath: string): string {
  return join(dirname(configPath), 'upgrade-state.json');
}

function readUpgradeState(configPath: string): UpgradeState | undefined {
  const p = upgradeStatePath(configPath);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as UpgradeState;
  } catch {
    return undefined;
  }
}

function writeUpgradeState(configPath: string, state: UpgradeState): void {
  writeFileSync(upgradeStatePath(configPath), JSON.stringify(state, null, 2), 'utf8');
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
    if (t[i]! > c[i]!) return true;
    if (t[i]! < c[i]!) return false;
  }
  return false;
}

function platformKey(): string {
  return `${platform()}-${arch()}`;
}

function isDocker(): boolean {
  return process.env.PROVIDER_NODE_DOCKER === '1' || existsSync('/.dockerenv');
}

function spawnUpdate(version: string): void {
  const env = { ...process.env, WOKEY_PROVIDER_NODE_VERSION: version };
  const plat = platform();
  let cmd: string;
  let args: string[];

  if (plat === 'darwin') {
    cmd = '/usr/local/wokey-provider-node/bin/provider-node';
    args = ['update'];
  } else if (plat === 'linux') {
    cmd = '/usr/local/bin/wokey-node';
    args = ['update'];
  } else if (plat === 'win32') {
    cmd = 'powershell.exe';
    const scriptPath = join(process.env.LOCALAPPDATA || '', 'WokeyProviderNode', 'bin', 'wokey-node.ps1');
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, 'update'];
  } else {
    return;
  }

  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env });
  child.unref();
}

export class AutoUpgradeController {
  private upgradeInProgress = false;
  private readonly options: AutoUpgradeOptions;

  constructor(options: AutoUpgradeOptions) {
    this.options = options;
  }

  async handleUpgradeAvailable(message: PlatformUpgradeAvailable): Promise<void> {
    const currentVersion = getProviderNodeBuildInfo().version;
    this.options.log.info({ targetVersion: message.version, currentVersion, urgent: message.urgent }, 'auto-upgrade: received upgrade_available');

    if (isDocker()) {
      this.options.log.info({}, 'auto-upgrade: skipping in Docker environment');
      return;
    }

    if (!isNewerVersion(message.version, currentVersion)) {
      this.options.log.info({}, 'auto-upgrade: target version is not newer, skipping');
      return;
    }

    const key = platformKey();
    const expectedHash = message.hashes[key];
    if (!expectedHash) {
      this.options.log.warn({ key, availableKeys: Object.keys(message.hashes) }, 'auto-upgrade: no hash for this platform');
      return;
    }
    this.options.log.info({ key, expectedHash }, 'auto-upgrade: platform-provided artifact hash (verified by install script checksums.txt)');

    if (this.upgradeInProgress) {
      this.options.log.info({}, 'auto-upgrade: upgrade already in progress, skipping');
      return;
    }

    this.upgradeInProgress = true;
    try {
      await this.executeUpgrade(message.version, currentVersion);
    } catch (err) {
      this.options.log.error({ err }, 'auto-upgrade: upgrade failed');
      this.upgradeInProgress = false;
    }
  }

  private async executeUpgrade(targetVersion: string, currentVersion: string): Promise<void> {
    this.options.log.info({ targetVersion }, 'auto-upgrade: stopping bridge to reject new requests');
    this.options.stopBridge();

    this.options.log.info({ targetVersion }, 'auto-upgrade: draining in-flight requests');
    await this.drain();

    writeUpgradeState(this.options.configPath, {
      previousVersion: currentVersion,
      targetVersion,
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    });

    this.options.log.info({ targetVersion }, 'auto-upgrade: spawning update process');
    spawnUpdate(targetVersion);
    process.exit(0);
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
  if (!state || state.status !== 'pending') return;

  state.startCount++;
  writeUpgradeState(configPath, state);

  if (state.startCount >= CRASH_LOOP_THRESHOLD) {
    log.error({ targetVersion: state.targetVersion, previousVersion: state.previousVersion, startCount: state.startCount },
      'auto-upgrade: crash-loop detected, rolling back');
    writeUpgradeState(configPath, { ...state, status: 'rolled_back' });
    spawnUpdate(state.previousVersion);
    process.exit(1);
  }

  log.info({ targetVersion: state.targetVersion, startCount: state.startCount }, 'auto-upgrade: post-upgrade startup check');
}

export function scheduleUpgradeVerification(configPath: string, log: AutoUpgradeOptions['log']): void {
  const state = readUpgradeState(configPath);
  if (!state || state.status !== 'pending') return;

  setTimeout(() => {
    const current = readUpgradeState(configPath);
    if (current && current.status === 'pending') {
      writeUpgradeState(configPath, { ...current, status: 'verified' });
      log.info({ targetVersion: current.targetVersion }, 'auto-upgrade: version verified stable');
    }
  }, STABILITY_TIMEOUT_MS);
}
