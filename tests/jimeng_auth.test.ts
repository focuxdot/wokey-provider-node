import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectDreaminaCli,
  JimengAuthorizationHandler,
  type JimengAuthEvent,
} from '../src/provider-node/jimeng-auth.js';
import {
  createJimengCredentialStore,
  decodeGoKeyringSecret,
  type NativeCommandResult,
} from '../src/provider-node/jimeng-credential-store.js';
import { JIMENG_AUTH_CONTROL_PROTOCOL_VERSION, type PlatformJimengAuthStart } from '../src/shared/protocol.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function startMessage(): PlatformJimengAuthStart {
  return {
    type: 'platform.jimeng_auth_start',
    protocolVersion: JIMENG_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-1',
    flowId: 'flow-1',
    providerId: 'provider-1',
    nodeId: 'node-1',
    deadlineMs: 60_000,
  };
}

describe('JimengAuthorizationHandler', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('detects the CLI version on %s', async (platform) => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-version-test-'));
    tempDirs.push(parent);
    const executable = join(parent, 'dreamina');
    await writeFile(
      executable,
      ['#!/bin/sh', 'printf \'{"version":"b5ccc5d-dirty","build_time":"2026-07-29"}\\n\''].join('\n'),
    );
    await chmod(executable, 0o755);

    expect(detectDreaminaCli(executable, platform)).toEqual({
      path: executable,
      version: 'b5ccc5d-dirty',
    });
  });

  it.each([
    ['linux', join('.local', 'bin', 'dreamina')],
    ['darwin', join('.local', 'bin', 'dreamina')],
    ['win32', join('bin', 'dreamina.exe')],
  ] as const)('detects the CLI in the official default path on %s', async (platform, relativePath) => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-default-path-test-'));
    tempDirs.push(parent);
    const executable = join(parent, relativePath);
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, ['#!/bin/sh', "printf 'version: 1.4.14\\n'"].join('\n'));
    await chmod(executable, 0o755);

    expect(detectDreaminaCli(undefined, platform, parent)).toEqual({
      path: executable,
      version: '1.4.14',
    });
  });

  it('discovers Seedance 2.5 text-video capabilities from the installed CLI help', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-dreamina-capability-test-'));
    tempDirs.push(parent);
    const executable = join(parent, 'dreamina');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "text2video" ]; then',
      '  printf "model_version: seedance2.0mini, seedance2.5\\nvideo_resolution: 480p, 720p\\n"',
      'else',
      '  printf \'{"version":"a857341-dirty"}\\n\'',
      'fi',
    ].join('\n'));
    await chmod(executable, 0o755);

    expect(detectDreaminaCli(executable, 'linux')).toEqual({
      path: executable,
      version: 'a857341-dirty',
      textToVideoModels: ['seedance2.0mini', 'seedance2.5'],
      textToVideoResolutions: ['480p', '720p'],
    });
  });

  it('rejects a second authorization while the native credential slot is in use', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-exclusive-test-'));
    tempDirs.push(parent);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async () => {
        await blocked;
        throw new Error('jimeng_auth_cancelled');
      },
    });
    handler.start(startMessage(), () => {});
    await vi.waitFor(async () => expect(await readdir(parent)).toHaveLength(1));

    const second = { ...startMessage(), requestId: 'request-2', flowId: 'flow-2' };
    const event = await new Promise<JimengAuthEvent>((resolve) => handler.start(second, resolve));
    expect(event).toMatchObject({
      type: 'provider.jimeng_auth_failed',
      stage: 'launch',
      errorCode: 'jimeng_auth_start_invalid',
    });
    handler.cancelAll();
    release();
    await vi.waitFor(async () => expect(await readdir(parent)).toEqual([]));
  });

  it('captures and restores a native credential before emitting completion', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-native-test-'));
    tempDirs.push(parent);
    const order: string[] = [];
    const previous = Buffer.from('previous-native-value');
    const auth = Buffer.from(
      JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_expires_at: 1_900_000_000,
        device_key: { device_id: 'device-secret' },
        user_info: { user_id: 'jimeng-user-1' },
      }),
    );
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'darwin',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      createCredentialStore: () => ({
        snapshot: async () => {
          order.push('snapshot');
          return previous;
        },
        capture: async () => {
          order.push('capture');
          return auth;
        },
        restore: async (snapshot) => {
          order.push('restore');
          expect(snapshot).toEqual(previous);
        },
      }),
      runCommand: async (_executable, args) => {
        order.push(args.join(' '));
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://auth.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: 'ok\n', stderr: '' };
      },
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type !== 'provider.jimeng_auth_started') resolve(value);
      });
    });
    expect(event.type).toBe('provider.jimeng_auth_completed');
    expect(order).toEqual(['snapshot', 'capture', 'user_credit', 'capture', 'restore']);
  });

  it('removes a malformed native credential and falls back to Device Flow', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-corrupt-native-test-'));
    tempDirs.push(parent);
    const order: string[] = [];
    let captures = 0;
    const auth = Buffer.from(
      JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_expires_at: 1_900_000_000,
        device_key: { device_id: 'device-secret' },
        user_info: { user_id: 'jimeng-user-1' },
      }),
    );
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'darwin',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      createCredentialStore: () => ({
        snapshot: async () => {
          order.push('snapshot');
          return Buffer.from('corrupt-native-value');
        },
        capture: async () => {
          captures += 1;
          order.push(`capture-${captures}`);
          return captures === 1 ? Buffer.from('not-json') : auth;
        },
        restore: async (snapshot) => {
          order.push(snapshot ? 'restore' : 'delete');
        },
      }),
      runCommand: async (_executable, args) => {
        order.push(args.join(' '));
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://jimeng.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: 'ok\n', stderr: '' };
      },
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type !== 'provider.jimeng_auth_started') resolve(value);
      });
    });

    expect(event.type).toBe('provider.jimeng_auth_completed');
    expect(order).toEqual([
      'snapshot',
      'capture-1',
      'delete',
      'login --headless',
      'login checklogin --device_code=node-only-secret --poll=60',
      'capture-2',
      'user_credit',
      'capture-3',
      'delete',
    ]);
  });

  it.each([
    'darwin',
    'linux',
    'win32',
  ] as const)('uses the OS-appropriate credential environment on %s', async (platform) => {
    const parent = await mkdtemp(join(tmpdir(), `wokey-jimeng-${platform}-environment-test-`));
    tempDirs.push(parent);
    const nativeHomeDir = join(parent, 'native-home');
    await mkdir(nativeHomeDir, { mode: 0o700 });
    const observedEnvironments: NodeJS.ProcessEnv[] = [];
    const auth = Buffer.from(
      JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_expires_at: 1_900_000_000,
        device_key: { device_id: 'device-secret' },
        user_info: { user_id: 'jimeng-user-1' },
      }),
    );
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform,
      nativeHomeDir,
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      createCredentialStore: (options) => {
        observedEnvironments.push({ ...options.env });
        return {
          snapshot: async () => undefined,
          capture: async () => auth,
          restore: async () => {},
        };
      },
      runCommand: async (_executable, args, options) => {
        observedEnvironments.push({ ...options.env });
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://jimeng.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
            ].join('\n'),
            stderr: '',
          };
        }
        return { stdout: 'ok\n', stderr: '' };
      },
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type !== 'provider.jimeng_auth_started') resolve(value);
      });
    });

    expect(event.type).toBe('provider.jimeng_auth_completed');
    expect(observedEnvironments).toHaveLength(4);
    for (const env of observedEnvironments) {
      if (platform === 'darwin') expect(env.HOME).toBe(nativeHomeDir);
      else {
        expect(env.HOME).not.toBe(nativeHomeDir);
        expect(env.HOME).toMatch(new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wokey-jimeng-auth-`));
      }
      expect(env.XDG_CONFIG_HOME).not.toBe(nativeHomeDir);
      expect(env.XDG_DATA_HOME).not.toBe(nativeHomeDir);
      expect(env.XDG_CACHE_HOME).not.toBe(nativeHomeDir);
      expect(env.XDG_RUNTIME_DIR).not.toBe(nativeHomeDir);
      if (platform === 'win32') {
        expect(env.USERPROFILE).toBe(env.HOME);
        expect(env.APPDATA).toMatch(/\/config\/Roaming$/);
        expect(env.LOCALAPPDATA).toMatch(/\/data\/Local$/);
        expect(env.TEMP).toBe(env.XDG_CACHE_HOME);
        expect(env.TMP).toBe(env.XDG_CACHE_HOME);
      }
    }
  });

  it('runs headless Device Flow in an isolated HOME and emits only the final bundle', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-handler-test-'));
    tempDirs.push(parent);
    const commands: string[][] = [];
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async (_executable, args, options) => {
        commands.push(args);
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://auth.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
              'expires_in: 300',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'login') {
          expect(args).toContain('--device_code=node-only-secret');
          if (!options.env.HOME) throw new Error('HOME missing');
          const authPath = join(options.env.HOME, '.local/share/dreamina/byted_cli_user_token.json');
          await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
          await writeFile(
            authPath,
            JSON.stringify({
              access_token: 'access-secret',
              refresh_token: 'refresh-secret',
              token_expires_at: 1_900_000_000,
              device_key: { device_id: 'device-secret' },
              user_info: { user_id: 'jimeng-user-1' },
            }),
            { mode: 0o600 },
          );
          return { stdout: 'login success\n', stderr: '' };
        }
        expect(args).toEqual(['user_credit']);
        return {
          stdout: [
            'user_id: jimeng-user-1',
            'user_name: Provider Account',
            'vip_level: VIP',
            'total_credit: 100',
            'has_cli_permission: true',
          ].join('\n'),
          stderr: '',
        };
      },
    });

    const events: JimengAuthEvent[] = [];
    await new Promise<void>((resolve) => {
      handler.start(startMessage(), (event) => {
        events.push(event);
        if (event.type === 'provider.jimeng_auth_completed' || event.type === 'provider.jimeng_auth_failed') resolve();
      });
    });

    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual(['user_credit']);
    expect(events[0]).toMatchObject({
      type: 'provider.jimeng_auth_started',
      verificationUri: 'https://auth.jianying.com/device',
      userCode: 'ABCD-EFGH',
    });
    expect(events[0]).not.toHaveProperty('deviceCode');
    const completed = events[1];
    expect(completed?.type, JSON.stringify(completed)).toBe('provider.jimeng_auth_completed');
    if (completed?.type !== 'provider.jimeng_auth_completed') throw new Error('missing completion');
    const bundle = JSON.parse(completed.encodedCredentialBundle) as Record<string, unknown>;
    expect(bundle).toMatchObject({
      schemaVersion: 2,
      storageFormat: 'dreamina_auth_json_v1',
      sourceCliVersion: '1.4.14',
      accountProfile: {
        accountId: 'jimeng-user-1',
        accountName: 'Provider Account',
        vipLevel: 'VIP',
        totalCredit: 100,
        hasCliPermission: true,
      },
    });
    const auth = JSON.parse(Buffer.from(String(bundle.authFileBase64), 'base64').toString('utf8'));
    expect(auth.user_info.user_id).toBe('jimeng-user-1');
    // Completion is deliberately emitted only after the isolated credential
    // directory has been removed.
    expect(await readdir(parent)).toEqual([]);
  });

  it.each([
    {
      label: 'labeled authorization material written to stderr',
      result: {
        stdout: '',
        stderr: [
          'verification_uri: https://auth.jianying.com/device',
          'user_code: ABCD-EFGH',
          'device_code: node-only-secret',
          'expires_in: 300',
        ].join('\n'),
      },
    },
    {
      label: 'machine-readable JSON authorization material',
      result: {
        stdout: JSON.stringify({
          verification_uri: 'https://auth.jianying.com/device',
          verification_uri_complete: 'https://auth.jianying.com/device?code=ABCD-EFGH',
          user_code: 'ABCD-EFGH',
          device_code: 'node-only-secret',
          expires_in: 300,
        }),
        stderr: 'warning: machine-readable output enabled',
      },
    },
    {
      label: 'authorization material split across stdout and stderr',
      result: {
        stdout: ['verification_uri: https://auth.jianying.com/device', 'user_code: ABCD-EFGH'].join('\n'),
        stderr: 'device_code: node-only-secret',
      },
    },
  ])('accepts $label without exposing the device code', async ({ result }) => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-output-compat-test-'));
    tempDirs.push(parent);
    const auth = Buffer.from(
      JSON.stringify({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_expires_at: 1_900_000_000,
        device_key: { device_id: 'device-secret' },
        user_info: { user_id: 'jimeng-user-1' },
      }),
    );
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: 'a857341-dirty' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      createCredentialStore: () => ({
        snapshot: async () => undefined,
        capture: async () => auth,
        restore: async () => {},
      }),
      runCommand: async (_executable, args) => {
        if (args.includes('--headless')) return result;
        return { stdout: args[0] === 'user_credit' ? 'user_id: jimeng-user-1' : 'login success', stderr: '' };
      },
    });

    const events: JimengAuthEvent[] = [];
    await new Promise<void>((resolve) => {
      handler.start(startMessage(), (event) => {
        events.push(event);
        if (event.type === 'provider.jimeng_auth_completed' || event.type === 'provider.jimeng_auth_failed') resolve();
      });
    });

    expect(events.map((event) => event.type)).toEqual([
      'provider.jimeng_auth_started',
      'provider.jimeng_auth_completed',
    ]);
    expect(events[0]).toMatchObject({
      verificationUri: 'https://auth.jianying.com/device',
      userCode: 'ABCD-EFGH',
    });
    expect(JSON.stringify(events)).not.toContain('node-only-secret');
  });

  it('fails closed when stdout and stderr contain conflicting authorization material', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-output-conflict-test-'));
    tempDirs.push(parent);
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: 'a857341-dirty' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async () => ({
        stdout: [
          'verification_uri: https://auth.jianying.com/device',
          'user_code: ABCD-EFGH',
          'device_code: stdout-secret',
        ].join('\n'),
        stderr: 'device_code: conflicting-secret',
      }),
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type === 'provider.jimeng_auth_failed') resolve(value);
      });
    });
    expect(event).toMatchObject({
      type: 'provider.jimeng_auth_failed',
      stage: 'device_authorization',
      errorCode: 'jimeng_device_authorization_output_conflict',
      retryable: false,
    });
    expect(JSON.stringify(event)).not.toContain('secret');
  });

  it.each([
    [
      'verification URI',
      ['verification_uri: http://phishing.invalid/device', 'user_code: ABCD-EFGH', 'device_code: secret'],
    ],
    [
      'verification URI on another HTTPS host',
      ['verification_uri: https://jimeng.example/device', 'user_code: ABCD-EFGH', 'device_code: secret'],
    ],
    [
      'verification URI with a deceptive Jianying suffix',
      ['verification_uri: https://jianying.com.evil.example/device', 'user_code: ABCD-EFGH', 'device_code: secret'],
    ],
    [
      'complete verification URI',
      [
        'verification_uri: https://jimeng.jianying.com/device',
        'verification_uri_complete: javascript:alert(1)',
        'user_code: ABCD-EFGH',
        'device_code: secret',
      ],
    ],
  ])('fails closed on a non-HTTPS %s and removes the temporary HOME', async (_label, authorizationOutput) => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-handler-invalid-'));
    tempDirs.push(parent);
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async () => ({
        stdout: authorizationOutput.join('\n'),
        stderr: '',
      }),
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type === 'provider.jimeng_auth_failed') resolve(value);
      });
    });
    expect(event).toMatchObject({
      type: 'provider.jimeng_auth_failed',
      stage: 'device_authorization',
      errorCode: 'jimeng_verification_uri_invalid',
      retryable: false,
    });
    await vi.waitFor(async () => {
      expect(await readdir(parent)).toEqual([]);
    });
  });

  it('cancels an in-flight poll without exposing the device code', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-handler-cancel-'));
    tempDirs.push(parent);
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async (_executable, args, options) => {
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://jimeng.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
            ].join('\n'),
            stderr: '',
          };
        }
        await vi.waitFor(() => expect(options.flow.cancelled).toBe(true));
        throw new Error('jimeng_auth_cancelled');
      },
    });

    const events: JimengAuthEvent[] = [];
    const failed = new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (event) => {
        events.push(event);
        if (event.type === 'provider.jimeng_auth_started') {
          handler.cancel({
            type: 'platform.jimeng_auth_cancel',
            protocolVersion: JIMENG_AUTH_CONTROL_PROTOCOL_VERSION,
            requestId: 'cancel-1',
            flowId: 'flow-1',
            nodeId: 'node-1',
          });
        }
        if (event.type === 'provider.jimeng_auth_failed') resolve(event);
      });
    });

    await expect(failed).resolves.toMatchObject({
      type: 'provider.jimeng_auth_failed',
      stage: 'user_authorization',
      errorCode: 'jimeng_auth_cancelled',
      retryable: false,
    });
    expect(JSON.stringify(events)).not.toContain('node-only-secret');
    await vi.waitFor(async () => {
      expect(await readdir(parent)).toEqual([]);
    });
  });

  it('fails before capture when the non-generating user_credit check fails', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-handler-credit-'));
    tempDirs.push(parent);
    const handler = new JimengAuthorizationHandler({
      cli: { path: '/opt/dreamina', version: '1.4.14' },
      platform: 'linux',
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      runCommand: async (_executable, args, options) => {
        if (args.includes('--headless')) {
          return {
            stdout: [
              'verification_uri: https://jimeng.jianying.com/device',
              'user_code: ABCD-EFGH',
              'device_code: node-only-secret',
            ].join('\n'),
            stderr: '',
          };
        }
        if (args[0] === 'login') {
          if (!options.env.HOME) throw new Error('HOME missing');
          const authPath = join(options.env.HOME, '.local/share/dreamina/byted_cli_user_token.json');
          await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
          await writeFile(
            authPath,
            JSON.stringify({
              access_token: 'access-secret',
              refresh_token: 'refresh-secret',
              token_expires_at: 1_900_000_000,
              device_key: { device_id: 'device-secret' },
              user_info: { user_id: 'jimeng-user-1' },
            }),
            { mode: 0o600 },
          );
          return { stdout: 'login success\n', stderr: '' };
        }
        throw new Error('jimeng_cli_exit_1');
      },
    });

    const event = await new Promise<JimengAuthEvent>((resolve) => {
      handler.start(startMessage(), (value) => {
        if (value.type === 'provider.jimeng_auth_failed') resolve(value);
      });
    });
    expect(event).toMatchObject({
      type: 'provider.jimeng_auth_failed',
      stage: 'credential_validation',
      errorCode: 'jimeng_cli_exit_1',
      retryable: true,
    });
    await vi.waitFor(async () => {
      expect(await readdir(parent)).toEqual([]);
    });
  });
});

describe('Jimeng credential stores', () => {
  it('decodes the representations used by go-keyring', () => {
    expect(decodeGoKeyringSecret(Buffer.from('go-keyring-base64:aGVsbG8='))).toEqual(Buffer.from('hello'));
    expect(decodeGoKeyringSecret(Buffer.from('go-keyring-encoded:68656c6c6f'))).toEqual(Buffer.from('hello'));
    expect(decodeGoKeyringSecret(Buffer.from('hello'))).toEqual(Buffer.from('hello'));
  });

  it('captures, injects, verifies, and restores macOS Keychain credentials without putting secrets in argv', async () => {
    const previous = Buffer.from('previous-native-secret');
    const injected = Buffer.from('{\n  "access_token": "injected-secret"\n}');
    let stored = Buffer.from(`go-keyring-base64:${previous.toString('base64')}`);
    const calls: Array<{ args: string[]; input?: Buffer }> = [];
    const run = async (
      _executable: string,
      args: string[],
      options: { input?: Buffer },
    ): Promise<NativeCommandResult> => {
      calls.push({ args, input: options.input });
      if (args[0] === 'find-generic-password') {
        return { code: 0, stdout: Buffer.concat([stored, Buffer.from('\n')]), stderr: Buffer.alloc(0) };
      }
      const command = options.input?.toString('utf8') ?? '';
      const encoded = command.match(/-w '([^']+)'/)?.[1];
      if (!encoded) return { code: 2, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      stored = Buffer.from(encoded);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const store = createJimengCredentialStore({ platform: 'darwin', homeDir: '/unused', env: {}, runNativeCommand: run });
    const snapshot = await store.snapshot();
    await expect(store.capture()).resolves.toEqual(previous);
    await store.restore(injected);
    await expect(store.capture()).resolves.toEqual(injected);
    await store.restore(snapshot);
    await expect(store.capture()).resolves.toEqual(previous);

    const writes = calls.filter((call) => call.args[0] === '-i');
    expect(writes).toHaveLength(2);
    expect(writes.every((call) => call.args.length === 1)).toBe(true);
    expect(writes.every((call) => !call.input?.includes(injected))).toBe(true);
    expect(writes.every((call) => call.input?.includes('go-keyring-base64:'))).toBe(true);
  });

  it('exposes the native macOS login keychain inside an isolated video HOME without changing Keychain preferences', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-jimeng-isolated-keychain-test-'));
    tempDirs.push(parent);
    const nativeHomeDir = join(parent, 'native-home');
    const isolatedHomeDir = join(parent, 'isolated-home');
    const nativeKeychain = join(nativeHomeDir, 'Library', 'Keychains', 'login.keychain-db');
    await mkdir(dirname(nativeKeychain), { recursive: true });
    await writeFile(nativeKeychain, 'test-keychain');

    const calls: string[][] = [];
    const store = createJimengCredentialStore({
      platform: 'darwin',
      homeDir: isolatedHomeDir,
      env: { HOME: isolatedHomeDir },
      isolated: true,
      nativeHomeDir,
      runNativeCommand: async (_executable, args) => {
        calls.push(args);
        return { code: 44, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });

    await expect(store.snapshot()).resolves.toBeUndefined();
    await expect(readlink(join(
      isolatedHomeDir,
      'Library',
      'Keychains',
      'login.keychain-db',
    ))).resolves.toBe(nativeKeychain);
    expect(calls).toEqual([[
      'find-generic-password',
      '-s',
      'dreamina',
      '-a',
      'byted_cli_user_token',
      '-w',
    ]]);
    expect(calls.flat()).not.toContain('default-keychain');
    expect(calls.flat()).not.toContain('list-keychains');
    await rm(isolatedHomeDir, { recursive: true, force: true });
    await expect(readFile(nativeKeychain, 'utf8')).resolves.toBe('test-keychain');
  });

  it('rejects an isolated macOS credential store whose command HOME is not the isolated HOME', () => {
    expect(() => createJimengCredentialStore({
      platform: 'darwin',
      homeDir: '/tmp/isolated-home',
      env: { HOME: '/Users/provider' },
      isolated: true,
      nativeHomeDir: '/Users/provider',
    })).toThrow('jimeng_credential_store_isolation_invalid');
  });

  it('fails closed when a macOS Keychain write does not persist', async () => {
    const previous = Buffer.from('previous');
    const calls: Array<{ args: string[]; input?: Buffer }> = [];
    const run = async (
      _executable: string,
      args: string[],
      options: { input?: Buffer },
    ): Promise<NativeCommandResult> => {
      calls.push({ args, input: options.input });
      if (args[0] === 'find-generic-password') {
        const stored = Buffer.from(`go-keyring-base64:${previous.toString('base64')}\n`);
        return { code: 0, stdout: stored, stderr: Buffer.alloc(0) };
      }
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const store = createJimengCredentialStore({
      platform: 'darwin',
      homeDir: '/unused',
      env: {},
      runNativeCommand: run,
    });

    await expect(store.restore(Buffer.from('different'))).rejects.toThrow('jimeng_credential_store_failed');
    expect(calls.some((call) => call.args[0] === '-i')).toBe(true);
  });

  it('uses Windows Credential Manager through encoded code and sends credential bytes over stdin', async () => {
    const calls: Array<{ args: string[]; input?: Buffer }> = [];
    const stored = Buffer.from('{"access_token":"secret"}');
    const run = async (
      _executable: string,
      args: string[],
      options: { input?: Buffer },
    ): Promise<NativeCommandResult> => {
      calls.push({ args, input: options.input });
      if (!options.input) return { code: 0, stdout: Buffer.from(stored.toString('base64')), stderr: Buffer.alloc(0) };
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const store = createJimengCredentialStore({ platform: 'win32', homeDir: 'C:\\temp', env: {}, runNativeCommand: run });
    const snapshot = await store.snapshot();
    await store.restore(snapshot);

    expect(calls[0]?.args).toContain('-EncodedCommand');
    expect(calls[1]?.args.join(' ')).not.toContain(stored.toString('utf8'));
    expect(calls[1]?.input).toEqual(Buffer.from(stored.toString('base64')));
  });
});
