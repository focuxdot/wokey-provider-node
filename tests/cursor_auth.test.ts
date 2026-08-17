import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CursorAuthorizationHandler,
  detectCursorAgent,
  type CursorAuthEvent,
} from '../src/provider-node/cursor-auth.js';
import {
  CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
  type PlatformCursorAuthStart,
} from '../src/shared/protocol.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function startMessage(): PlatformCursorAuthStart {
  return {
    type: 'platform.cursor_auth_start',
    protocolVersion: CURSOR_AUTH_CONTROL_PROTOCOL_VERSION,
    requestId: 'request-1',
    flowId: 'flow-1',
    providerId: 'provider-1',
    nodeId: 'node-1',
    deadlineMs: 30_000,
  };
}

describe.skipIf(process.platform === 'win32')('CursorAuthorizationHandler', () => {
  it('advertises Cursor auth by default and resolves the CLI only when authorization starts', async () => {
    let resolutions = 0;
    const handler = new CursorAuthorizationHandler({
      resolveCli: () => {
        resolutions += 1;
        return undefined;
      },
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
    });
    expect(handler.capability()).toEqual({ protocolVersions: [1], cliVersion: 'lazy' });
    expect(resolutions).toBe(0);
    const event = await new Promise<CursorAuthEvent>((resolve) => handler.start(startMessage(), resolve));
    expect(resolutions).toBe(1);
    expect(event).toMatchObject({
      type: 'provider.cursor_auth_failed',
      errorCode: 'cursor_cli_unavailable',
      retryable: false,
    });
  });

  it('detects Cursor Agent and completes browser authorization from an isolated HOME', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-cursor-auth-test-'));
    tempDirs.push(parent);
    const executable = join(parent, 'cursor-agent');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "2026.08.11-test\\n"; exit 0; fi',
      'if [ -n "$CURSOR_API_KEY$CURSOR_API_ENDPOINT" ]; then exit 9; fi',
      'if [ "$1" = "login" ]; then',
      '  mkdir -p "$XDG_CONFIG_HOME/cursor"',
      '  printf "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=test\\n"',
      '  printf \'{"authInfo":{"authId":"123|cursor-secret","userId":123,"email":"provider@example.com"}}\' > "$XDG_CONFIG_HOME/cursor/cli-config.json"',
      '  exit 0',
      'fi',
      'if [ "$1" = "models" ]; then printf "cursor-grok-4.6-high-fast\\n"; exit 0; fi',
      'exit 1',
    ].join('\n'));
    await chmod(executable, 0o755);

    expect(detectCursorAgent(executable)).toEqual({ path: executable, version: '2026.08.11-test' });
    const handler = new CursorAuthorizationHandler({
      cli: { path: executable, version: '2026.08.11-test' },
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      platform: 'linux',
    });
    const events: CursorAuthEvent[] = [];
    handler.start(startMessage(), (event) => events.push(event));
    await expect.poll(() => events.length, { timeout: 5_000 }).toBe(2);

    expect(events[0]).toMatchObject({
      type: 'provider.cursor_auth_started',
      authorizationUrl: 'https://cursor.com/loginDeepControl?challenge=test',
    });
    expect(events[1]).toMatchObject({ type: 'provider.cursor_auth_completed' });
    const completed = events[1];
    if (completed.type !== 'provider.cursor_auth_completed') throw new Error('unexpected_event');
    expect(JSON.parse(completed.encodedCredentialBundle)).toEqual({
      version: 1,
      accessToken: '123|cursor-secret',
      accountId: '123',
      accountEmail: 'provider@example.com',
      authorizedClientVersion: '2026.08.11-test',
    });
    await expect.poll(async () => (await readdir(parent)).sort()).toEqual(['cursor-agent']);
  });

  it('rejects non-Cursor authorization URLs and removes temporary state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-cursor-auth-url-test-'));
    tempDirs.push(parent);
    const executable = join(parent, 'cursor-agent');
    await writeFile(executable, [
      '#!/bin/sh',
      'printf "https://example.com/login?token=secret\\n"',
      'exit 0',
    ].join('\n'));
    await chmod(executable, 0o755);
    const handler = new CursorAuthorizationHandler({
      cli: { path: executable, version: 'test' },
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      platform: 'linux',
    });
    const event = await new Promise<CursorAuthEvent>((resolve) => handler.start(startMessage(), (value) => {
      if (value.type === 'provider.cursor_auth_failed') resolve(value);
    }));
    expect(event).toMatchObject({
      type: 'provider.cursor_auth_failed',
      stage: 'browser_authorization',
      errorCode: 'cursor_authorization_url_invalid',
    });
    expect(event).not.toHaveProperty('encodedCredentialBundle');
    await expect.poll(async () => (await readdir(parent)).sort()).toEqual(['cursor-agent']);
  });

  it('uses the native macOS login keychain through an isolated HOME and restores previous Cursor tokens', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'wokey-cursor-macos-auth-test-'));
    tempDirs.push(parent);
    const nativeHomeDir = join(parent, 'native-home');
    await mkdir(join(nativeHomeDir, 'Library', 'Keychains'), { recursive: true });
    await writeFile(join(nativeHomeDir, 'Library', 'Keychains', 'login.keychain-db'), 'test-keychain');
    const executable = join(parent, 'cursor-agent');
    await writeFile(executable, [
      '#!/bin/sh',
      'if [ "$1" = "login" ]; then',
      '  mkdir -p "$XDG_CONFIG_HOME/cursor"',
      '  printf "https://cursor.com/loginDeepControl?challenge=test\\n"',
      '  printf \'{"authInfo":{"userId":456,"email":"mac@example.com"}}\' > "$XDG_CONFIG_HOME/cursor/cli-config.json"',
      '  exit 0',
      'fi',
      'if [ "$1" = "models" ]; then printf "cursor-grok-4.6-high-fast\\n"; exit 0; fi',
      'exit 1',
    ].join('\n'));
    await chmod(executable, 0o755);

    const calls: Array<{ args: string[]; input?: string }> = [];
    let readCount = 0;
    const handler = new CursorAuthorizationHandler({
      cli: { path: executable, version: '2026.08.11-test' },
      getIdentity: () => ({ providerId: 'provider-1', nodeId: 'node-1' }),
      tempParentDir: parent,
      platform: 'darwin',
      nativeHomeDir,
      runNativeCommand: async (_executable, args, options) => {
        calls.push({ args, input: options.input?.toString('utf8') });
        if (args[0] === 'find-generic-password') {
          const isAccess = args.includes('cursor-access-token');
          const initial = readCount < 2;
          readCount += 1;
          return {
            code: 0,
            stdout: Buffer.from(initial
              ? isAccess ? 'old-access' : 'old-refresh'
              : isAccess ? 'new-access' : 'new-refresh'),
            stderr: Buffer.alloc(0),
          };
        }
        return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const events: CursorAuthEvent[] = [];
    handler.start(startMessage(), (event) => events.push(event));
    await expect.poll(() => events.length, { timeout: 5_000 }).toBe(2);
    const completed = events[1];
    if (completed.type !== 'provider.cursor_auth_completed') throw new Error('unexpected_event');
    expect(JSON.parse(completed.encodedCredentialBundle)).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      accountId: '456',
      accountEmail: 'mac@example.com',
    });
    const restores = calls.filter((call) => call.args[0] === '-i');
    expect(restores).toHaveLength(2);
    expect(restores.map((call) => call.input)).toEqual(expect.arrayContaining([
      expect.stringContaining('old-access'),
      expect.stringContaining('old-refresh'),
    ]));
    expect(restores.every((call) => !call.input?.includes('new-'))).toBe(true);
  });
});
