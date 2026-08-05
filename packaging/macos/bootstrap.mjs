#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const configPath = process.env.PROVIDER_CONFIG_PATH;
if (!configPath) process.exit(0);

const dataDir = dirname(configPath);
const statePath = join(dataDir, 'upgrade-state.json');
const runtimeRoot = join(dataDir, 'runtime');
const versionsRoot = join(runtimeRoot, 'versions');
const currentLink = join(runtimeRoot, 'current');

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

function writeState(state) {
  const temporaryPath = `${statePath}.bootstrap-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

function currentVersion() {
  try {
    if (!lstatSync(currentLink).isSymbolicLink()) return undefined;
    const target = resolve(runtimeRoot, readlinkSync(currentLink));
    if (!target.startsWith(`${resolve(versionsRoot)}/`)) return undefined;
    return readJson(join(target, 'package.json'))?.version;
  } catch {
    return undefined;
  }
}

function switchCurrent(version) {
  const target = join(versionsRoot, version);
  if (!existsSync(join(target, 'package.json'))) return false;
  const temporaryLink = join(runtimeRoot, `.current-bootstrap-${process.pid}`);
  rmSync(temporaryLink, { force: true });
  symlinkSync(join('versions', version), temporaryLink, 'dir');
  renameSync(temporaryLink, currentLink);
  return true;
}

const state = readJson(statePath);
if (!state || state.status !== 'pending') process.exit(0);

const observedVersion = currentVersion();
const nextStartCount = Number(state.startCount || 0) + 1;
if (observedVersion !== state.targetVersion || nextStartCount >= 3) {
  const reason = observedVersion !== state.targetVersion ? 'target_version_not_active' : 'crash_loop_detected';
  if (switchCurrent(state.previousVersion)) {
    writeState({ ...state, startCount: nextStartCount, status: 'rolled_back', failureReason: reason, observedVersion });
    process.stderr.write(`Provider Node rolled back from ${state.targetVersion} to ${state.previousVersion}: ${reason}\n`);
    process.exit(0);
  }
  writeState({ ...state, startCount: nextStartCount, status: 'failed', failureReason: `${reason}:previous_runtime_missing`, observedVersion });
  process.stderr.write(`Provider Node could not roll back ${state.targetVersion}: previous runtime ${state.previousVersion} is missing\n`);
  process.exit(1);
}

writeState({ ...state, startCount: nextStartCount, observedVersion });
