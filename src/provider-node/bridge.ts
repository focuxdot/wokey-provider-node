import WebSocket, { type RawData } from 'ws';
import { nanoid } from 'nanoid';
import {
  decodeOfficialExitBinaryFrame,
  OFFICIAL_EXIT_BULK_MAX_INITIAL_WINDOW_BYTES,
  OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES,
  OFFICIAL_EXIT_DEFAULT_CONNECTION_QUEUE_BUDGET_BYTES,
  OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
  OFFICIAL_EXIT_WEBSOCKET_MAX_MESSAGE_BYTES,
} from '../shared/official-exit-binary.js';
import type {
  OfficialExitHealth,
  OfficialExitClose,
  OfficialExitDataFrame,
  OfficialExitOpenRequest,
  OfficialExitDataProtocol,
  OfficialExitEarlyDataProtocol,
  PlatformDrainAck,
  PlatformCredentialMirrorUpdateAck,
  PlatformCredentialRefreshHint,
  PlatformCredentialDataChannelPlan,
  PlatformCredentialDataChannelReady,
  PlatformCredentialDataChannelsUpdated,
  PlatformJimengAuthCancel,
  PlatformJimengAuthStart,
  PlatformJimengCliInstall,
  PlatformJimengUsageCancel,
  PlatformJimengUsageRefresh,
  PlatformJimengVideoCancel,
  PlatformJimengVideoExecute,
  PlatformProviderReady,
  PlatformUpgradeAvailable,
  ProviderCredentialMirrorUpdate,
  ProviderCredentialDataChannelReady,
  ProviderCredentialDataChannelsApplied,
  ProviderCredentialDataChannelsResyncRequested,
  ProviderDrainNotice,
  ProviderHeartbeat,
  ProviderHello,
  ProviderUpgradeStatus,
} from '../shared/protocol.js';
import { JIMENG_CLI_INSTALL_PROTOCOL_VERSION } from '../shared/protocol.js';
import { sha256Json } from '../shared/crypto.js';
import { type ProviderNodeConfig, platformFallbackUrl } from './config.js';
import { ProviderRiskController, type ProviderRiskSnapshot } from './risk.js';
import {
  ProviderOfficialExitTunnelManager,
  type ProviderOfficialExitSendOptions,
  type ProviderOfficialExitSendResult,
  type PlatformBulkTransferSelection,
} from './official-exit.js';
import { WebSocketSendScheduler } from '../shared/websocket-send-scheduler.js';
import type { JimengAuthorizationHandler } from './jimeng-auth.js';
import type { JimengVideoHandler } from './jimeng-video.js';

const HEARTBEAT_INTERVAL_MS = 10_000;
// Official-exit nodes report state less often: tunnel traffic already carries
// the per-request signals, but the Platform still routes on the heartbeat's
// inFlight / risk / cooldown / acceptingSessions numbers, so they must never
// go fully stale — keep a low-frequency floor instead of no heartbeat at all.
// Stays just under the Platform's 90s NODE_HEARTBEAT_STALE_MS so a floor
// report always lands within one staleness window.
const HEARTBEAT_FLOOR_INTERVAL_MS = 85_000;
// Low-level WebSocket ping fallback for older Platform versions or a one-way
// control-plane failure. Current Platform versions already ping every 30s, so
// once the node observes that probe it suppresses its duplicate ping while the
// Platform remains active. The 60s fallback stays below the ~100s idle cutoff
// seen on CDN-proxied connections.
const KEEPALIVE_PING_INTERVAL_MS = 30_000;
const PLATFORM_ACTIVITY_FALLBACK_AFTER_MS = 60_000;
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
const PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES = positiveEnvNumber(
  'PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES',
  OFFICIAL_EXIT_DEFAULT_CONNECTION_QUEUE_BUDGET_BYTES,
);
const PROVIDER_CREDENTIAL_DATA_CHANNEL_MAX_CONCURRENT_HANDSHAKES = Math.max(1, Math.min(
  8,
  Math.floor(positiveEnvNumber('PROVIDER_CREDENTIAL_DATA_CHANNEL_MAX_CONCURRENT_HANDSHAKES', 4)),
));
const PROVIDER_CREDENTIAL_DATA_CHANNEL_READY_TIMEOUT_MS = positiveEnvNumber(
  'PROVIDER_CREDENTIAL_DATA_CHANNEL_READY_TIMEOUT_MS',
  10_000,
);
const PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_CHECK_INTERVAL_MS = positiveEnvNumber(
  'PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_CHECK_INTERVAL_MS',
  30_000,
);
const PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_TIMEOUT_MS = Math.max(
  positiveEnvNumber('PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_TIMEOUT_MS', 90_000),
  PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_CHECK_INTERVAL_MS * 3,
);

export interface ProviderCredentialDataChannelPoolState {
  enabled: boolean;
  desired: number;
  connecting: number;
  awaitingReady: number;
  ready: number;
  reconnecting: number;
  pending: number;
  livenessTimeouts: number;
  lastLivenessTimeoutAt?: string;
}

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
  onPlatformUpgradeAvailable?: (message: PlatformUpgradeAvailable) => void | Promise<void>;
  jimengAuthorization?: JimengAuthorizationHandler;
  jimengVideo?: JimengVideoHandler;
  jimengCliInstall?: {
    install: () => Promise<{ cliVersion: string }>;
  };
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
  credentialDataChannel?: {
    credentialBindingId: string;
    connectionToken: string;
  },
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
        ...(credentialDataChannel
          ? {
              'x-provider-data-channel': credentialDataChannel.credentialBindingId,
              'x-provider-connection-token': credentialDataChannel.connectionToken,
            }
          : {}),
      },
    },
  };
}

type ProviderCredentialDataChannel = {
  credentialBindingId: string;
  socket: WebSocket;
  scheduler: WebSocketSendScheduler;
  tunnels: ProviderOfficialExitTunnelManager;
  epochId: string;
  state: 'connecting' | 'awaiting_ready' | 'ready' | 'closed';
  readyTimer?: NodeJS.Timeout;
  lastPlatformActivityAt: number;
  handshakeSlotHeld: boolean;
  finalized: boolean;
  finalize: (reason?: string) => void;
};

class ProviderCredentialDataChannelPool {
  private plan?: PlatformCredentialDataChannelPlan;
  private readonly channels = new Map<string, ProviderCredentialDataChannel>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly pendingConnections = new Set<string>();
  private livenessTimer?: NodeJS.Timeout;
  private livenessTimeouts = 0;
  private lastLivenessTimeoutAt?: string;
  private activeHandshakes = 0;
  private acceptingSessions = true;
  private dataProtocol: OfficialExitDataProtocol = 'json_base64_v1';
  private earlyDataProtocol?: OfficialExitEarlyDataProtocol;
  private bulkTransfer?: SelectedOfficialExitBulkTransfer;

  constructor(
    private readonly getConfig: () => ProviderNodeConfig,
    private readonly getUseFallback: () => boolean,
    private readonly sendControl: (message: unknown) => ProviderOfficialExitSendResult,
  ) {}

  configure(
    plan: PlatformCredentialDataChannelPlan,
    dataProtocol: OfficialExitDataProtocol,
    earlyDataProtocol: OfficialExitEarlyDataProtocol | undefined,
    bulkTransfer: SelectedOfficialExitBulkTransfer | undefined,
    acceptingSessions: boolean,
  ): boolean {
    const normalizedIds = [...new Set(plan.credentialBindingIds.filter(Boolean))].sort();
    if (
      plan.protocolVersion !== 1
      || !plan.epochId
      || !Number.isSafeInteger(plan.revision)
      || plan.revision < 1
      || !plan.connectionToken
      || normalizedIds.length !== plan.credentialBindingIds.length
    ) {
      this.requestPlanResync(plan.epochId);
      return false;
    }

    const current = this.plan;
    const epochChanged = Boolean(current && current.epochId !== plan.epochId);
    if (current && !epochChanged) {
      if (plan.revision < current.revision) return false;
      if (plan.connectionToken !== current.connectionToken) {
        this.requestPlanResync(plan.epochId);
        return false;
      }
      if (
        plan.revision === current.revision
        && (
          normalizedIds.join('\u001f') !== current.credentialBindingIds.join('\u001f')
        )
      ) {
        this.requestPlanResync(plan.epochId);
        return false;
      }
    }
    if (epochChanged) this.stopChannels('credential_data_channel_epoch_replaced');
    this.plan = {
      ...plan,
      credentialBindingIds: normalizedIds,
    };
    this.dataProtocol = dataProtocol;
    this.earlyDataProtocol = earlyDataProtocol;
    this.bulkTransfer = bulkTransfer;
    this.acceptingSessions = acceptingSessions;

    const desired = new Set(this.plan.credentialBindingIds);
    for (const credentialBindingId of [...this.channels.keys()]) {
      if (!desired.has(credentialBindingId)) {
        this.closeChannel(credentialBindingId, 'credential_data_channel_removed');
      }
    }
    for (const [credentialBindingId, timer] of this.reconnectTimers) {
      if (desired.has(credentialBindingId)) continue;
      clearTimeout(timer);
      this.reconnectTimers.delete(credentialBindingId);
      this.reconnectAttempts.delete(credentialBindingId);
    }
    for (const credentialBindingId of [...this.pendingConnections]) {
      if (!desired.has(credentialBindingId)) this.pendingConnections.delete(credentialBindingId);
    }
    for (const channel of this.channels.values()) {
      this.configureTunnels(channel.tunnels);
      const queueBudgetBytes = this.channelQueueBudgetBytes();
      channel.scheduler.setQueueLimits({
        maxQueuedBytes: queueBudgetBytes,
        highWaterBytes: Math.min(PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES, queueBudgetBytes),
      });
    }
    for (const credentialBindingId of desired) {
      if (!this.channels.has(credentialBindingId) && !this.reconnectTimers.has(credentialBindingId)) {
        this.pendingConnections.add(credentialBindingId);
      }
    }
    this.ensureLivenessTimer();
    this.pumpConnections();
    return true;
  }

  setAcceptingSessions(accepting: boolean): void {
    this.acceptingSessions = accepting;
    for (const channel of this.channels.values()) channel.tunnels.setAcceptingSessions(accepting);
  }

  activeSessionCount(): number {
    let count = 0;
    for (const channel of this.channels.values()) count += channel.tunnels.activeSessionCount();
    return count;
  }

  stateSnapshot(): ProviderCredentialDataChannelPoolState {
    let connecting = 0;
    let awaitingReady = 0;
    let ready = 0;
    for (const channel of this.channels.values()) {
      if (channel.state === 'connecting') connecting += 1;
      else if (channel.state === 'awaiting_ready') awaitingReady += 1;
      else if (channel.state === 'ready') ready += 1;
    }
    return {
      enabled: Boolean(this.plan),
      desired: this.plan?.credentialBindingIds.length ?? 0,
      connecting,
      awaitingReady,
      ready,
      reconnecting: this.reconnectTimers.size,
      pending: this.pendingConnections.size,
      livenessTimeouts: this.livenessTimeouts,
      lastLivenessTimeoutAt: this.lastLivenessTimeoutAt,
    };
  }

  stop(reasonCode: string): void {
    this.plan = undefined;
    this.stopChannels(reasonCode);
  }

  private stopChannels(reasonCode: string): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = undefined;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    this.pendingConnections.clear();
    for (const credentialBindingId of [...this.channels.keys()]) {
      this.closeChannel(credentialBindingId, reasonCode);
    }
  }

  private pumpConnections(): void {
    while (
      this.activeHandshakes < PROVIDER_CREDENTIAL_DATA_CHANNEL_MAX_CONCURRENT_HANDSHAKES
      && this.pendingConnections.size > 0
    ) {
      const credentialBindingId = this.pendingConnections.values().next().value as string | undefined;
      if (!credentialBindingId) return;
      this.pendingConnections.delete(credentialBindingId);
      this.connect(credentialBindingId);
    }
  }

  private connect(credentialBindingId: string): void {
    const plan = this.plan;
    if (
      !plan?.credentialBindingIds.includes(credentialBindingId) ||
      this.channels.has(credentialBindingId) ||
      this.reconnectTimers.has(credentialBindingId)
    )
      return;

    const connection = buildProviderBridgeWebSocketConnection(this.getConfig(), this.getUseFallback(), {
      credentialBindingId,
      connectionToken: plan.connectionToken,
    });
    const socket = new WebSocket(connection.url, connection.options);
    const scheduler = new WebSocketSendScheduler(socket, {
      highWaterBytes: Math.min(
        PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES,
        this.channelQueueBudgetBytes(),
      ),
      maxQueuedBytes: this.channelQueueBudgetBytes(),
      sendTimeoutMs: PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS,
    });
    const blockedSessions = new Set<string>();
    const tunnels = new ProviderOfficialExitTunnelManager(
      this.getConfig,
      (message, options = { lane: 'control' }) => {
        if (
          this.channels.get(credentialBindingId)?.state !== 'ready'
          || socket.readyState !== WebSocket.OPEN
        ) {
          const error = new Error('provider_credential_channel_disconnected');
          options.onComplete?.(error);
          return { accepted: false, error };
        }
        const encoded = Buffer.isBuffer(message) ? message : JSON.stringify(message);
        return scheduler.enqueue(encoded, {
          lane: options.lane,
          sessionId: options.sessionId,
          callback: options.onComplete,
        });
      },
      undefined,
      {
        backpressureTimeoutMs: PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS,
        setPlatformInputBackpressure: (sessionId, blocked) => {
          if (blocked) blockedSessions.add(sessionId);
          else blockedSessions.delete(sessionId);
          if (blockedSessions.size > 0) socket.pause();
          else socket.resume();
        },
      },
    );
    this.configureTunnels(tunnels);
    const channel: ProviderCredentialDataChannel = {
      credentialBindingId,
      socket,
      scheduler,
      tunnels,
      epochId: plan.epochId,
      state: 'connecting',
      lastPlatformActivityAt: Date.now(),
      handshakeSlotHeld: true,
      finalized: false,
      finalize: () => {},
    };
    this.channels.set(credentialBindingId, channel);
    this.activeHandshakes += 1;

    const finalize = (reason = 'closed') => {
      if (channel.finalized) return;
      channel.finalized = true;
      channel.state = 'closed';
      if (channel.readyTimer) clearTimeout(channel.readyTimer);
      scheduler.close(new Error('provider_credential_channel_disconnected'));
      tunnels.closeAll('credential_data_channel_closed');
      this.releaseHandshakeSlot(channel);
      if (this.channels.get(credentialBindingId) !== channel) return;
      this.channels.delete(credentialBindingId);
      if (this.nonRetryableCloseReason(reason)) {
        this.requestPlanResync(channel.epochId);
      }
      else {
        this.scheduleReconnect(credentialBindingId, plan.epochId);
      }
    };
    channel.finalize = finalize;
    socket.on('open', () => {
      if (this.channels.get(credentialBindingId) !== channel || channel.finalized) return;
      channel.state = 'awaiting_ready';
      channel.lastPlatformActivityAt = Date.now();
      channel.readyTimer = setTimeout(() => {
        if (channel.state === 'ready' || channel.finalized) return;
        try {
          socket.terminate();
        }
        catch {
          socket.close(1008, 'credential_data_channel_ready_timeout');
        }
        finalize('credential_data_channel_ready_timeout');
      }, PROVIDER_CREDENTIAL_DATA_CHANNEL_READY_TIMEOUT_MS);
      channel.readyTimer.unref?.();
    });
    socket.on('message', (raw, isBinary) => {
      if (this.channels.get(credentialBindingId) !== channel || channel.finalized) return;
      channel.lastPlatformActivityAt = Date.now();
      if (isBinary) {
        if (channel.state !== 'ready') {
          socket.close(1008, 'credential_data_channel_not_ready');
          return;
        }
        try {
          const encoded = rawDataBuffer(raw);
          tunnels.handleBinaryFrame(decodeOfficialExitBinaryFrame(encoded), encoded.byteLength);
        } catch {
          socket.close(1003, 'invalid_binary_frame');
        }
        return;
      }
      const encoded = rawDataBuffer(raw);
      void this.handleMessage(channel, encoded.toString('utf8'), encoded.byteLength).catch(() =>
        socket.close(1008, 'credential_data_channel_message_invalid'),
      );
    });
    socket.on('ping', () => {
      if (this.channels.get(credentialBindingId) !== channel || channel.finalized) return;
      channel.lastPlatformActivityAt = Date.now();
    });
    socket.on('pong', () => {
      if (this.channels.get(credentialBindingId) !== channel || channel.finalized) return;
      channel.lastPlatformActivityAt = Date.now();
    });
    socket.on('close', (_code, reason) => finalize(normalizeProviderBridgeCloseReason(reason)));
    socket.on('error', () => {
      try {
        socket.terminate();
      }
      catch {
        // close/finalize below owns cleanup
      }
      finalize('socket_error');
    });
  }

  private async handleMessage(channel: ProviderCredentialDataChannel, raw: string, wireBytes: number): Promise<void> {
    const message = JSON.parse(raw) as
      | PlatformCredentialDataChannelReady
      | OfficialExitOpenRequest
      | OfficialExitDataFrame
      | OfficialExitClose
      | { type: string };
    if (message.type === 'platform.credential_data_channel_ready') {
      const ready = message as PlatformCredentialDataChannelReady;
      if (
        ready.protocolVersion !== 1 ||
        ready.nodeId !== this.getConfig().nodeId ||
        ready.credentialBindingId !== channel.credentialBindingId ||
        ready.epochId !== channel.epochId ||
        ready.epochId !== this.plan?.epochId ||
        !Number.isSafeInteger(ready.revision) ||
        ready.revision < 1 ||
        ready.revision > this.plan.revision ||
        !this.plan.credentialBindingIds.includes(channel.credentialBindingId)
      )
        throw new Error('credential_data_channel_ready_invalid');
      const acknowledged: ProviderCredentialDataChannelReady = {
        type: 'provider.credential_data_channel_ready',
        nodeId: ready.nodeId,
        credentialBindingId: ready.credentialBindingId,
        epochId: ready.epochId,
        revision: ready.revision,
      };
      const result = channel.scheduler.enqueue(JSON.stringify(acknowledged), { lane: 'control' });
      if (!result.accepted) throw result.error ?? new Error('credential_data_channel_ready_ack_failed');
      channel.state = 'ready';
      if (channel.readyTimer) clearTimeout(channel.readyTimer);
      channel.readyTimer = undefined;
      this.releaseHandshakeSlot(channel);
      this.reconnectAttempts.delete(channel.credentialBindingId);
      return;
    }
    if (channel.state !== 'ready') throw new Error('credential_data_channel_not_ready');
    if (!isOfficialExitPlatformMessage(message)) {
      throw new Error('credential_data_channel_message_invalid');
    }
    if (message.type === 'official_exit.open' && message.credentialBindingId !== channel.credentialBindingId)
      throw new Error('credential_data_channel_binding_mismatch');
    await channel.tunnels.handleMessage(message, wireBytes);
  }

  private configureTunnels(tunnels: ProviderOfficialExitTunnelManager): void {
    tunnels.setNegotiatedDataProtocol(this.dataProtocol);
    tunnels.setNegotiatedEarlyDataProtocol(this.earlyDataProtocol);
    tunnels.setNegotiatedBulkTransfer(this.channelBulkTransfer());
    tunnels.setAcceptingSessions(this.acceptingSessions);
  }

  private channelQueueBudgetBytes(): number {
    const totalBudget = this.bulkTransfer?.connectionQueueBudgetBytes
      ?? PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES;
    const channelCount = Math.max(1, this.plan?.credentialBindingIds.length ?? 1);
    return Math.max(1, Math.floor(totalBudget / channelCount));
  }

  private channelBulkTransfer(): SelectedOfficialExitBulkTransfer | undefined {
    if (!this.bulkTransfer) return undefined;
    const queueBudgetBytes = this.channelQueueBudgetBytes();
    const interactiveReserveBytes = Math.min(1024 * 1024, Math.floor(queueBudgetBytes / 4));
    const availableWindowBytes = queueBudgetBytes - interactiveReserveBytes;
    if (availableWindowBytes < OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES) return undefined;
    return {
      ...this.bulkTransfer,
      bulkInitialWindowBytes: Math.min(
        this.bulkTransfer.bulkInitialWindowBytes,
        availableWindowBytes,
      ),
      connectionQueueBudgetBytes: queueBudgetBytes,
    };
  }

  private closeChannel(credentialBindingId: string, reasonCode: string): void {
    const channel = this.channels.get(credentialBindingId);
    if (!channel) return;
    this.channels.delete(credentialBindingId);
    channel.finalized = true;
    channel.state = 'closed';
    if (channel.readyTimer) clearTimeout(channel.readyTimer);
    this.releaseHandshakeSlot(channel);
    channel.scheduler.close(new Error('provider_credential_channel_disconnected'));
    channel.tunnels.closeAll(reasonCode);
    try {
      channel.socket.close(1000, reasonCode);
    }
    catch {
      // local state is already closed
    }
  }

  private scheduleReconnect(credentialBindingId: string, epochId: string): void {
    const plan = this.plan;
    if (
      !plan ||
      plan.epochId !== epochId ||
      !plan.credentialBindingIds.includes(credentialBindingId) ||
      this.reconnectTimers.has(credentialBindingId)
    )
      return;
    const attempt = this.reconnectAttempts.get(credentialBindingId) ?? 0;
    this.reconnectAttempts.set(credentialBindingId, Math.min(attempt + 1, 10));
    const baseDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempt);
    const delay = Math.round(baseDelay + baseDelay * RECONNECT_JITTER_RATIO * Math.random());
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(credentialBindingId);
      this.pendingConnections.add(credentialBindingId);
      this.pumpConnections();
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(credentialBindingId, timer);
  }

  private ensureLivenessTimer(): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(
      () => this.reconcileChannelLiveness(),
      PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_CHECK_INTERVAL_MS,
    );
    this.livenessTimer.unref?.();
  }

  private reconcileChannelLiveness(): void {
    const plan = this.plan;
    if (!plan) return;
    const desired = new Set(plan.credentialBindingIds);
    for (const credentialBindingId of desired) {
      if (
        !this.channels.has(credentialBindingId)
        && !this.reconnectTimers.has(credentialBindingId)
        && !this.pendingConnections.has(credentialBindingId)
      ) {
        this.pendingConnections.add(credentialBindingId);
      }
    }
    const now = Date.now();
    for (const channel of [...this.channels.values()]) {
      if (channel.finalized || !desired.has(channel.credentialBindingId)) continue;
      if (now - channel.lastPlatformActivityAt < PROVIDER_CREDENTIAL_DATA_CHANNEL_LIVENESS_TIMEOUT_MS) {
        if (channel.socket.readyState === WebSocket.OPEN) {
          try {
            // Drive an independent liveness probe so this watchdog does not
            // depend on Platform's separately configured ping cadence.
            channel.socket.ping();
          }
          catch {
            // The timeout path below owns cleanup if no activity follows.
          }
        }
        continue;
      }
      try {
        channel.socket.terminate();
      }
      catch {
        // finalize below owns local cleanup and reconnect scheduling
      }
      this.livenessTimeouts += 1;
      this.lastLivenessTimeoutAt = new Date(now).toISOString();
      channel.finalize('credential_data_channel_liveness_timeout');
    }
    this.pumpConnections();
  }

  private releaseHandshakeSlot(channel: ProviderCredentialDataChannel): void {
    if (!channel.handshakeSlotHeld) return;
    channel.handshakeSlotHeld = false;
    this.activeHandshakes = Math.max(0, this.activeHandshakes - 1);
    this.pumpConnections();
  }

  private requestPlanResync(epochId?: string): void {
    const request: ProviderCredentialDataChannelsResyncRequested = {
      type: 'provider.credential_data_channels_resync_requested',
      nodeId: this.getConfig().nodeId,
      epochId,
    };
    this.sendControl(request);
  }

  private nonRetryableCloseReason(reason: string): boolean {
    return reason === 'invalid_provider_secret'
      || reason === 'provider_credential_channel_token_invalid'
      || reason === 'provider_credential_channel_not_authorized'
      || reason === 'provider_credential_channel_headers_incomplete'
      || reason === 'provider_credential_channel_ready_stale'
      || reason === 'provider_control_channel_closed'
      || reason === 'credential_data_channel_removed'
      || reason === 'credential_data_channels_disabled';
  }
}

export class ProviderBridge {
  private socket: WebSocket | null = null;
  private controlScheduler: WebSocketSendScheduler | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly pendingMirrorUpdates = new Map<
    string,
    {
      credentialBindingId: string;
      timer: NodeJS.Timeout;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  private reconnectAttempt = 0;
  private selectedOfficialExitDataProtocol: OfficialExitDataProtocol = 'json_base64_v1';
  private selectedOfficialExitEarlyDataProtocol?: OfficialExitEarlyDataProtocol;
  private selectedOfficialExitBulkTransfer?: SelectedOfficialExitBulkTransfer;
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
    (message, sendOptions) => this.send(message, sendOptions),
    undefined,
    {
      backpressureTimeoutMs: PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS,
      setPlatformInputBackpressure: (sessionId, blocked) => {
        if (blocked) this.platformInputBlockedSessions.add(sessionId);
        else this.platformInputBlockedSessions.delete(sessionId);
        if (this.platformInputBlockedSessions.size > 0) this.socket?.pause();
        else this.socket?.resume();
      },
    },
  );
  private readonly credentialDataChannels = new ProviderCredentialDataChannelPool(
    () => this.getConfig(),
    () => this.useFallback,
    (message) => this.send(message),
  );
  readonly state: BridgeState = {
    connected: false,
    inFlight: 0,
  };

  constructor(
    private getConfig: () => ProviderNodeConfig,
    private readonly options: ProviderBridgeOptions = {},
  ) {}

  setJimengHandlers(handlers: { authorization?: JimengAuthorizationHandler; video?: JimengVideoHandler }) {
    if (this.options.jimengAuthorization !== handlers.authorization) this.options.jimengAuthorization?.cancelAll();
    if (this.options.jimengVideo !== handlers.video) this.options.jimengVideo?.cancelAll();
    this.options.jimengAuthorization = handlers.authorization;
    this.options.jimengVideo = handlers.video;
    // A second hello is supported by Platform and immediately refreshes the
    // node's control capabilities without reconnecting or interrupting traffic.
    if (this.socket?.readyState === WebSocket.OPEN) this.sendHello();
  }

  start() {
    this.stopped = false;
    this.acceptingSessions = true;
    this.officialExitTunnels.setAcceptingSessions(true);
    this.credentialDataChannels.setAcceptingSessions(true);
    this.state.reconnectSuppressedReason = undefined;
    this.useFallback = Boolean(this.getConfig().preferFallbackEndpoint);
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.acceptingSessions = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.keepaliveTimer = null;
    this.officialExitTunnels.closeAll();
    this.credentialDataChannels.stop('provider_node_stopped');
    this.controlScheduler?.close();
    this.controlScheduler = null;
    this.platformInputBlockedSessions.clear();
    this.finishPendingDrainAck();
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_stopped'));
    this.options.jimengAuthorization?.cancelAll();
    this.options.jimengVideo?.cancelAll();
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
    this.credentialDataChannels.stop('provider_bridge_reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.rejectPendingMirrorUpdates(new Error('provider_bridge_reconnecting'));
    this.controlScheduler?.close();
    this.controlScheduler = null;
    this.socket?.close();
    this.connect();
  }

  beginDrain(): Promise<void> {
    if (this.pendingDrainAck) return this.pendingDrainAck.promise;
    this.acceptingSessions = false;
    this.officialExitTunnels.setAcceptingSessions(false);
    this.credentialDataChannels.setAcceptingSessions(false);
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
    return this.officialExitTunnels.activeSessionCount() + this.credentialDataChannels.activeSessionCount();
  }

  credentialDataChannelState(): ProviderCredentialDataChannelPoolState {
    return this.credentialDataChannels.stateSnapshot();
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
      this.send(message, {
        lane: 'control',
        onComplete: (error) => {
          if (!error) return;
          const pending = this.pendingMirrorUpdates.get(requestId);
          if (!pending) return;
          this.pendingMirrorUpdates.delete(requestId);
          clearTimeout(pending.timer);
          pending.reject(error);
        },
      });
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
    this.controlScheduler?.close();
    this.controlScheduler = this.createScheduler(socket, PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES);
    let opened = false;
    let platformPingObserved = false;
    const scheduleKeepalivePing = (delayMs: number, retryDelayMs: number) => {
      if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = setTimeout(() => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
        socket.ping();
        scheduleKeepalivePing(retryDelayMs, retryDelayMs);
      }, delayMs);
      this.keepaliveTimer.unref?.();
    };
    const markPlatformActivity = () => {
      if (this.socket === socket && platformPingObserved) {
        scheduleKeepalivePing(PLATFORM_ACTIVITY_FALLBACK_AFTER_MS, KEEPALIVE_PING_INTERVAL_MS);
      }
    };

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
      scheduleKeepalivePing(KEEPALIVE_PING_INTERVAL_MS, KEEPALIVE_PING_INTERVAL_MS);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs(config));
    });

    socket.on('ping', () => {
      platformPingObserved = true;
      markPlatformActivity();
    });
    socket.on('pong', markPlatformActivity);
    socket.on('message', (raw, isBinary) => {
      markPlatformActivity();
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
    this.credentialDataChannels.stop('platform_connection_closed');
    this.controlScheduler?.close();
    this.controlScheduler = null;
    this.finishPendingDrainAck();
    this.rejectPendingMirrorUpdates(new Error(`provider_bridge_${reason}`));
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
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
        officialExitEarlyDataProtocols: ['buffered_v1'],
        officialExitBulkTransfer: {
          minInitialWindowBytes: OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES,
          maxInitialWindowBytes: OFFICIAL_EXIT_BULK_MAX_INITIAL_WINDOW_BYTES,
          maxConnectionQueueBytes: PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES,
        },
        flowControl: ['credit_v1'],
        maxBinaryFrameBytes: OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES,
        ...(config.officialExit?.enabled
          ? {
              credentialDataChannels: {
                protocolVersions: [1] as [1],
                maxConcurrentHandshakes: PROVIDER_CREDENTIAL_DATA_CHANNEL_MAX_CONCURRENT_HANDSHAKES,
              },
            }
          : {}),
      },
      controlCapabilities:
        this.options.jimengCliInstall || this.options.jimengAuthorization || this.options.jimengVideo
          ? {
              ...(this.options.jimengCliInstall
                ? { jimengCliInstall: { protocolVersions: [JIMENG_CLI_INSTALL_PROTOCOL_VERSION] } }
                : {}),
              ...(this.options.jimengAuthorization
                ? { jimengAuth: this.options.jimengAuthorization.capability() }
                : {}),
              ...(this.options.jimengVideo
                ? {
                    jimengVideo: this.options.jimengVideo.capability(),
                    ...(this.options.jimengVideo.usageCapability
                      ? { jimengUsage: this.options.jimengVideo.usageCapability() }
                      : {}),
                  }
                : {}),
            }
          : undefined,
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
    const message = JSON.parse(raw) as
      | OfficialExitOpenRequest
      | OfficialExitDataFrame
      | OfficialExitClose
      | PlatformCredentialMirrorUpdateAck
      | PlatformCredentialRefreshHint
      | { type: string };
    if (message.type === 'platform.ready') {
      const ready = message as PlatformProviderReady;
      const selected = selectedOfficialExitDataProtocol(ready);
      this.selectedOfficialExitDataProtocol = selected;
      this.officialExitTunnels.setNegotiatedDataProtocol(selected);
      this.selectedOfficialExitEarlyDataProtocol = selectedOfficialExitEarlyDataProtocol(ready, selected);
      this.officialExitTunnels.setNegotiatedEarlyDataProtocol(this.selectedOfficialExitEarlyDataProtocol);
      const bulkTransfer = selectedOfficialExitBulkTransfer(ready, selected);
      this.selectedOfficialExitBulkTransfer = bulkTransfer;
      this.officialExitTunnels.setNegotiatedBulkTransfer(bulkTransfer);
      const controlQueueBudgetBytes = bulkTransfer?.connectionQueueBudgetBytes
        ?? PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES;
      this.controlScheduler?.setQueueLimits({
        maxQueuedBytes: controlQueueBudgetBytes,
        highWaterBytes: Math.min(PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES, controlQueueBudgetBytes),
      });
      if (ready.credentialDataChannels) {
        const applied = this.credentialDataChannels.configure(
          ready.credentialDataChannels,
          selected,
          this.selectedOfficialExitEarlyDataProtocol,
          bulkTransfer,
          this.acceptingSessions,
        );
        if (applied) this.acknowledgeCredentialDataChannelPlan(ready.credentialDataChannels);
      }
      else {
        this.credentialDataChannels.stop('credential_data_channels_disabled');
      }
      this.options.onPlatformReady?.();
      return;
    }
    if (message.type === 'platform.credential_data_channels_updated') {
      const update = message as PlatformCredentialDataChannelsUpdated;
      if (update.nodeId !== this.getConfig().nodeId) return;
      const applied = this.credentialDataChannels.configure(
        update.plan,
        this.selectedOfficialExitDataProtocol,
        this.selectedOfficialExitEarlyDataProtocol,
        this.selectedOfficialExitBulkTransfer,
        this.acceptingSessions,
      );
      if (applied) this.acknowledgeCredentialDataChannelPlan(update.plan);
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
    if (message.type === 'platform.jimeng_auth_start') {
      const start = message as PlatformJimengAuthStart;
      if (!this.options.jimengAuthorization) {
        this.send({
          type: 'provider.jimeng_auth_failed',
          protocolVersion: start.protocolVersion,
          requestId: start.requestId,
          flowId: start.flowId,
          nodeId: this.getConfig().nodeId,
          stage: 'launch',
          errorCode: 'jimeng_cli_unavailable',
          retryable: false,
        });
        return;
      }
      this.options.jimengAuthorization.start(start, (event) => this.send(event));
      return;
    }
    if (message.type === 'platform.jimeng_auth_cancel') {
      this.options.jimengAuthorization?.cancel(message as PlatformJimengAuthCancel);
      return;
    }
    if (message.type === 'platform.jimeng_cli_install') {
      const install = message as PlatformJimengCliInstall;
      const config = this.getConfig();
      if (
        install.protocolVersion !== JIMENG_CLI_INSTALL_PROTOCOL_VERSION ||
        install.nodeId !== config.nodeId ||
        install.providerId !== config.providerId ||
        !this.options.jimengCliInstall
      ) {
        this.send({
          type: 'provider.jimeng_cli_install_failed',
          protocolVersion: JIMENG_CLI_INSTALL_PROTOCOL_VERSION,
          requestId: install.requestId,
          nodeId: config.nodeId,
          errorCode: this.options.jimengCliInstall
            ? 'jimeng_cli_install_request_invalid'
            : 'jimeng_cli_install_unsupported',
          retryable: false,
        });
        return;
      }
      try {
        const result = await this.options.jimengCliInstall.install();
        this.send({
          type: 'provider.jimeng_cli_install_completed',
          protocolVersion: JIMENG_CLI_INSTALL_PROTOCOL_VERSION,
          requestId: install.requestId,
          nodeId: config.nodeId,
          cliVersion: result.cliVersion,
        });
      } catch (error) {
        const failure = jimengCliInstallFailure(error);
        this.send({
          type: 'provider.jimeng_cli_install_failed',
          protocolVersion: JIMENG_CLI_INSTALL_PROTOCOL_VERSION,
          requestId: install.requestId,
          nodeId: config.nodeId,
          errorCode: failure.errorCode,
          retryable: failure.retryable,
        });
      }
      return;
    }
    if (message.type === 'platform.jimeng_usage_refresh') {
      const refresh = message as PlatformJimengUsageRefresh;
      if (!this.options.jimengVideo) {
        this.send({
          type: 'provider.jimeng_usage_failed',
          protocolVersion: refresh.protocolVersion,
          requestId: refresh.requestId,
          nodeId: this.getConfig().nodeId,
          credentialBindingId: refresh.credentialBindingId,
          errorCode: 'jimeng_usage_not_supported',
          retryable: false,
        });
        return;
      }
      this.options.jimengVideo.refreshUsage(refresh, (event) => this.send(event));
      return;
    }
    if (message.type === 'platform.jimeng_usage_cancel') {
      this.options.jimengVideo?.cancelUsage(message as PlatformJimengUsageCancel);
      return;
    }
    if (message.type === 'platform.jimeng_video_execute') {
      const execute = message as PlatformJimengVideoExecute;
      if (!this.options.jimengVideo) {
        this.send({
          type: 'provider.jimeng_video_failed',
          protocolVersion: execute.protocolVersion,
          requestId: execute.requestId,
          videoJobId: execute.videoJobId,
          nodeId: this.getConfig().nodeId,
          operation: execute.operation?.type === 'query' ? 'query' : 'submit',
          stage: 'validation',
          errorCode: 'jimeng_video_not_supported',
          retryable: false,
          submissionUnknown: false,
        });
        return;
      }
      this.options.jimengVideo.execute(execute, (event) => this.send(event));
      return;
    }
    if (message.type === 'platform.jimeng_video_cancel') {
      this.options.jimengVideo?.cancel(message as PlatformJimengVideoCancel);
      return;
    }
    if (message.type === 'platform.upgrade_available') {
      await this.options.onPlatformUpgradeAvailable?.(message as PlatformUpgradeAvailable);
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

  private acknowledgeCredentialDataChannelPlan(plan: PlatformCredentialDataChannelPlan): void {
    const applied: ProviderCredentialDataChannelsApplied = {
      type: 'provider.credential_data_channels_applied',
      nodeId: this.getConfig().nodeId,
      epochId: plan.epochId,
      revision: plan.revision,
    };
    this.send(applied);
  }

  reportUpgradeStatus(status: ProviderUpgradeStatus): Promise<void> {
    return new Promise((resolve, reject) => {
      this.send(status, {
        lane: 'control',
        onComplete: (error) => error ? reject(error) : resolve(),
      });
    });
  }

  private send(
    message: unknown,
    options: ProviderOfficialExitSendOptions = { lane: 'control' },
  ): ProviderOfficialExitSendResult {
    const socket = this.socket;
    const scheduler = this.controlScheduler;
    if (!socket || !scheduler || socket.readyState !== WebSocket.OPEN) {
      const error = new Error('provider_websocket_disconnected');
      options.onComplete?.(error);
      return { accepted: false, error };
    }
    const encoded = Buffer.isBuffer(message) ? message : JSON.stringify(message);
    const result = scheduler.enqueue(encoded, {
      lane: options.lane,
      sessionId: options.sessionId,
      callback: (error) => {
        if (error) this.state.lastError = error.message;
        options.onComplete?.(error);
      },
    });
    return result;
  }

  private createScheduler(socket: WebSocket, maxQueuedBytes: number): WebSocketSendScheduler {
    return new WebSocketSendScheduler(socket, {
      highWaterBytes: PROVIDER_WS_BACKPRESSURE_HIGH_WATER_BYTES,
      maxQueuedBytes,
      sendTimeoutMs: PROVIDER_OFFICIAL_EXIT_BACKPRESSURE_TIMEOUT_MS,
    });
  }

  private heartbeatIntervalMs(config: ProviderNodeConfig): number {
    return config.officialExit?.enabled ? HEARTBEAT_FLOOR_INTERVAL_MS : HEARTBEAT_INTERVAL_MS;
  }

  private nextReconnectDelayMs(): number {
    const exponentialDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    const jitter = exponentialDelay * RECONNECT_JITTER_RATIO * Math.random();
    return Math.round(exponentialDelay + jitter);
  }

  private capabilitiesWithLocalCapacity(config: ProviderNodeConfig) {
    if (config.officialExit?.enabled) {
      return [
        {
          routeMode: 'official_exit' as const,
          officialExit: {
            routeMode: 'official_exit' as const,
            dataProtocols: ['json_base64_v1' as const, 'binary_v1' as const],
          },
        },
      ];
    }
    return [
      {
        ...config.capability,
        routeMode: config.capability.routeMode,
      },
    ];
  }

  private officialExitHealth(config: ProviderNodeConfig): OfficialExitHealth | undefined {
    if (!config.officialExit?.enabled) return undefined;
    const healthy = !this.state.lastError;
    return {
      status: healthy ? 'healthy' : 'degraded',
      activeSessions: this.inFlightCount(),
      recentConnectErrorRate: 0,
      recentTimeoutRate: 0,
      lastCheckAt: new Date().toISOString(),
      reasonCodes: healthy ? [] : [this.state.lastError || 'official_exit_unhealthy'],
    };
  }
}

function jimengCliInstallFailure(error: unknown): { errorCode: string; retryable: boolean } {
  const candidate =
    error && typeof error === 'object'
      ? (error as { errorCode?: unknown; code?: unknown; message?: unknown; retryable?: unknown })
      : undefined;
  const rawCode = candidate?.errorCode ?? candidate?.code ?? candidate?.message;
  const errorCode =
    typeof rawCode === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(rawCode) ? rawCode : 'jimeng_cli_install_failed';
  return { errorCode, retryable: candidate?.retryable === true };
}

function isOfficialExitPlatformMessage(message: {
  type: string;
}): message is OfficialExitOpenRequest | OfficialExitDataFrame | OfficialExitClose {
  return (
    message.type === 'official_exit.open' ||
    message.type === 'official_exit.data' ||
    message.type === 'official_exit.close'
  );
}

function selectedOfficialExitDataProtocol(ready: PlatformProviderReady): OfficialExitDataProtocol {
  const transport = ready.transport;
  if (
    transport?.officialExitDataProtocol === 'binary_v1' &&
    transport.flowControl === 'credit_v1' &&
    (transport.maxBinaryFrameBytes ?? 0) >= OFFICIAL_EXIT_BINARY_MAX_PAYLOAD_BYTES
  ) {
    return 'binary_v1';
  }
  return 'json_base64_v1';
}

function selectedOfficialExitEarlyDataProtocol(
  ready: PlatformProviderReady,
  dataProtocol: OfficialExitDataProtocol,
): OfficialExitEarlyDataProtocol | undefined {
  return dataProtocol === 'binary_v1' && ready.transport?.officialExitEarlyDataProtocol === 'buffered_v1'
    ? 'buffered_v1'
    : undefined;
}

export interface SelectedOfficialExitBulkTransfer extends PlatformBulkTransferSelection {
  connectionQueueBudgetBytes: number;
}

export function selectedOfficialExitBulkTransfer(
  ready: PlatformProviderReady,
  dataProtocol: OfficialExitDataProtocol,
): SelectedOfficialExitBulkTransfer | undefined {
  const bulkTransfer = ready.transport?.bulkTransfer;
  if (
    dataProtocol !== 'binary_v1' ||
    !bulkTransfer ||
    !Number.isSafeInteger(bulkTransfer.initialWindowBytes) ||
    bulkTransfer.initialWindowBytes < OFFICIAL_EXIT_BULK_MIN_INITIAL_WINDOW_BYTES ||
    bulkTransfer.initialWindowBytes > OFFICIAL_EXIT_BULK_MAX_INITIAL_WINDOW_BYTES ||
    !Number.isSafeInteger(bulkTransfer.connectionQueueBudgetBytes) ||
    bulkTransfer.connectionQueueBudgetBytes < bulkTransfer.initialWindowBytes ||
    bulkTransfer.connectionQueueBudgetBytes > PROVIDER_WS_SEND_QUEUE_BUDGET_BYTES
  ) {
    return undefined;
  }
  return {
    bulkInitialWindowBytes: bulkTransfer.initialWindowBytes,
    connectionQueueBudgetBytes: bulkTransfer.connectionQueueBudgetBytes,
  };
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
