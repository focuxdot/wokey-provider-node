import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, lstat, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { gzipSync, gunzipSync } from 'node:zlib';
import type {
  JimengVideoFailureStage,
  PlatformJimengVideoCancel,
  PlatformJimengVideoExecute,
  ProviderJimengVideoCompleted,
  ProviderJimengVideoFailed,
  ProviderNodeControlCapabilities,
} from '../shared/protocol.js';
import { JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION } from '../shared/protocol.js';
import type { DreaminaCliDescriptor } from './jimeng-auth.js';
import {
  createJimengCredentialStore,
  isSupportedDreaminaPlatform,
  type JimengCredentialStore,
  type SupportedDreaminaPlatform,
} from './jimeng-credential-store.js';

const AUTH_FILE_RELATIVE_PATH = join('.local', 'share', 'dreamina', 'byted_cli_user_token.json');
const TASK_STATE_PATHS = [
  '.dreamina_cli/tasks.db',
  '.dreamina_cli/tasks.db-wal',
  '.dreamina_cli/tasks.db-shm',
  '.dreamina_cli/version.json',
] as const;
const LEGACY_TEXT_MODELS = [
  'seedance2.0mini',
  'seedance2.0fast',
  'seedance2.0',
  'seedance2.0fast_vip',
  'seedance2.0_vip',
] as const;
const LEGACY_IMAGE_MODELS = ['seedance1.0fast', 'seedance1.5pro', ...LEGACY_TEXT_MODELS] as const;
const LEGACY_FRAME_MODELS = ['seedance1.5pro', ...LEGACY_TEXT_MODELS] as const;
const LEGACY_MULTIMODAL_MODELS = [...LEGACY_TEXT_MODELS] as const;
const RATIOS = new Set(['1:1', '3:4', '16:9', '4:3', '9:16', '21:9']);
const LEGACY_RESOLUTIONS = ['720p', '1080p', '4k'] as const;
const MAX_AUTH_BYTES = 64 * 1024;
const MAX_TASK_STATE_RAW_BYTES = 8 * 1024 * 1024;
const MAX_TASK_STATE_COMPRESSED_BYTES = 560 * 1024;
const MAX_CLI_OUTPUT_BYTES = 128 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_MEDIA_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_DEADLINE_MS = 30 * 60_000;
const KILL_GRACE_MS = 1_000;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

type VideoEvent = ProviderJimengVideoCompleted | ProviderJimengVideoFailed;
type TaskStatePath = (typeof TASK_STATE_PATHS)[number];

interface RunningOperation {
  videoJobId: string;
  controller: AbortController;
  process?: ChildProcess;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface TaskStateArchive {
  schemaVersion: 1;
  videoJobId: string;
  submitId: string;
  sourceCliVersion: string;
  capturedAt: string;
  files: Array<{ path: TaskStatePath; base64: string; sha256: string }>;
}

interface TaskStateEnvelope {
  schemaVersion: 1;
  storageFormat: 'dreamina_cli_task_state_gzip_v1';
  videoJobId: string;
  submitId: string;
  sha256: string;
  gzipBase64: string;
}

interface SubmissionReceipt {
  schemaVersion: 1;
  videoJobId: string;
  requestHash: string;
  state: 'prepared' | 'submitting' | 'submitted' | 'submission_unknown';
  updatedAt: string;
  submitId?: string;
  encodedTaskStateBundle?: string;
  encodedCredentialBundle?: string;
  credentialChanged?: boolean;
  upstreamResult?: Record<string, unknown>;
  unknownReason?: string;
}

export interface JimengVideoHandlerOptions {
  cli: DreaminaCliDescriptor;
  receiptsDirectory: string;
  getIdentity: () => { nodeId: string; providerId: string };
  platform?: NodeJS.Platform;
  tempParentDir?: string;
  sealReceipt: (plaintext: string) => string;
  openReceipt: (ciphertext: string) => string;
  allowedTransferOrigins?: string[];
  createCredentialStore?: (options: {
    platform: SupportedDreaminaPlatform;
    homeDir: string;
    env: NodeJS.ProcessEnv;
  }) => JimengCredentialStore;
  runCommand?: (
    executable: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number; running: RunningOperation },
  ) => Promise<CommandResult>;
  withCredentialLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/**
 * Platform command -> durable receipt -> ephemeral HOME -> Dreamina CLI
 *                  -> credential/task-state capture -> correlated event
 *
 * A submit receipt reaches `submitting` immediately before spawn. Any process
 * loss after that point becomes submission_unknown and is never auto-retried.
 */
export class JimengVideoHandler {
  private readonly active = new Map<string, RunningOperation>();
  private readonly receiptStore: SubmissionReceiptStore;
  private readonly textModels: Set<string>;
  private readonly modelsByMode: Record<
    'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference',
    Set<string>
  >;
  private readonly resolutions: Set<string>;
  private readonly allowedTransferOrigins: ReadonlySet<string>;

  constructor(private readonly options: JimengVideoHandlerOptions) {
    this.receiptStore = new SubmissionReceiptStore(options.receiptsDirectory, options.sealReceipt, options.openReceipt);
    this.textModels = new Set(options.cli.textToVideoModels ?? LEGACY_TEXT_MODELS);
    this.modelsByMode = {
      text_to_video: this.textModels,
      image_to_video: new Set(options.cli.videoModelsByMode?.image_to_video ?? LEGACY_IMAGE_MODELS),
      first_last_frames: new Set(options.cli.videoModelsByMode?.first_last_frames ?? LEGACY_FRAME_MODELS),
      multimodal_reference: new Set(options.cli.videoModelsByMode?.multimodal_reference ?? LEGACY_MULTIMODAL_MODELS),
    };
    this.resolutions = new Set(
      options.cli.videoResolutions ?? options.cli.textToVideoResolutions ?? LEGACY_RESOLUTIONS,
    );
    this.allowedTransferOrigins = new Set((options.allowedTransferOrigins ?? []).map((value) => new URL(value).origin));
  }

  capability(): NonNullable<ProviderNodeControlCapabilities['jimengVideo']> {
    const generationModes = this.options.cli.videoGenerationModes ?? ['text_to_video'];
    return {
      protocolVersions: [JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION],
      cliVersion: this.options.cli.version,
      generationModes,
      upstreamModelVersions: [...new Set(generationModes.flatMap((mode) => [...this.modelsByMode[mode]]))],
      resolutions: [...this.resolutions],
    };
  }

  execute(message: PlatformJimengVideoExecute, emit: (event: VideoEvent) => void): void {
    const operationType = message.operation?.type === 'query' ? 'query' : 'submit';
    const identity = this.options.getIdentity();
    if (
      message.protocolVersion !== JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION ||
      message.nodeId !== identity.nodeId ||
      message.providerId !== identity.providerId ||
      !validIdentifier(message.requestId, 160) ||
      !validIdentifier(message.videoJobId, 128) ||
      this.active.size > 0
    ) {
      emit(
        failedEvent(
          message,
          operationType,
          'validation',
          this.active.size > 0 ? 'jimeng_video_node_busy' : 'jimeng_video_request_invalid',
          true,
          false,
        ),
      );
      return;
    }
    if (!['linux', 'darwin', 'win32'].includes(this.options.platform ?? process.platform)) {
      emit(failedEvent(message, operationType, 'validation', 'jimeng_video_platform_unsupported', false, false));
      return;
    }

    const running: RunningOperation = { videoJobId: message.videoJobId, controller: new AbortController() };
    this.active.set(message.requestId, running);
    const task = () => this.run(message, running);
    void (this.options.withCredentialLease ? this.options.withCredentialLease(task) : task())
      .then(emit)
      .catch((error) => emit(errorEvent(message, operationType, error)))
      .finally(() => this.active.delete(message.requestId));
  }

  cancel(message: PlatformJimengVideoCancel): boolean {
    const identity = this.options.getIdentity();
    if (message.protocolVersion !== JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION || message.nodeId !== identity.nodeId)
      return false;
    const running = this.active.get(message.requestId);
    if (!running || running.videoJobId !== message.videoJobId) return false;
    running.controller.abort();
    terminateProcess(running.process);
    return true;
  }

  cancelAll(): void {
    for (const running of this.active.values()) {
      running.controller.abort();
      terminateProcess(running.process);
    }
  }

  private async run(message: PlatformJimengVideoExecute, running: RunningOperation): Promise<VideoEvent> {
    if (running.controller.signal.aborted) throw videoError('cli_execution', 'jimeng_cli_aborted', true, false);
    const deadlineMs = boundedDeadline(message.deadlineMs);
    const credential = parseCredentialBundle(message.encodedCredentialBundle);
    if (message.operation.type === 'submit') {
      const operation = message.operation;
      validateSubmitOperation(operation, this.modelsByMode, this.resolutions, this.allowedTransferOrigins);
      const requestHash = sha256(Buffer.from(stableJson(operation)));
      const existing = await this.receiptStore.prepare(message.videoJobId, requestHash);
      if (existing.state === 'submitted') {
        if (
          !existing.submitId ||
          !existing.encodedTaskStateBundle ||
          !existing.upstreamResult ||
          (existing.credentialChanged === true && !existing.encodedCredentialBundle) ||
          (existing.credentialChanged !== true && existing.encodedCredentialBundle !== undefined)
        )
          throw videoError('receipt', 'jimeng_video_receipt_corrupt', false, false);
        return completedEvent(message, {
          operation: 'submit',
          submitId: existing.submitId,
          reusedSubmission: true,
          encodedTaskStateBundle: existing.encodedTaskStateBundle,
          encodedCredentialBundle: existing.credentialChanged ? existing.encodedCredentialBundle : undefined,
          credentialChanged: existing.credentialChanged === true,
          upstreamResult: existing.upstreamResult,
        });
      }
      if (existing.state === 'submitting' || existing.state === 'submission_unknown') {
        await this.receiptStore.markUnknown(existing, existing.unknownReason ?? 'interrupted_while_submitting');
        throw videoError('receipt', 'jimeng_submission_unknown', false, true);
      }

      return await withEphemeralSession(credential, message.videoJobId, undefined, this.options, async (session) => {
        const mediaFiles = await downloadMediaInputs(operation.mediaInputs ?? [], session.rootDir, deadlineMs, running);
        const args = submitArgs(operation, mediaFiles);
        const submitting = await this.receiptStore.markSubmitting(existing);
        let command: CommandResult;
        try {
          command = await this.runCli(args, session.env, deadlineMs, running);
        } catch (error) {
          await this.receiptStore.markUnknown(submitting, 'submit_result_not_durable');
          throw videoError('cli_execution', errorCode(error), retryable(error), true, error);
        }
        try {
          const upstreamResult = parseCliJson(command.stdout);
          const submitId = nestedString(upstreamResult, 'submit_id', 'submitId', 'task_id', 'taskId');
          if (!submitId || !validIdentifier(submitId, 256))
            throw videoError('cli_execution', 'jimeng_submit_id_missing', false, true);
          const encodedTaskStateBundle = await captureTaskState(
            session.homeDir,
            message.videoJobId,
            submitId,
            this.options.cli.version,
          );
          const credentialResult = await captureSessionCredential(session, credential, this.options.cli.version);
          await this.receiptStore.markSubmitted(submitting, {
            submitId,
            encodedTaskStateBundle,
            encodedCredentialBundle: credentialResult.changed ? credentialResult.encoded : undefined,
            credentialChanged: credentialResult.changed,
            upstreamResult,
          });
          return completedEvent(message, {
            operation: 'submit',
            submitId,
            reusedSubmission: false,
            encodedTaskStateBundle,
            encodedCredentialBundle: credentialResult.changed ? credentialResult.encoded : undefined,
            credentialChanged: credentialResult.changed,
            upstreamResult,
          });
        } catch (error) {
          await this.receiptStore.markUnknown(submitting, 'submit_acceptance_not_durable');
          const detail =
            error instanceof JimengVideoError
              ? error
              : videoError('task_state_capture', errorCode(error), false, true, error);
          throw videoError(detail.stage, detail.code, detail.retryable, true, detail);
        }
      });
    }

    const operation = message.operation;
    const submitId = requiredIdentifier(operation.submitId, 256, 'jimeng_submit_id_invalid');
    return await withEphemeralSession(
      credential,
      message.videoJobId,
      {
        submitId,
        encoded: operation.encodedTaskStateBundle,
      },
      this.options,
      async (session) => {
        let command: CommandResult;
        const downloadDir = join(session.rootDir, 'output');
        await mkdir(downloadDir, { recursive: false, mode: 0o700 });
        try {
          command = await this.runCli(
            ['query_result', `--submit_id=${submitId}`, `--download_dir=${downloadDir}`],
            session.env,
            deadlineMs,
            running,
          );
        } catch (error) {
          throw videoError('cli_execution', errorCode(error), retryable(error), false, error);
        }
        const upstreamResult = parseCliJson(command.stdout);
        const encodedTaskStateBundle = await captureTaskState(
          session.homeDir,
          message.videoJobId,
          submitId,
          this.options.cli.version,
        );
        const credentialResult = await captureSessionCredential(session, credential, this.options.cli.version);
        const outputArtifact = await uploadDownloadedOutput(
          downloadDir,
          operation.artifactUpload,
          deadlineMs,
          running,
          this.allowedTransferOrigins,
        );
        return completedEvent(message, {
          operation: 'query',
          submitId,
          reusedSubmission: false,
          encodedTaskStateBundle,
          encodedCredentialBundle: credentialResult.changed ? credentialResult.encoded : undefined,
          credentialChanged: credentialResult.changed,
          upstreamResult,
          outputArtifact,
        });
      },
    );
  }

  private runCli(
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    running: RunningOperation,
  ): Promise<CommandResult> {
    return (this.options.runCommand ?? spawnBounded)(this.options.cli.path, args, { env, timeoutMs, running });
  }
}

async function withEphemeralSession<T>(
  credential: { encoded: string; bytes: Buffer },
  videoJobId: string,
  taskState: { submitId: string; encoded: string } | undefined,
  options: JimengVideoHandlerOptions,
  run: (session: {
    rootDir: string;
    homeDir: string;
    authFilePath: string;
    env: NodeJS.ProcessEnv;
    credentialStore?: JimengCredentialStore;
  }) => Promise<T>,
): Promise<T> {
  const parent = options.tempParentDir ?? process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const rootDir = await mkdtemp(join(parent, 'wokey-jimeng-video-'));
  const homeDir = join(rootDir, 'home');
  const authFilePath = join(homeDir, AUTH_FILE_RELATIVE_PATH);
  let result: T | undefined;
  let primaryError: unknown;
  let credentialStore: JimengCredentialStore | undefined;
  let credentialSnapshot: Buffer | undefined;
  let credentialInjected = false;
  try {
    await chmod(rootDir, 0o700);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: join(rootDir, 'config'),
      XDG_DATA_HOME: join(rootDir, 'data'),
      XDG_CACHE_HOME: join(rootDir, 'cache'),
      XDG_RUNTIME_DIR: join(rootDir, 'runtime'),
    };
    const platform = options.platform ?? process.platform;
    if (!isSupportedDreaminaPlatform(platform))
      throw videoError('credential_injection', 'jimeng_video_platform_unsupported', false, false);
    if (platform === 'win32') {
      env.USERPROFILE = homeDir;
      env.APPDATA = join(rootDir, 'config', 'Roaming');
      env.LOCALAPPDATA = join(rootDir, 'data', 'Local');
      env.TEMP = join(rootDir, 'cache');
      env.TMP = join(rootDir, 'cache');
    }
    await Promise.all(
      Object.values(env)
        .filter((value): value is string => typeof value === 'string' && value.startsWith(rootDir))
        .map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    );
    if (platform === 'linux') {
      await mkdir(dirname(authFilePath), { recursive: true, mode: 0o700 });
      await writeFile(authFilePath, credential.bytes, { flag: 'wx', mode: 0o600 });
    } else {
      credentialStore = (options.createCredentialStore ?? createJimengCredentialStore)({ platform, homeDir, env });
      credentialSnapshot = await credentialStore.snapshot();
      await credentialStore.restore(credential.bytes);
      credentialInjected = true;
    }
    if (taskState) await restoreTaskState(homeDir, videoJobId, taskState.submitId, taskState.encoded);
    result = await run({ rootDir, homeDir, authFilePath, env, credentialStore });
  } catch (error) {
    primaryError = error;
  }
  if (credentialInjected && credentialStore) {
    try {
      await credentialStore.restore(credentialSnapshot);
    } catch (error) {
      if (primaryError === undefined)
        primaryError = videoError('cleanup', 'jimeng_credential_restore_failed', true, false, error);
    }
  }
  try {
    await rm(rootDir, { recursive: true, force: true });
  } catch (error) {
    if (primaryError === undefined)
      throw videoError('cleanup', 'jimeng_video_session_cleanup_failed', true, false, error);
  }
  if (primaryError !== undefined) throw primaryError;
  return result as T;
}

function validateSubmitOperation(
  input: Extract<PlatformJimengVideoExecute['operation'], { type: 'submit' }>,
  modelsByMode: Record<
    'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference',
    ReadonlySet<string>
  >,
  resolutions: ReadonlySet<string>,
  allowedTransferOrigins: ReadonlySet<string>,
): void {
  if (!modelsByMode[input.mode]?.has(input.modelVersion))
    throw videoError('validation', 'jimeng_video_model_unsupported', false, false);
  if (
    typeof input.prompt !== 'string' ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt, 'utf8') > MAX_PROMPT_BYTES ||
    input.prompt.includes('\0')
  )
    throw videoError('validation', 'jimeng_video_prompt_invalid', false, false);
  const minDuration = input.modelVersion === 'seedance1.0fast' || input.modelVersion === 'seedance1.5pro' ? 5 : 4;
  const maxDuration =
    input.modelVersion === 'seedance2.5'
      ? 30
      : input.modelVersion === 'seedance1.5pro'
        ? 12
        : input.modelVersion === 'seedance1.0fast'
          ? 10
          : 15;
  if (
    !Number.isInteger(input.durationSeconds) ||
    input.durationSeconds < minDuration ||
    input.durationSeconds > maxDuration
  )
    throw videoError('validation', 'jimeng_video_duration_invalid', false, false);
  if (!RATIOS.has(input.ratio)) throw videoError('validation', 'jimeng_video_ratio_invalid', false, false);
  if (!resolutions.has(input.resolution))
    throw videoError('validation', 'jimeng_video_resolution_unsupported', false, false);
  if (input.modelVersion === 'seedance2.5') {
    if (input.resolution !== '480p' && input.resolution !== '720p')
      throw videoError('validation', 'jimeng_video_resolution_unsupported', false, false);
  } else if (input.modelVersion !== 'seedance2.0_vip' && input.resolution !== '720p') {
    throw videoError('validation', 'jimeng_video_resolution_unsupported', false, false);
  }
  validateMediaInputs(input, allowedTransferOrigins);
}

function submitArgs(
  input: Extract<PlatformJimengVideoExecute['operation'], { type: 'submit' }>,
  files: Map<string, string>,
): string[] {
  const common = [
    `--prompt=${input.prompt.trim()}`,
    `--model_version=${input.modelVersion}`,
    `--duration=${input.durationSeconds}`,
    `--ratio=${input.ratio}`,
    `--video_resolution=${input.resolution}`,
    '--poll=0',
  ];
  if (input.mode === 'text_to_video') return ['text2video', ...common];
  if (input.mode === 'image_to_video')
    return ['image2video', `--image=${requiredMediaFile(input.mediaInputs[0], files)}`, ...common];
  if (input.mode === 'first_last_frames') {
    const first = input.mediaInputs.find((item) => item.role === 'first_frame');
    const last = input.mediaInputs.find((item) => item.role === 'last_frame');
    return [
      'frames2video',
      `--first=${requiredMediaFile(first, files)}`,
      `--last=${requiredMediaFile(last, files)}`,
      ...common,
    ];
  }
  const mediaArgs = input.mediaInputs.map((item) => `--${item.kind}=${requiredMediaFile(item, files)}`);
  return ['multimodal2video', ...mediaArgs, ...common];
}

function validateMediaInputs(
  input: Extract<PlatformJimengVideoExecute['operation'], { type: 'submit' }>,
  allowedTransferOrigins: ReadonlySet<string>,
): void {
  const mediaInputs = input.mediaInputs ?? [];
  if (!Array.isArray(mediaInputs) || mediaInputs.length > 15)
    throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
  for (const item of mediaInputs) {
    if (!validIdentifier(item.id, 128) || !['image', 'video', 'audio'].includes(item.kind))
      throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
    if (
      !Number.isInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > MAX_MEDIA_INPUT_BYTES ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
    const url = safeTransferUrl(item.downloadUrl, allowedTransferOrigins);
    if (!url || Buffer.byteLength(item.filename, 'utf8') > 255 || item.filename.includes('\0'))
      throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
  }
  const images = mediaInputs.filter((item) => item.kind === 'image');
  const videos = mediaInputs.filter((item) => item.kind === 'video');
  const audios = mediaInputs.filter((item) => item.kind === 'audio');
  if (input.mode === 'text_to_video' && mediaInputs.length !== 0)
    throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
  if (input.mode === 'image_to_video' && (images.length !== 1 || mediaInputs.length !== 1))
    throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
  if (
    input.mode === 'first_last_frames' &&
    (mediaInputs.length !== 2 ||
      images.filter((item) => item.role === 'first_frame').length !== 1 ||
      images.filter((item) => item.role === 'last_frame').length !== 1)
  )
    throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
  if (
    input.mode === 'multimodal_reference' &&
    (images.length + videos.length < 1 || images.length > 9 || videos.length > 3 || audios.length > 3)
  )
    throw videoError('validation', 'jimeng_video_inputs_invalid', false, false);
}

async function downloadMediaInputs(
  inputs: Extract<PlatformJimengVideoExecute['operation'], { type: 'submit' }>['mediaInputs'],
  rootDir: string,
  timeoutMs: number,
  running: RunningOperation,
): Promise<Map<string, string>> {
  const directory = join(rootDir, 'inputs');
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const files = new Map<string, string>();
  for (const input of inputs) {
    const path = join(directory, `${input.id}-${safeFilename(input.filename)}`);
    const signal = deadlineSignal(timeoutMs, running.controller.signal);
    let response: Response;
    try {
      response = await fetch(input.downloadUrl, { signal });
    } catch (error) {
      throw videoError('media_transfer', 'jimeng_video_input_download_failed', true, false, error);
    }
    if (!response.ok || !response.body)
      throw videoError('media_transfer', 'jimeng_video_input_download_failed', true, false);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared !== input.bytes)
      throw videoError('media_transfer', 'jimeng_video_input_length_mismatch', false, false);
    const hash = createHash('sha256');
    let bytes = 0;
    let header = Buffer.alloc(0);
    const verifier = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > input.bytes || bytes > MAX_MEDIA_INPUT_BYTES) throw new Error('too_large');
        hash.update(chunk);
        if (header.byteLength < 16)
          header = Buffer.concat([header, Buffer.from(chunk).subarray(0, 16 - header.byteLength)]);
        controller.enqueue(chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body.pipeThrough(verifier) as unknown as NodeReadableStream<Uint8Array>),
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      throw videoError('media_transfer', 'jimeng_video_input_download_failed', true, false, error);
    }
    if (bytes !== input.bytes || hash.digest('hex') !== input.sha256)
      throw videoError('media_transfer', 'jimeng_video_input_sha256_mismatch', false, false);
    if (!validMediaMagic(header, input.contentType))
      throw videoError('media_transfer', 'jimeng_video_input_content_mismatch', false, false);
    files.set(input.id, path);
  }
  return files;
}

async function uploadDownloadedOutput(
  downloadDir: string,
  upload: { url: string; maxBytes: number },
  timeoutMs: number,
  running: RunningOperation,
  allowedTransferOrigins: ReadonlySet<string>,
): Promise<{ contentType: 'video/mp4'; bytes: number; sha256: string } | undefined> {
  const entries = await readdir(downloadDir, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp4'));
  if (candidates.length === 0) return undefined;
  if (
    !upload ||
    !safeTransferUrl(upload.url, allowedTransferOrigins) ||
    !Number.isInteger(upload.maxBytes) ||
    upload.maxBytes < 1 ||
    upload.maxBytes > MAX_VIDEO_OUTPUT_BYTES
  ) {
    throw videoError('validation', 'jimeng_video_artifact_upload_invalid', false, false);
  }
  if (candidates.length !== 1) throw videoError('media_transfer', 'jimeng_video_output_ambiguous', false, false);
  const [candidate] = candidates;
  if (!candidate) throw videoError('media_transfer', 'jimeng_video_output_ambiguous', false, false);
  const path = join(downloadDir, candidate.name);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > upload.maxBytes)
    throw videoError('media_transfer', 'jimeng_video_output_invalid', false, false);
  const header = Buffer.alloc(12);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.read(header, 0, header.byteLength, 0);
  } finally {
    await handle.close();
  }
  if (header.subarray(4, 8).toString('ascii') !== 'ftyp')
    throw videoError('media_transfer', 'jimeng_video_output_invalid', false, false);
  const digest = await sha256File(path);
  const signal = deadlineSignal(timeoutMs, running.controller.signal);
  let response: Response;
  try {
    response = await fetch(upload.url, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(info.size),
        'x-content-sha256': digest,
      },
      body: createReadStream(path) as unknown as BodyInit,
      duplex: 'half',
      signal,
    } as RequestInit & { duplex: 'half' });
  } catch (error) {
    throw videoError('media_transfer', 'jimeng_video_output_upload_failed', true, false, error);
  }
  if (!response.ok) throw videoError('media_transfer', 'jimeng_video_output_upload_failed', true, false);
  return { contentType: 'video/mp4', bytes: info.size, sha256: digest };
}

function requiredMediaFile(input: { id: string } | undefined, files: Map<string, string>): string {
  const path = input ? files.get(input.id) : undefined;
  if (!path) throw videoError('validation', 'jimeng_video_input_file_missing', false, false);
  return path;
}

function safeTransferUrl(value: string, allowedOrigins: ReadonlySet<string>): URL | undefined {
  try {
    if (typeof value !== 'string' || value.length > 2_048) return undefined;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (allowedOrigins.size > 0 && !allowedOrigins.has(url.origin)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function safeFilename(value: string): string {
  const filename = value
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return filename || 'input.bin';
}

function validMediaMagic(data: Buffer, rawContentType: string): boolean {
  const contentType = rawContentType.toLowerCase().split(';')[0]?.trim();
  const ascii = (start: number, end: number) => data.subarray(start, end).toString('ascii');
  if (contentType === 'image/png')
    return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (contentType === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (contentType === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (contentType === 'image/gif') return ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a';
  if (contentType === 'video/mp4' || contentType === 'video/quicktime' || contentType === 'audio/mp4')
    return ascii(4, 8) === 'ftyp';
  if (contentType === 'video/webm') return data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (contentType === 'audio/wav' || contentType === 'audio/x-wav')
    return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (contentType === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (contentType === 'audio/mpeg')
    return ascii(0, 3) === 'ID3' || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0);
  return false;
}

function deadlineSignal(timeoutMs: number, parent: AbortSignal): AbortSignal {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

function parseCredentialBundle(encoded: string): { encoded: string; bytes: Buffer; accountProfile?: Record<string, unknown> } {
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 128 * 1024)
    throw videoError('credential_injection', 'jimeng_credential_bundle_invalid', false, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error) {
    throw videoError('credential_injection', 'jimeng_credential_bundle_invalid', false, false, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw videoError('credential_injection', 'jimeng_credential_bundle_invalid', false, false);
  const value = parsed as Record<string, unknown>;
  if (
    value.schemaVersion !== 2 ||
    value.storageFormat !== 'dreamina_auth_json_v1' ||
    typeof value.authFileBase64 !== 'string' ||
    typeof value.authFileSha256 !== 'string'
  )
    throw videoError('credential_injection', 'jimeng_credential_bundle_invalid', false, false);
  const bytes = Buffer.from(value.authFileBase64, 'base64');
  const auth = validateAuthBytes(bytes);
  if (bytes.toString('base64') !== value.authFileBase64 || sha256(bytes) !== value.authFileSha256)
    throw videoError('credential_injection', 'jimeng_credential_bundle_sha256_mismatch', false, false);
  const accountProfile = validatedAccountProfile(value.accountProfile, auth);
  return { encoded: JSON.stringify(value), bytes, ...(accountProfile ? { accountProfile } : {}) };
}

function validateAuthBytes(bytes: Buffer): Record<string, unknown> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_AUTH_BYTES)
    throw videoError('credential_injection', 'jimeng_credential_auth_file_size_invalid', false, false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw videoError('credential_injection', 'jimeng_credential_auth_file_json_invalid', false, false, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw videoError('credential_injection', 'jimeng_credential_auth_file_json_invalid', false, false);
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    typeof value.refresh_token !== 'string' ||
    !value.refresh_token ||
    !value.token_expires_at ||
    !value.device_key ||
    !value.user_info
  )
    throw videoError('credential_injection', 'jimeng_credential_auth_file_field_missing', false, false);
  return value;
}

async function captureSessionCredential(
  session: { authFilePath: string; credentialStore?: JimengCredentialStore },
  initial: { encoded: string; bytes: Buffer; accountProfile?: Record<string, unknown> },
  cliVersion: string,
): Promise<{ changed: boolean; encoded: string }> {
  let bytes: Buffer;
  if (session.credentialStore) {
    bytes = await session.credentialStore.capture();
  } else {
    const handle = await open(session.authFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
        throw videoError('credential_capture', 'jimeng_credential_auth_file_permissions_invalid', false, false);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  validateAuthBytes(bytes);
  if (bytes.equals(initial.bytes)) return { changed: false, encoded: initial.encoded };
  return {
    changed: true,
    encoded: JSON.stringify({
      schemaVersion: 2,
      storageFormat: 'dreamina_auth_json_v1',
      authFileBase64: bytes.toString('base64'),
      authFileSha256: sha256(bytes),
      capturedAt: new Date().toISOString(),
      sourceCliVersion: cliVersion,
      ...(initial.accountProfile ? { accountProfile: initial.accountProfile } : {}),
    }),
  };
}

function validatedAccountProfile(
  value: unknown,
  auth: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw videoError('credential_injection', 'jimeng_credential_account_profile_invalid', false, false);
  const profile = value as Record<string, unknown>;
  const accountId = profileText(profile.accountId, 256);
  const userInfo = auth.user_info;
  const authAccountId = userInfo && typeof userInfo === 'object' && !Array.isArray(userInfo)
    ? profileText((userInfo as Record<string, unknown>).user_id, 256)
    : undefined;
  if (!accountId || (authAccountId && accountId !== authAccountId))
    throw videoError('credential_injection', 'jimeng_credential_account_profile_invalid', false, false);
  return profile;
}

function profileText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : '';
  return text && text.length <= maxLength ? text : undefined;
}

async function captureTaskState(
  homeDir: string,
  videoJobId: string,
  submitId: string,
  cliVersion: string,
): Promise<string> {
  const files: TaskStateArchive['files'] = [];
  let rawBytes = 0;
  for (const path of TASK_STATE_PATHS) {
    let bytes: Buffer;
    try {
      bytes = await readSecureFile(join(homeDir, path));
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw error;
    }
    rawBytes += bytes.byteLength;
    if (rawBytes > MAX_TASK_STATE_RAW_BYTES)
      throw videoError('task_state_capture', 'jimeng_task_state_too_large', false, false);
    if (path === '.dreamina_cli/tasks.db' && !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER))
      throw videoError('task_state_capture', 'jimeng_task_state_database_invalid', false, false);
    files.push({ path, base64: bytes.toString('base64'), sha256: sha256(bytes) });
  }
  if (!files.some((file) => file.path === '.dreamina_cli/tasks.db'))
    throw videoError('task_state_capture', 'jimeng_task_state_database_missing', false, false);
  const archive: TaskStateArchive = {
    schemaVersion: 1,
    videoJobId,
    submitId,
    sourceCliVersion: cliVersion,
    capturedAt: new Date().toISOString(),
    files,
  };
  const raw = Buffer.from(JSON.stringify(archive));
  const compressed = gzipSync(raw, { level: 9 });
  if (compressed.byteLength > MAX_TASK_STATE_COMPRESSED_BYTES)
    throw videoError('task_state_capture', 'jimeng_task_state_control_payload_too_large', false, false);
  const envelope: TaskStateEnvelope = {
    schemaVersion: 1,
    storageFormat: 'dreamina_cli_task_state_gzip_v1',
    videoJobId,
    submitId,
    sha256: sha256(raw),
    gzipBase64: compressed.toString('base64'),
  };
  return JSON.stringify(envelope);
}

async function restoreTaskState(homeDir: string, videoJobId: string, submitId: string, encoded: string): Promise<void> {
  let envelope: TaskStateEnvelope;
  try {
    envelope = JSON.parse(encoded) as TaskStateEnvelope;
  } catch (error) {
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false, error);
  }
  if (
    envelope.schemaVersion !== 1 ||
    envelope.storageFormat !== 'dreamina_cli_task_state_gzip_v1' ||
    envelope.videoJobId !== videoJobId ||
    envelope.submitId !== submitId ||
    !/^[a-f0-9]{64}$/.test(envelope.sha256)
  )
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false);
  const compressed = Buffer.from(envelope.gzipBase64, 'base64');
  if (compressed.byteLength > MAX_TASK_STATE_COMPRESSED_BYTES || compressed.toString('base64') !== envelope.gzipBase64)
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false);
  let raw: Buffer;
  try {
    raw = gunzipSync(compressed, { maxOutputLength: MAX_TASK_STATE_RAW_BYTES });
  } catch (error) {
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false, error);
  }
  if (sha256(raw) !== envelope.sha256)
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_sha256_mismatch', false, false);
  let archive: TaskStateArchive;
  try {
    archive = JSON.parse(raw.toString('utf8')) as TaskStateArchive;
  } catch (error) {
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false, error);
  }
  if (
    archive.schemaVersion !== 1 ||
    archive.videoJobId !== videoJobId ||
    archive.submitId !== submitId ||
    !Array.isArray(archive.files)
  )
    throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false);
  const seen = new Set<string>();
  for (const file of archive.files) {
    if (
      !(TASK_STATE_PATHS as readonly string[]).includes(file.path) ||
      seen.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw videoError('task_state_restore', 'jimeng_task_state_bundle_invalid', false, false);
    seen.add(file.path);
    const bytes = Buffer.from(file.base64, 'base64');
    if (bytes.toString('base64') !== file.base64 || sha256(bytes) !== file.sha256)
      throw videoError('task_state_restore', 'jimeng_task_state_bundle_sha256_mismatch', false, false);
    if (file.path === '.dreamina_cli/tasks.db' && !bytes.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER))
      throw videoError('task_state_restore', 'jimeng_task_state_database_invalid', false, false);
    const path = join(homeDir, file.path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  }
  if (!seen.has('.dreamina_cli/tasks.db'))
    throw videoError('task_state_restore', 'jimeng_task_state_database_missing', false, false);
}

async function readSecureFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw videoError('task_state_capture', 'jimeng_task_state_file_invalid', false, false);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

class SubmissionReceiptStore {
  constructor(
    private readonly directory: string,
    private readonly seal: (plaintext: string) => string,
    private readonly open: (ciphertext: string) => string,
  ) {}

  async prepare(videoJobId: string, requestHash: string): Promise<SubmissionReceipt> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const existing = await this.load(videoJobId);
    if (existing) {
      if (existing.requestHash !== requestHash)
        throw videoError('receipt', 'jimeng_receipt_request_conflict', false, false);
      return existing;
    }
    const receipt: SubmissionReceipt = {
      schemaVersion: 1,
      videoJobId,
      requestHash,
      state: 'prepared',
      updatedAt: new Date().toISOString(),
    };
    await this.write(this.path(videoJobId), receipt, true);
    return receipt;
  }

  async markSubmitting(current: SubmissionReceipt): Promise<SubmissionReceipt> {
    return await this.transition(current, { ...current, state: 'submitting', updatedAt: new Date().toISOString() });
  }

  async markUnknown(current: SubmissionReceipt, unknownReason: string): Promise<SubmissionReceipt> {
    if (current.state === 'submission_unknown') return current;
    return await this.transition(current, {
      ...current,
      state: 'submission_unknown',
      unknownReason,
      updatedAt: new Date().toISOString(),
    });
  }

  async markSubmitted(
    current: SubmissionReceipt,
    result: {
      submitId: string;
      encodedTaskStateBundle: string;
      encodedCredentialBundle?: string;
      credentialChanged: boolean;
      upstreamResult: Record<string, unknown>;
    },
  ): Promise<SubmissionReceipt> {
    return await this.transition(current, {
      ...current,
      state: 'submitted',
      ...result,
      updatedAt: new Date().toISOString(),
    });
  }

  private async transition(current: SubmissionReceipt, next: SubmissionReceipt): Promise<SubmissionReceipt> {
    const latest = await this.load(current.videoJobId);
    if (!latest || latest.requestHash !== current.requestHash || latest.state !== current.state)
      throw videoError('receipt', 'jimeng_receipt_state_conflict', true, false);
    await this.write(this.path(current.videoJobId), next, false);
    return next;
  }

  private async load(videoJobId: string): Promise<SubmissionReceipt | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path(videoJobId), 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      throw videoError('receipt', 'jimeng_receipt_read_failed', true, false, error);
    }
    try {
      const envelope = JSON.parse(raw) as { schemaVersion?: unknown; storageFormat?: unknown; ciphertext?: unknown };
      if (
        envelope.schemaVersion !== 1 ||
        envelope.storageFormat !== 'provider_node_encrypted_json_v1' ||
        typeof envelope.ciphertext !== 'string'
      )
        throw new Error('invalid');
      const value = JSON.parse(this.open(envelope.ciphertext)) as SubmissionReceipt;
      if (
        value.schemaVersion !== 1 ||
        value.videoJobId !== videoJobId ||
        !/^[a-f0-9]{64}$/.test(value.requestHash) ||
        !['prepared', 'submitting', 'submitted', 'submission_unknown'].includes(value.state)
      )
        throw new Error('invalid');
      return value;
    } catch (error) {
      throw videoError('receipt', 'jimeng_video_receipt_corrupt', false, false, error);
    }
  }

  private async write(path: string, value: SubmissionReceipt, exclusive: boolean): Promise<void> {
    await writeAtomicJson(
      path,
      {
        schemaVersion: 1,
        storageFormat: 'provider_node_encrypted_json_v1',
        ciphertext: this.seal(JSON.stringify(value)),
      },
      exclusive,
    );
  }

  private path(videoJobId: string): string {
    return join(this.directory, `${videoJobId}.json`);
  }
}

async function writeAtomicJson(path: string, value: unknown, exclusive: boolean): Promise<void> {
  if (exclusive) {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function spawnBounded(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; running: RunningOperation },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.running.controller.signal.aborted)
      return reject(videoError('cli_execution', 'jimeng_cli_aborted', true, false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        env: options.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(videoError('cli_execution', 'jimeng_cli_spawn_failed', true, false, error));
      return;
    }
    if (!child.stdout || !child.stderr) {
      terminateProcess(child);
      reject(videoError('cli_execution', 'jimeng_cli_spawn_failed', true, false));
      return;
    }
    options.running.process = child;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.running.controller.signal.removeEventListener('abort', abort);
      options.running.process = undefined;
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_CLI_OUTPUT_BYTES) {
        terminateProcess(child);
        finish(videoError('cli_execution', 'jimeng_cli_output_too_large', false, false));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', (error) => finish(videoError('cli_execution', 'jimeng_cli_spawn_failed', true, false, error)));
    child.once('close', (code, signal) =>
      finish(
        code === 0
          ? undefined
          : videoError(
              'cli_execution',
              signal ? `jimeng_cli_signal_${signal.toLowerCase()}` : `jimeng_cli_exit_${code ?? 'unknown'}`,
              true,
              false,
            ),
      ),
    );
    const abort = () => {
      terminateProcess(child);
      finish(videoError('cli_execution', 'jimeng_cli_aborted', true, false));
    };
    options.running.controller.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      terminateProcess(child);
      finish(videoError('cli_execution', 'jimeng_cli_timeout', true, false));
    }, options.timeoutMs);
    timer.unref?.();
  });
}

function terminateProcess(child: ChildProcess | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, KILL_GRACE_MS);
  timer.unref?.();
}

function parseCliJson(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > MAX_CLI_OUTPUT_BYTES)
    throw videoError('cli_execution', 'jimeng_cli_output_invalid', false, false);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  try {
    const value = JSON.parse(first >= 0 && last >= first ? trimmed.slice(first, last + 1) : trimmed) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
    return value as Record<string, unknown>;
  } catch (error) {
    throw videoError('cli_execution', 'jimeng_cli_output_invalid', false, false, error);
  }
}

function nestedString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key] as string;
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data))
    return nestedString(value.data as Record<string, unknown>, ...keys);
  return undefined;
}

function completedEvent(
  message: PlatformJimengVideoExecute,
  result: Omit<ProviderJimengVideoCompleted, 'type' | 'protocolVersion' | 'requestId' | 'videoJobId' | 'nodeId'>,
): ProviderJimengVideoCompleted {
  return {
    type: 'provider.jimeng_video_completed',
    protocolVersion: JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    videoJobId: message.videoJobId,
    nodeId: message.nodeId,
    ...result,
  };
}

function failedEvent(
  message: Pick<PlatformJimengVideoExecute, 'requestId' | 'videoJobId' | 'nodeId'>,
  operation: 'submit' | 'query',
  stage: JimengVideoFailureStage,
  code: string,
  canRetry: boolean,
  submissionUnknown: boolean,
): ProviderJimengVideoFailed {
  return {
    type: 'provider.jimeng_video_failed',
    protocolVersion: JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
    requestId: message.requestId,
    videoJobId: message.videoJobId,
    nodeId: message.nodeId,
    operation,
    stage,
    errorCode: code,
    retryable: canRetry,
    submissionUnknown,
  };
}

function errorEvent(
  message: PlatformJimengVideoExecute,
  operation: 'submit' | 'query',
  error: unknown,
): ProviderJimengVideoFailed {
  const detail =
    error instanceof JimengVideoError
      ? error
      : videoError('cli_execution', errorCode(error), retryable(error), false, error);
  return failedEvent(message, operation, detail.stage, detail.code, detail.retryable, detail.submissionUnknown);
}

class JimengVideoError extends Error {
  constructor(
    readonly stage: JimengVideoFailureStage,
    readonly code: string,
    readonly retryable: boolean,
    readonly submissionUnknown: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, options);
  }
}

function videoError(
  stage: JimengVideoFailureStage,
  code: string,
  canRetry: boolean,
  submissionUnknown: boolean,
  cause?: unknown,
): JimengVideoError {
  return new JimengVideoError(stage, code, canRetry, submissionUnknown, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown): string {
  return error instanceof JimengVideoError
    ? error.code
    : error instanceof Error && /^jimeng_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'jimeng_video_execution_failed';
}
function retryable(error: unknown): boolean {
  return error instanceof JimengVideoError ? error.retryable : true;
}
function boundedDeadline(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_DEADLINE_MS)
    throw videoError('validation', 'jimeng_video_deadline_invalid', false, false);
  return value;
}
function requiredIdentifier(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !validIdentifier(value, max)) throw videoError('validation', code, false, false);
  return value;
}
function validIdentifier(value: string, max: number): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && Buffer.byteLength(value) <= max;
}
function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}
