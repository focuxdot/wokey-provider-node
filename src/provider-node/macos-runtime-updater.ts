import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify, type Bundle } from 'sigstore';
import {
  assertRuntimeVersion,
  currentRuntimePath,
  macosRuntimeLayout,
  pruneMacosRuntimes,
  readRuntimeVersion,
  runtimeVersionPath,
  switchCurrentRuntime,
} from './macos-runtime-layout.js';
import { readUpgradeState, writeUpgradeState } from './upgrade-state.js';

const REPOSITORY = 'focuxdot/wokey-provider-node';
const GITHUB_API = `https://api.github.com/repos/${REPOSITORY}`;
const OFFICIAL_ISSUER = 'https://token.actions.githubusercontent.com';
const LOCK_STALE_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const RETRY_DELAY_MS = 5 * 60_000;

interface UpdateOptions {
  configPath: string;
  targetVersion?: string;
  expectedSha256?: string;
  architecture?: string;
  releaseBaseUrl?: string;
  allowTestReleaseBaseUrl?: boolean;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function updateErrorDetail(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return detail.replace(/[\r\n]+/g, ' ').slice(0, 1_000);
}

function updateErrorIsRetryable(error: unknown): boolean {
  const detail = updateErrorDetail(error);
  if (/SHA-256|signed checksums|signature|certificate|identity|transparency|invalid checksums|version does not match|unsafe runtime/i.test(detail)) {
    return false;
  }
  return /download failed \((?:408|429|5\d\d)\)|fetch failed|timeout|timed out|ECONN|ENET|EAI_AGAIN|socket|TUF/i.test(detail);
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { 'user-agent': 'wokey-provider-node-updater' },
  });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function latestVersion(): Promise<string> {
  const response = await fetch(`${GITHUB_API}/releases/latest`, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'wokey-provider-node-updater' },
  });
  if (!response.ok) throw new Error(`failed to resolve latest release (${response.status})`);
  const body = await response.json() as { tag_name?: unknown };
  if (typeof body.tag_name !== 'string') throw new Error('latest release did not include tag_name');
  return assertRuntimeVersion(body.tag_name.replace(/^v/, ''));
}

function parseChecksums(manifest: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of manifest.toString('utf8').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const match = rawLine.match(/^([a-fA-F0-9]{64})\s{2}([^/\\]+)$/);
    if (!match?.[1] || !match[2]) throw new Error(`invalid checksums.txt line: ${rawLine}`);
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function acquireUpdateLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!existsSync(lockPath)) throw error;
    const age = Date.now() - statSync(lockPath).mtimeMs;
    let ownerIsAlive = false;
    try {
      const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')) as { pid?: unknown };
      if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
        process.kill(owner.pid, 0);
        ownerIsAlive = true;
      }
    } catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code === 'EPERM') ownerIsAlive = true;
    }
    if (ownerIsAlive || age <= LOCK_STALE_MS) throw new Error('another Provider Node update is already running');
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath, { mode: 0o700 });
  }
  writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  return () => rmSync(lockPath, { recursive: true, force: true });
}

function validateArchiveEntries(archivePath: string): void {
  const listing = execFileSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8' });
  for (const rawEntry of listing.split(/\r?\n/)) {
    if (!rawEntry) continue;
    const entry = rawEntry.replace(/^\.\//, '');
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`unsafe runtime archive entry: ${rawEntry}`);
    }
  }
}

function verifyRuntime(runtimePath: string, version: string): void {
  if (readRuntimeVersion(runtimePath) !== version) throw new Error('runtime package version does not match release version');
  for (const relativePath of ['dist/provider-node/server.js', 'dist/provider-node/macos-runtime-updater.js', 'bin/provider-node-cli.mjs']) {
    if (!existsSync(join(runtimePath, relativePath))) throw new Error(`runtime is missing ${relativePath}`);
  }
}

export async function installMacosRuntime(options: UpdateOptions): Promise<{ previousVersion: string; targetVersion: string }> {
  const architecture = options.architecture ?? process.arch;
  if (architecture !== 'arm64' && architecture !== 'x64') throw new Error(`unsupported macOS architecture: ${architecture}`);
  const targetVersion = assertRuntimeVersion(options.targetVersion ?? await latestVersion());
  const customBase = options.releaseBaseUrl;
  if (customBase && !options.allowTestReleaseBaseUrl) throw new Error('custom release base URL is not allowed');
  const releaseBase = (customBase ?? `https://github.com/${REPOSITORY}/releases/download/v${targetVersion}`).replace(/\/$/, '');
  const assetName = `WokeyProviderNode-macos-runtime-${architecture}-${targetVersion}.tar.gz`;
  const manifestUrl = `${releaseBase}/checksums.txt`;
  const bundleUrl = `${releaseBase}/checksums.txt.sigstore.json`;
  const layout = macosRuntimeLayout(options.configPath);
  const release = acquireUpdateLock(layout.lock);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'wokey-runtime-update-'));
  try {
    const [manifest, bundleBytes] = await Promise.all([download(manifestUrl), download(bundleUrl)]);
    const bundle = JSON.parse(bundleBytes.toString('utf8')) as Bundle;
    await verify(bundle, manifest, {
      certificateIssuer: OFFICIAL_ISSUER,
      certificateIdentityURI: `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/tags/v${targetVersion}`,
      ctLogThreshold: 1,
      tlogThreshold: 1,
    });
    const signedHash = parseChecksums(manifest).get(assetName);
    if (!signedHash) throw new Error(`signed checksums do not include ${assetName}`);
    if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== signedHash) {
      throw new Error('Platform artifact hash does not match the signed release manifest');
    }
    const archive = await download(`${releaseBase}/${assetName}`);
    if (sha256(archive) !== signedHash) throw new Error('downloaded runtime archive SHA-256 mismatch');

    const archivePath = join(temporaryDirectory, basename(assetName));
    writeFileSync(archivePath, archive, { mode: 0o600 });
    validateArchiveEntries(archivePath);
    const stagingPath = join(temporaryDirectory, 'runtime');
    mkdirSync(stagingPath, { mode: 0o700 });
    execFileSync('/usr/bin/tar', ['-xzf', archivePath, '-C', stagingPath], { stdio: 'pipe' });
    verifyRuntime(stagingPath, targetVersion);

    mkdirSync(layout.versions, { recursive: true, mode: 0o700 });
    const previousPath = currentRuntimePath(options.configPath);
    const previousVersion = previousPath ? readRuntimeVersion(previousPath) : undefined;
    if (!previousVersion) throw new Error('current runtime is missing or invalid; reinstall the migration package');
    pruneMacosRuntimes(options.configPath, [previousVersion, targetVersion]);
    const installedPath = runtimeVersionPath(options.configPath, targetVersion);
    if (existsSync(installedPath) && installedPath !== previousPath) {
      rmSync(installedPath, { recursive: true, force: true });
    }
    if (!existsSync(installedPath)) renameSync(stagingPath, installedPath);
    else verifyRuntime(installedPath, targetVersion);
    if (previousVersion === targetVersion) return { previousVersion, targetVersion };

    writeUpgradeState(options.configPath, {
      previousVersion,
      targetVersion,
      upgradedAt: new Date().toISOString(),
      startCount: 0,
      status: 'pending',
    });
    switchCurrentRuntime(options.configPath, targetVersion);
    return { previousVersion, targetVersion };
  } catch (error) {
    const state = readUpgradeState(options.configPath);
    if (state?.status === 'pending' && state.targetVersion === targetVersion) {
      const retryable = updateErrorIsRetryable(error);
      writeUpgradeState(options.configPath, {
        ...state,
        status: 'failed',
        failureReason: retryable ? 'runtime_update_retryable' : 'runtime_update_rejected',
        failureDetail: updateErrorDetail(error),
        failedAt: new Date().toISOString(),
        ...(retryable ? { retryAfter: new Date(Date.now() + RETRY_DELAY_MS).toISOString() } : {}),
        retryable,
      });
    }
    throw error;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    release();
  }
}

async function main(): Promise<void> {
  const configPath = process.env.PROVIDER_CONFIG_PATH
    ?? join(process.env.HOME ?? '', 'Library', 'Application Support', 'Wokey Provider Node', 'provider-node.json');
  const result = await installMacosRuntime({
    configPath,
    targetVersion: process.env.WOKEY_PROVIDER_NODE_VERSION,
    expectedSha256: process.env.WOKEY_PROVIDER_NODE_EXPECTED_SHA256,
    releaseBaseUrl: process.env.WOKEY_PROVIDER_NODE_TEST_RELEASE_BASE_URL,
    allowTestReleaseBaseUrl: process.env.WOKEY_PROVIDER_NODE_ALLOW_TEST_RELEASE_BASE_URL === '1',
  });
  process.stdout.write(`Installed Wokey Provider Node ${result.targetVersion} (previous ${result.previousVersion}).\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`Provider Node update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
