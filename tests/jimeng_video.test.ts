import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JimengVideoHandler } from '../src/provider-node/jimeng-video.js';
import {
  JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
  JIMENG_USAGE_CONTROL_PROTOCOL_VERSION,
  type PlatformJimengUsageRefresh,
  type PlatformJimengVideoExecute,
  type ProviderJimengUsageCompleted,
  type ProviderJimengUsageFailed,
  type ProviderJimengVideoCompleted,
  type ProviderJimengVideoFailed,
} from '../src/shared/protocol.js';

type VideoEvent = ProviderJimengVideoCompleted | ProviderJimengVideoFailed;
type UsageEvent = ProviderJimengUsageCompleted | ProviderJimengUsageFailed;

afterEach(() => vi.unstubAllGlobals());

const receiptCodec = {
  sealReceipt: (value: string) => Buffer.from(value).toString('base64'),
  openReceipt: (value: string) => Buffer.from(value, 'base64').toString(),
};

function credentialBundle(accessToken = 'access-secret'): string {
  const bytes = Buffer.from(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-secret',
      token_expires_at: 1_900_000_000,
      device_key: { device_id: 'device-secret' },
      user_info: { user_id: 'user-1' },
    }),
  );
  return JSON.stringify({
    schemaVersion: 2,
    storageFormat: 'dreamina_auth_json_v1',
    authFileBase64: bytes.toString('base64'),
    authFileSha256: createHash('sha256').update(bytes).digest('hex'),
    capturedAt: '2026-08-01T00:00:00.000Z',
    sourceCliVersion: '1.4.14',
    accountProfile: {
      accountId: 'user-1',
      accountName: 'Provider Account',
      vipLevel: 'VIP',
    },
  });
}

function submitMessage(overrides: Partial<PlatformJimengVideoExecute> = {}): PlatformJimengVideoExecute {
  return {
    type: 'platform.jimeng_video_execute',
    protocolVersion: JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-1',
    videoJobId: 'video-job-1',
    providerId: 'provider-1',
    nodeId: 'node-1',
    deadlineMs: 10_000,
    encodedCredentialBundle: credentialBundle(),
    operation: {
      type: 'submit',
      mode: 'text_to_video',
      modelVersion: 'seedance2.0mini',
      prompt: 'a cat running',
      durationSeconds: 5,
      ratio: '16:9',
      resolution: '720p',
    },
    ...overrides,
  };
}

function sqliteDatabase(): Buffer {
  return Buffer.concat([Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(100)]);
}

function execute(handler: JimengVideoHandler, message: PlatformJimengVideoExecute): Promise<VideoEvent> {
  return new Promise((resolve) => handler.execute(message, resolve));
}

function refreshUsage(handler: JimengVideoHandler, message: PlatformJimengUsageRefresh): Promise<UsageEvent> {
  return new Promise((resolve) => handler.refreshUsage(message, resolve));
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function commandHome(env: NodeJS.ProcessEnv): string {
  if (!env.HOME) throw new Error('missing HOME');
  return env.HOME;
}

describe('Jimeng Provider Node video executor', () => {
  it('queries live credit in an isolated credential session and returns a refreshed profile', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-usage-test-'));
    let sessionRoot = '';
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        expect(args).toEqual(['user_credit']);
        sessionRoot = join(commandHome(options.env), '..');
        return {
          stdout: JSON.stringify({
            user_id: 'user-1',
            user_name: 'Provider Account',
            vip_level: 'VIP',
            total_credit: 88,
          }),
          stderr: '',
        };
      },
    });
    try {
      const event = await refreshUsage(handler, {
        type: 'platform.jimeng_usage_refresh',
        protocolVersion: JIMENG_USAGE_CONTROL_PROTOCOL_VERSION,
        requestId: 'usage-request-1',
        providerId: 'provider-1',
        nodeId: 'node-1',
        credentialBindingId: 'credential-1',
        deadlineMs: 10_000,
        encodedCredentialBundle: credentialBundle(),
      });
      expect(event).toMatchObject({
        type: 'provider.jimeng_usage_completed',
        credentialBindingId: 'credential-1',
        totalCredit: 88,
        checkedAt: expect.any(String),
      });
      if (event.type !== 'provider.jimeng_usage_completed') throw new Error('usage refresh failed');
      const bundle = JSON.parse(event.encodedCredentialBundle) as {
        accountProfile: Record<string, unknown>;
      };
      expect(bundle.accountProfile).toMatchObject({
        accountId: 'user-1',
        totalCredit: 88,
        creditCheckedAt: event.checkedAt,
      });
      await expect(access(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('submits once, captures task state and refreshed credentials, and removes the temporary HOME', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-test-'));
    const receipts = join(parent, 'receipts');
    const sessions = join(parent, 'sessions');
    await mkdir(sessions);
    const calls: string[][] = [];
    let sessionRoot = '';
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: receipts,
      ...receiptCodec,
      tempParentDir: sessions,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        calls.push(args);
        const home = commandHome(options.env);
        sessionRoot = join(home, '..');
        const taskDir = join(home, '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        const authPath = join(home, '.local/share/dreamina/byted_cli_user_token.json');
        const refreshed = JSON.parse((await readFile(authPath)).toString()) as Record<string, unknown>;
        refreshed.access_token = 'refreshed-access';
        await writeFile(authPath, JSON.stringify(refreshed), { mode: 0o600 });
        return { stdout: '{"submit_id":"submit-1","gen_status":"querying"}', stderr: '' };
      },
    });

    try {
      const message = submitMessage();
      if (message.operation.type === 'submit') delete message.operation.ratio;
      const event = await execute(handler, message);
      expect(event).toMatchObject({
        type: 'provider.jimeng_video_completed',
        operation: 'submit',
        submitId: 'submit-1',
        reusedSubmission: false,
        credentialChanged: true,
      });
      expect(calls).toEqual([
        [
          'text2video',
          '--prompt=a cat running',
          '--model_version=seedance2.0mini',
          '--duration=5',
          '--video_resolution=720p',
          '--poll=0',
        ],
      ]);
      expect(event.type === 'provider.jimeng_video_completed' && event.encodedTaskStateBundle.length).toBeGreaterThan(
        100,
      );
      if (event.type !== 'provider.jimeng_video_completed' || !event.encodedCredentialBundle)
        throw new Error('missing refreshed credential');
      const refreshedBundle = JSON.parse(event.encodedCredentialBundle) as {
        authFileBase64: string;
        accountProfile?: Record<string, unknown>;
      };
      expect(JSON.parse(Buffer.from(refreshedBundle.authFileBase64, 'base64').toString())).toMatchObject({
        access_token: 'refreshed-access',
      });
      expect(refreshedBundle.accountProfile).toEqual({
        accountId: 'user-1',
        accountName: 'Provider Account',
        vipLevel: 'VIP',
      });
      const receipt = await readFile(join(receipts, 'video-job-1.json'), 'utf8');
      expect(receipt).not.toContain('refreshed-access');
      const replayMessage = submitMessage({ requestId: 'request-replay' });
      if (replayMessage.operation.type === 'submit') delete replayMessage.operation.ratio;
      const replayed = await execute(handler, replayMessage);
      expect(replayed).toMatchObject({
        type: 'provider.jimeng_video_completed',
        reusedSubmission: true,
        credentialChanged: true,
      });
      if (replayed.type !== 'provider.jimeng_video_completed' || !replayed.encodedCredentialBundle)
        throw new Error('missing replayed credential');
      const replayedBundle = JSON.parse(replayed.encodedCredentialBundle) as { authFileBase64: string };
      expect(JSON.parse(Buffer.from(replayedBundle.authFileBase64, 'base64').toString())).toMatchObject({
        access_token: 'refreshed-access',
      });
      expect(calls).toHaveLength(1);
      await expect(access(sessionRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('replays a durable receipt without submitting to Dreamina twice', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-replay-'));
    let calls = 0;
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, _args, options) => {
        calls += 1;
        const dir = join(commandHome(options.env), '.dreamina_cli');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'tasks.db'), sqliteDatabase());
        return { stdout: '{"submit_id":"submit-once"}', stderr: '' };
      },
    });
    try {
      const first = await execute(handler, submitMessage());
      await nextTurn();
      const second = await execute(handler, submitMessage({ requestId: 'request-2' }));
      expect(first).toMatchObject({ type: 'provider.jimeng_video_completed', reusedSubmission: false });
      expect(second).toMatchObject({
        type: 'provider.jimeng_video_completed',
        reusedSubmission: true,
        submitId: 'submit-once',
      });
      expect(calls).toBe(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('restores captured task state into a fresh HOME for query', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-query-'));
    let calls = 0;
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        calls += 1;
        const home = commandHome(options.env);
        const db = join(home, '.dreamina_cli/tasks.db');
        if (args[0] === 'query_result') {
          expect(await readFile(db)).toEqual(sqliteDatabase());
          return {
            stdout: '{"submit_id":"submit-query","gen_status":"success","video_url":"https://example.test/video.mp4"}',
            stderr: '',
          };
        }
        await mkdir(join(home, '.dreamina_cli'), { recursive: true });
        await writeFile(db, sqliteDatabase());
        return { stdout: '{"submit_id":"submit-query"}', stderr: '' };
      },
    });
    try {
      const submitted = await execute(handler, submitMessage());
      expect(submitted.type).toBe('provider.jimeng_video_completed');
      if (submitted.type !== 'provider.jimeng_video_completed') return;
      await nextTurn();
      const queried = await execute(
        handler,
        submitMessage({
          requestId: 'request-query',
          operation: {
            type: 'query',
            submitId: submitted.submitId,
            encodedTaskStateBundle: submitted.encodedTaskStateBundle,
          },
        }),
      );
      expect(queried).toMatchObject({
        type: 'provider.jimeng_video_completed',
        operation: 'query',
        submitId: 'submit-query',
        upstreamResult: { gen_status: 'success' },
      });
      expect(calls).toBe(2);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects unsupported models before the CLI starts', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-invalid-'));
    let calls = 0;
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async () => {
        calls += 1;
        return { stdout: '{}', stderr: '' };
      },
    });
    try {
      const message = submitMessage();
      if (message.operation.type === 'submit') message.operation.modelVersion = 'seedance2.5';
      expect(await execute(handler, message)).toMatchObject({
        type: 'provider.jimeng_video_failed',
        stage: 'validation',
        errorCode: 'jimeng_video_model_unsupported',
        submissionUnknown: false,
      });
      expect(calls).toBe(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('advertises and submits Seedance 2.5 with its 480P and 30-second limits when the CLI exposes it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-25-'));
    const calls: string[][] = [];
    const handler = new JimengVideoHandler({
      cli: {
        path: '/opt/dreamina',
        version: 'a857341-dirty',
        textToVideoModels: ['seedance2.0mini', 'seedance2.5'],
        textToVideoResolutions: ['480p', '720p'],
      },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        calls.push(args);
        const taskDir = join(commandHome(options.env), '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        return { stdout: '{"submit_id":"submit-25","gen_status":"querying"}', stderr: '' };
      },
    });
    try {
      expect(handler.capability()).toMatchObject({
        upstreamModelVersions: ['seedance2.0mini', 'seedance2.5'],
        resolutions: ['480p', '720p'],
      });
      const message = submitMessage();
      if (message.operation.type !== 'submit') throw new Error('expected submit');
      message.operation.modelVersion = 'seedance2.5';
      message.operation.durationSeconds = 30;
      message.operation.resolution = '480p';
      expect(await execute(handler, message)).toMatchObject({
        type: 'provider.jimeng_video_completed',
        submitId: 'submit-25',
      });
      expect(calls[0]).toEqual([
        'text2video',
        '--prompt=a cat running',
        '--model_version=seedance2.5',
        '--duration=30',
        '--ratio=16:9',
        '--video_resolution=480p',
        '--poll=0',
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('marks an indeterminate submit as unknown and never retries it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-unknown-'));
    let calls = 0;
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async () => {
        calls += 1;
        throw new Error('jimeng_cli_timeout');
      },
    });
    try {
      expect(await execute(handler, submitMessage())).toMatchObject({
        type: 'provider.jimeng_video_failed',
        errorCode: 'jimeng_cli_timeout',
        submissionUnknown: true,
      });
      await nextTurn();
      expect(await execute(handler, submitMessage({ requestId: 'request-retry' }))).toMatchObject({
        type: 'provider.jimeng_video_failed',
        errorCode: 'jimeng_submission_unknown',
        submissionUnknown: true,
      });
      expect(calls).toBe(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('replays a submitted receipt when only temporary media download URLs change', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-replay-url-'));
    const image = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('reference-image'),
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(image, {
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(image.length) },
    })));
    let calls = 0;
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      allowedTransferOrigins: ['https://node.test'],
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, _args, options) => {
        calls += 1;
        const taskDir = join(commandHome(options.env), '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        return { stdout: '{"submit_id":"submit-url-replay"}', stderr: '' };
      },
    });
    const mediaInput = (downloadUrl: string) => ({
      id: 'reference-image',
      kind: 'image' as const,
      role: 'reference' as const,
      filename: 'reference.png',
      contentType: 'image/png',
      bytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
      downloadUrl,
    });
    try {
      const first = submitMessage({ requestId: 'request-first', videoJobId: 'video-url-replay' });
      if (first.operation.type !== 'submit') throw new Error('expected submit');
      first.operation.mode = 'image_to_video';
      first.operation.mediaInputs = [mediaInput('https://node.test/grant-first')];
      expect(await execute(handler, first)).toMatchObject({
        type: 'provider.jimeng_video_completed',
        submitId: 'submit-url-replay',
        reusedSubmission: false,
      });
      await nextTurn();

      const retry = submitMessage({ requestId: 'request-retry', videoJobId: 'video-url-replay' });
      if (retry.operation.type !== 'submit') throw new Error('expected submit');
      retry.operation.mode = 'image_to_video';
      retry.operation.mediaInputs = [mediaInput('https://node.test/grant-retry')];
      expect(await execute(handler, retry)).toMatchObject({
        type: 'provider.jimeng_video_completed',
        submitId: 'submit-url-replay',
        reusedSubmission: true,
      });
      await nextTurn();

      const changed = submitMessage({ requestId: 'request-changed', videoJobId: 'video-url-replay' });
      if (changed.operation.type !== 'submit') throw new Error('expected submit');
      changed.operation.mode = 'image_to_video';
      changed.operation.mediaInputs = [{
        ...mediaInput('https://node.test/grant-changed'),
        sha256: 'f'.repeat(64),
      }];
      expect(await execute(handler, changed)).toMatchObject({
        type: 'provider.jimeng_video_failed',
        errorCode: 'jimeng_receipt_request_conflict',
      });
      expect(calls).toBe(1);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('only cancels the matching active video job', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-cancel-'));
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, _args, options) => {
        if (options.running.controller.signal.aborted) throw new Error('jimeng_cli_aborted');
        await new Promise<void>((_resolve, reject) => {
          options.running.controller.signal.addEventListener('abort', () => reject(new Error('jimeng_cli_aborted')), {
            once: true,
          });
        });
        return { stdout: '{}', stderr: '' };
      },
    });
    try {
      const result = execute(handler, submitMessage());
      await nextTurn();
      expect(
        handler.cancel({
          type: 'platform.jimeng_video_cancel',
          protocolVersion: JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
          requestId: 'request-1',
          videoJobId: 'different-job',
          nodeId: 'node-1',
        }),
      ).toBe(false);
      expect(
        handler.cancel({
          type: 'platform.jimeng_video_cancel',
          protocolVersion: JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION,
          requestId: 'request-1',
          videoJobId: 'video-job-1',
          nodeId: 'node-1',
        }),
      ).toBe(true);
      await expect(result).resolves.toMatchObject({
        type: 'provider.jimeng_video_failed',
        errorCode: 'jimeng_cli_aborted',
        submissionUnknown: true,
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('maps media inputs to CLI commands after transport integrity checks without format validation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-modes-'));
    const mediaById = new Map<string, Buffer>();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const id = new URL(url).pathname.slice(1);
        const media = mediaById.get(id);
        if (!media) throw new Error(`missing test media: ${id}`);
        return new Response(media, { status: 200, headers: { 'content-length': String(media.length) } });
      }),
    );
    const calls: string[][] = [];
    const handler = new JimengVideoHandler({
      cli: {
        path: '/opt/dreamina',
        version: '1.4.15',
        videoGenerationModes: ['text_to_video', 'image_to_video', 'first_last_frames', 'multimodal_reference'],
        videoModelsByMode: {
          text_to_video: ['seedance2.0mini'],
          image_to_video: ['seedance2.0mini'],
          first_last_frames: ['seedance2.0mini'],
          multimodal_reference: ['seedance2.0mini'],
        },
        videoResolutions: ['720p'],
      },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        calls.push(args);
        const taskDir = join(commandHome(options.env), '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        return { stdout: `{"submit_id":"submit-${calls.length}"}`, stderr: '' };
      },
    });
    const input = (
      id: string,
      kind: 'image' | 'video' | 'audio',
      role: 'first_frame' | 'last_frame' | 'reference' = 'reference',
    ) => {
      const media =
        kind === 'image'
          ? Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('image')])
          : kind === 'video'
            ? Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('video')])
            : Buffer.concat([Buffer.from('ID3'), Buffer.from('audio')]);
      mediaById.set(id, media);
      return {
        id,
        kind,
        role,
        filename: `${id}.bin`,
        contentType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
        bytes: media.length,
        sha256: createHash('sha256').update(media).digest('hex'),
        downloadUrl: `https://node.test/${id}`,
      };
    };
    try {
      const image = submitMessage({ requestId: 'request-image', videoJobId: 'video-image' });
      if (image.operation.type !== 'submit') throw new Error('expected submit');
      image.operation.mode = 'image_to_video';
      image.operation.mediaInputs = [input('image', 'image')];
      expect((await execute(handler, image)).type).toBe('provider.jimeng_video_completed');
      await nextTurn();

      const frames = submitMessage({ requestId: 'request-frames', videoJobId: 'video-frames' });
      if (frames.operation.type !== 'submit') throw new Error('expected submit');
      frames.operation.mode = 'first_last_frames';
      frames.operation.mediaInputs = [input('first', 'image', 'first_frame'), input('last', 'image', 'last_frame')];
      expect((await execute(handler, frames)).type).toBe('provider.jimeng_video_completed');
      await nextTurn();

      const multimodal = submitMessage({ requestId: 'request-multi', videoJobId: 'video-multi' });
      if (multimodal.operation.type !== 'submit') throw new Error('expected submit');
      multimodal.operation.mode = 'multimodal_reference';
      multimodal.operation.mediaInputs = [
        input('ref-image', 'image'),
        input('ref-video', 'video'),
        input('ref-audio', 'audio'),
      ];
      expect((await execute(handler, multimodal)).type).toBe('provider.jimeng_video_completed');
      await nextTurn();

      const passthrough = submitMessage({ requestId: 'request-passthrough', videoJobId: 'video-passthrough' });
      if (passthrough.operation.type !== 'submit') throw new Error('expected submit');
      passthrough.operation.mode = 'image_to_video';
      const opaqueMedia = Buffer.from('platform-validated-media');
      mediaById.set('passthrough-image', opaqueMedia);
      passthrough.operation.mediaInputs = [{
        id: 'passthrough-image',
        kind: 'image',
        role: 'reference',
        filename: 'passthrough.png',
        contentType: 'image/png',
        bytes: opaqueMedia.length,
        sha256: createHash('sha256').update(opaqueMedia).digest('hex'),
        downloadUrl: 'https://node.test/passthrough-image',
      }];
      expect((await execute(handler, passthrough)).type).toBe('provider.jimeng_video_completed');

      expect(calls[0]?.[0]).toBe('image2video');
      expect(calls[0]?.some((arg) => arg.startsWith('--image='))).toBe(true);
      expect(calls[1]?.[0]).toBe('frames2video');
      expect(calls[1]?.some((arg) => arg.startsWith('--first='))).toBe(true);
      expect(calls[1]?.some((arg) => arg.startsWith('--last='))).toBe(true);
      expect(calls[2]?.[0]).toBe('multimodal2video');
      expect(calls[2]?.filter((arg) => /^--(?:image|video|audio)=/.test(arg))).toHaveLength(3);
      expect(calls[3]?.[0]).toBe('image2video');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('downloads a completed MP4, uploads it with a digest, and reports only verified artifact metadata', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-video-output-'));
    const output = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('mp4-output-bytes')]);
    let uploaded = Buffer.alloc(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const chunks: Buffer[] = [];
        if (!init?.body) throw new Error('missing upload body');
        for await (const chunk of init.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return new Response('{}', { status: 200 });
      }),
    );
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.15' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform: 'linux',
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      runCommand: async (_binary, args, options) => {
        const home = commandHome(options.env);
        const taskDir = join(home, '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        if (args[0] === 'query_result') {
          const downloadArg = args.find((arg) => arg.startsWith('--download_dir='));
          if (!downloadArg) throw new Error('missing download directory');
          const downloadDir = downloadArg.slice('--download_dir='.length);
          await writeFile(join(downloadDir, 'result.mp4'), output);
          return { stdout: '{"submit_id":"submit-output","status":"completed"}', stderr: '' };
        }
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        return { stdout: '{"submit_id":"submit-output"}', stderr: '' };
      },
    });
    try {
      const submitted = await execute(handler, submitMessage());
      if (submitted.type !== 'provider.jimeng_video_completed') throw new Error('submit failed');
      await nextTurn();
      const query = submitMessage({
        requestId: 'request-output-query',
        videoJobId: 'video-job-1',
        operation: {
          type: 'query',
          submitId: submitted.submitId,
          encodedTaskStateBundle: submitted.encodedTaskStateBundle,
          artifactUpload: { url: 'https://node.test/upload', maxBytes: 1024 },
        },
      });
      const result = await execute(handler, query);
      expect(result).toMatchObject({
        type: 'provider.jimeng_video_completed',
        outputArtifact: {
          contentType: 'video/mp4',
          bytes: output.length,
          sha256: createHash('sha256').update(output).digest('hex'),
        },
      });
      expect(uploaded).toEqual(output);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.each(['darwin', 'win32'] as const)('injects and restores the native credential store on %s', async (platform) => {
    const parent = await mkdtemp(join(tmpdir(), `wokey-jimeng-video-${platform}-`));
    const previous = Buffer.from('previous-native-secret');
    const injected: Array<Buffer | undefined> = [];
    const refreshed = Buffer.from(
      JSON.stringify({
        access_token: 'refreshed-native',
        refresh_token: 'refresh-secret',
        token_expires_at: 1_900_000_000,
        device_key: { device_id: 'device-secret' },
        user_info: { user_id: 'user-1' },
      }),
    );
    const handler = new JimengVideoHandler({
      cli: { path: '/opt/dreamina', version: '1.4.15' },
      receiptsDirectory: join(parent, 'receipts'),
      ...receiptCodec,
      tempParentDir: parent,
      platform,
      getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
      createCredentialStore: () => ({
        snapshot: async () => previous,
        restore: async (value) => {
          injected.push(value ? Buffer.from(value) : undefined);
        },
        capture: async () => refreshed,
      }),
      runCommand: async (_binary, _args, options) => {
        const taskDir = join(commandHome(options.env), '.dreamina_cli');
        await mkdir(taskDir, { recursive: true });
        await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
        return { stdout: '{"submit_id":"submit-native"}', stderr: '' };
      },
    });
    try {
      const result = await execute(handler, submitMessage());
      expect(result).toMatchObject({ type: 'provider.jimeng_video_completed', credentialChanged: true });
      const originalBundle = JSON.parse(credentialBundle()) as { authFileBase64: string };
      expect(injected).toEqual([Buffer.from(originalBundle.authFileBase64, 'base64'), previous]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it.each(['darwin', 'win32'] as const)(
    'reuses an identical native credential without writing the credential store on %s',
    async (platform) => {
      const parent = await mkdtemp(join(tmpdir(), `wokey-jimeng-video-native-reuse-${platform}-`));
      const bundle = JSON.parse(credentialBundle()) as { authFileBase64: string };
      const localCredential = Buffer.from(bundle.authFileBase64, 'base64');
      const restore = vi.fn(async () => {});
      const handler = new JimengVideoHandler({
        cli: { path: '/opt/dreamina', version: '1.4.15' },
        receiptsDirectory: join(parent, 'receipts'),
        ...receiptCodec,
        tempParentDir: parent,
        platform,
        getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
        createCredentialStore: () => ({
          snapshot: async () => Buffer.from(localCredential),
          restore,
          capture: async () => Buffer.from(localCredential),
        }),
        runCommand: async (_binary, _args, options) => {
          const taskDir = join(commandHome(options.env), '.dreamina_cli');
          await mkdir(taskDir, { recursive: true });
          await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
          return { stdout: '{"submit_id":"submit-native-reuse"}', stderr: '' };
        },
      });
      try {
        const result = await execute(handler, submitMessage());
        expect(result).toMatchObject({
          type: 'provider.jimeng_video_completed',
          credentialChanged: false,
        });
        expect(restore).not.toHaveBeenCalled();
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.each(['darwin', 'win32'] as const)(
    'reuses a refreshed native credential for the same Jimeng account on %s',
    async (platform) => {
      const parent = await mkdtemp(join(tmpdir(), `wokey-jimeng-video-native-account-reuse-${platform}-`));
      const bundle = JSON.parse(credentialBundle()) as { authFileBase64: string };
      const localAuth = JSON.parse(Buffer.from(bundle.authFileBase64, 'base64').toString()) as Record<string, unknown>;
      localAuth.access_token = 'newer-local-access-token';
      localAuth.refresh_token = 'newer-local-refresh-token';
      const localCredential = Buffer.from(JSON.stringify(localAuth, null, 2));
      const restore = vi.fn(async () => {});
      const handler = new JimengVideoHandler({
        cli: { path: '/opt/dreamina', version: '1.4.15' },
        receiptsDirectory: join(parent, 'receipts'),
        ...receiptCodec,
        tempParentDir: parent,
        platform,
        getIdentity: () => ({ nodeId: 'node-1', providerId: 'provider-1' }),
        createCredentialStore: () => ({
          snapshot: async () => Buffer.from(localCredential),
          restore,
          capture: async () => Buffer.from(localCredential),
        }),
        runCommand: async (_binary, _args, options) => {
          const taskDir = join(commandHome(options.env), '.dreamina_cli');
          await mkdir(taskDir, { recursive: true });
          await writeFile(join(taskDir, 'tasks.db'), sqliteDatabase());
          return { stdout: '{"submit_id":"submit-native-account-reuse"}', stderr: '' };
        },
      });
      try {
        const result = await execute(handler, submitMessage());
        expect(result).toMatchObject({
          type: 'provider.jimeng_video_completed',
          credentialChanged: true,
        });
        expect(restore).not.toHaveBeenCalled();
        if (result.type !== 'provider.jimeng_video_completed' || !result.encodedCredentialBundle)
          throw new Error('missing refreshed credential');
        const refreshed = JSON.parse(result.encodedCredentialBundle) as { authFileBase64: string };
        expect(Buffer.from(refreshed.authFileBase64, 'base64')).toEqual(localCredential);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
