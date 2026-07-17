import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import {
  DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS,
  OFFICIAL_EXIT_VENDOR_CONFIGS,
  ProviderOfficialExitTunnelManager,
  classifyConnectError,
  classifySocketError,
  isOfficialExitHostAllowed,
  parseOfficialExitAllowlist,
} from '../src/provider-node/official-exit.js';
import type { ProviderNodeConfig } from '../src/provider-node/config.js';
import type { OfficialExitOpenRequest } from '../src/shared/protocol.js';

function networkError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe('official-exit transport error classification', () => {
  it('uses connect-stage errors only before TCP connect', () => {
    expect(classifyConnectError(networkError('ENOTFOUND'))).toBe('official_exit_dns_failed');
    expect(classifyConnectError(networkError('EAI_AGAIN'))).toBe('official_exit_dns_failed');
    expect(classifyConnectError(networkError('ECONNREFUSED'))).toBe('official_exit_connect_refused');
    expect(classifyConnectError(networkError('ETIMEDOUT'))).toBe('official_exit_connect_timeout');
    expect(classifyConnectError(networkError('ENETUNREACH'))).toBe('official_exit_connect_failed');
  });

  it('uses socket-stage errors after TCP connect', () => {
    expect(classifySocketError(networkError('ETIMEDOUT'))).toBe('official_exit_socket_timeout');
    expect(classifySocketError(networkError('ECONNRESET'))).toBe('official_exit_socket_reset');
    expect(classifySocketError(networkError('EPIPE'))).toBe('official_exit_socket_broken_pipe');
    expect(classifySocketError(networkError('ENETDOWN'))).toBe('official_exit_socket_failed');
  });
});

describe('parseOfficialExitAllowlist', () => {
  it('returns the official vendor default list for unset or blank input', () => {
    expect(parseOfficialExitAllowlist(undefined)).toEqual([...DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS]);
    expect(parseOfficialExitAllowlist('')).toEqual([...DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS]);
    expect(parseOfficialExitAllowlist('  ,  ')).toEqual([...DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS]);
  });

  it('splits, trims, and lowercases comma-separated hosts', () => {
    expect(parseOfficialExitAllowlist(' api.OpenAI.com , .anthropic.com. '))
      .toEqual(['api.openai.com', '.anthropic.com']);
  });
});

describe('official-exit vendor defaults', () => {
  it('keeps the supported vendor list in the public node repo', () => {
    expect(OFFICIAL_EXIT_VENDOR_CONFIGS.map((vendor) => vendor.id)).toEqual([
      'openai',
      'anthropic',
      'qwen',
      'zhipu',
      'moonshot',
      'minimax',
      'xiaomi',
      'deepseek',
      'google',
      'xai',
    ]);
  });

  it('derives the default allowlist from supported official vendor hosts', () => {
    const configuredHosts = OFFICIAL_EXIT_VENDOR_CONFIGS.flatMap((vendor) => vendor.allowedHosts);
    expect(DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS).toEqual([...new Set(configuredHosts)]);
  });
});

describe('isOfficialExitHostAllowed', () => {
  it('allows only official vendor hosts by default', () => {
    const defaults = parseOfficialExitAllowlist(undefined);
    for (const host of DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS) {
      expect(isOfficialExitHostAllowed(host, defaults)).toBe(true);
    }
    expect(isOfficialExitHostAllowed('chatgpt.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('cli-chat-proxy.grok.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('grok.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('future-api.grok.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('notgrok.com', defaults)).toBe(false);
    expect(isOfficialExitHostAllowed('grok.com.evil.example', defaults)).toBe(false);
    expect(isOfficialExitHostAllowed('api.kimi.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('dashscope-us.aliyuncs.com', defaults)).toBe(true);
    expect(isOfficialExitHostAllowed('anything.example', defaults)).toBe(false);
    expect(isOfficialExitHostAllowed('127.0.0.1', defaults)).toBe(false);
  });

  it('does not allow unrestricted egress with "*"', () => {
    expect(isOfficialExitHostAllowed('anything.example', parseOfficialExitAllowlist('*'))).toBe(false);
    expect(isOfficialExitHostAllowed('127.0.0.1', parseOfficialExitAllowlist('*'))).toBe(false);
  });

  it('matches exact hosts case-insensitively', () => {
    expect(isOfficialExitHostAllowed('api.anthropic.com', ['api.anthropic.com'])).toBe(true);
    expect(isOfficialExitHostAllowed('API.Anthropic.com', ['api.anthropic.com'])).toBe(true);
    expect(isOfficialExitHostAllowed('evil.example', ['api.anthropic.com'])).toBe(false);
  });

  it('matches a domain and its subdomains for "." and "*." entries', () => {
    for (const entry of ['.openai.com', '*.openai.com']) {
      expect(isOfficialExitHostAllowed('openai.com', [entry])).toBe(true);
      expect(isOfficialExitHostAllowed('api.openai.com', [entry])).toBe(true);
      expect(isOfficialExitHostAllowed('auth.openai.com', [entry])).toBe(true);
      expect(isOfficialExitHostAllowed('notopenai.com', [entry])).toBe(false);
      expect(isOfficialExitHostAllowed('openai.com.evil.example', [entry])).toBe(false);
    }
  });

  it('denies an empty host when the allowlist is non-empty', () => {
    expect(isOfficialExitHostAllowed('', ['api.anthropic.com'])).toBe(false);
  });

  it('matches when the allowlist entry is not pre-lowercased', () => {
    expect(isOfficialExitHostAllowed('api.anthropic.com', ['API.Anthropic.com'])).toBe(true);
    expect(isOfficialExitHostAllowed('api.openai.com', ['.OpenAI.com'])).toBe(true);
  });

  it('treats a trailing-dot FQDN as equivalent to its relative form', () => {
    expect(isOfficialExitHostAllowed('api.anthropic.com.', ['api.anthropic.com'])).toBe(true);
    expect(isOfficialExitHostAllowed('api.openai.com.', ['.openai.com'])).toBe(true);
    expect(isOfficialExitHostAllowed('api.openai.com', ['api.openai.com.'])).toBe(true);
    expect(isOfficialExitHostAllowed('api.openai.com', ['.openai.com.'])).toBe(true);
  });
});

describe('ProviderOfficialExitTunnelManager egress allowlist', () => {
  const config = {
    providerId: 'prov_1',
    nodeId: 'node_1',
    officialExit: { enabled: true },
  } as unknown as ProviderNodeConfig;

  function openRequest(targetHost: string, targetPort = 443): OfficialExitOpenRequest {
    return {
      type: 'official_exit.open',
      sessionId: 'sess_1',
      routeMode: 'official_exit',
      providerId: 'prov_1',
      nodeId: 'node_1',
      targetHost,
      targetPort,
      deadlineMs: 5_000,
    };
  }

  it('rejects a disallowed host without opening a socket', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const manager = new ProviderOfficialExitTunnelManager(
      () => config,
      (message) => sent.push(message as Record<string, unknown>),
      ['api.anthropic.com'],
    );

    await manager.handleMessage(openRequest('evil.example'));

    expect(sent).toEqual([
      {
        type: 'official_exit.open_response',
        sessionId: 'sess_1',
        accepted: false,
        reasonCode: 'official_exit_vendor_not_allowed',
      },
    ]);
    expect(manager.activeSessionCount()).toBe(0);
  });

  it('reports bounded TCP connection and byte diagnostics on existing frames', async () => {
    const upstream = createServer((socket) => {
      socket.write('hello');
      socket.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    const sent: Array<Record<string, unknown>> = [];
    const manager = new ProviderOfficialExitTunnelManager(
      () => config,
      (message) => sent.push(message as unknown as Record<string, unknown>),
      ['127.0.0.1'],
    );

    await manager.handleMessage(openRequest('127.0.0.1', address.port));
    await new Promise((resolve) => setTimeout(resolve, 20));
    upstream.close();

    expect(sent[0]).toMatchObject({
      type: 'official_exit.open_response',
      accepted: true,
      transportDiagnostic: {
        version: 1,
        stage: 'socket',
        outcome: 'connected',
        addressFamily: 'ipv4',
      },
    });
    expect(sent.find((message) => message.type === 'official_exit.close')).toMatchObject({
      transportDiagnostic: {
        version: 1,
        stage: 'socket',
        outcome: 'closed',
        bytesFromUpstream: 5,
        bytesToUpstream: 0,
      },
    });
  });
});
