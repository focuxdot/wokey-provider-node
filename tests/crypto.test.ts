import { describe, expect, it } from 'vitest';
import { signJson, verifyJsonSignature } from '../src/shared/crypto.js';

describe('receipt signatures', () => {
  it('verifies matching payloads and rejects tampering', () => {
    const payload = { requestId: 'req_1', amount: 1 };
    const signature = signJson('secret', payload);

    expect(verifyJsonSignature('secret', payload, signature)).toBe(true);
    expect(verifyJsonSignature('secret', { ...payload, amount: 2 }, signature)).toBe(false);
  });
});
