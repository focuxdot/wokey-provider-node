import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS,
  OFFICIAL_EXIT_VENDOR_CONFIGS,
  ProviderOfficialExitTunnelManager,
  isOfficialExitHostAllowed,
  parseOfficialExitAllowlist,
} from '../src/provider-node/official-exit.js';
import type { ProviderNodeConfig } from '../src/provider-node/config.js';
import type { OfficialExitOpenRequest } from '../src/shared/protocol.js';

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

  function openRequest(targetHost: string): OfficialExitOpenRequest {
    return {
      type: 'official_exit.open',
      sessionId: 'sess_1',
      routeMode: 'official_exit',
      providerId: 'prov_1',
      nodeId: 'node_1',
      targetHost,
      targetPort: 443,
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
});
