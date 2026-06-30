import { describe, expect, it, vi } from 'vitest';
import {
  ProviderRiskController,
  UpstreamError,
  classifyHttpUpstreamError,
  classifyProviderError,
  cooldownForError,
} from '../src/provider-node/risk.js';

describe('provider risk controller', () => {
  it('keeps auth failures out of routing until manual reset', () => {
    const risk = new ProviderRiskController();

    const classified = risk.recordFailure(new UpstreamError('upstream_auth_invalid', 'bad token'));

    expect(classified.code).toBe('upstream_auth_invalid');
    expect(risk.canDispatch().allowed).toBe(false);
    expect(risk.snapshot().state).toBe('auth_invalid');

    risk.reset();
    expect(risk.canDispatch().allowed).toBe(true);
  });

  it('uses retry-after for rate limits and reopens after cooldown', () => {
    vi.useFakeTimers();
    try {
      const risk = new ProviderRiskController();
      risk.recordFailure(new UpstreamError('upstream_rate_limited', '429', { retryAfterMs: 2_000 }));

      expect(risk.canDispatch().allowed).toBe(false);

      vi.advanceTimersByTime(2_001);
      expect(risk.canDispatch().allowed).toBe(true);
      expect(risk.snapshot().state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies text errors and applies exponential transient cooldown', () => {
    expect(classifyProviderError(new Error('oauth_400:invalid_grant')).code).toBe('credential_refresh_invalid');
    expect(classifyProviderError(new Error('429 rate limit')).code).toBe('upstream_rate_limited');
    expect(cooldownForError('upstream_server_error', 1)).toBe(30_000);
    expect(cooldownForError('upstream_server_error', 3)).toBe(120_000);
  });

  it('keeps invalid refresh tokens out of routing until manual reset', () => {
    const risk = new ProviderRiskController();

    const classified = risk.recordFailure(new Error('oauth_400:invalid_grant'));

    expect(classified.code).toBe('credential_refresh_invalid');
    expect(risk.canDispatch().allowed).toBe(false);
    expect(risk.snapshot().state).toBe('auth_invalid');
  });

  it('classifies HTTP 400 as request invalid instead of auth invalid', () => {
    const error = classifyHttpUpstreamError(
      new Response(JSON.stringify({ type: 'invalid_request_error' }), { status: 400 }),
      JSON.stringify({ type: 'invalid_request_error' }),
    );

    expect(error.code).toBe('upstream_request_invalid');
  });

  it('never includes upstream response bodies in provider errors', () => {
    const error = classifyHttpUpstreamError(
      new Response('secret prompt echo', { status: 500 }),
      'secret prompt echo with sk-test123456789 and Bearer token-value',
    );

    expect(error.message).toBe('upstream_500');
    expect(error.message).not.toContain('secret prompt');
    expect(error.message).not.toContain('sk-test');
  });
});
