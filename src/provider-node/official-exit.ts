import { connect, type Socket } from 'node:net';
import {
  OFFICIAL_EXIT_BULK_MAX_INITIAL_WINDOW_BYTES,
  OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES,
  encodeOfficialExitBinaryData,
  encodeOfficialExitBinaryWindowUpdate,
  OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES,
  OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
  type OfficialExitBinaryFrame,
} from '../shared/official-exit-binary.js';
import type {
  OfficialExitClose,
  OfficialExitDataProtocol,
  OfficialExitEarlyDataProtocol,
  OfficialExitDataFrame,
  OfficialExitError,
  OfficialExitOpenRequest,
  OfficialExitOpenResponse,
  OfficialExitTransportDiagnostic,
  OfficialExitTrafficClass,
} from '../shared/protocol.js';
import type { WebSocketSendLane } from '../shared/websocket-send-scheduler.js';
import { DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS } from '../shared/official-exit-vendors.js';
import type { ProviderNodeConfig } from './config.js';

type OfficialExitPlatformMessage = OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose;
type OfficialExitProviderMessage = OfficialExitOpenResponse | OfficialExitDataFrame | OfficialExitClose | OfficialExitError;
type OfficialExitProviderOutbound = OfficialExitProviderMessage | Buffer;

export { DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS, OFFICIAL_EXIT_VENDOR_CONFIGS } from '../shared/official-exit-vendors.js';

export const OFFICIAL_EXIT_ALLOWLIST_ENV = 'PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS';
export const OFFICIAL_EXIT_EARLY_DATA_MAX_BYTES = 64 * 1024;
const OFFICIAL_EXIT_OPEN_RESPONSE_MARGIN_MS = 10_000;

// Operator-controlled egress allowlist for the official-exit tunnel. The node
// trusts its bound Platform to only dial real vendor hosts, but an operator who
// wants to bound that trust can pin the exact hosts this machine may open TCP to.
// This is read from the local environment, never from Platform-synced config, so
// Platform cannot widen or disable it.
//
// Leaving the env unset or blank uses the official vendor default list above.
// Entries are matched case-insensitively: an entry beginning with "*." or "."
// matches the domain and any subdomain; every other entry matches the host exactly.
export function parseOfficialExitAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS];
  const entries = raw
    .split(',')
    .map((host) => normalizeOfficialExitHostPattern(host))
    .filter(Boolean);
  return entries.length ? entries : [...DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS];
}

export function isOfficialExitHostAllowed(host: string, allowlist: readonly string[]): boolean {
  // Normalize an absolute (trailing-dot) FQDN to its relative form so a vendor
  // host sent as "api.anthropic.com." still matches an "api.anthropic.com" entry.
  const target = host.trim().toLowerCase().replace(/\.$/, '');
  if (!target) return false;
  return allowlist.some((entry) => matchHostPattern(target, entry));
}

function matchHostPattern(host: string, entry: string): boolean {
  const normalized = normalizeOfficialExitHostPattern(entry);
  const domain = normalized.startsWith('*.') ? normalized.slice(2) : normalized.startsWith('.') ? normalized.slice(1) : '';
  if (domain) return host === domain || host.endsWith(`.${domain}`);
  return host === normalized;
}

function normalizeOfficialExitHostPattern(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

interface OfficialExitSession {
  socket: Socket;
  seqOut: number;
  bytesIn: number;
  bytesOut: number;
  platformPayloadBytes: number;
  closed: boolean;
  connected: boolean;
  maxBytesIn?: number;
  maxBytesOut?: number;
  connectedAt: number;
  connectMs: number;
  addressFamily?: 'ipv4' | 'ipv6';
  remoteAddress?: string;
  dataProtocol: OfficialExitDataProtocol;
  earlyDataProtocol?: OfficialExitEarlyDataProtocol;
  trafficClass: OfficialExitTrafficClass;
  initialWindowBytes: number;
  earlyDataBytes: number;
  pendingToUpstream: Array<{ payload: Buffer; creditBytes: number }>;
  pendingToUpstreamBytes: number;
  expectedSeqIn: number;
  outboundCredit: number;
  pendingFromUpstream: Buffer[];
  pendingFromUpstreamOffset: number;
  webSocketBytesIn: number;
  webSocketBytesOut: number;
  backpressureCount: number;
  peakBufferedBytes: number;
  upstreamBackpressureTimer?: NodeJS.Timeout;
  platformInputBackpressureTimer?: NodeJS.Timeout;
  platformInputBlocked: boolean;
}

export interface ProviderOfficialExitTunnelManagerOptions {
  backpressureTimeoutMs?: number;
  setPlatformInputBackpressure?: (
    sessionId: string,
    blocked: boolean,
  ) => void;
}

export interface ProviderOfficialExitSendOptions {
  lane: WebSocketSendLane;
  sessionId?: string;
  onComplete?: (error?: Error | null) => void;
}

export interface ProviderOfficialExitSendResult {
  accepted: boolean;
  backpressured?: boolean;
  bufferedBytes?: number;
  error?: Error;
}

export interface PlatformBulkTransferSelection {
  bulkInitialWindowBytes: number;
}

export class ProviderOfficialExitTunnelManager {
  private readonly sessions = new Map<string, OfficialExitSession>();

  private readonly allowedHosts: readonly string[];
  private negotiatedDataProtocol: OfficialExitDataProtocol = 'json_base64_v1';
  private negotiatedEarlyDataProtocol?: OfficialExitEarlyDataProtocol;
  private negotiatedBulkInitialWindowBytes?: number;
  private acceptingSessions = true;
  private readonly options: Required<Pick<
    ProviderOfficialExitTunnelManagerOptions,
    'backpressureTimeoutMs'
  >> & Pick<ProviderOfficialExitTunnelManagerOptions, 'setPlatformInputBackpressure'>;

  constructor(
    private getConfig: () => ProviderNodeConfig,
    private send: (
      message: OfficialExitProviderOutbound,
      options?: ProviderOfficialExitSendOptions,
    ) => ProviderOfficialExitSendResult | undefined,
    allowedHosts: readonly string[] = parseOfficialExitAllowlist(process.env[OFFICIAL_EXIT_ALLOWLIST_ENV]),
    options: ProviderOfficialExitTunnelManagerOptions = {},
  ) {
    this.allowedHosts = allowedHosts;
    this.options = {
      backpressureTimeoutMs: options.backpressureTimeoutMs ?? 30_000,
      setPlatformInputBackpressure: options.setPlatformInputBackpressure,
    };
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  setNegotiatedDataProtocol(dataProtocol: OfficialExitDataProtocol): void {
    this.negotiatedDataProtocol = dataProtocol;
  }

  setNegotiatedEarlyDataProtocol(earlyDataProtocol: OfficialExitEarlyDataProtocol | undefined): void {
    this.negotiatedEarlyDataProtocol = earlyDataProtocol;
  }

  setNegotiatedBulkTransfer(bulkTransfer: PlatformBulkTransferSelection | undefined): void {
    this.negotiatedBulkInitialWindowBytes = bulkTransfer?.bulkInitialWindowBytes;
  }

  setAcceptingSessions(accepting: boolean): void {
    this.acceptingSessions = accepting;
  }

  closeAll(reasonCode = 'provider_node_stopped'): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      this.closeSession(sessionId, session, reasonCode, false);
    }
  }

  async handleMessage(message: OfficialExitPlatformMessage, wireBytes?: number): Promise<void> {
    if (message.type === 'official_exit.open') {
      await this.open(message);
      return;
    }
    if (message.type === 'official_exit.data') {
      this.writeJsonData(message, wireBytes);
      return;
    }
    this.closeFromPlatform(message);
  }

  handleBinaryFrame(
    frame: OfficialExitBinaryFrame,
    wireBytes: number,
  ): void {
    if (frame.kind === 'data') {
      this.writeBinaryData(frame, wireBytes);
      return;
    }
    const session = this.sessions.get(frame.sessionId);
    if (
      !session
      || session.closed
      || session.dataProtocol !== 'binary_v1'
    ) return;
    session.webSocketBytesIn += wireBytes;
    session.outboundCredit += frame.creditBytes;
    if (session.outboundCredit > 16 * 1024 * 1024) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_invalid_window_update');
      return;
    }
    this.pumpUpstreamToPlatform(frame.sessionId, session);
  }

  private async open(request: OfficialExitOpenRequest): Promise<void> {
    const config = this.getConfig();
    const rejection = this.validateOpenRequest(request, config);
    if (rejection) {
      this.sendOpenResponse(request.sessionId, false, rejection);
      return;
    }

    await new Promise<void>((resolve) => {
      const connectStartedAt = Date.now();
      const socket = connect({
        host: request.targetHost,
        port: request.targetPort,
      });
      const session: OfficialExitSession = {
        socket,
        seqOut: 0,
        bytesIn: 0,
        bytesOut: 0,
        platformPayloadBytes: 0,
        closed: false,
        connected: false,
        maxBytesIn: request.maxBytesIn,
        maxBytesOut: request.maxBytesOut,
        connectedAt: connectStartedAt,
        connectMs: 0,
        dataProtocol: request.dataProtocol ?? 'json_base64_v1',
        earlyDataProtocol: request.earlyDataProtocol,
        trafficClass: request.trafficClass ?? 'interactive',
        initialWindowBytes: request.initialWindowBytes ?? OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES,
        earlyDataBytes: 0,
        pendingToUpstream: [],
        pendingToUpstreamBytes: 0,
        expectedSeqIn: 0,
        outboundCredit: request.initialWindowBytes ?? OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES,
        pendingFromUpstream: [],
        pendingFromUpstreamOffset: 0,
        webSocketBytesIn: 0,
        webSocketBytesOut: 0,
        backpressureCount: 0,
        peakBufferedBytes: 0,
        platformInputBlocked: false,
      };
      this.sessions.set(request.sessionId, session);
      let settled = false;

      const failBeforeConnect = (reasonCode: string) => {
        if (settled) return;
        settled = true;
        session.closed = true;
        this.sessions.delete(request.sessionId);
        socket.destroy();
        this.sendOpenResponse(request.sessionId, false, reasonCode, {
          version: 1,
          stage: 'connect',
          outcome: 'failed',
          reasonCode,
          connectMs: Date.now() - connectStartedAt,
          bytesToUpstream: 0,
          earlyDataBytes: session.earlyDataBytes,
          webSocketBytesFromPlatform: session.webSocketBytesIn,
        });
        resolve();
      };

      socket.setTimeout(officialExitConnectTimeoutMs(request.deadlineMs));
      socket.once('connect', () => {
        if (settled) return;
        if (session.closed || this.sessions.get(request.sessionId) !== session) {
          settled = true;
          socket.destroy();
          resolve();
          return;
        }
        settled = true;
        // Connect/open_response remains bounded by deadlineMs. Once the tunnel is
        // open, use the independent response-idle budget when a newer Platform
        // supplies it; older Platforms retain the legacy deadlineMs behavior.
        socket.setTimeout(officialExitSocketIdleTimeoutMs(request.deadlineMs, request.socketIdleTimeoutMs));
        const addressFamily = socket.remoteFamily === 'IPv4' ? 'ipv4' : socket.remoteFamily === 'IPv6' ? 'ipv6' : undefined;
        const connectMs = Date.now() - connectStartedAt;
        session.connected = true;
        session.connectedAt = Date.now();
        session.connectMs = connectMs;
        session.addressFamily = addressFamily;
        session.remoteAddress = socket.remoteAddress;
        this.attachSocketHandlers(request.sessionId, session);
        this.flushPendingToUpstream(request.sessionId, session);
        if (session.closed) {
          resolve();
          return;
        }
        this.sendOpenResponse(request.sessionId, true, undefined, this.transportDiagnostic(session, 'connected'));
        resolve();
      });
      socket.once('error', (error) => {
        if (!settled) {
          failBeforeConnect(classifyConnectError(error));
          return;
        }
        const session = this.sessions.get(request.sessionId);
        if (session) this.sendErrorAndClose(request.sessionId, session, classifySocketError(error), error.message);
      });
      socket.once('timeout', () => {
        if (!settled) {
          failBeforeConnect('official_exit_connect_timeout');
          return;
        }
        const session = this.sessions.get(request.sessionId);
        if (session) this.sendErrorAndClose(request.sessionId, session, 'official_exit_socket_timeout');
      });
      socket.once('close', () => {
        if (settled) return;
        settled = true;
        this.sessions.delete(request.sessionId);
        resolve();
      });
    });
  }

  private validateOpenRequest(request: OfficialExitOpenRequest, config: ProviderNodeConfig): string | undefined {
    if (!this.acceptingSessions) return 'official_exit_node_draining';
    if (!config.officialExit?.enabled) return 'official_exit_disabled';
    if (request.routeMode !== 'official_exit') return 'official_exit_route_mode_required';
    if (request.providerId !== config.providerId || request.nodeId !== config.nodeId) return 'official_exit_identity_mismatch';
    if (!request.targetHost || /[\s/]/.test(request.targetHost)) return 'official_exit_invalid_target_host';
    if (!Number.isInteger(request.targetPort) || request.targetPort <= 0 || request.targetPort > 65_535) {
      return 'official_exit_invalid_target_port';
    }
    if (!isOfficialExitHostAllowed(request.targetHost, this.allowedHosts)) return 'official_exit_vendor_not_allowed';
    if (this.sessions.has(request.sessionId)) return 'official_exit_duplicate_session';
    const requestedDataProtocol = request.dataProtocol ?? 'json_base64_v1';
    if (requestedDataProtocol !== this.negotiatedDataProtocol) return 'official_exit_data_protocol_not_negotiated';
    if (request.earlyDataProtocol !== undefined && request.earlyDataProtocol !== this.negotiatedEarlyDataProtocol) {
      return 'official_exit_early_data_protocol_not_negotiated';
    }
    const trafficClass = request.trafficClass ?? 'interactive';
    if (trafficClass !== 'interactive' && trafficClass !== 'bulk') {
      return 'official_exit_traffic_class_invalid';
    }
    const expectedInitialWindowBytes = trafficClass === 'bulk'
      ? this.negotiatedBulkInitialWindowBytes ?? OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES
      : OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES;
    const requestedInitialWindowBytes = request.initialWindowBytes ?? OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES;
    if (
      !expectedInitialWindowBytes
      || !Number.isSafeInteger(requestedInitialWindowBytes)
      || requestedInitialWindowBytes !== expectedInitialWindowBytes
      || requestedInitialWindowBytes < OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES
      || requestedInitialWindowBytes > OFFICIAL_EXIT_BULK_MAX_INITIAL_WINDOW_BYTES
      || (
        trafficClass === 'bulk'
        && this.negotiatedBulkInitialWindowBytes !== undefined
        && requestedInitialWindowBytes < OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES
      )
    ) {
      return 'official_exit_initial_window_not_negotiated';
    }
    return undefined;
  }

  private attachSocketHandlers(sessionId: string, session: OfficialExitSession): void {
    session.socket.on('data', (chunk) => {
      if (session.closed) return;
      session.bytesIn += Buffer.byteLength(chunk);
      if (session.maxBytesIn !== undefined && session.bytesIn > session.maxBytesIn) {
        this.sendErrorAndClose(sessionId, session, 'official_exit_max_bytes_in_exceeded');
        return;
      }
      if (session.dataProtocol === 'binary_v1') {
        session.pendingFromUpstream.push(Buffer.from(chunk));
        session.socket.pause();
        this.pumpUpstreamToPlatform(sessionId, session);
        return;
      }
      const frame: OfficialExitDataFrame = {
        type: 'official_exit.data',
        sessionId,
        seq: session.seqOut,
        payloadBase64: Buffer.from(chunk).toString('base64'),
      };
      const encodedBytes = Buffer.byteLength(JSON.stringify(frame));
      session.webSocketBytesOut += encodedBytes;
      session.seqOut += 1;
      this.sendSessionFrame(sessionId, session, frame, session.trafficClass);
    });
    session.socket.once('close', () => {
      if (this.sessions.get(sessionId) !== session) return;
      this.closeSession(sessionId, session, 'official_exit_remote_closed', true);
    });
  }

  private writeJsonData(frame: OfficialExitDataFrame, wireBytes?: number): void {
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.closed) {
      this.sendControl({
        type: 'official_exit.error',
        sessionId: frame.sessionId,
        errorCode: 'official_exit_session_not_found',
        retryable: true,
      });
      return;
    }
    if (session.dataProtocol !== 'json_base64_v1' || frame.seq !== session.expectedSeqIn) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_frame_sequence_mismatch');
      return;
    }
    session.expectedSeqIn += 1;
    const chunk = Buffer.from(frame.payloadBase64, 'base64');
    session.webSocketBytesIn += wireBytes ?? Buffer.byteLength(JSON.stringify(frame));
    session.platformPayloadBytes += chunk.byteLength;
    if (session.maxBytesOut !== undefined && session.platformPayloadBytes > session.maxBytesOut) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_max_bytes_out_exceeded');
      return;
    }
    if (!session.connected) {
      this.queueEarlyData(frame.sessionId, session, chunk, 0);
      return;
    }
    this.writeToUpstream(frame.sessionId, session, chunk, 0);
  }

  private writeBinaryData(
    frame: Extract<OfficialExitBinaryFrame, { kind: 'data' }>,
    wireBytes: number,
  ): void {
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.closed) {
      this.sendControl({
        type: 'official_exit.error',
        sessionId: frame.sessionId,
        errorCode: 'official_exit_session_not_found',
        retryable: true,
      });
      return;
    }
    if (
      session.dataProtocol !== 'binary_v1'
      || frame.seq !== session.expectedSeqIn
    ) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_frame_sequence_mismatch');
      return;
    }
    session.expectedSeqIn += 1;
    session.webSocketBytesIn += wireBytes;
    session.platformPayloadBytes += frame.payload.byteLength;
    if (session.maxBytesOut !== undefined && session.platformPayloadBytes > session.maxBytesOut) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_max_bytes_out_exceeded');
      return;
    }
    if (!session.connected) {
      this.queueEarlyData(frame.sessionId, session, frame.payload, frame.payload.byteLength);
      return;
    }
    this.writeToUpstream(frame.sessionId, session, frame.payload, frame.payload.byteLength);
  }

  private queueEarlyData(
    sessionId: string,
    session: OfficialExitSession,
    payload: Buffer,
    creditBytes: number,
  ): void {
    if (session.earlyDataProtocol !== 'buffered_v1') {
      this.sendErrorAndClose(sessionId, session, 'official_exit_early_data_not_negotiated');
      return;
    }
    if (session.pendingToUpstreamBytes + payload.byteLength > OFFICIAL_EXIT_EARLY_DATA_MAX_BYTES) {
      this.sendErrorAndClose(sessionId, session, 'official_exit_early_data_exceeded');
      return;
    }
    session.pendingToUpstream.push({ payload: Buffer.from(payload), creditBytes });
    session.pendingToUpstreamBytes += payload.byteLength;
    session.earlyDataBytes += payload.byteLength;
  }

  private flushPendingToUpstream(sessionId: string, session: OfficialExitSession): void {
    const pending = session.pendingToUpstream;
    session.pendingToUpstream = [];
    session.pendingToUpstreamBytes = 0;
    for (const item of pending) {
      if (session.closed) return;
      this.writeToUpstream(sessionId, session, item.payload, item.creditBytes);
    }
  }

  private writeToUpstream(
    sessionId: string,
    session: OfficialExitSession,
    payload: Buffer,
    creditBytes: number,
  ): void {
    session.bytesOut += payload.byteLength;
    const writable = session.socket.write(payload, () => {
      if (session.closed) return;
      if (creditBytes <= 0) return;
      const update = encodeOfficialExitBinaryWindowUpdate(sessionId, creditBytes);
      session.webSocketBytesOut += update.byteLength;
      this.sendSessionFrame(sessionId, session, update, 'window');
    });
    if (!writable) {
      if (creditBytes <= 0) {
        this.blockPlatformInput(sessionId, session);
        return;
      }
      session.backpressureCount += 1;
      this.startPlatformInputBackpressureTimeout(sessionId, session);
      session.socket.once('drain', () => {
        if (session.closed || session.platformInputBlocked) return;
        this.clearPlatformInputBackpressureTimeout(session);
      });
    }
  }

  private pumpUpstreamToPlatform(sessionId: string, session: OfficialExitSession): void {
    if (session.closed || session.dataProtocol !== 'binary_v1') return;
    while (session.outboundCredit > 0 && session.pendingFromUpstream.length > 0) {
      const pending = session.pendingFromUpstream[0];
      if (!pending) break;
      const remaining = pending.byteLength - session.pendingFromUpstreamOffset;
      const payloadBytes = Math.min(
        remaining,
        session.outboundCredit,
        OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
      );
      const payload = pending.subarray(
        session.pendingFromUpstreamOffset,
        session.pendingFromUpstreamOffset + payloadBytes,
      );
      const encoded = encodeOfficialExitBinaryData(sessionId, session.seqOut, payload);
      session.seqOut += 1;
      session.outboundCredit -= payload.byteLength;
      session.webSocketBytesOut += encoded.byteLength;
      session.pendingFromUpstreamOffset += payload.byteLength;
      if (session.pendingFromUpstreamOffset >= pending.byteLength) {
        session.pendingFromUpstream.shift();
        session.pendingFromUpstreamOffset = 0;
      }
      if (!this.sendSessionFrame(sessionId, session, encoded, session.trafficClass)) return;
    }
    if (session.pendingFromUpstream.length === 0 && session.outboundCredit > 0) {
      this.clearUpstreamBackpressureTimeout(session);
      session.socket.resume();
    } else {
      this.startUpstreamBackpressureTimeout(sessionId, session);
    }
  }

  private sendControl(message: OfficialExitProviderMessage): void {
    this.send(message, { lane: 'control' });
  }

  private sendSessionFrame(
    sessionId: string,
    session: OfficialExitSession,
    message: OfficialExitDataFrame | Buffer,
    lane: OfficialExitTrafficClass | 'window',
  ): boolean {
    const result = this.send(message, {
      lane,
      sessionId,
      onComplete: (error) => {
        if (error) {
          if (this.sessions.get(sessionId) === session && !session.closed) {
            this.sendErrorAndClose(sessionId, session, providerWebSocketSendErrorCode(error), error.message);
          }
          return;
        }
        if (
          session.dataProtocol === 'json_base64_v1'
          && this.sessions.get(sessionId) === session
          && !session.closed
        ) {
          session.socket.resume();
        }
      },
    });
    if (!result || typeof result !== 'object' || typeof result.accepted !== 'boolean') return true;
    session.peakBufferedBytes = Math.max(session.peakBufferedBytes, result.bufferedBytes ?? 0);
    if (result.backpressured) {
      session.backpressureCount += 1;
      if (session.dataProtocol === 'json_base64_v1') session.socket.pause();
    }
    if (result.accepted) return true;
    if (!session.closed) {
      const error = result.error ?? new Error('provider_websocket_queue_overflow');
      this.sendErrorAndClose(sessionId, session, providerWebSocketSendErrorCode(error), error.message);
    }
    return false;
  }

  private blockPlatformInput(sessionId: string, session: OfficialExitSession): void {
    if (session.platformInputBlocked) return;
    session.platformInputBlocked = true;
    session.backpressureCount += 1;
    this.options.setPlatformInputBackpressure?.(sessionId, true);
    this.startPlatformInputBackpressureTimeout(sessionId, session);
    session.socket.once('drain', () => {
      if (session.closed) return;
      session.platformInputBlocked = false;
      this.options.setPlatformInputBackpressure?.(sessionId, false);
      this.clearPlatformInputBackpressureTimeout(session);
    });
  }

  private startUpstreamBackpressureTimeout(sessionId: string, session: OfficialExitSession): void {
    if (session.upstreamBackpressureTimer || session.closed) return;
    session.upstreamBackpressureTimer = setTimeout(() => {
      session.upstreamBackpressureTimer = undefined;
      this.sendErrorAndClose(sessionId, session, 'official_exit_backpressure_timeout');
    }, this.options.backpressureTimeoutMs);
    session.upstreamBackpressureTimer.unref?.();
  }

  private clearUpstreamBackpressureTimeout(session: OfficialExitSession): void {
    if (session.upstreamBackpressureTimer) clearTimeout(session.upstreamBackpressureTimer);
    session.upstreamBackpressureTimer = undefined;
  }

  private startPlatformInputBackpressureTimeout(sessionId: string, session: OfficialExitSession): void {
    if (session.platformInputBackpressureTimer || session.closed) return;
    session.platformInputBackpressureTimer = setTimeout(() => {
      session.platformInputBackpressureTimer = undefined;
      this.sendErrorAndClose(sessionId, session, 'official_exit_backpressure_timeout');
    }, this.options.backpressureTimeoutMs);
    session.platformInputBackpressureTimer.unref?.();
  }

  private clearPlatformInputBackpressureTimeout(session: OfficialExitSession): void {
    if (session.platformInputBackpressureTimer) clearTimeout(session.platformInputBackpressureTimer);
    session.platformInputBackpressureTimer = undefined;
  }

  private closeFromPlatform(message: OfficialExitClose): void {
    const session = this.sessions.get(message.sessionId);
    if (!session) return;
    this.closeSession(message.sessionId, session, message.reasonCode ?? 'official_exit_platform_closed', false);
  }

  private sendOpenResponse(
    sessionId: string,
    accepted: boolean,
    reasonCode?: string,
    transportDiagnostic?: OfficialExitTransportDiagnostic,
  ): void {
    this.sendControl({
      type: 'official_exit.open_response',
      sessionId,
      accepted,
      reasonCode,
      transportDiagnostic,
    });
  }

  private sendErrorAndClose(
    sessionId: string,
    session: OfficialExitSession,
    errorCode: string,
    errorMessage?: string,
  ): void {
    this.sendControl({
      type: 'official_exit.error',
      sessionId,
      errorCode,
      errorMessage,
      retryable: errorCode !== 'official_exit_vendor_not_allowed',
      transportDiagnostic: this.transportDiagnostic(session, 'failed', errorCode),
    });
    this.closeSession(sessionId, session, errorCode, true);
  }

  private closeSession(
    sessionId: string,
    session: OfficialExitSession,
    reasonCode: string,
    notifyPlatform: boolean,
  ): void {
    if (session.closed) return;
    session.closed = true;
    this.clearUpstreamBackpressureTimeout(session);
    this.clearPlatformInputBackpressureTimeout(session);
    if (session.platformInputBlocked) {
      this.options.setPlatformInputBackpressure?.(sessionId, false);
    }
    this.sessions.delete(sessionId);
    session.socket.destroy();
    if (notifyPlatform) {
      this.sendControl({
        type: 'official_exit.close',
        sessionId,
        reasonCode,
        transportDiagnostic: this.transportDiagnostic(session, 'closed', reasonCode),
      });
    }
  }

  private transportDiagnostic(
    session: OfficialExitSession,
    outcome: 'connected' | 'failed' | 'closed',
    reasonCode?: string,
  ): OfficialExitTransportDiagnostic {
    return {
      version: 1,
      stage: 'socket',
      outcome,
      reasonCode,
      addressFamily: session.addressFamily,
      remoteAddress: session.remoteAddress,
      connectMs: session.connectMs,
      elapsedMs: Date.now() - session.connectedAt,
      bytesFromUpstream: session.bytesIn,
      bytesToUpstream: session.bytesOut,
      dataProtocol: session.dataProtocol,
      webSocketBytesFromPlatform: session.webSocketBytesIn,
      webSocketBytesToPlatform: session.webSocketBytesOut,
      backpressureCount: session.backpressureCount,
      peakBufferedBytes: session.peakBufferedBytes,
      earlyDataBytes: session.earlyDataBytes,
    };
  }
}

/**
 * Leave enough time for the node's failed open_response and diagnostics to
 * reach Platform before Platform abandons the pending open. Use a proportional
 * margin for short development deadlines and cap the production margin at ten
 * seconds.
 */
export function officialExitConnectTimeoutMs(deadlineMs: number): number {
  const relativeBudgetMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? Math.max(1, Math.floor(deadlineMs))
    : 1_000;
  const marginMs = Math.min(
    OFFICIAL_EXIT_OPEN_RESPONSE_MARGIN_MS,
    Math.max(1, Math.floor(relativeBudgetMs * 0.1)),
  );
  return Math.max(1, relativeBudgetMs - marginMs);
}

export function officialExitSocketIdleTimeoutMs(
  deadlineMs: number,
  socketIdleTimeoutMs: number | undefined,
): number {
  const fallbackMs = Number.isFinite(deadlineMs) && deadlineMs > 0
    ? Math.floor(deadlineMs)
    : 1_000;
  const requestedMs = Number.isFinite(socketIdleTimeoutMs) && socketIdleTimeoutMs !== undefined && socketIdleTimeoutMs > 0
    ? Math.floor(socketIdleTimeoutMs)
    : fallbackMs;
  return Math.max(1_000, requestedMs);
}

export function classifyConnectError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'official_exit_dns_failed';
  if (code === 'ECONNREFUSED') return 'official_exit_connect_refused';
  if (code === 'ETIMEDOUT') return 'official_exit_connect_timeout';
  return 'official_exit_connect_failed';
}

/** Classify failures emitted after the TCP connection has already opened. */
export function classifySocketError(error: Error): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ETIMEDOUT') return 'official_exit_socket_timeout';
  if (code === 'ECONNRESET') return 'official_exit_socket_reset';
  if (code === 'EPIPE') return 'official_exit_socket_broken_pipe';
  return 'official_exit_socket_failed';
}

function providerWebSocketSendErrorCode(error: Error): string {
  if (error.message.includes('send_timeout')) return 'official_exit_backpressure_timeout';
  if (error.message.includes('queue_overflow')) return 'official_exit_connection_queue_overflow';
  if (error.message.includes('disconnected')) return 'official_exit_provider_connection_closed';
  return 'official_exit_websocket_send_failed';
}
