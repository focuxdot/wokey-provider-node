import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CursorAuthControlProtocolVersion,
  CursorAuthFailureStage,
  PlatformCursorAuthCancel,
  PlatformCursorAuthStart,
  ProviderCursorAuthCompleted,
  ProviderCursorAuthFailed,
  ProviderCursorAuthStarted,
} from '../shared/protocol.js';
import { CURSOR_AUTH_CONTROL_PROTOCOL_VERSION } from '../shared/protocol.js';

const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const VALIDATION_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 1_000;
const NATIVE_COMMAND_TIMEOUT_MS = 15_000;
const CURSOR_KEYCHAIN_ACCOUNT = 'cursor-user';
const CURSOR_ACCESS_TOKEN_SERVICE = 'cursor-access-token';
const CURSOR_REFRESH_TOKEN_SERVICE = 'cursor-refresh-token';

export interface CursorAgentDescriptor {
  path: string;
  version: string;
}

export type CursorAuthEvent =
  | ProviderCursorAuthStarted
  | ProviderCursorAuthCompleted
  | ProviderCursorAuthFailed;

interface RunningFlow {
  cancelled: boolean;
  process?: ChildProcess;
  cli: CursorAgentDescriptor;
}

export interface CursorAuthorizationHandlerOptions {
  cli?: CursorAgentDescriptor;
  resolveCli?: () => CursorAgentDescriptor | undefined;
  getIdentity: () => { nodeId: string; providerId: string };
  tempParentDir?: string;
  now?: () => number;
  validateCredential?: boolean;
  platform?: NodeJS.Platform;
  nativeHomeDir?: string;
  runNativeCommand?: NativeCommandRunner;
}

interface NativeCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

type NativeCommandRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: Buffer; timeoutMs: number },
) => Promise<NativeCommandResult>;

interface CursorTokenMaterial {
  accessToken: string;
  refreshToken?: string;
}

interface CursorKeychainSnapshot {
  accessToken?: Buffer;
  refreshToken?: Buffer;
}

export class CursorAuthorizationHandler {
  private readonly flows = new Map<string, RunningFlow>();
  private readonly now: () => number;

  constructor(private readonly options: CursorAuthorizationHandlerOptions) {
    this.now = options.now ?? Date.now;
  }

  capability() {
    return {
      protocolVersions: [CURSOR_AUTH_CONTROL_PROTOCOL_VERSION],
      // Capability is enabled on every current node. Binary resolution is
      // intentionally lazy so a missing CLI produces an actionable start
      // failure instead of hiding Cursor from the Provider UI.
      cliVersion: this.options.cli?.version ?? 'lazy',
    } satisfies {
      protocolVersions: CursorAuthControlProtocolVersion[];
      cliVersion: string;
    };
  }

  start(message: PlatformCursorAuthStart, emit: (event: CursorAuthEvent) => void): void {
    const identity = this.options.getIdentity();
    if (
      message.protocolVersion !== CURSOR_AUTH_CONTROL_PROTOCOL_VERSION
      || message.nodeId !== identity.nodeId
      || message.providerId !== identity.providerId
      || !message.flowId
      || this.flows.has(message.flowId)
      || this.flows.size > 0
    ) {
      emit(failedEvent(message, 'launch', 'cursor_auth_start_invalid', false));
      return;
    }
    const cli = this.options.cli ?? this.options.resolveCli?.();
    if (!cli) {
      emit(failedEvent(message, 'launch', 'cursor_cli_unavailable', false));
      return;
    }
    const flow: RunningFlow = { cancelled: false, cli };
    this.flows.set(message.flowId, flow);
    void this.run(message, flow, emit).finally(() => this.flows.delete(message.flowId));
  }

  cancel(message: PlatformCursorAuthCancel): boolean {
    const identity = this.options.getIdentity();
    if (message.protocolVersion !== CURSOR_AUTH_CONTROL_PROTOCOL_VERSION || message.nodeId !== identity.nodeId) {
      return false;
    }
    const flow = this.flows.get(message.flowId);
    if (!flow) return false;
    flow.cancelled = true;
    terminateProcess(flow.process);
    return true;
  }

  cancelAll(): void {
    for (const flow of this.flows.values()) {
      flow.cancelled = true;
      terminateProcess(flow.process);
    }
  }

  private async run(
    message: PlatformCursorAuthStart,
    flow: RunningFlow,
    emit: (event: CursorAuthEvent) => void,
  ): Promise<void> {
    const rootDir = await mkdtemp(join(this.options.tempParentDir ?? tmpdir(), 'wokey-cursor-auth-'));
    const homeDir = join(rootDir, 'home');
    let stage: CursorAuthFailureStage = 'launch';
    let terminalEvent: ProviderCursorAuthCompleted | ProviderCursorAuthFailed | undefined;
    let keychain: MacCursorKeychainStore | undefined;
    let keychainSnapshot: CursorKeychainSnapshot | undefined;
    try {
      await chmod(rootDir, 0o700);
      await Promise.all([
        mkdir(homeDir, { mode: 0o700 }),
        mkdir(join(rootDir, 'config'), { mode: 0o700 }),
        mkdir(join(rootDir, 'data'), { mode: 0o700 }),
        mkdir(join(rootDir, 'cache'), { mode: 0o700 }),
      ]);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: join(rootDir, 'config'),
        XDG_DATA_HOME: join(rootDir, 'data'),
        XDG_CACHE_HOME: join(rootDir, 'cache'),
        NO_OPEN_BROWSER: '1',
        // A host-level API key or endpoint override must not satisfy validation
        // or receive the newly authorized account token by accident.
        CURSOR_API_KEY: undefined,
        CURSOR_API_ENDPOINT: undefined,
      };

      const platform = this.options.platform ?? process.platform;
      if (platform === 'darwin') {
        keychain = new MacCursorKeychainStore({
          isolatedHomeDir: homeDir,
          nativeHomeDir: this.options.nativeHomeDir ?? homedir(),
          env,
          run: this.options.runNativeCommand ?? runNativeCommand,
        });
        keychainSnapshot = await keychain.snapshot();
      }

      stage = 'browser_authorization';
      await this.runLogin(message, flow, env, emit);
      assertNotCancelled(flow);

      stage = 'credential_capture';
      const tokenMaterial = keychain ? await keychain.capture() : undefined;
      const bundle = await readCursorCredentialBundle(
        join(rootDir, 'config', 'cursor', 'cli-config.json'),
        flow.cli.version,
        tokenMaterial,
      );

      if (this.options.validateCredential !== false) {
        stage = 'credential_validation';
        await runValidation(flow.cli.path, env, flow);
      }
      terminalEvent = {
        type: 'provider.cursor_auth_completed',
        protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
        requestId: message.requestId,
        flowId: message.flowId,
        nodeId: message.nodeId,
        encodedCredentialBundle: JSON.stringify(bundle),
      };
    } catch (error) {
      terminalEvent = failedEvent(
        message,
        stage,
        cursorAuthErrorCode(error, flow),
        retryableCursorAuthError(error, flow),
        commandDiagnostic(error),
        error instanceof CursorCommandError ? error.exitCode : undefined,
      );
    } finally {
      terminateProcess(flow.process);
      flow.process = undefined;
      if (keychain) {
        try {
          await keychain.restore(keychainSnapshot ?? {});
        } catch (error) {
          terminalEvent = failedEvent(
            message,
            'cleanup',
            'cursor_auth_keychain_restore_failed',
            false,
            safeDiagnostic(error instanceof Error ? error.message : String(error)),
          );
        }
      }
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch (error) {
        terminalEvent = failedEvent(
          message,
          'cleanup',
          'cursor_auth_cleanup_failed',
          true,
          safeDiagnostic(error instanceof Error ? error.message : String(error)),
        );
      }
    }
    if (terminalEvent) emit(terminalEvent);
  }

  private runLogin(
    message: PlatformCursorAuthStart,
    flow: RunningFlow,
    env: NodeJS.ProcessEnv,
    emit: (event: CursorAuthEvent) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(flow.cli.path, ['login'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      flow.process = child;
      let output = '';
      let started = false;
      const deadlineMs = Math.max(1_000, Math.min(message.deadlineMs, 15 * 60_000));
      const expiresAt = new Date(this.now() + deadlineMs).toISOString();
      const onChunk = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
        if (started) return;
        let authorizationUrl: string | undefined;
        try {
          authorizationUrl = cursorAuthorizationUrl(output);
        } catch (error) {
          terminateProcess(child);
          reject(error);
          return;
        }
        if (!authorizationUrl) return;
        started = true;
        emit({
          type: 'provider.cursor_auth_started',
          protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
          requestId: message.requestId,
          flowId: message.flowId,
          nodeId: message.nodeId,
          authorizationUrl,
          expiresAt,
        });
      };
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      const timer = setTimeout(() => {
        terminateProcess(child);
        reject(new CursorCommandError('cursor_auth_expired', undefined, output));
      }, deadlineMs);
      timer.unref?.();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(new CursorCommandError('cursor_cli_launch_failed', undefined, error.message));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        flow.process = undefined;
        if (flow.cancelled) return reject(new CursorCommandError('cursor_auth_cancelled'));
        if (code !== 0) {
          return reject(new CursorCommandError(
            signal ? 'cursor_auth_interrupted' : 'cursor_auth_login_failed',
            typeof code === 'number' ? code : undefined,
            output,
          ));
        }
        if (!started) return reject(new CursorCommandError('cursor_auth_url_missing', code ?? undefined, output));
        resolve();
      });
    });
  }
}

class CursorCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly diagnostic?: string,
  ) {
    super(message);
  }
}

async function readCursorCredentialBundle(
  path: string,
  cliVersion: string,
  tokenMaterial?: CursorTokenMaterial,
) {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new Error('cursor_credential_file_missing');
  if (info.size <= 0 || info.size > MAX_CONFIG_BYTES) throw new Error('cursor_credential_file_invalid');
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const authInfo = parsed.authInfo;
  if (!authInfo || typeof authInfo !== 'object' || Array.isArray(authInfo)) {
    throw new Error('cursor_credential_auth_info_missing');
  }
  const record = authInfo as Record<string, unknown>;
  const accessToken = tokenMaterial?.accessToken
    ?? requiredString(record.authId, 'cursor_credential_access_token_missing', 16_384);
  const accountId = typeof record.userId === 'number' && Number.isSafeInteger(record.userId)
    ? String(record.userId)
    : requiredString(record.userId, 'cursor_credential_account_id_missing', 512);
  const accountEmail = typeof record.email === 'string' && record.email.trim()
    ? record.email.trim().slice(0, 320)
    : undefined;
  return {
    version: 1 as const,
    accessToken,
    ...(tokenMaterial?.refreshToken ? { refreshToken: tokenMaterial.refreshToken } : {}),
    accountId,
    ...(accountEmail ? { accountEmail } : {}),
    authorizedClientVersion: cliVersion,
  };
}

class MacCursorKeychainStore {
  private prepared = false;

  constructor(private readonly options: {
    isolatedHomeDir: string;
    nativeHomeDir: string;
    env: NodeJS.ProcessEnv;
    run: NativeCommandRunner;
  }) {}

  async snapshot(): Promise<CursorKeychainSnapshot> {
    await this.prepare();
    return {
      accessToken: await this.read(CURSOR_ACCESS_TOKEN_SERVICE),
      refreshToken: await this.read(CURSOR_REFRESH_TOKEN_SERVICE),
    };
  }

  async capture(): Promise<CursorTokenMaterial> {
    const snapshot = await this.snapshot();
    if (!snapshot.accessToken?.length) throw new Error('cursor_credential_access_token_missing');
    const accessToken = boundedToken(snapshot.accessToken, 'cursor_credential_access_token_invalid');
    const refreshToken = snapshot.refreshToken?.length
      ? boundedToken(snapshot.refreshToken, 'cursor_credential_refresh_token_invalid')
      : undefined;
    return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
  }

  async restore(snapshot: CursorKeychainSnapshot): Promise<void> {
    await this.prepare();
    await this.restoreItem(CURSOR_ACCESS_TOKEN_SERVICE, snapshot.accessToken);
    await this.restoreItem(CURSOR_REFRESH_TOKEN_SERVICE, snapshot.refreshToken);
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    const nativeKeychain = join(this.options.nativeHomeDir, 'Library', 'Keychains', 'login.keychain-db');
    const metadata = await lstat(nativeKeychain);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('cursor_login_keychain_invalid');
    }
    const isolatedKeychainsDir = join(this.options.isolatedHomeDir, 'Library', 'Keychains');
    await mkdir(isolatedKeychainsDir, { recursive: true, mode: 0o700 });
    await symlink(nativeKeychain, join(isolatedKeychainsDir, 'login.keychain-db'), 'file');
    this.prepared = true;
  }

  private async read(service: string): Promise<Buffer | undefined> {
    const result = await this.options.run(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', CURSOR_KEYCHAIN_ACCOUNT, '-w'],
      { env: this.options.env, timeoutMs: NATIVE_COMMAND_TIMEOUT_MS },
    );
    if (result.code === 44) return undefined;
    if (result.code !== 0) throw new Error('cursor_keychain_read_failed');
    return trimSingleTrailingNewline(result.stdout);
  }

  private async restoreItem(service: string, value?: Buffer): Promise<void> {
    if (!value) {
      const result = await this.options.run(
        '/usr/bin/security',
        ['delete-generic-password', '-s', service, '-a', CURSOR_KEYCHAIN_ACCOUNT],
        { env: this.options.env, timeoutMs: NATIVE_COMMAND_TIMEOUT_MS },
      );
      if (result.code !== 0 && result.code !== 44) throw new Error('cursor_keychain_restore_failed');
      return;
    }
    const token = boundedToken(value, 'cursor_keychain_snapshot_invalid');
    const command = `${[
      'add-generic-password',
      '-U',
      '-s', quoteSecurityInteractive(service),
      '-a', quoteSecurityInteractive(CURSOR_KEYCHAIN_ACCOUNT),
      '-w', quoteSecurityInteractive(token),
    ].join(' ')}\n`;
    const result = await this.options.run(
      '/usr/bin/security',
      ['-i'],
      { env: this.options.env, input: Buffer.from(command, 'utf8'), timeoutMs: NATIVE_COMMAND_TIMEOUT_MS },
    );
    if (result.code !== 0) throw new Error('cursor_keychain_restore_failed');
  }
}

function runNativeCommand(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: Buffer; timeoutMs: number },
): Promise<NativeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.stdin?.end(options.input);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('cursor_keychain_command_timeout'));
    }, options.timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

function boundedToken(value: Buffer, code: string): string {
  if (value.length <= 0 || value.length > 16_384) throw new Error(code);
  const token = value.toString('utf8');
  if (!token.trim() || token.includes('\0') || token.includes('\n') || token.includes('\r')) throw new Error(code);
  return token;
}

function trimSingleTrailingNewline(value: Buffer): Buffer {
  if (value.length >= 2 && value[value.length - 2] === 13 && value[value.length - 1] === 10) {
    return value.subarray(0, -2);
  }
  if (value.length >= 1 && value[value.length - 1] === 10) return value.subarray(0, -1);
  return value;
}

function quoteSecurityInteractive(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runValidation(
  executable: string,
  env: NodeJS.ProcessEnv,
  flow: RunningFlow,
): Promise<void> {
  const result = await runCommand(executable, ['models'], env, flow, VALIDATION_TIMEOUT_MS);
  if (!/\S/.test(result.stdout)) {
    throw new CursorCommandError('cursor_credential_validation_failed', result.exitCode, result.output);
  }
}

function runCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  flow: RunningFlow,
  timeoutMs: number,
): Promise<{ stdout: string; output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    flow.process = child;
    let stdout = '';
    let output = '';
    const onStdout = (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
      output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
    };
    const onStderr = (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    const timer = setTimeout(() => {
      terminateProcess(child);
      reject(new CursorCommandError('cursor_credential_validation_timeout', undefined, output));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new CursorCommandError('cursor_cli_launch_failed', undefined, error.message));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      flow.process = undefined;
      if (flow.cancelled) return reject(new CursorCommandError('cursor_auth_cancelled'));
      if (code !== 0) return reject(new CursorCommandError('cursor_credential_validation_failed', code ?? undefined, output));
      resolve({ stdout, output, exitCode: code });
    });
  });
}

function cursorAuthorizationUrl(output: string): string | undefined {
  const match = output.match(/https:\/\/[^\s<>"']+/i);
  if (!match) return undefined;
  const url = new URL(match[0].replace(/[),.;]+$/, ''));
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || (host !== 'cursor.com' && !host.endsWith('.cursor.com'))) {
    throw new Error('cursor_authorization_url_invalid');
  }
  if (url.username || url.password) throw new Error('cursor_authorization_url_invalid');
  return url.toString();
}

function requiredString(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(code);
  return value.trim();
}

function failedEvent(
  message: PlatformCursorAuthStart,
  stage: CursorAuthFailureStage,
  errorCode: string,
  retryable: boolean,
  diagnostic?: string,
  exitCode?: number,
): ProviderCursorAuthFailed {
  return {
    type: 'provider.cursor_auth_failed',
    protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    flowId: message.flowId,
    nodeId: message.nodeId,
    stage,
    errorCode,
    retryable,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(typeof diagnostic === 'string' && diagnostic ? { diagnostic } : {}),
  };
}

function cursorAuthErrorCode(error: unknown, flow: RunningFlow): string {
  if (flow.cancelled) return 'cursor_auth_cancelled';
  const value = error instanceof Error ? error.message : '';
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : 'cursor_auth_failed';
}

function retryableCursorAuthError(error: unknown, flow: RunningFlow): boolean {
  if (flow.cancelled) return false;
  const code = cursorAuthErrorCode(error, flow);
  return code === 'cursor_cli_launch_failed'
    || code === 'cursor_credential_validation_timeout'
    || code === 'cursor_auth_interrupted';
}

function commandDiagnostic(error: unknown): string | undefined {
  if (error instanceof CursorCommandError) return safeDiagnostic(error.diagnostic);
  return safeDiagnostic(error instanceof Error ? error.message : String(error));
}

function safeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        return `${url.origin}${url.pathname}${url.search || url.hash ? '?[REDACTED]' : ''}`;
      } catch {
        return '[URL]';
      }
    })
    .replace(/\b(authId|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)\b\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '/Users/[USER]')
    .trim();
  return result ? result.slice(0, 2_000) : undefined;
}

function assertNotCancelled(flow: RunningFlow): void {
  if (flow.cancelled) throw new Error('cursor_auth_cancelled');
}

function terminateProcess(child?: ChildProcess): void {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // Already exited.
    }
  }, CANCEL_GRACE_MS);
  timer.unref?.();
}

export function detectCursorAgent(configuredPath = ''): CursorAgentDescriptor | undefined {
  const candidates = [
    configuredPath.trim(),
    join(homedir(), '.local', 'bin', 'cursor-agent'),
    'cursor-agent',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
    }
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (result.status !== 0) continue;
    const version = String(result.stdout || result.stderr).trim().split(/\s+/)[0];
    if (version && version.length <= 128) return { path: candidate, version };
  }
  return undefined;
}
