import { timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER_NAME = 'x-wokey-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutatingMethod(method: string | undefined): boolean {
  return !SAFE_METHODS.has(String(method || 'GET').toUpperCase());
}

export function verifyCsrfToken(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isAllowedConsoleOrigin(rawOrigin: string | undefined, allowedHosts: Set<string>): boolean {
  if (!rawOrigin) return true;
  try {
    const origin = new URL(rawOrigin);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    return allowedHosts.has(origin.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function hasJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().split(';', 1)[0]?.trim() === 'application/json';
}
