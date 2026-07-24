import { connect, type Socket } from 'node:net';
import {
  encodeOfficialExitBinaryData,
  encodeOfficialExitBinaryWindowUpdate,
  OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES,
  OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
  type OfficialExitBinaryFrame,
} from '../shared/official-exit-binary.js';
import type {
  OfficialExitClose,
  OfficialExitDataProtocol,
  OfficialExitDataFrame,
  OfficialExitError,
  OfficialExitOpenRequest,
  OfficialExitOpenResponse,
  OfficialExitTransportDiagnostic,
} from '../shared/protocol.js';
import { DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS } from '../shared/official-exit-vendors.js';
import type { ProviderNodeConfig } from './config.js';

type OfficialExitPlatformMessage = OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose;
type OfficialExitProviderMessage = OfficialExitOpenResponse | OfficialExitDataFrame | OfficialExitClose | OfficialExitError;
type OfficialExitProviderOutbound = OfficialExitProviderMessage | Buffer;

export { DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS, OFFICIAL_EXIT_VENDOR_CONFIGS } from '../shared/official-exit-vendors.js';

export const OFFICIAL_EXIT_ALLOWLIST_ENV = 'PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS';
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
  closed: boolean;
  maxBytesIn?: number;
  maxBytesOut?: number;
  connectedAt: number;
  connectMs: number;
  addressFamily?: 'ipv4' | 'ipv6';
  remoteAddress?: string;
  dataProtocol: OfficialExitDataProtocol;
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
  backpressurePollTimer?: NodeJS.Timeout;
  platformInputBlocked: boolean;
}

export interface ProviderOfficialExitTunnelManagerOptions {
  webSocketBufferedAmount?: () => number;
  webSocketHighWaterBytes?: number;
  backpressureTimeoutMs?: number;
  setPlatformInputBackpressure?: (sessionId: string, blocked: boolean) => void;
}

export class ProviderOfficialExitTunnelManager {
  private readonly sessions = new Map<string, OfficialExitSession>();

  private readonly allowedHosts: readonly string[];
  private negotiatedDataProtocol: OfficialExitDataProtocol = 'json_base64_v1';
  private acceptingSessions = true;
  private readonly options: Required<Pick<
    ProviderOfficialExitTunnelManagerOptions,
    'webSocketBufferedAmount' | 'webSocketHighWaterBytes' | 'backpressureTimeoutMs'
  >> & Pick<ProviderOfficialExitTunnelManagerOptions, 'setPlatformInputBackpressure'>;

  constructor(
    private getConfig: () => ProviderNodeConfig,
    private send: (message: OfficialExitProviderOutbound) => void,
    allowedHosts: readonly string[] = parseOfficialExitAllowlist(process.env[OFFICIAL_EXIT_ALLOWLIST_ENV]),
    options: ProviderOfficialExitTunnelManagerOptions = {},
  ) {
    this.allowedHosts = allowedHosts;
    this.options = {
      webSocketBufferedAmount: options.webSocketBufferedAmount ?? (() => 0),
      webSocketHighWaterBytes: options.webSocketHighWaterBytes ?? 4 * 1024 * 1024,
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

  handleBinaryFrame(frame: OfficialExitBinaryFrame, wireBytes: number): void {
    if (frame.kind === 'data') {
      this.writeBinaryData(frame, wireBytes);
      return;
    }
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.closed || session.dataProtocol !== 'binary_v1') return;
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
      let settled = false;

      const failBeforeConnect = (reasonCode: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        this.sendOpenResponse(request.sessionId, false, reasonCode, {
          version: 1,
          stage: 'connect',
          outcome: 'failed',
          reasonCode,
          connectMs: Date.now() - connectStartedAt,
        });
        resolve();
      };

      socket.setTimeout(officialExitConnectTimeoutMs(request.deadlineMs));
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        // The shorter deadline only governs TCP connect/open_response. Once the
        // tunnel is open, preserve the existing socket inactivity timeout.
        socket.setTimeout(Math.max(1_000, request.deadlineMs));
        const addressFamily = socket.remoteFamily === 'IPv4' ? 'ipv4' : socket.remoteFamily === 'IPv6' ? 'ipv6' : undefined;
        const connectMs = Date.now() - connectStartedAt;
        const session: OfficialExitSession = {
          socket,
          seqOut: 0,
          bytesIn: 0,
          bytesOut: 0,
          closed: false,
          maxBytesIn: request.maxBytesIn,
          maxBytesOut: request.maxBytesOut,
          connectedAt: Date.now(),
          connectMs,
          addressFamily,
          remoteAddress: socket.remoteAddress,
          dataProtocol: request.dataProtocol ?? 'json_base64_v1',
          expectedSeqIn: 0,
          outboundCredit: OFFICIAL_EXIT_BINARY_INITIAL_WINDOW_BYTES,
          pendingFromUpstream: [],
          pendingFromUpstreamOffset: 0,
          webSocketBytesIn: 0,
          webSocketBytesOut: 0,
          backpressureCount: 0,
          peakBufferedBytes: 0,
          platformInputBlocked: false,
        };
        this.sessions.set(request.sessionId, session);
        this.attachSocketHandlers(request.sessionId, session);
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
    const requestedDataProtocol = request.dataProtocol ?? 'json_base64_v1';
    if (requestedDataProtocol !== this.negotiatedDataProtocol) return 'official_exit_data_protocol_not_negotiated';
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
      this.send(frame);
      session.seqOut += 1;
      this.applyWebSocketBackpressure(sessionId, session);
    });
    session.socket.once('close', () => {
      if (this.sessions.get(sessionId) !== session) return;
      this.closeSession(sessionId, session, 'official_exit_remote_closed', true);
    });
  }

  private writeJsonData(frame: OfficialExitDataFrame, wireBytes?: number): void {
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.closed) {
      this.send({
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
    session.bytesOut += chunk.byteLength;
    if (session.maxBytesOut !== undefined && session.bytesOut > session.maxBytesOut) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_max_bytes_out_exceeded');
      return;
    }
    if (!session.socket.write(chunk)) this.blockPlatformInput(frame.sessionId, session);
  }

  private writeBinaryData(
    frame: Extract<OfficialExitBinaryFrame, { kind: 'data' }>,
    wireBytes: number,
  ): void {
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.closed) {
      this.send({
        type: 'official_exit.error',
        sessionId: frame.sessionId,
        errorCode: 'official_exit_session_not_found',
        retryable: true,
      });
      return;
    }
    if (session.dataProtocol !== 'binary_v1' || frame.seq !== session.expectedSeqIn) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_frame_sequence_mismatch');
      return;
    }
    session.expectedSeqIn += 1;
    session.webSocketBytesIn += wireBytes;
    session.bytesOut += frame.payload.byteLength;
    if (session.maxBytesOut !== undefined && session.bytesOut > session.maxBytesOut) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_max_bytes_out_exceeded');
      return;
    }
    const writable = session.socket.write(frame.payload, () => {
      if (session.closed) return;
      const update = encodeOfficialExitBinaryWindowUpdate(frame.sessionId, frame.payload.byteLength);
      session.webSocketBytesOut += update.byteLength;
      this.send(update);
      this.applyWebSocketBackpressure(frame.sessionId, session);
    });
    if (!writable) {
      session.backpressureCount += 1;
      this.startPlatformInputBackpressureTimeout(frame.sessionId, session);
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
      this.send(encoded);
      if (this.applyWebSocketBackpressure(sessionId, session)) return;
    }
    if (session.pendingFromUpstream.length === 0 && session.outboundCredit > 0) {
      this.clearUpstreamBackpressureTimeout(session);
      session.socket.resume();
    } else {
      this.startUpstreamBackpressureTimeout(sessionId, session);
    }
  }

  private applyWebSocketBackpressure(sessionId: string, session: OfficialExitSession): boolean {
    const bufferedBytes = Math.max(0, this.options.webSocketBufferedAmount());
    session.peakBufferedBytes = Math.max(session.peakBufferedBytes, bufferedBytes);
    if (bufferedBytes <= this.options.webSocketHighWaterBytes) return false;
    session.backpressureCount += 1;
    session.socket.pause();
    this.startUpstreamBackpressureTimeout(sessionId, session);
    if (!session.backpressurePollTimer) {
      const poll = () => {
        session.backpressurePollTimer = undefined;
        if (session.closed) return;
        const current = Math.max(0, this.options.webSocketBufferedAmount());
        session.peakBufferedBytes = Math.max(session.peakBufferedBytes, current);
        if (current <= Math.floor(this.options.webSocketHighWaterBytes / 2)) {
          this.clearUpstreamBackpressureTimeout(session);
          if (session.dataProtocol === 'binary_v1') this.pumpUpstreamToPlatform(sessionId, session);
          else session.socket.resume();
          return;
        }
        session.backpressurePollTimer = setTimeout(poll, 5);
        session.backpressurePollTimer.unref?.();
      };
      session.backpressurePollTimer = setTimeout(poll, 5);
      session.backpressurePollTimer.unref?.();
    }
    return true;
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
    this.send({
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
    this.send({
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
    if (session.backpressurePollTimer) clearTimeout(session.backpressurePollTimer);
    if (session.platformInputBlocked) this.options.setPlatformInputBackpressure?.(sessionId, false);
    this.sessions.delete(sessionId);
    session.socket.destroy();
    if (notifyPlatform) {
      this.send({
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
