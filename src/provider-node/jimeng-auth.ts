import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJimengCredentialStore,
  isSupportedDreaminaPlatform,
  type JimengCredentialStore,
  type SupportedDreaminaPlatform,
} from './jimeng-credential-store.js';
import type {
  JimengAuthFailureStage,
  JimengAuthControlProtocolVersion,
  PlatformJimengAuthCancel,
  PlatformJimengAuthStart,
  ProviderJimengAuthCompleted,
  ProviderJimengAuthFailed,
  ProviderJimengAuthStarted,
} from '../shared/protocol.js';
import { JIMENG_AUTH_CONTROL_PROTOCOL_VERSION } from '../shared/protocol.js';

const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const LOGIN_START_TIMEOUT_MS = 30_000;
const CREDENTIAL_VALIDATION_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 1_000;

export type JimengAuthEvent = ProviderJimengAuthStarted | ProviderJimengAuthCompleted | ProviderJimengAuthFailed;

export interface DreaminaCliDescriptor {
  path: string;
  version: string;
  textToVideoModels?: string[];
  textToVideoResolutions?: string[];
  videoGenerationModes?: Array<'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference'>;
  videoModelsByMode?: Partial<
    Record<'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference', string[]>
  >;
  videoResolutions?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface JimengAccountProfile {
  accountId: string;
  accountName?: string;
  accountEmail?: string;
  vipLevel?: string;
  totalCredit?: number;
  hasCliPermission?: boolean;
}

interface RunningFlow {
  cancelled: boolean;
  process?: ChildProcess;
}

export interface JimengAuthorizationHandlerOptions {
  cli: DreaminaCliDescriptor;
  getIdentity: () => { nodeId: string; providerId: string };
  platform?: NodeJS.Platform;
  nativeHomeDir?: string;
  tempParentDir?: string;
  now?: () => number;
  createCredentialStore?: (options: {
    platform: SupportedDreaminaPlatform;
    homeDir: string;
    env: NodeJS.ProcessEnv;
    isolated?: boolean;
    nativeHomeDir?: string;
  }) => JimengCredentialStore;
  runCommand?: (
    executable: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; flow: RunningFlow },
  ) => Promise<CommandResult>;
  withCredentialLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  prepareCommandHome?: (homeDir: string) => Promise<void>;
}

export class JimengAuthorizationHandler {
  private readonly flows = new Map<string, RunningFlow>();
  private readonly now: () => number;

  constructor(private readonly options: JimengAuthorizationHandlerOptions) {
    this.now = options.now ?? Date.now;
  }

  capability() {
    return {
      protocolVersions: [JIMENG_AUTH_CONTROL_PROTOCOL_VERSION],
      cliVersion: this.options.cli.version,
    } satisfies {
      protocolVersions: JimengAuthControlProtocolVersion[];
      cliVersion: string;
    };
  }

  start(message: PlatformJimengAuthStart, emit: (event: JimengAuthEvent) => void): void {
    const identity = this.options.getIdentity();
    if (
      message.protocolVersion !== JIMENG_AUTH_CONTROL_PROTOCOL_VERSION ||
      message.nodeId !== identity.nodeId ||
      message.providerId !== identity.providerId ||
      !message.flowId ||
      this.flows.has(message.flowId) ||
      this.flows.size > 0
    ) {
      emit(failedEvent(message, 'launch', 'jimeng_auth_start_invalid', false));
      return;
    }
    const flow: RunningFlow = { cancelled: false };
    this.flows.set(message.flowId, flow);
    const operation = () => this.run(message, flow, emit);
    void (this.options.withCredentialLease ? this.options.withCredentialLease(operation) : operation()).finally(() => {
      this.flows.delete(message.flowId);
    });
  }

  cancel(message: PlatformJimengAuthCancel): boolean {
    const identity = this.options.getIdentity();
    if (message.protocolVersion !== JIMENG_AUTH_CONTROL_PROTOCOL_VERSION || message.nodeId !== identity.nodeId) {
      return false;
    }
    const flow = this.flows.get(message.flowId);
    if (!flow) return false;
    flow.cancelled = true;
    terminateProcessGroup(flow.process);
    return true;
  }

  cancelAll(): void {
    for (const flow of this.flows.values()) {
      flow.cancelled = true;
      terminateProcessGroup(flow.process);
    }
  }

  private async run(
    message: PlatformJimengAuthStart,
    flow: RunningFlow,
    emit: (event: JimengAuthEvent) => void,
  ): Promise<void> {
    assertNotCancelled(flow);
    const parentDir = this.options.tempParentDir ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
    const rootDir = await mkdtemp(join(parentDir, 'wokey-jimeng-auth-'));
    const homeDir = join(rootDir, 'home');
    let stage: JimengAuthFailureStage = 'launch';
    let failed: ProviderJimengAuthFailed | undefined;
    let completedEvent: ProviderJimengAuthCompleted | undefined;
    let credentialStore: JimengCredentialStore | undefined;
    let credentialSnapshot: Buffer | undefined;
    let credentialSnapshotTaken = false;
    try {
      await chmod(rootDir, 0o700);
      await mkdir(homeDir, { mode: 0o700 });
      const configDir = join(rootDir, 'config');
      const dataDir = join(rootDir, 'data');
      const cacheDir = join(rootDir, 'cache');
      const runtimeDir = join(rootDir, 'runtime');
      const platform = this.options.platform ?? process.platform;
      if (!isSupportedDreaminaPlatform(platform)) throw new Error('jimeng_platform_unsupported');

      // Windows authorization must run with the exact logged-in user
      // environment. In particular, setting HOME or any XDG_* variable changes
      // where some Dreamina CLI builds look for configuration and which
      // keyring backend they select. That made the scheduled Provider Node
      // invocation fail even though the same binary succeeded in PowerShell.
      // Keep Windows untouched; Linux remains fully isolated and macOS keeps
      // its isolated XDG view while using the native login keychain.
      const nativeHomeDir = this.options.nativeHomeDir ?? homedir();
      const commandHomeDir = platform === 'linux' ? homeDir : nativeHomeDir;
      const env: NodeJS.ProcessEnv = platform === 'win32'
        ? { ...process.env }
        : {
            ...process.env,
            HOME: commandHomeDir,
            XDG_CONFIG_HOME: configDir,
            XDG_DATA_HOME: dataDir,
            XDG_CACHE_HOME: cacheDir,
            XDG_RUNTIME_DIR: runtimeDir,
          };
      await Promise.all([
        mkdir(configDir, { mode: 0o700 }),
        mkdir(dataDir, { mode: 0o700 }),
        mkdir(cacheDir, { mode: 0o700 }),
        mkdir(runtimeDir, { mode: 0o700 }),
      ]);
      await this.options.prepareCommandHome?.(commandHomeDir);

      credentialStore = (this.options.createCredentialStore ?? createJimengCredentialStore)({
        platform,
        homeDir,
        env,
      });
      credentialSnapshot = await credentialStore.snapshot();
      credentialSnapshotTaken = true;

      let encodedCredentialBundle: string | undefined;
      if (credentialSnapshot) {
        try {
          encodedCredentialBundle = captureCredentialBundle(
            await credentialStore.capture(),
            this.options.cli.version,
          );
        } catch (error) {
          if (!isInvalidCredentialBundleError(error)) throw error;
          // A malformed native item cannot be restored safely. Remove it and
          // fall through to a fresh Device Flow.
          await credentialStore.restore(undefined);
          credentialSnapshot = undefined;
        }
      }

      if (!encodedCredentialBundle) {
        stage = 'device_authorization';
        const startResult = await this.runCommand(
          // `login` may reuse CLI state that is invisible to our credential
          // snapshot and exit successfully without printing Device Flow
          // material. At this point no usable credential was captured, so
          // force the fresh OAuth path explicitly.
          ['relogin', '--headless'],
          env,
          Math.min(LOGIN_START_TIMEOUT_MS, message.deadlineMs),
          flow,
        );
        assertNotCancelled(flow);
        const material = parseDeviceAuthorization(startResult);
        const expiresAtMs = Math.min(
          this.now() + message.deadlineMs,
          material.expiresInSeconds ? this.now() + material.expiresInSeconds * 1_000 : Number.POSITIVE_INFINITY,
        );
        emit({
          type: 'provider.jimeng_auth_started',
          protocolVersion: JIMENG_AUTH_CONTROL_PROTOCOL_VERSION,
          requestId: message.requestId,
          flowId: message.flowId,
          nodeId: message.nodeId,
          verificationUri: material.verificationUri,
          verificationUriComplete: material.verificationUriComplete,
          userCode: material.userCode,
          expiresAt: new Date(expiresAtMs).toISOString(),
        });

        stage = 'user_authorization';
        const remainingMs = Math.max(1, expiresAtMs - this.now());
        await this.runCommand(
          [
            'login',
            'checklogin',
            `--device_code=${material.deviceCode}`,
            `--poll=${Math.max(1, Math.ceil(remainingMs / 1_000))}`,
          ],
          env,
          remainingMs,
          flow,
        );
        assertNotCancelled(flow);

        stage = 'credential_capture';
        encodedCredentialBundle = captureCredentialBundle(
          await credentialStore.capture(),
          this.options.cli.version,
        );
      }

      // Do one real, non-generating upstream call before accepting the
      // credential. A successful login poll only proves token issuance;
      // `user_credit` proves that the saved session can actually reach Jimeng.
      stage = 'credential_validation';
      const validationResult = await this.runCommand(
        ['user_credit'],
        env,
        Math.min(CREDENTIAL_VALIDATION_TIMEOUT_MS, message.deadlineMs),
        flow,
      );
      assertNotCancelled(flow);

      // `user_credit` refreshes the CLI's cached user profile. Capture once
      // more so the central encrypted bundle contains the latest account ID,
      // nickname and VIP level for the Provider credential table.
      const validatedCredentialBytes = await credentialStore.capture();
      encodedCredentialBundle = captureCredentialBundle(
        validatedCredentialBytes,
        this.options.cli.version,
        parseJimengAccountProfile(validationResult.stdout, validatedCredentialBytes),
      );
      completedEvent = completedEventFor(message, encodedCredentialBundle);
    } catch (error) {
      failed = failedEvent(message, stage, errorCode(error), retryableError(error));
    } finally {
      stage = 'cleanup';
      let cleanupFailed = false;
      terminateProcessGroup(flow.process);
      try {
        if (credentialStore && credentialSnapshotTaken) await credentialStore.restore(credentialSnapshot);
      } catch {
        cleanupFailed = true;
      }
      try {
        await rm(rootDir, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) {
        completedEvent = undefined;
        failed = failedEvent(message, stage, 'jimeng_auth_cleanup_failed', true);
      }
    }
    if (completedEvent) emit(completedEvent);
    else if (failed) emit(failed);
  }

  private runCommand(
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    flow: RunningFlow,
  ): Promise<CommandResult> {
    return (this.options.runCommand ?? spawnBounded)(this.options.cli.path, args, { env, timeoutMs, flow });
  }
}

export function detectDreaminaCli(
  configuredPath = process.env.DREAMINA_CLI_PATH,
  platform = process.platform,
  homeDir = homedir(),
): DreaminaCliDescriptor | undefined {
  if (!isSupportedDreaminaPlatform(platform)) return undefined;
  const executable = configuredPath || defaultDreaminaCliPath(platform, homeDir);
  try {
    accessSync(executable, constants.X_OK);
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: false,
      maxBuffer: 16 * 1024,
    });
    if (result.status !== 0) return undefined;
    const version = parseCliVersion(`${result.stdout || result.stderr}`);
    if (!version || version.length > 128) return undefined;
    const commands = [
      ['text_to_video', 'text2video'],
      ['image_to_video', 'image2video'],
      ['first_last_frames', 'frames2video'],
      ['multimodal_reference', 'multimodal2video'],
    ] as const;
    const videoModelsByMode: DreaminaCliDescriptor['videoModelsByMode'] = {};
    const resolutions = new Set<string>();
    for (const [mode, command] of commands) {
      const help = spawnSync(executable, [command, '--help'], {
        encoding: 'utf8',
        timeout: 5_000,
        shell: false,
        maxBuffer: 64 * 1024,
      });
      if (help.status !== 0) continue;
      const parsed = parseVideoCapabilities(`${help.stdout || help.stderr}`);
      if (!parsed) continue;
      videoModelsByMode[mode] = parsed.models;
      for (const resolution of parsed.resolutions) resolutions.add(resolution);
    }
    const videoGenerationModes = Object.keys(videoModelsByMode) as NonNullable<
      DreaminaCliDescriptor['videoGenerationModes']
    >;
    const textCapabilities = videoModelsByMode.text_to_video;
    return {
      path: executable,
      version,
      ...(textCapabilities ? { textToVideoModels: textCapabilities, textToVideoResolutions: [...resolutions] } : {}),
      ...(videoGenerationModes.length > 1
        ? { videoGenerationModes, videoModelsByMode, videoResolutions: [...resolutions] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseVideoCapabilities(output: string): { models: string[]; resolutions: string[] } | undefined {
  const models = [...new Set(output.toLowerCase().match(/\bseedance[0-9][a-z0-9._]*\b/g) ?? [])]
    .filter((model) => model.length <= 64)
    .slice(0, 20);
  if (!models.length) return undefined;
  const resolutions = [...new Set(output.toLowerCase().match(/\b(?:480p|720p|1080p|4k)\b/g) ?? [])];
  return { models, resolutions };
}

export function defaultDreaminaCliPath(platform: SupportedDreaminaPlatform, homeDir: string): string {
  return platform === 'win32' ? join(homeDir, 'bin', 'dreamina.exe') : join(homeDir, '.local', 'bin', 'dreamina');
}

export function parseCliVersion(output: string): string | undefined {
  const value = output.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = (parsed as Record<string, unknown>).version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    }
  } catch {
    // Fall through to the text formats used by other CLI builds.
  }
  const labeled = /(?:^|\s)version\s*[:=]?\s*v?([0-9][A-Za-z0-9._+-]*)/i.exec(value);
  if (labeled?.[1]) return labeled[1];
  const singleLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (singleLine.length !== 1) return undefined;
  const line = singleLine[0];
  if (!line) return undefined;
  const token = /(?:^|\s)v?([0-9][A-Za-z0-9._+-]*)$/.exec(line);
  return token?.[1];
}

function captureCredentialBundle(
  bytes: Buffer,
  cliVersion: string,
  accountProfile?: JimengAccountProfile,
): string {
  validateAuthFile(bytes);
  return JSON.stringify({
    schemaVersion: 2,
    storageFormat: 'dreamina_auth_json_v1',
    authFileBase64: bytes.toString('base64'),
    authFileSha256: createHash('sha256').update(bytes).digest('hex'),
    capturedAt: new Date().toISOString(),
    sourceCliVersion: cliVersion,
    ...(accountProfile ? { accountProfile } : {}),
  });
}

export function parseJimengAccountProfile(output: string, authFileBytes: Buffer): JimengAccountProfile {
  validateAuthFile(authFileBytes);
  const auth = JSON.parse(authFileBytes.toString('utf8')) as Record<string, unknown>;
  const userInfo = auth.user_info as Record<string, unknown>;
  const outputFields = parseAccountProfileOutput(output);
  const accountId = profileText(
    outputFields.user_id ?? outputFields.account_id ?? userInfo.user_id,
    256,
  );
  if (!accountId) throw new Error('jimeng_credential_identity_missing');
  const authAccountId = profileText(userInfo.user_id, 256);
  if (authAccountId && accountId !== authAccountId) throw new Error('jimeng_credential_identity_mismatch');
  const totalCredit = profileNumber(outputFields.total_credit ?? outputFields.credits ?? userInfo.total_credit);
  const hasCliPermission = profileBoolean(outputFields.has_cli_permission ?? userInfo.has_cli_permission);
  return {
    accountId,
    ...(profileText(outputFields.user_name ?? outputFields.screen_name ?? userInfo.user_name ?? userInfo.screen_name, 256)
      ? { accountName: profileText(outputFields.user_name ?? outputFields.screen_name ?? userInfo.user_name ?? userInfo.screen_name, 256) }
      : {}),
    ...(profileText(outputFields.email ?? outputFields.email_address ?? userInfo.email ?? userInfo.email_address, 320)
      ? { accountEmail: profileText(outputFields.email ?? outputFields.email_address ?? userInfo.email ?? userInfo.email_address, 320) }
      : {}),
    ...(profileText(outputFields.vip_level ?? outputFields.membership_level ?? userInfo.vip_level, 128)
      ? { vipLevel: profileText(outputFields.vip_level ?? outputFields.membership_level ?? userInfo.vip_level, 128) }
      : {}),
    ...(totalCredit !== undefined ? { totalCredit } : {}),
    ...(hasCliPermission !== undefined ? { hasCliPermission } : {}),
  };
}

function parseAccountProfileOutput(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        const nested = value.user_info;
        return nested && typeof nested === 'object' && !Array.isArray(nested)
          ? { ...value, ...(nested as Record<string, unknown>) }
          : value;
      }
    } catch {
      // The official CLI currently emits labeled lines; JSON is supported for
      // compatibility with machine-readable builds.
    }
  }
  const fields: Record<string, unknown> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([a-z][a-z0-9_]*)\s*:\s*(.*?)\s*$/i.exec(line);
    if (match?.[1] && match[2] !== undefined) fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function profileText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : '';
  return text && text.length <= maxLength ? text : undefined;
}

function profileNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function profileBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function validateAuthFile(bytes: Buffer): void {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_AUTH_FILE_BYTES) {
    throw new Error('jimeng_credential_auth_file_size_invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('jimeng_credential_auth_file_json_invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('jimeng_credential_auth_file_json_invalid');
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    typeof value.refresh_token !== 'string' ||
    !value.refresh_token ||
    !value.token_expires_at ||
    !value.device_key ||
    !value.user_info
  ) {
    throw new Error('jimeng_credential_auth_file_field_missing');
  }
}

function isInvalidCredentialBundleError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('jimeng_credential_auth_file_');
}

function completedEventFor(
  message: Pick<PlatformJimengAuthStart, 'requestId' | 'flowId' | 'nodeId'>,
  encodedCredentialBundle: string,
): ProviderJimengAuthCompleted {
  return {
    type: 'provider.jimeng_auth_completed',
    protocolVersion: JIMENG_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    flowId: message.flowId,
    nodeId: message.nodeId,
    encodedCredentialBundle,
  };
}

function parseDeviceAuthorization(output: CommandResult): {
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  deviceCode: string;
  expiresInSeconds?: number;
} {
  const fields = mergeDeviceAuthorizationFields(
    parseDeviceAuthorizationFields(output.stdout),
    parseDeviceAuthorizationFields(output.stderr),
  );
  const verificationUri = fields.get('verification_uri');
  const userCode = fields.get('user_code');
  const deviceCode = fields.get('device_code');
  if (!verificationUri || !userCode || !deviceCode) {
    throw new Error(deviceAuthorizationOutputErrorCode(output));
  }
  const parsedUri = new URL(verificationUri);
  if (!isOfficialJimengVerificationUri(parsedUri)) {
    throw new Error('jimeng_verification_uri_invalid');
  }
  const verificationUriComplete = fields.get('verification_uri_complete');
  let parsedCompleteUri: string | undefined;
  if (verificationUriComplete) {
    const completeUri = new URL(verificationUriComplete);
    if (!isOfficialJimengVerificationUri(completeUri)) {
      throw new Error('jimeng_verification_uri_invalid');
    }
    parsedCompleteUri = completeUri.toString();
  }
  const expires = Number(fields.get('expires_in'));
  return {
    verificationUri: parsedUri.toString(),
    verificationUriComplete: parsedCompleteUri,
    userCode,
    deviceCode,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? expires : undefined,
  };
}

function deviceAuthorizationOutputErrorCode(output: CommandResult): string {
  const diagnostic = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (diagnostic.includes('store unavailable') || diagnostic.includes('backend unavailable')) {
    return 'jimeng_credential_store_unavailable';
  }
  if (diagnostic.includes('get device code failed')) {
    return 'jimeng_device_authorization_request_failed';
  }
  if (diagnostic.includes('版本文件缺失') || (diagnostic.includes('version file') && diagnostic.includes('missing'))) {
    return 'jimeng_cli_version_metadata_missing';
  }
  return 'jimeng_device_authorization_output_invalid';
}

const DEVICE_AUTHORIZATION_FIELDS = new Set([
  'verification_uri',
  'verification_uri_complete',
  'user_code',
  'device_code',
  'expires_in',
]);

function parseDeviceAuthorizationFields(output: string): Map<string, string> {
  const fields = new Map<string, string>();
  const trimmed = output.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
          const key = rawKey.toLowerCase().replaceAll('-', '_');
          if (!DEVICE_AUTHORIZATION_FIELDS.has(key)) continue;
          if (typeof rawValue === 'string' && rawValue.trim()) fields.set(key, rawValue.trim());
          else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) fields.set(key, String(rawValue));
        }
      }
    } catch {
      // Official builds normally emit labeled lines. JSON is accepted for
      // machine-readable builds, while unrelated CLI diagnostics are ignored.
    }
  }
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([a-z][a-z0-9_-]*)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const key = match[1].toLowerCase().replaceAll('-', '_');
    if (DEVICE_AUTHORIZATION_FIELDS.has(key)) fields.set(key, match[2]);
  }
  return fields;
}

function mergeDeviceAuthorizationFields(...sources: Map<string, string>[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const source of sources) {
    for (const [key, value] of source) {
      const existing = merged.get(key);
      if (existing !== undefined && existing !== value) {
        throw new Error('jimeng_device_authorization_output_conflict');
      }
      merged.set(key, value);
    }
  }
  return merged;
}

function isOfficialJimengVerificationUri(uri: URL): boolean {
  return uri.protocol === 'https:' && isJianyingHost(uri.hostname) && !uri.username && !uri.password;
}

function isJianyingHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'jianying.com' || host.endsWith('.jianying.com');
}

function spawnBounded(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; flow: RunningFlow },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    options.flow.process = child;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.flow.process = undefined;
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('jimeng_cli_result_missing'));
    };
    const append = (chunks: Uint8Array[], currentBytes: number, chunk: Uint8Array): number => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminateProcessGroup(child);
        throw new Error('jimeng_cli_output_too_large');
      }
      chunks.push(chunk);
      return nextBytes;
    };
    child.stdout?.on('data', (chunk: Uint8Array) => {
      try {
        stdoutBytes = append(stdoutChunks, stdoutBytes, chunk);
      } catch (error) {
        finish(error as Error);
      }
    });
    child.stderr?.on('data', (chunk: Uint8Array) => {
      try {
        stderrBytes = append(stderrChunks, stderrBytes, chunk);
      } catch (error) {
        finish(error as Error);
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        finish(undefined, {
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
        return;
      }
      finish(
        new Error(options.flow.cancelled ? 'jimeng_auth_cancelled' : `jimeng_cli_exit_${code ?? signal ?? 'unknown'}`),
      );
    });
    const timer = setTimeout(
      () => {
        terminateProcessGroup(child);
        finish(new Error('jimeng_cli_timeout'));
      },
      Math.max(1, options.timeoutMs),
    );
    timer.unref?.();
  });
}

function terminateProcessGroup(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, CANCEL_GRACE_MS);
  timer.unref?.();
}

function assertNotCancelled(flow: RunningFlow): void {
  if (flow.cancelled) throw new Error('jimeng_auth_cancelled');
}

function failedEvent(
  message: Pick<PlatformJimengAuthStart, 'requestId' | 'flowId' | 'nodeId'>,
  stage: JimengAuthFailureStage,
  errorCodeValue: string,
  retryable: boolean,
): ProviderJimengAuthFailed {
  return {
    type: 'provider.jimeng_auth_failed',
    protocolVersion: JIMENG_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    flowId: message.flowId,
    nodeId: message.nodeId,
    stage,
    errorCode: errorCodeValue,
    retryable,
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^jimeng_[a-z0-9_]+$/.test(message) ? message : 'jimeng_auth_failed';
}

function retryableError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'jimeng_cli_timeout' || code === 'jimeng_auth_cleanup_failed' || code.startsWith('jimeng_cli_exit_');
}
