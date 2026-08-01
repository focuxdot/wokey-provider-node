import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultDreaminaCliPath, parseCliVersion } from './jimeng-auth.js';

const DREAMINA_CLI_DOWNLOAD_BASE =
  'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta';
const DREAMINA_VERSION_METADATA_URL =
  'https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/version.json';
const DREAMINA_CLI_DOWNLOAD_HOST = 'lf3-static.bytednsdoc.com';
const MAX_CLI_BYTES = 64 * 1024 * 1024;
const MAX_VERSION_METADATA_BYTES = 16 * 1024;
const VERSION_METADATA_DOWNLOAD_TIMEOUT_MS = 10_000;

const ARTIFACTS = {
  'darwin-arm64': 'dreamina_cli_darwin_arm64',
  'darwin-x64': 'dreamina_cli_darwin_amd64',
  'linux-arm64': 'dreamina_cli_linux_arm64',
  'linux-x64': 'dreamina_cli_linux_amd64',
  'win32-x64': 'dreamina_cli_windows_amd64.exe',
} as const;

type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export interface DreaminaCliInstallStatus {
  supported: boolean;
  status: 'idle' | 'installing' | 'succeeded' | 'failed';
  targetPath?: string;
  version?: string;
  errorCode?: string;
}

export interface DreaminaCliInstallResult {
  path: string;
  version: string;
  bytes: number;
  sha256: string;
}

export interface DreaminaCliInstallerOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  configuredPath?: string;
  fetchImpl?: typeof fetch;
  verifyBinary?: (path: string) => Promise<string>;
}

export class DreaminaCliInstallError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'DreaminaCliInstallError';
  }
}

export class DreaminaCliInstaller {
  private currentStatus: DreaminaCliInstallStatus;
  private installPromise?: Promise<DreaminaCliInstallResult>;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly targetPath?: string;
  private readonly homeDir: string;
  private versionMetadataPromise?: Promise<Buffer>;

  constructor(private readonly options: DreaminaCliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.homeDir = options.homeDir ?? homedir();
    const artifact = dreaminaCliArtifact(this.platform, this.arch);
    this.targetPath = artifact
      ? options.configuredPath ||
        defaultDreaminaCliPath(this.platform as SupportedPlatform, this.homeDir)
      : undefined;
    this.currentStatus = {
      supported: Boolean(artifact),
      status: 'idle',
      ...(this.targetPath ? { targetPath: this.targetPath } : {}),
    };
  }

  status(): DreaminaCliInstallStatus {
    return { ...this.currentStatus };
  }

  install(): Promise<DreaminaCliInstallResult> {
    if (!this.currentStatus.supported || !this.targetPath) {
      return Promise.reject(new DreaminaCliInstallError('jimeng_cli_install_unsupported'));
    }
    if (this.installPromise) return this.installPromise;
    this.currentStatus = { supported: true, status: 'installing', targetPath: this.targetPath };
    this.installPromise = this.performInstall()
      .then((result) => {
        this.currentStatus = {
          supported: true,
          status: 'succeeded',
          targetPath: result.path,
          version: result.version,
        };
        return result;
      })
      .catch((error: unknown) => {
        const normalized = normalizeInstallError(error);
        this.currentStatus = {
          supported: true,
          status: 'failed',
          targetPath: this.targetPath,
          errorCode: normalized.code,
        };
        throw normalized;
      })
      .finally(() => {
        this.installPromise = undefined;
      });
    return this.installPromise;
  }

  async prepareCommandHome(commandHomeDir: string): Promise<void> {
    const bytes = await this.ensureVersionMetadata();
    const targetPath = join(commandHomeDir, '.dreamina_cli', 'version.json');
    const installedPath = this.versionMetadataPath();
    if (targetPath === installedPath) return;
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    await writeFile(targetPath, bytes, { mode: 0o600 });
  }

  private async performInstall(): Promise<DreaminaCliInstallResult> {
    const artifact = dreaminaCliArtifact(this.platform, this.arch);
    if (!artifact || !this.targetPath) throw new DreaminaCliInstallError('jimeng_cli_install_unsupported');

    const url = `${DREAMINA_CLI_DOWNLOAD_BASE}/${artifact}`;
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, { redirect: 'follow' });
    } catch (error) {
      throw new DreaminaCliInstallError('jimeng_cli_install_download_failed', true, { cause: error });
    }
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url || url);
    } catch {
      throw new DreaminaCliInstallError('jimeng_cli_install_source_rejected');
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== DREAMINA_CLI_DOWNLOAD_HOST) {
      throw new DreaminaCliInstallError('jimeng_cli_install_source_rejected');
    }
    if (!response.ok) throw new DreaminaCliInstallError('jimeng_cli_install_download_failed', true);

    const expectedMd5 = response.headers.get('content-md5')?.trim();
    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (!expectedMd5) throw new DreaminaCliInstallError('jimeng_cli_install_integrity_missing');
    if (declaredLength === undefined || declaredLength <= 0 || declaredLength > MAX_CLI_BYTES) {
      throw new DreaminaCliInstallError('jimeng_cli_install_size_rejected');
    }

    let bytes: Buffer;
    try {
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength !== declaredLength || arrayBuffer.byteLength > MAX_CLI_BYTES) {
        throw new DreaminaCliInstallError('jimeng_cli_install_size_rejected');
      }
      bytes = Buffer.from(arrayBuffer);
    } catch (error) {
      if (error instanceof DreaminaCliInstallError) throw error;
      throw new DreaminaCliInstallError('jimeng_cli_install_download_failed', true, { cause: error });
    }

    const actualMd5 = createHash('md5').update(bytes).digest('base64');
    if (actualMd5 !== expectedMd5) throw new DreaminaCliInstallError('jimeng_cli_install_checksum_mismatch');
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const targetDirectory = dirname(this.targetPath);
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const stagingDirectory = await mkdtemp(join(targetDirectory, '.dreamina-install-'));
    const stagedPath = join(stagingDirectory, this.platform === 'win32' ? 'dreamina.exe' : 'dreamina');
    const backupPath = join(
      stagingDirectory,
      this.platform === 'win32' ? 'dreamina.previous.exe' : 'dreamina.previous',
    );
    let movedExisting = false;
    try {
      await writeFile(stagedPath, bytes, { mode: 0o700, flag: 'wx' });
      if (this.platform !== 'win32') await chmod(stagedPath, 0o755);
      const version = await (this.options.verifyBinary ?? verifyDreaminaBinary)(stagedPath);
      await this.ensureVersionMetadata(true);
      try {
        await stat(this.targetPath);
        await rename(this.targetPath, backupPath);
        movedExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await rename(stagedPath, this.targetPath);
      } catch (error) {
        if (movedExisting) await rename(backupPath, this.targetPath).catch(() => undefined);
        throw error;
      }
      return { path: this.targetPath, version, bytes: bytes.length, sha256 };
    } catch (error) {
      if (error instanceof DreaminaCliInstallError) throw error;
      throw new DreaminaCliInstallError('jimeng_cli_install_failed', true, { cause: error });
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private ensureVersionMetadata(forceRefresh = false): Promise<Buffer> {
    if (!forceRefresh && this.versionMetadataPromise) return this.versionMetadataPromise;
    const operation = this.loadOrDownloadVersionMetadata(forceRefresh).finally(() => {
      if (this.versionMetadataPromise === operation) this.versionMetadataPromise = undefined;
    });
    this.versionMetadataPromise = operation;
    return operation;
  }

  private async loadOrDownloadVersionMetadata(forceRefresh: boolean): Promise<Buffer> {
    const path = this.versionMetadataPath();
    if (!forceRefresh) {
      try {
        const existing = await readFile(path);
        validateVersionMetadata(existing);
        return existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof DreaminaCliInstallError) {
          // Replace malformed or partial metadata with a fresh official copy.
        } else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new DreaminaCliInstallError('jimeng_cli_version_metadata_failed', true, { cause: error });
        }
      }
    }

    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(DREAMINA_VERSION_METADATA_URL, {
        redirect: 'follow',
        signal: AbortSignal.timeout(VERSION_METADATA_DOWNLOAD_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DreaminaCliInstallError('jimeng_cli_version_metadata_download_failed', true, { cause: error });
    }
    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url || DREAMINA_VERSION_METADATA_URL);
    } catch {
      throw new DreaminaCliInstallError('jimeng_cli_install_source_rejected');
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== DREAMINA_CLI_DOWNLOAD_HOST) {
      throw new DreaminaCliInstallError('jimeng_cli_install_source_rejected');
    }
    if (!response.ok) throw new DreaminaCliInstallError('jimeng_cli_version_metadata_download_failed', true);
    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (declaredLength === undefined || declaredLength <= 0 || declaredLength > MAX_VERSION_METADATA_BYTES) {
      throw new DreaminaCliInstallError('jimeng_cli_version_metadata_invalid');
    }
    let bytes: Buffer;
    try {
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength !== declaredLength || arrayBuffer.byteLength > MAX_VERSION_METADATA_BYTES) {
        throw new DreaminaCliInstallError('jimeng_cli_version_metadata_invalid');
      }
      bytes = Buffer.from(arrayBuffer);
      validateVersionMetadata(bytes);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { mode: 0o600 });
    } catch (error) {
      if (error instanceof DreaminaCliInstallError) throw error;
      throw new DreaminaCliInstallError('jimeng_cli_version_metadata_failed', true, { cause: error });
    }
    return bytes;
  }

  private versionMetadataPath(): string {
    return join(this.homeDir, '.dreamina_cli', 'version.json');
  }
}

export function dreaminaCliArtifact(platform: NodeJS.Platform, arch: string): string | undefined {
  return ARTIFACTS[`${platform}-${arch}` as keyof typeof ARTIFACTS];
}

function parseContentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeInstallError(error: unknown): DreaminaCliInstallError {
  return error instanceof DreaminaCliInstallError
    ? error
    : new DreaminaCliInstallError('jimeng_cli_install_failed', true, { cause: error });
}

function validateVersionMetadata(bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_VERSION_METADATA_BYTES) {
    throw new DreaminaCliInstallError('jimeng_cli_version_metadata_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DreaminaCliInstallError('jimeng_cli_version_metadata_invalid');
  }
  const version = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).version
    : undefined;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof version !== 'string' ||
    !version ||
    version.length > 128
  ) {
    throw new DreaminaCliInstallError('jimeng_cli_version_metadata_invalid');
  }
}

function verifyDreaminaBinary(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new DreaminaCliInstallError('jimeng_cli_install_validation_failed'));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 16 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 16 * 1024) stderr += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(new DreaminaCliInstallError('jimeng_cli_install_validation_failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const version = parseCliVersion(`${stdout || stderr}`);
      if (code !== 0 || !version || version.length > 128) {
        reject(new DreaminaCliInstallError('jimeng_cli_install_validation_failed'));
        return;
      }
      resolve(version);
    });
  });
}
