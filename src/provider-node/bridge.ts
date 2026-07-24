import WebSocket, { type RawData } from 'ws';
import { nanoid } from 'nanoid';
import {
  decodeOfficialExitBinaryFrame,
  OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
  OFFICIAL_EXIT_WEBSOCKET_MAX_MESSAGE_BYTES,
} from '../shared/official-exit-binary.js';
import type {
  OfficialExitHealth,
  OfficialExitClose,
  OfficialExitDataFrame,
  OfficialExitOpenRequest,
  OfficialExitDataProtocol,
  PlatformDrainAck,
  PlatformCredentialMirrorUpdateAck,
  PlatformCredentialRefreshHint,
  PlatformProviderReady,
  PlatformUpgradeAvailable,
  ProviderCredentialMirrorUpdate,
  ProviderDrainNotice,
  ProviderHeartbeat,
  ProviderHello,
} from '../shared/protocol.js';
import { sha256Json } from '../shared/crypto.js';
import { type ProviderNodeConfig, platformFallbackUrl } from './config.js';
import { ProviderRiskController, type ProviderRiskSnapshot } from './risk.js';
import { ProviderOfficialExitTunnelManager } from './official-exit.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
// Low-level WebSocket ping to keep the relay warm through intermediaries that
// idle out quiet connections (a CDN-proxied fallback path typically cuts idle
// sockets at ~100s). A bound official-exit node sends no business heartbeat, so
// without this an idle node on the fallback would be dropped and reconnect-churn.
const KEEPALIVE_PING_INTERVAL_MS = 30_000;
// Max time for a single connect+upgrade attempt. Keeps a blocked/blackholed
// endpoint from hanging on the OS TCP timeout so the primary↔fallback flip is
// quick. Must stay well under the reconnect cadence.
const PLATFORM_HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.25;
const MIRROR_UPDATE_ACK_TIMEOUT_MS = 30_000;
const DRAIN_ACK_TIMEOUT_MS = 5_000;
const PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES = positiveEnvNumber(
  'PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES',
  4 * 1024 * 1024,
);
const PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS = positiveEnvNumber(
  'PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS',
  30_000,
);

export interface BridgeState {
  connected: boolean;
  inFlight: number;
  lastError?: string;
  lastConnectedAt?: string;
  lastHeartbeatAt?: string;
  reconnectSuppressedReason?: string;
  risk?: ProviderRiskSnapshot;
}

export interface ProviderBridgeOptions {
  onPlatformReady?: () => void;
  onPlatformCredentialRefreshHint?: (message: PlatformCredentialRefreshHint) => void;
  onPlatformUpgradeAvailable?: (message: PlatformUpgradeAvailable) => void;
  // Called when the bridge settles on a different endpoint than config recorded,
  // so the host can persist the preference (direct vs fallback) for next start.
  onEndpointPreferenceChange?: (preferFallback: boolean) => void;
}

type CredentialMirrorUpdateInput = Omit<ProviderCredentialMirrorUpdate, 'type' | 'requestId'>;

const NON_RETRYABLE_CLOSE_REASONS = new Set([
  'invalid_provider_secret',
  'node_paused',
  'node_revoked',
  'node_secret_rotated',
  'provider_identity_mismatch',
  'unsupported_node_version',
]);

export function normalizeProviderBridgeCloseReason(reason: Buffer | string | undefined): string {
  if (!reason) return 'closed';
  const normalized = Buffer.isBuffer(reason) ? reason.toString('utf8') : reason;
  return normalized.trim() || 'closed';
}

export function shouldSuppressProviderBridgeReconnect(reason: string): boolean {
  return NON_RETRYABLE_CLOSE_REASONS.has(reason);
}

export function buildProviderBridgeWebSocketConnection(
  config: Pick<ProviderNodeConfig, 'platformWsUrl' | 'nodeId' | 'providerNodeSecret'>,
  useFallback = false,
): { url: string; options: WebSocket.ClientOptions } {
  const fallbackUrl = useFallback ? platformFallbackUrl(config.platformWsUrl) : null;
  return {
    url: fallbackUrl ?? config.platformWsUrl,
    options: {
      // Bound handshake time so a blocked/blackholed endpoint (e.g. a primary IP
      // that a firewall silently drops, where TCP would otherwise hang on the OS
      // connect timeout for ~2 minutes) fails fast and the bridge flips to the
      // other endpoint within seconds instead of appearing dead.
      handshakeTimeout: PLATFORM_HANDSHAKE_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: OFFICIAL_EXIT_WEBSOCKET_MAX_MESSAGE_BYTES,
      headers: {
        'x-provider-node-id': config.nodeId,
        'x-provider-node-secret': config.providerNodeSecret,
      },
    },
  };
}

export class ProviderBridge {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly pendingMirrorUpdates = new Map<string, {
    credentialBindingId: string;
    timer: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private reconnectAttempt = 0;
  // Which endpoint the next connect() targets: false = direct primary, true =
  // CDN-proxied fallback. We only flip after a connect attempt fails outright,
  // so once an endpoint connects the bridge sticks to it (a drop on a healthy
  // link retries the same endpoint first) and direct-reachable nodes never touch
  // the fallback. Nodes on networks that block the primary IP settle on fallback.
  private useFallback = false;
  private lastSentCapabilitiesHash: string | null = null;
  private stopped = false;
  private acceptingSessions = true;
  private pendingDrainAck?: {
    requestId: string;
    timer: NodeJS.Timeout;
    promise: Promise<void>;
    resolve: () => void;
  };
  private readonly platformInputBlockedSessions = new Set<string>();
  private readonly risk = new ProviderRiskController();
  private readonly officialExitTunnels = new ProviderOfficialExitTunnelManager(
    () => this.getConfig(),
    (message) => this.send(message),
    undefined,
    {
      webSocketBufferedAmount: () => this.socket?.bufferedAmount ?? 0,
      webSocketHighWaterBytes: PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES,
      backpressureTimeoutMs: PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS,
      setPlatformInputBackpressure: (sessionId, blocked) => {
        if (blocked) this.platformInputBlockedSessions.add(sessionId);
        else this.platformInputBlockedSessions.delete(sessionId);
        if (this.platformInputBlockedSessions.size > 0) this.socket?.pause();
        else this.socket?.resume();
      },
    },
  );
  readonly state: BridgeState = {
    connected: false,
    inFlight: 0,
  };

  constructor(private getConfig: () => ProviderNodeConfig, private readonly options: ProviderBridgeOptions = {}) {}

  start() {
    this.stopped = false;
    this.acceptingSessions = true;
    this.officialExitTunnels.setAcceptingSessions(true);
    this.state.reconnectSuppressedReason = undefined;
    this.useFallback = Boolean(this.getConfig().preferFallbackEndpoint);
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.acceptingSessions = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.keepaliveTimer = null;
    this.officialExitTunnels.closeAll();
    this.platformInputBlockedSessions.clear();
    this.finishPendingDrainAck();
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_stopped'));
    this.socket?.close();
  }

  reconnectNow() {
    this.stopped = false;
    this.acceptingSessions = true;
    this.risk.reset();
    this.reconnectAttempt = 0;
    this.useFallback = Boolean(this.getConfig().preferFallbackEndpoint);
    this.state.reconnectSuppressedReason = undefined;
    this.officialExitTunnels.setAcceptingSessions(true);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_reconnecting'));
    this.socket?.close();
    this.connect();
  }

  beginDrain(): Promise<void> {
    if (this.pendingDrainAck) return this.pendingDrainAck.promise;
    this.acceptingSessions = false;
    this.officialExitTunnels.setAcceptingSessions(false);
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.resolve();
    this.sendHeartbeat(true);
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    const requestId = nanoid();
    const timer = setTimeout(() => this.finishPendingDrainAck(requestId), DRAIN_ACK_TIMEOUT_MS);
    timer.unref?.();
    this.pendingDrainAck = {
      requestId,
      timer,
      promise,
      resolve: resolvePromise,
    };
    const notice: ProviderDrainNotice = {
      type: 'provider.drain',
      requestId,
      nodeId: this.getConfig().nodeId,
      acceptingSessions: false,
    };
    this.send(notice);
    return promise;
  }

  inFlightCount(): number {
    return this.officialExitTunnels.activeSessionCount();
  }

  sendCredentialMirrorUpdate(input: CredentialMirrorUpdateInput): Promise<void> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('provider_bridge_not_connected'));
    }
    const requestId = nanoid();
    const message: ProviderCredentialMirrorUpdate = {
      type: 'provider.credential_mirror_update',
      requestId,
      ...input,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMirrorUpdates.delete(requestId);
        reject(new Error('credential_mirror_update_ack_timeout'));
      }, MIRROR_UPDATE_ACK_TIMEOUT_MS);
      timer.unref?.();
      this.pendingMirrorUpdates.set(requestId, {
        credentialBindingId: input.credentialBindingId,
        timer,
        resolve,
        reject,
      });
      this.send(message);
    });
  }

  private connect() {
    if (this.stopped) return;
    const config = this.getConfig();
    // Node identity and secret travel in headers, not the query string, so they
    // do not land in proxy access logs or request URL telemetry.
    const connection = buildProviderBridgeWebSocketConnection(config, this.useFallback);
    const socket = new WebSocket(connection.url, connection.options);
    this.socket = socket;
    let opened = false;

    socket.on('open', () => {
      const config = this.getConfig();
      opened = true;
      this.state.connected = true;
      this.state.lastConnectedAt = new Date().toISOString();
      this.state.lastError = undefined;
      this.reconnectAttempt = 0;
      // Remember the endpoint that actually connected so the next start skips a
      // dead primary (or recovers to it) without paying a handshake timeout.
      if (Boolean(config.preferFallbackEndpoint) !== this.useFallback) {
        this.options.onEndpointPreferenceChange?.(this.useFallback);
      }
      this.sendHello();
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, KEEPALIVE_PING_INTERVAL_MS);
      this.keepaliveTimer.unref?.();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.shouldSendBusinessHeartbeat(config)) {
        this.sendHeartbeat();
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
      }
    });

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        try {
          const encoded = rawDataBuffer(raw);
          const frame = decodeOfficialExitBinaryFrame(encoded);
          this.officialExitTunnels.handleBinaryFrame(frame, encoded.byteLength);
        } catch {
          socket.close(1003, 'invalid_binary_frame');
        }
        return;
      }
      const encoded = rawDataBuffer(raw);
      this.handleMessage(encoded.toString('utf8'), encoded.byteLength).catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : 'handle_message_failed';
      });
    });

    socket.on('close', (_code, reason) => {
      if (this.socket === socket) this.scheduleReconnect(normalizeProviderBridgeCloseReason(reason), opened);
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.scheduleReconnect(error.message, opened);
    });
  }

  private scheduleReconnect(reason: string, wasConnected = true) {
    if (this.stopped) return;
    this.state.connected = false;
    this.state.lastError = reason;
    this.state.reconnectSuppressedReason = undefined;
    this.officialExitTunnels.closeAll('platform_connection_closed');
    this.finishPendingDrainAck();
    this.rejectPendingMirrorUpdates(new Error(`provider_bridge_${reason}`));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.heartbeatTimer = null;
    this.keepaliveTimer = null;
    if (shouldSuppressProviderBridgeReconnect(reason)) {
      this.state.reconnectSuppressedReason = reason;
      return;
    }
    // A single failed attempt emits BOTH 'error' and 'close', so this runs twice;
    // the dedup guard makes only the first one schedule. Flip AFTER the guard so a
    // failed connect alternates the endpoint exactly once (direct ↔ CDN-proxied
    // fallback) — flipping before it would toggle twice and never alternate. A
    // drop after a healthy session (wasConnected) keeps the same endpoint.
    if (this.reconnectTimer) return;
    if (!wasConnected && platformFallbackUrl(this.getConfig().platformWsUrl)) {
      this.useFallback = !this.useFallback;
    }
    const delayMs = this.nextReconnectDelayMs();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private sendHello() {
    const config = this.getConfig();
    const capabilities = this.capabilitiesWithLocalCapacity(config);
    this.lastSentCapabilitiesHash = sha256Json(capabilities);
    const hello: ProviderHello = {
      type: 'provider.hello',
      nodeId: config.nodeId,
      providerId: config.providerId,
      nodeVersion: config.nodeVersion,
      nodeBuildHash: config.nodeBuildHash,
      runtimeMode: config.runtimeMode,
      capabilities,
      officialExit: this.officialExitHealth(config),
      acceptingSessions: this.acceptingSessions,
      transportCapabilities: {
        officialExitDataProtocols: ['json_base64_v1', 'binary_v1'],
        flowControl: ['credit_v1'],
        maxBinaryFrameBytes: OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
      },
    };
    this.send(hello);
  }

  private sendHeartbeat(forceCapabilities = false) {
    const config = this.getConfig();
    const risk = this.risk.snapshot();
    this.state.risk = risk;
    const capabilities = this.capabilitiesWithLocalCapacity(config);
    const capabilitiesHash = sha256Json(capabilities);
    const heartbeat: ProviderHeartbeat = {
      type: 'provider.heartbeat',
      nodeId: config.nodeId,
      inFlight: this.inFlightCount(),
      healthy: !this.state.lastError && this.risk.canDispatch().allowed,
      lastErrorCode: risk.lastErrorCode || this.state.lastError,
      riskState: risk.state,
      cooldownUntil: risk.cooldownUntil,
      consecutiveFailures: risk.consecutiveFailures,
      officialExit: this.officialExitHealth(config),
      acceptingSessions: this.acceptingSessions,
    };
    if (forceCapabilities || capabilitiesHash !== this.lastSentCapabilitiesHash) {
      heartbeat.capabilities = capabilities;
      this.lastSentCapabilitiesHash = capabilitiesHash;
    }
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.send(heartbeat);
  }

  private async handleMessage(raw: string, wireBytes?: number) {
    const message = JSON.parse(raw) as OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose | PlatformCredentialMirrorUpdateAck | PlatformCredentialRefreshHint | { type: string };
    if (message.type === 'platform.ready') {
      const ready = message as PlatformProviderReady;
      const selected = selectedOfficialExitDataProtocol(ready);
      this.officialExitTunnels.setNegotiatedDataProtocol(selected);
      this.options.onPlatformReady?.();
      return;
    }
    if (message.type === 'platform.drain_ack') {
      const ack = message as PlatformDrainAck;
      if (ack.nodeId === this.getConfig().nodeId) {
        this.finishPendingDrainAck(ack.requestId);
      }
      return;
    }
    if (message.type === 'platform.credential_refresh_hint') {
      this.options.onPlatformCredentialRefreshHint?.(message as PlatformCredentialRefreshHint);
      return;
    }
    if (message.type === 'platform.credential_mirror_update_ack') {
      this.handleCredentialMirrorUpdateAck(message as PlatformCredentialMirrorUpdateAck);
      return;
    }
    if (message.type === 'platform.upgrade_available') {
      this.options.onPlatformUpgradeAvailable?.(message as PlatformUpgradeAvailable);
      return;
    }
    if (isOfficialExitPlatformMessage(message)) {
      await this.officialExitTunnels.handleMessage(message, wireBytes);
    }
  }

  private handleCredentialMirrorUpdateAck(message: PlatformCredentialMirrorUpdateAck): void {
    const pending = this.pendingMirrorUpdates.get(message.requestId);
    if (!pending) return;
    this.pendingMirrorUpdates.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve();
      return;
    }
    pending.reject(new Error(message.errorMessage || message.errorCode || 'credential_mirror_update_failed'));
  }

  private rejectPendingMirrorUpdates(error: Error): void {
    for (const [requestId, pending] of this.pendingMirrorUpdates) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingMirrorUpdates.delete(requestId);
    }
  }

  private finishPendingDrainAck(requestId?: string): void {
    const pending = this.pendingDrainAck;
    if (!pending || (requestId && pending.requestId !== requestId)) return;
    this.pendingDrainAck = undefined;
    clearTimeout(pending.timer);
    pending.resolve();
  }

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(Buffer.isBuffer(message) ? message : JSON.stringify(message));
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : 'provider_bridge_send_failed';
      }
    }
  }

  private shouldSendBusinessHeartbeat(config: ProviderNodeConfig): boolean {
    return !config.officialExit?.enabled;
  }

  private nextReconnectDelayMs(): number {
    const exponentialDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * (2 ** this.reconnectAttempt),
    );
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    const jitter = exponentialDelay * RECONNECT_JITTER_RATIO * Math.random();
    return Math.round(exponentialDelay + jitter);
  }

  private capabilitiesWithLocalCapacity(config: ProviderNodeConfig) {
    if (config.officialExit?.enabled) {
      return [{
        routeMode: 'official_exit' as const,
        officialExit: {
          routeMode: 'official_exit' as const,
          dataProtocols: ['json_base64_v1' as const, 'binary_v1' as const],
        },
      }];
    }
    return [{
      ...config.capability,
      routeMode: config.capability.routeMode,
    }];
  }

  private officialExitHealth(config: ProviderNodeConfig): OfficialExitHealth | undefined {
    if (!config.officialExit?.enabled) return undefined;
    const healthy = !this.state.lastError;
    return {
      status: healthy ? 'healthy' : 'degraded',
      activeSessions: this.officialExitTunnels.activeSessionCount(),
      recentConnectErrorRate: 0,
      recentTimeoutRate: 0,
      lastCheckAt: new Date().toISOString(),
      reasonCodes: healthy ? [] : [this.state.lastError || 'official_exit_unhealthy'],
    };
  }
}

function isOfficialExitPlatformMessage(
  message: { type: string },
): message is OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose {
  return message.type === 'official_exit.open'
    || message.type === 'official_exit.data'
    || message.type === 'official_exit.close';
}

function selectedOfficialExitDataProtocol(ready: PlatformProviderReady): OfficialExitDataProtocol {
  const transport = ready.transport;
  if (
    transport?.officialExitDataProtocol === 'binary_v1'
    && transport.flowControl === 'credit_v1'
    && (transport.maxBinaryFrameBytes ?? 0) >= OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES
  ) {
    return 'binary_v1';
  }
  return 'json_base64_v1';
}

function rawDataBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
