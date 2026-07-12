import { connect, type Socket } from 'node:net';
import type {
  OfficialExitClose,
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

export { DEFAULT_OFFICIAL_EXIT_ALLOWED_HOSTS, OFFICIAL_EXIT_VENDOR_CONFIGS } from '../shared/official-exit-vendors.js';

export const OFFICIAL_EXIT_ALLOWLIST_ENV = 'PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS';

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
}

export class ProviderOfficialExitTunnelManager {
  private readonly sessions = new Map<string, OfficialExitSession>();

  private readonly allowedHosts: readonly string[];

  constructor(
    private getConfig: () => ProviderNodeConfig,
    private send: (message: OfficialExitProviderMessage) => void,
    allowedHosts: readonly string[] = parseOfficialExitAllowlist(process.env[OFFICIAL_EXIT_ALLOWLIST_ENV]),
  ) {
    this.allowedHosts = allowedHosts;
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  closeAll(reasonCode = 'provider_node_stopped'): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      this.closeSession(sessionId, session, reasonCode, false);
    }
  }

  async handleMessage(message: OfficialExitPlatformMessage): Promise<void> {
    if (message.type === 'official_exit.open') {
      await this.open(message);
      return;
    }
    if (message.type === 'official_exit.data') {
      this.writeData(message);
      return;
    }
    this.closeFromPlatform(message);
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

      socket.setTimeout(Math.max(1_000, request.deadlineMs));
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
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
    if (!config.officialExit?.enabled) return 'official_exit_disabled';
    if (request.routeMode !== 'official_exit') return 'official_exit_route_mode_required';
    if (request.providerId !== config.providerId || request.nodeId !== config.nodeId) return 'official_exit_identity_mismatch';
    if (!request.targetHost || /[\s/]/.test(request.targetHost)) return 'official_exit_invalid_target_host';
    if (!Number.isInteger(request.targetPort) || request.targetPort <= 0 || request.targetPort > 65_535) {
      return 'official_exit_invalid_target_port';
    }
    if (!isOfficialExitHostAllowed(request.targetHost, this.allowedHosts)) return 'official_exit_vendor_not_allowed';
    return undefined;
  }

  private attachSocketHandlers(sessionId: string, session: OfficialExitSession): void {
    session.socket.on('data', (chunk) => {
      if (session.closed) return;
      session.bytesIn += chunk.byteLength;
      if (session.maxBytesIn !== undefined && session.bytesIn > session.maxBytesIn) {
        this.sendErrorAndClose(sessionId, session, 'official_exit_max_bytes_in_exceeded');
        return;
      }
      this.send({
        type: 'official_exit.data',
        sessionId,
        seq: session.seqOut,
        payloadBase64: Buffer.from(chunk).toString('base64'),
      });
      session.seqOut += 1;
    });
    session.socket.once('close', () => {
      if (this.sessions.get(sessionId) !== session) return;
      this.closeSession(sessionId, session, 'official_exit_remote_closed', true);
    });
  }

  private writeData(frame: OfficialExitDataFrame): void {
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
    const chunk = Buffer.from(frame.payloadBase64, 'base64');
    session.bytesOut += chunk.byteLength;
    if (session.maxBytesOut !== undefined && session.bytesOut > session.maxBytesOut) {
      this.sendErrorAndClose(frame.sessionId, session, 'official_exit_max_bytes_out_exceeded');
      return;
    }
    session.socket.write(chunk);
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
    };
  }
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
