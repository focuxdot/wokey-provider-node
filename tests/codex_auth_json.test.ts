import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectCodexAuthJson, importCodexAuthJson, resolveCodexAuthJsonPath } from '../src/provider-node/codex-auth-json.js';
import { subscriptionPlanDisplayName } from '../src/shared/subscription-plan.js';

describe('Codex auth.json import', () => {
  it('imports Codex CLI tokens from auth.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-'));
    try {
      const path = join(dir, 'auth.json');
      const accessToken = jwt({ exp: 1_800_000_000 });
      const idToken = jwt({
        email: 'provider@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account_test',
        },
      });
      writeFileSync(path, JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'refresh_test',
          account_id: 'account_fallback',
        },
      }));

      const imported = importCodexAuthJson(path);

      expect(imported.accessToken).toBe(accessToken);
      expect(imported.refreshToken).toBe('refresh_test');
      expect(imported.idToken).toBe(idToken);
      expect(imported.accountEmail).toBe('provider@example.com');
      expect(imported.organizationId).toBe('account_test');
      expect(imported.expiresAt).toBe(1_800_000_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands tilde paths', () => {
    expect(resolveCodexAuthJsonPath('~/custom-auth.json')).toContain('/custom-auth.json');
  });

  it('detects importable Codex CLI auth.json without returning secrets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-auth-detect-'));
    try {
      const path = join(dir, 'auth.json');
      writeFileSync(path, JSON.stringify({
        tokens: {
          access_token: jwt({
            exp: 1_800_000_000,
            'https://api.openai.com/auth': {
              chatgpt_plan_type: 'prolite',
            },
          }),
          refresh_token: 'refresh_test',
          account_id: 'account_test',
        },
      }));

      const detected = detectCodexAuthJson(path);

      expect(detected).toEqual({
        path,
        exists: true,
        ready: true,
        organizationId: 'account_test',
        accountEmail: undefined,
        expiresAt: 1_800_000_000_000,
        subscriptionType: 'prolite',
        subscriptionDisplayName: 'Codex Pro 5x',
      });
      expect(JSON.stringify(detected)).not.toContain('refresh_test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('maps Codex plan types to user-facing labels', () => {
    expect(subscriptionPlanDisplayName('openai', 'prolite')).toBe('Codex Pro 5x');
    expect(subscriptionPlanDisplayName('openai', 'pro_lite')).toBe('Codex Pro 5x');
    expect(subscriptionPlanDisplayName('openai', 'codex pro-lite plan')).toBe('Codex Pro 5x');
    expect(subscriptionPlanDisplayName('openai', 'pro')).toBe('Codex Pro 20x');
    expect(subscriptionPlanDisplayName('openai', 'plus')).toBe('Codex Plus');
    expect(subscriptionPlanDisplayName('openai', 'k12')).toBe('Codex K12');
    expect(subscriptionPlanDisplayName('anthropic', 'claude pro')).toBe('Claude Pro');
    expect(subscriptionPlanDisplayName('anthropic', 'max_5x')).toBe('Claude Max 5x');
    expect(subscriptionPlanDisplayName('anthropic', 'default_claude_max_5x')).toBe('Claude Max 5x');
    expect(subscriptionPlanDisplayName('anthropic', 'enterprise')).toBe('Claude Enterprise');
    expect(subscriptionPlanDisplayName('google', 'gemini_pro')).toBe('Gemini Pro');
  });
});

function jwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
