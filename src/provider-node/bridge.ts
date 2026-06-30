import WebSocket from 'ws';
import { nanoid } from 'nanoid';
import type {
  OfficialExitHealth,
  OfficialExitClose,
  OfficialExitDataFrame,
  OfficialExitOpenRequest,
  PlatformCredentialMirrorUpdateAck,
  PlatformCredentialRefreshHint,
  PlatformUpgradeAvailable,
  ProviderCredentialMirrorUpdate,
  ProviderHeartbeat,
  ProviderHello,
} from '../shared/protocol.js';
import { sha256Json } from '../shared/crypto.js';
import type { ProviderNodeConfig } from './config.js';
import { ProviderRiskController, type ProviderRiskSnapshot } from './risk.js';
import { ProviderOfficialExitTunnelManager } from './official-exit.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.25;
const MIRROR_UPDATE_ACK_TIMEOUT_MS = 30_000;

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
): { url: string; options: WebSocket.ClientOptions } {
  return {
    url: config.platformWsUrl,
    options: {
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
  private readonly pendingMirrorUpdates = new Map<string, {
    credentialBindingId: string;
    timer: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private reconnectAttempt = 0;
  private lastSentCapabilitiesHash: string | null = null;
  private stopped = false;
  private readonly risk = new ProviderRiskController();
  private readonly officialExitTunnels = new ProviderOfficialExitTunnelManager(
    () => this.getConfig(),
    (message) => this.send(message),
  );
  readonly state: BridgeState = {
    connected: false,
    inFlight: 0,
  };

  constructor(private getConfig: () => ProviderNodeConfig, private readonly options: ProviderBridgeOptions = {}) {}

  start() {
    this.stopped = false;
    this.state.reconnectSuppressedReason = undefined;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.officialExitTunnels.closeAll();
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_stopped'));
    this.socket?.close();
  }

  reconnectNow() {
    this.stopped = false;
    this.risk.reset();
    this.reconnectAttempt = 0;
    this.state.reconnectSuppressedReason = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_reconnecting'));
    this.socket?.close();
    this.connect();
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
    const connection = buildProviderBridgeWebSocketConnection(config);
    const socket = new WebSocket(connection.url, connection.options);
    this.socket = socket;

    socket.on('open', () => {
      const config = this.getConfig();
      this.state.connected = true;
      this.state.lastConnectedAt = new Date().toISOString();
      this.state.lastError = undefined;
      this.reconnectAttempt = 0;
      this.sendHello();
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.shouldSendBusinessHeartbeat(config)) {
        this.sendHeartbeat();
        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
      }
    });

    socket.on('message', (raw) => {
      this.handleMessage(String(raw)).catch((error) => {
        this.state.lastError = error instanceof Error ? error.message : 'handle_message_failed';
      });
    });

    socket.on('close', (_code, reason) => {
      if (this.socket === socket) this.scheduleReconnect(normalizeProviderBridgeCloseReason(reason));
    });
    socket.on('error', (error) => {
      if (this.socket === socket) this.scheduleReconnect(error.message);
    });
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    this.state.connected = false;
    this.state.lastError = reason;
    this.state.reconnectSuppressedReason = undefined;
    this.officialExitTunnels.closeAll('platform_connection_closed');
    this.rejectPendingMirrorUpdates(new Error(`provider_bridge_${reason}`));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (shouldSuppressProviderBridgeReconnect(reason)) {
      this.state.reconnectSuppressedReason = reason;
      return;
    }
    if (this.reconnectTimer) return;
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
      inFlight: this.state.inFlight,
      healthy: !this.state.lastError && this.risk.canDispatch().allowed,
      lastErrorCode: risk.lastErrorCode || this.state.lastError,
      riskState: risk.state,
      cooldownUntil: risk.cooldownUntil,
      consecutiveFailures: risk.consecutiveFailures,
      officialExit: this.officialExitHealth(config),
    };
    if (forceCapabilities || capabilitiesHash !== this.lastSentCapabilitiesHash) {
      heartbeat.capabilities = capabilities;
      this.lastSentCapabilitiesHash = capabilitiesHash;
    }
    this.state.lastHeartbeatAt = new Date().toISOString();
    this.send(heartbeat);
  }

  private async handleMessage(raw: string) {
    const message = JSON.parse(raw) as OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose | PlatformCredentialMirrorUpdateAck | PlatformCredentialRefreshHint | { type: string };
    if (message.type === 'platform.ready') {
      this.options.onPlatformReady?.();
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
      await this.officialExitTunnels.handleMessage(message);
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

  private send(message: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
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
