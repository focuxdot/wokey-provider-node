import { describe, expect, it } from 'vitest';

import {
  decodeOfficialExitBinaryFrame,
  encodeOfficialExitBinaryData,
  encodeOfficialExitBinaryWindowUpdate,
  OfficialExitBinaryFrameError,
} from '../src/shared/official-exit-binary.js';

describe('official-exit binary v1 codec', () => {
  it('matches the cross-repository data-frame golden vector', () => {
    const encoded = encodeOfficialExitBinaryData('oex_1', 7, Buffer.from([0x00, 0xff, 0x41]));
    expect(encoded.toString('hex')).toBe('574f45580101000500000007000000036f65785f3100ff41');
    expect(decodeOfficialExitBinaryFrame(encoded)).toEqual({
      kind: 'data',
      sessionId: 'oex_1',
      seq: 7,
      payload: Buffer.from([0x00, 0xff, 0x41]),
    });
  });

  it('matches the cross-repository credit-frame golden vector', () => {
    const encoded = encodeOfficialExitBinaryWindowUpdate('oex_1', 65_536);
    expect(encoded.toString('hex')).toBe('574f45580102000500010000000000006f65785f31');
    expect(decodeOfficialExitBinaryFrame(encoded)).toEqual({
      kind: 'window_update',
      sessionId: 'oex_1',
      creditBytes: 65_536,
    });
  });

  it('rejects malformed, truncated, oversized, and unknown frames', () => {
    const valid = encodeOfficialExitBinaryData('oex_1', 0, Buffer.from('hello'));
    const badMagic = Buffer.from(valid);
    badMagic.writeUInt32BE(0, 0);
    const badLength = Buffer.from(valid);
    badLength.writeUInt32BE(99, 12);
    const badOpcode = Buffer.from(valid);
    badOpcode.writeUInt8(99, 5);

    for (const frame of [Buffer.alloc(5), badMagic, badLength, badOpcode]) {
      expect(() => decodeOfficialExitBinaryFrame(frame)).toThrow(OfficialExitBinaryFrameError);
    }
    expect(() => encodeOfficialExitBinaryData('oex_1', 0, Buffer.alloc(64 * 1024 + 1)))
      .toThrow(OfficialExitBinaryFrameError);
  });
});
