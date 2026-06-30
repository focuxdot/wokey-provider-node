#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = process.env.ROOT_DIR || process.cwd();

function bumpPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`package version must be x.y.z before packaging, got ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const packagePath = join(rootDir, 'package.json');
const lockPath = join(rootDir, 'package-lock.json');
const pkg = readJson(packagePath);
const nextVersion = bumpPatch(pkg.version);
pkg.version = nextVersion;
writeJson(packagePath, pkg);

const lock = readJson(lockPath);
lock.version = nextVersion;
if (lock.packages?.['']) {
  lock.packages[''].version = nextVersion;
}
writeJson(lockPath, lock);

const shellInstallerPath = join(rootDir, 'packaging', 'install.sh');
const shellInstaller = readFileSync(shellInstallerPath, 'utf8')
  .replace(/VERSION="\$\{WOKEY_PROVIDER_NODE_VERSION:-\d+\.\d+\.\d+\}"/, `VERSION="\${WOKEY_PROVIDER_NODE_VERSION:-${nextVersion}}"`);
writeFileSync(shellInstallerPath, shellInstaller);

const powershellInstallerPath = join(rootDir, 'packaging', 'install.ps1');
const powershellInstaller = readFileSync(powershellInstallerPath, 'utf8')
  .replace(/else \{ "\d+\.\d+\.\d+" \}/, `else { "${nextVersion}" }`);
writeFileSync(powershellInstallerPath, powershellInstaller);

console.log(`Bumped Provider Node package version to ${nextVersion}`);
