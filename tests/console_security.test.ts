import { describe, expect, it } from 'vitest';
import {
  hasJsonContentType,
  isAllowedConsoleOrigin,
  isMutatingMethod,
  verifyCsrfToken,
} from '../src/provider-node/console-security.js';

describe('provider console security helpers', () => {
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);

  it('classifies mutating methods', () => {
    expect(isMutatingMethod('GET')).toBe(false);
    expect(isMutatingMethod('HEAD')).toBe(false);
    expect(isMutatingMethod('OPTIONS')).toBe(false);
    expect(isMutatingMethod('POST')).toBe(true);
    expect(isMutatingMethod('PATCH')).toBe(true);
  });

  it('requires exact csrf token matches', () => {
    expect(verifyCsrfToken('token', 'token')).toBe(true);
    expect(verifyCsrfToken('token', 'other')).toBe(false);
    expect(verifyCsrfToken(undefined, 'token')).toBe(false);
  });

  it('allows loopback origins and rejects cross-site origins', () => {
    expect(isAllowedConsoleOrigin(undefined, allowedHosts)).toBe(true);
    expect(isAllowedConsoleOrigin('http://127.0.0.1:16888', allowedHosts)).toBe(true);
    expect(isAllowedConsoleOrigin('http://localhost:16888', allowedHosts)).toBe(true);
    expect(isAllowedConsoleOrigin('https://evil.example', allowedHosts)).toBe(false);
  });

  it('requires json content type for writes', () => {
    expect(hasJsonContentType('application/json')).toBe(true);
    expect(hasJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(hasJsonContentType('text/plain')).toBe(false);
    expect(hasJsonContentType('application/x-www-form-urlencoded')).toBe(false);
  });
});
