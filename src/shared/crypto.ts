import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function signJson(secret: string, value: unknown): string {
  return createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
}

export function verifyJsonSignature(secret: string, value: unknown, signature: string): boolean {
  const expected = Buffer.from(signJson(secret, value), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
