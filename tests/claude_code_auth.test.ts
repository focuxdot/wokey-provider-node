import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyClaudeCodeMetadata, detectClaudeCodeAuth, importClaudeCodeOAuth } from '../src/provider-node/claude-code-auth.js';
import type { ProviderOAuthConfig } from '../src/provider-node/config.js';

describe('Claude Code auth import', () => {
  it('imports Claude Code OAuth credentials from a credentials payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-code-auth-'));
    try {
      const path = join(dir, '.credentials.json');
      writeFileSync(path, `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-access',
          refreshToken: 'anthropic-refresh',
          expiresAt: 1_800_000_000,
          scopes: ['user:profile', 'user:inference'],
          subscriptionType: 'max',
          rateLimitTier: 'claude_max',
        },
      })}\n`);

      const oauth = importClaudeCodeOAuth(path);
      expect(oauth).toMatchObject({
        accessToken: 'anthropic-access',
        refreshToken: 'anthropic-refresh',
        tokenType: 'Bearer',
        expiresAt: 1_800_000_000_000,
        scope: 'user:profile user:inference',
        subscriptionType: 'claude_max',
        subscriptionDisplayName: 'Claude Max',
      });

      const detected = detectClaudeCodeAuth(path, { readSecret: true });
      expect(detected).toMatchObject({
        path,
        exists: true,
        ready: true,
        subscriptionType: 'claude_max',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects incomplete Claude Code OAuth credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-code-auth-'));
    try {
      const path = join(dir, '.credentials.json');
      writeFileSync(path, `${JSON.stringify({ claudeAiOauth: { accessToken: 'anthropic-access' } })}\n`);

      expect(() => importClaudeCodeOAuth(path)).toThrow('claude_code_credentials_missing_tokens');
      expect(detectClaudeCodeAuth(path, { readSecret: true })).toMatchObject({
        exists: true,
        ready: false,
        error: 'claude_code_credentials_missing_tokens',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps Claude Code in the import area without reading secret material during detection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-code-auth-'));
    try {
      const path = join(dir, '.credentials.json');
      writeFileSync(path, `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-access',
          refreshToken: 'anthropic-refresh',
        },
      })}\n`);

      expect(detectClaudeCodeAuth(path)).toMatchObject({
        path,
        exists: true,
        ready: false,
        requiresAuthorization: true,
        error: 'claude_code_credentials_authorization_required',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers concrete Claude rate limit tier over payment channel metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-code-auth-'));
    try {
      vi.stubEnv('HOME', dir);
      writeFileSync(join(dir, '.claude.json'), `${JSON.stringify({
        userID: 'claude-code-device-id',
        oauthAccount: {
          accountUuid: 'claude-code-account-uuid',
          emailAddress: 'claude@example.com',
          billingType: 'apple_subscription',
          organizationRateLimitTier: 'default_claude_max_5x',
        },
      })}\n`);
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', '.credentials.json'), `${JSON.stringify({
        claudeAiOauth: {
          accessToken: 'anthropic-access',
          refreshToken: 'anthropic-refresh',
          subscriptionType: 'apple_subscription',
          rateLimitTier: 'default_claude_max_5x',
        },
      })}\n`);

      expect(detectClaudeCodeAuth(undefined, { readSecret: true })).toMatchObject({
        accountEmail: 'claude@example.com',
        claudeCodeAccountUuid: 'claude-code-account-uuid',
        subscriptionType: 'default_claude_max_5x',
        subscriptionDisplayName: 'Claude Max 5x',
      });
      expect(importClaudeCodeOAuth()).toMatchObject({
        subscriptionType: 'default_claude_max_5x',
        subscriptionDisplayName: 'Claude Max 5x',
        claudeCodeUserId: 'claude-code-device-id',
        claudeCodeAccountUuid: 'claude-code-account-uuid',
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates an existing Claude OAuth config when local metadata has a newer plan for the same account', () => {
    const oauth: ProviderOAuthConfig = {
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      accountEmail: 'claude@example.com',
      organizationId: 'org_same',
      claudeCodeAccountUuid: 'account_same',
      subscriptionType: 'claude_pro',
      subscriptionDisplayName: 'Claude Pro',
    };

    expect(applyClaudeCodeMetadata(oauth, {
      accountEmail: 'claude@example.com',
      organizationId: 'org_same',
      claudeCodeAccountUuid: 'account_same',
      claudeCodeUserId: 'claude-user',
      subscriptionType: 'default_claude_max_5x',
    })).toBe(true);

    expect(oauth).toMatchObject({
      subscriptionType: 'default_claude_max_5x',
      subscriptionDisplayName: 'Claude Max 5x',
      claudeCodeUserId: 'claude-user',
    });
  });

  it('does not update Claude OAuth plan metadata when the local account does not match', () => {
    const oauth: ProviderOAuthConfig = {
      accessToken: 'anthropic-access',
      refreshToken: 'anthropic-refresh',
      accountEmail: 'old@example.com',
      claudeCodeAccountUuid: 'account_old',
      subscriptionType: 'claude_pro',
      subscriptionDisplayName: 'Claude Pro',
    };

    expect(applyClaudeCodeMetadata(oauth, {
      accountEmail: 'new@example.com',
      claudeCodeAccountUuid: 'account_new',
      subscriptionType: 'default_claude_max_5x',
    })).toBe(false);

    expect(oauth).toMatchObject({
      accountEmail: 'old@example.com',
      claudeCodeAccountUuid: 'account_old',
      subscriptionType: 'claude_pro',
      subscriptionDisplayName: 'Claude Pro',
    });
  });
});
