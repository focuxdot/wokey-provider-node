export const OFFICIAL_EXIT_BINARY_MAGIC = 0x574f4558; // "WOEX"
export const OFFICIAL_EXIT_BINARY_VERSION = 1;
export const OFFICIAL_EXIT_BINARY_HEADER_BYTES = 16;
export const OFFICIAL_EXIT_BINARY_MAX_SESSION_ID_BYTES = 128;
export const OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES = 64 * 1024;
export const OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES = 256 * 1024;
// Legacy JSON/base64 data frames and control messages are larger than one
// binary payload, but should never need ws's 100 MiB default message allowance.
export const OFFICIAL_EXIT_WEBSOCKET_MAX_MESSAGE_BYTES = 1024 * 1024;

const DATA_OPCODE = 1;
const WINDOW_UPDATE_OPCODE = 2;
const MAX_WINDOW_UPDATE_BYTES = 16 * 1024 * 1024;

export type OfficialExitBinaryFrame =
  | {
    kind: 'data';
    sessionId: string;
    seq: number;
    payload: Buffer;
  }
  | {
    kind: 'window_update';
    sessionId: string;
    creditBytes: number;
  };

export class OfficialExitBinaryFrameError extends Error {
  readonly code = 'official_exit_invalid_binary_frame';

  constructor(message: string) {
    super(message);
    this.name = 'OfficialExitBinaryFrameError';
  }
}

function uint32(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new OfficialExitBinaryFrameError(`${name} must be a uint32`);
  }
  return value;
}

function sessionIdBytes(sessionId: string): Buffer {
  const encoded = Buffer.from(sessionId, 'utf8');
  if (encoded.byteLength === 0 || encoded.byteLength > OFFICIAL_EXIT_BINARY_MAX_SESSION_ID_BYTES) {
    throw new OfficialExitBinaryFrameError('sessionId length is invalid');
  }
  if (encoded.toString('utf8') !== sessionId) {
    throw new OfficialExitBinaryFrameError('sessionId must be valid UTF-8');
  }
  return encoded;
}

function encodeFrame(opcode: number, sessionId: string, value: number, payload: Buffer): Buffer {
  const session = sessionIdBytes(sessionId);
  const frame = Buffer.allocUnsafe(OFFICIAL_EXIT_BINARY_HEADER_BYTES + session.byteLength + payload.byteLength);
  frame.writeUInt32BE(OFFICIAL_EXIT_BINARY_MAGIC, 0);
  frame.writeUInt8(OFFICIAL_EXIT_BINARY_VERSION, 4);
  frame.writeUInt8(opcode, 5);
  frame.writeUInt16BE(session.byteLength, 6);
  frame.writeUInt32BE(uint32('frame value', value), 8);
  frame.writeUInt32BE(payload.byteLength, 12);
  session.copy(frame, OFFICIAL_EXIT_BINARY_HEADER_BYTES);
  payload.copy(frame, OFFICIAL_EXIT_BINARY_HEADER_BYTES + session.byteLength);
  return frame;
}

export function encodeOfficialExitBinaryData(
  sessionId: string,
  seq: number,
  payload: Buffer,
): Buffer {
  if (payload.byteLength === 0 || payload.byteLength > OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES) {
    throw new OfficialExitBinaryFrameError('data payload length is invalid');
  }
  return encodeFrame(DATA_OPCODE, sessionId, seq, payload);
}

export function encodeOfficialExitBinaryWindowUpdate(sessionId: string, creditBytes: number): Buffer {
  if (!Number.isInteger(creditBytes) || creditBytes <= 0 || creditBytes > MAX_WINDOW_UPDATE_BYTES) {
    throw new OfficialExitBinaryFrameError('creditBytes is invalid');
  }
  return encodeFrame(WINDOW_UPDATE_OPCODE, sessionId, creditBytes, Buffer.alloc(0));
}

export function decodeOfficialExitBinaryFrame(raw: Buffer): OfficialExitBinaryFrame {
  if (raw.byteLength < OFFICIAL_EXIT_BINARY_HEADER_BYTES) {
    throw new OfficialExitBinaryFrameError('binary frame is truncated');
  }
  if (raw.readUInt32BE(0) !== OFFICIAL_EXIT_BINARY_MAGIC) {
    throw new OfficialExitBinaryFrameError('binary frame magic is invalid');
  }
  if (raw.readUInt8(4) !== OFFICIAL_EXIT_BINARY_VERSION) {
    throw new OfficialExitBinaryFrameError('binary frame version is unsupported');
  }
  const opcode = raw.readUInt8(5);
  const sessionLength = raw.readUInt16BE(6);
  const value = raw.readUInt32BE(8);
  const payloadLength = raw.readUInt32BE(12);
  if (sessionLength === 0 || sessionLength > OFFICIAL_EXIT_BINARY_MAX_SESSION_ID_BYTES) {
    throw new OfficialExitBinaryFrameError('binary frame sessionId length is invalid');
  }
  if (payloadLength > OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES) {
    throw new OfficialExitBinaryFrameError('binary frame payload exceeds the limit');
  }
  const expectedLength = OFFICIAL_EXIT_BINARY_HEADER_BYTES + sessionLength + payloadLength;
  if (raw.byteLength !== expectedLength) {
    throw new OfficialExitBinaryFrameError('binary frame length does not match its header');
  }
  const sessionBytes = raw.subarray(OFFICIAL_EXIT_BINARY_HEADER_BYTES, OFFICIAL_EXIT_BINARY_HEADER_BYTES + sessionLength);
  const sessionId = sessionBytes.toString('utf8');
  if (!sessionId || Buffer.from(sessionId, 'utf8').compare(sessionBytes) !== 0) {
    throw new OfficialExitBinaryFrameError('binary frame sessionId is not valid UTF-8');
  }
  const payload = raw.subarray(OFFICIAL_EXIT_BINARY_HEADER_BYTES + sessionLength);
  if (opcode === DATA_OPCODE) {
    if (payloadLength === 0) throw new OfficialExitBinaryFrameError('binary data frame payload is empty');
    return { kind: 'data', sessionId, seq: value, payload };
  }
  if (opcode === WINDOW_UPDATE_OPCODE) {
    if (payloadLength !== 0 || value === 0 || value > MAX_WINDOW_UPDATE_BYTES) {
      throw new OfficialExitBinaryFrameError('binary window update is invalid');
    }
    return { kind: 'window_update', sessionId, creditBytes: value };
  }
  throw new OfficialExitBinaryFrameError('binary frame opcode is unsupported');
}
