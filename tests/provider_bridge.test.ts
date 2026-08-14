import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderBridgeWebSocketConnection,
  normalizeProviderBridgeCloseReason,
  selectedOfficialExitBulkTransfer,
  shouldReportProviderCredentialDataChannelMetrics,
  shouldSuppressProviderBridgeReconnect,
} from '../src/provider-node/bridge.js';

// Minimal controllable WebSocket so the failover state machine can be driven
// (the real `ws` would open real sockets). buildProviderBridgeWebSocketConnection
// tests above don't instantiate it, so mocking the module is safe for them.
const { FakeWebSocket, fakeSockets } = vi.hoisted(() => {
  const sockets: Array<{
    url: string;
    options?: { headers?: Record<string, string> };
    readyState: number;
    pingCount: number;
    terminateCount: number;
    sent: Array<string | Buffer>;
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    pingCount = 0;
    terminateCount = 0;
    url: string;
    options?: { headers?: Record<string, string> };
    sent: Array<string | Buffer> = [];
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      this.url = url;
      this.options = options;
      sockets.push(this as never);
    }
    on(event: string, fn: (...a: unknown[]) => void) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(fn);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers[event] || []) fn(...args);
    }
    close() {}
    terminate() {
      this.terminateCount += 1;
      this.readyState = 3;
    }
    ping() {
      this.pingCount += 1;
    }
    send(data: string | Buffer) {
      this.sent.push(data);
    }
  }
  return { FakeWebSocket, fakeSockets: sockets };
});
vi.mock('ws', () => ({ default: FakeWebSocket }));

describe('ProviderBridge reconnect policy', () => {
  it('reports credential-channel metrics only for abnormal state, counter changes, and recovery', () => {
    const normal = { desired: 3, ready: 3, reconnecting: 0, livenessTimeouts: 0 };
    const reconnecting = { desired: 3, ready: 2, reconnecting: 1, livenessTimeouts: 0 };
    const recovered = { desired: 3, ready: 3, reconnecting: 0, livenessTimeouts: 0 };
    const livenessChanged = { desired: 3, ready: 3, reconnecting: 0, livenessTimeouts: 1 };

    expect(shouldReportProviderCredentialDataChannelMetrics(normal, undefined)).toBe(false);
    expect(shouldReportProviderCredentialDataChannelMetrics(reconnecting, undefined)).toBe(true);
    expect(shouldReportProviderCredentialDataChannelMetrics(recovered, reconnecting)).toBe(true);
    expect(shouldReportProviderCredentialDataChannelMetrics(recovered, normal)).toBe(false);
    expect(shouldReportProviderCredentialDataChannelMetrics(livenessChanged, normal)).toBe(true);
  });

  it('returns only a locally valid negotiated bulk queue budget', () => {
    const ready = (connectionQueueBudgetBytes: number) =>
      ({
        type: 'platform.ready',
        nodeId: 'node_123',
        transport: {
          officialExitDataProtocol: 'binary_v1',
          bulkTransfer: {
            initialWindowBytes: 1024 * 1024,
            connectionQueueBudgetBytes,
          },
        },
      }) as const;

    expect(selectedOfficialExitBulkTransfer(ready(16 * 1024 * 1024), 'binary_v1')).toEqual({
      bulkInitialWindowBytes: 1024 * 1024,
      connectionQueueBudgetBytes: 16 * 1024 * 1024,
    });
    expect(selectedOfficialExitBulkTransfer(ready(16 * 1024 * 1024 + 1), 'binary_v1')).toBeUndefined();
    expect(selectedOfficialExitBulkTransfer(ready(1024), 'binary_v1')).toBeUndefined();
  });

  it('suppresses reconnects for platform-managed close reasons', () => {
    expect(shouldSuppressProviderBridgeReconnect('node_paused')).toBe(true);
    expect(shouldSuppressProviderBridgeReconnect('invalid_provider_secret')).toBe(true);
    expect(shouldSuppressProviderBridgeReconnect('node_revoked')).toBe(true);
    expect(shouldSuppressProviderBridgeReconnect('node_secret_rotated')).toBe(true);
  });

  it('keeps reconnecting for transient transport close reasons', () => {
    expect(shouldSuppressProviderBridgeReconnect('closed')).toBe(false);
    expect(shouldSuppressProviderBridgeReconnect('provider_ping_timeout')).toBe(false);
    expect(shouldSuppressProviderBridgeReconnect('ECONNRESET')).toBe(false);
  });

  it('normalizes websocket close reasons', () => {
    expect(normalizeProviderBridgeCloseReason(Buffer.from('node_paused'))).toBe('node_paused');
    expect(normalizeProviderBridgeCloseReason(Buffer.from('  '))).toBe('closed');
    expect(normalizeProviderBridgeCloseReason(undefined)).toBe('closed');
  });

  it('sends node identity only in headers', () => {
    const connection = buildProviderBridgeWebSocketConnection({
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      nodeId: 'node_123',
      providerNodeSecret: 'secret_123',
    });

    expect(connection.url).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
    expect(connection.options.headers).toEqual({
      'x-provider-node-id': 'node_123',
      'x-provider-node-secret': 'secret_123',
    });
    expect(connection.options.perMessageDeflate).toBe(false);
    expect(connection.options.maxPayload).toBe(1024 * 1024);
  });

  it('adds scoped credential-channel headers without changing the URL', () => {
    const connection = buildProviderBridgeWebSocketConnection(
      {
        platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
        nodeId: 'node_123',
        providerNodeSecret: 'secret_123',
      },
      false,
      {
        credentialBindingId: 'credential_123',
        connectionToken: 'epoch_token',
      },
    );

    expect(connection.url).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
    expect(connection.options.headers).toMatchObject({
      'x-provider-node-id': 'node_123',
      'x-provider-node-secret': 'secret_123',
      'x-provider-data-channel': 'credential_123',
      'x-provider-connection-token': 'epoch_token',
    });
  });

  it('does not add node identity to existing connection query parameters', () => {
    const connection = buildProviderBridgeWebSocketConnection({
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect?region=sg',
      nodeId: 'node with spaces',
      providerNodeSecret: 'secret_123',
    });

    expect(connection.url).toBe('wss://node.wokey.ai:8443/internal/provider/connect?region=sg');
    expect(connection.options.headers).toMatchObject({
      'x-provider-node-id': 'node with spaces',
    });
  });

  it('targets the CDN-proxied fallback host when asked, keeping identity headers', () => {
    const config = {
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      nodeId: 'node_123',
      providerNodeSecret: 'secret_123',
    };
    expect(buildProviderBridgeWebSocketConnection(config, false).url).toBe(
      'wss://node.wokey.ai:8443/internal/provider/connect',
    );
    const fallback = buildProviderBridgeWebSocketConnection(config, true);
    expect(fallback.url).toBe('wss://nodey.wokey.ai:8443/internal/provider/connect');
    expect(fallback.options.headers).toMatchObject({ 'x-provider-node-id': 'node_123' });
  });

  it('bounds the handshake so a blocked endpoint fails fast and flips', () => {
    const connection = buildProviderBridgeWebSocketConnection({
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      nodeId: 'node_123',
      providerNodeSecret: 'secret_123',
    });
    expect(connection.options.handshakeTimeout).toBeGreaterThan(0);
    expect(connection.options.handshakeTimeout).toBeLessThanOrEqual(15_000);
  });

  it('falls back to the primary url when a custom host has no fallback', () => {
    const connection = buildProviderBridgeWebSocketConnection(
      {
        platformWsUrl: 'wss://staging.example.com:9443/internal/provider/connect',
        nodeId: 'node_123',
        providerNodeSecret: 'secret_123',
      },
      true,
    );
    expect(connection.url).toBe('wss://staging.example.com:9443/internal/provider/connect');
  });
});

describe('ProviderBridge endpoint failover', () => {
  beforeEach(() => {
    fakeSockets.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeBridge(preferFallbackEndpoint = false, officialExitEnabled = false) {
    const { defaultConfig } = await import('../src/provider-node/config.js');
    const { ProviderBridge } = await import('../src/provider-node/bridge.js');
    const config = {
      ...defaultConfig(),
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      preferFallbackEndpoint,
      officialExit: { enabled: officialExitEnabled },
    };
    return new ProviderBridge(() => config);
  }

  it('flips to the fallback exactly once when a connect attempt fails (error + close)', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      expect(fakeSockets).toHaveLength(1);
      expect(fakeSockets[0].url).toBe('wss://node.wokey.ai:8443/internal/provider/connect');

      // A single failed connect emits BOTH 'error' and 'close', neither preceded
      // by 'open'. The flip must net to one, not cancel itself.
      fakeSockets[0].emit('error', new Error('ETIMEDOUT'));
      fakeSockets[0].emit('close', 1006, Buffer.from(''));
      await vi.advanceTimersByTimeAsync(40_000);

      expect(fakeSockets).toHaveLength(2);
      expect(fakeSockets[1].url).toBe('wss://nodey.wokey.ai:8443/internal/provider/connect');
    } finally {
      bridge.stop();
    }
  });

  it('keeps the same endpoint after a healthy session drops', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');
      fakeSockets[0].emit('close', 1006, Buffer.from('')); // drop after a healthy session
      await vi.advanceTimersByTimeAsync(40_000);

      expect(fakeSockets).toHaveLength(2);
      expect(fakeSockets[1].url).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
    } finally {
      bridge.stop();
    }
  });

  it('suppresses duplicate pings after observing Platform keepalive and restores the fallback after silence', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      const socket = fakeSockets[0];
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit('open');

      // Preserve compatibility with older Platform versions until this
      // connection proves that Platform is the heartbeat initiator.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.pingCount).toBe(1);

      socket.emit('ping');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.pingCount).toBe(1);

      // Any inbound Platform frame proves the connection is active and pushes
      // the fallback deadline out, even when no business heartbeat is enabled.
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId: 'node_123',
          }),
        ),
        false,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.pingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.pingCount).toBe(2);
    } finally {
      bridge.stop();
    }
  });

  it('keeps a floor heartbeat on official-exit nodes so Platform routing state stays fresh', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const socket = fakeSockets[0];
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit('open');

      const heartbeatMessages = () =>
        socket.sent
          .filter((message): message is string => typeof message === 'string')
          .map((message) => JSON.parse(message) as Record<string, unknown>)
          .filter((message) => message.type === 'provider.heartbeat');
      const heartbeats = () => heartbeatMessages().length;

      // One immediate state report on connect.
      expect(heartbeats()).toBe(1);
      expect(heartbeatMessages()[0]).not.toHaveProperty('credentialDataChannels');

      // Not the chatty 10s cadence official-exit nodes deliberately avoid…
      await vi.advanceTimersByTimeAsync(60_000);
      expect(heartbeats()).toBe(1);

      // …but never silent either: the 85s floor report still goes out.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(heartbeats()).toBe(2);
    } finally {
      bridge.stop();
    }
  });

  it('publishes draining state and waits for the Platform acknowledgement', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');
      const drainPromise = bridge.beginDrain();
      const messages = fakeSockets[0].sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>);
      const heartbeat = messages.find(
        (message) => message.type === 'provider.heartbeat' && message.acceptingSessions === false,
      );
      const notice = messages.find((message) => message.type === 'provider.drain');

      expect(heartbeat).toMatchObject({ acceptingSessions: false });
      expect(notice).toMatchObject({
        nodeId: expect.any(String),
        acceptingSessions: false,
      });

      fakeSockets[0].emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.drain_ack',
            requestId: notice?.requestId,
            nodeId: notice?.nodeId,
          }),
        ),
        false,
      );
      await drainPromise;
    } finally {
      bridge.stop();
    }
  });

  it('sends upgrade status with the rollout identity over the control socket', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      const socket = fakeSockets[0];
      socket.readyState = FakeWebSocket.OPEN;
      socket.emit('open');

      await bridge.reportUpgradeStatus({
        type: 'provider.upgrade_status',
        nodeId: 'node_123',
        rolloutId: 'rollout_123',
        currentVersion: '0.1.75',
        targetVersion: '0.1.76',
        phase: 'received',
        observedAt: '2026-08-09T01:02:03.000Z',
      });

      const messages = socket.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>);
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'provider.upgrade_status',
        rolloutId: 'rollout_123',
        phase: 'received',
      }));
    } finally {
      bridge.stop();
    }
  });

  it('rejects a credential mirror update immediately when scheduler admission fails', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');
      const scheduler = (
        bridge as unknown as {
          controlScheduler: { close(): void };
        }
      ).controlScheduler;
      scheduler.close();

      await expect(
        bridge.sendCredentialMirrorUpdate({
          credentialBindingId: 'credential_123',
          vendor: 'openai',
          accessToken: 'access_token_123',
        }),
      ).rejects.toThrow('provider_websocket_disconnected');
    } finally {
      bridge.stop();
    }
  });

  it('keeps one physical socket when bulk flow control is negotiated', async () => {
    const bridge = await makeBridge(false);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const hello = control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello');
      expect(hello).toMatchObject({
        transportCapabilities: {
          officialExitBulkTransfer: {
            minInitialWindowBytes: 1024 * 1024,
            maxInitialWindowBytes: 4 * 1024 * 1024,
          },
        },
      });
      const maxConnectionQueueBytes = Number(
        (
          hello?.transportCapabilities as {
            officialExitBulkTransfer?: { maxConnectionQueueBytes?: number };
          }
        )?.officialExitBulkTransfer?.maxConnectionQueueBytes,
      );

      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId: 'node_123',
            transport: {
              officialExitDataProtocol: 'binary_v1',
              flowControl: 'credit_v1',
              initialWindowBytes: 256 * 1024,
              maxBinaryFrameBytes: 64 * 1024,
              bulkTransfer: {
                initialWindowBytes: 1024 * 1024,
                connectionQueueBudgetBytes: maxConnectionQueueBytes,
              },
            },
          }),
        ),
        false,
      );
      await Promise.resolve();

      expect(fakeSockets).toHaveLength(1);
      expect(control.options?.headers).not.toHaveProperty('x-provider-data-channel');

      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId: 'node_123',
            transport: {
              officialExitDataProtocol: 'binary_v1',
              bulkTransfer: {
                initialWindowBytes: 1024 * 1024,
                connectionQueueBudgetBytes: maxConnectionQueueBytes + 1,
              },
            },
          }),
        ),
        false,
      );
      await Promise.resolve();
      expect(
        (
          bridge as unknown as {
            controlScheduler: { maxQueuedBytes: number };
          }
        ).controlScheduler.maxQueuedBytes,
      ).toBe(maxConnectionQueueBytes);
    } finally {
      bridge.stop();
    }
  });

  it('opens one independently reconnecting data channel per planned credential', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const hello = control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello');
      expect(hello).toMatchObject({
        transportCapabilities: {
          credentialDataChannels: {
            protocolVersions: [1],
            maxConcurrentHandshakes: 4,
          },
        },
      });
      expect((hello?.transportCapabilities as {
        credentialDataChannels?: Record<string, unknown>;
      })?.credentialDataChannels).not.toHaveProperty('maxChannels');

      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId: 'node_123',
            credentialDataChannels: {
              protocolVersion: 1,
              epochId: 'epoch_1',
              revision: 1,
              connectionToken: 'epoch_token',
              credentialBindingIds: ['credential_a', 'credential_b', 'credential_c'],
            },
          }),
        ),
        false,
      );
      await Promise.resolve();

      expect(fakeSockets).toHaveLength(4);
      expect(fakeSockets.slice(1).map((socket) => socket.options?.headers?.['x-provider-data-channel'])).toEqual([
        'credential_a',
        'credential_b',
        'credential_c',
      ]);
      expect(
        fakeSockets
          .slice(1)
          .every((socket) => socket.options?.headers?.['x-provider-connection-token'] === 'epoch_token'),
      ).toBe(true);
      expect(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>))
        .toContainEqual(expect.objectContaining({
          type: 'provider.credential_data_channels_applied',
          epochId: 'epoch_1',
          revision: 1,
        }));
      const channelQueueBudgets = [...(
        bridge as unknown as {
          credentialDataChannels: {
            channels: Map<string, { scheduler: { maxQueuedBytes: number } }>;
          };
        }
      ).credentialDataChannels.channels.values()]
        .map((channel) => channel.scheduler.maxQueuedBytes);
      expect(channelQueueBudgets).toEqual([
        Math.floor((16 * 1024 * 1024) / 3),
        Math.floor((16 * 1024 * 1024) / 3),
        Math.floor((16 * 1024 * 1024) / 3),
      ]);

      fakeSockets[2].emit('close', 1006, Buffer.alloc(0));
      expect(fakeSockets).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(fakeSockets).toHaveLength(5);
      expect(fakeSockets[4].options?.headers?.['x-provider-data-channel']).toBe('credential_b');
    } finally {
      bridge.stop();
    }
  });

  it('replaces a ready credential channel that stops receiving Platform activity without a close event', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(
        control.sent
          .filter((message): message is string => typeof message === 'string')
          .map((message) => JSON.parse(message) as Record<string, unknown>)
          .find((message) => message.type === 'provider.hello')?.nodeId,
      );
      const credentialBindingIds = ['credential_a', 'credential_b', 'credential_c'];
      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId,
            credentialDataChannels: {
              protocolVersion: 1,
              epochId: 'epoch_liveness',
              revision: 1,
              connectionToken: 'epoch_token_liveness',
              credentialBindingIds,
            },
          }),
        ),
        false,
      );
      await Promise.resolve();

      for (const [index, credentialBindingId] of credentialBindingIds.entries()) {
        const socket = fakeSockets[index + 1];
        socket.readyState = FakeWebSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'platform.credential_data_channel_ready',
              protocolVersion: 1,
              nodeId,
              credentialBindingId,
              epochId: 'epoch_liveness',
              revision: 1,
            }),
          ),
          false,
        );
      }
      await Promise.resolve();
      expect(bridge.credentialDataChannelState()).toMatchObject({ desired: 3, ready: 3 });

      await vi.advanceTimersByTimeAsync(60_000);
      fakeSockets[2].emit('ping');
      fakeSockets[3].emit('ping');
      await vi.advanceTimersByTimeAsync(30_000);

      expect(fakeSockets[1].terminateCount).toBe(1);
      expect(fakeSockets[2].terminateCount).toBe(0);
      expect(fakeSockets[3].terminateCount).toBe(0);
      expect(bridge.credentialDataChannelState()).toMatchObject({
        desired: 3,
        ready: 2,
        reconnecting: 1,
        livenessTimeouts: 1,
      });
      (bridge as unknown as { sendHeartbeat: () => void }).sendHeartbeat();
      const heartbeat = control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .findLast((message) => message.type === 'provider.heartbeat');
      expect(heartbeat?.credentialDataChannels).toEqual({
        desired: 3,
        ready: 2,
        reconnecting: 1,
        livenessTimeouts: 1,
      });

      await vi.advanceTimersByTimeAsync(40_000);
      expect(fakeSockets.at(-1)?.options?.headers?.['x-provider-data-channel']).toBe('credential_a');
    } finally {
      bridge.stop();
    }
  });

  it('keeps a healthy credential channel alive with node-driven ping probes', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(
        control.sent
          .filter((message): message is string => typeof message === 'string')
          .map((message) => JSON.parse(message) as Record<string, unknown>)
          .find((message) => message.type === 'provider.hello')?.nodeId,
      );
      control.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'platform.ready',
          nodeId,
          credentialDataChannels: {
            protocolVersion: 1,
            epochId: 'epoch_node_ping',
            revision: 1,
            connectionToken: 'epoch_token_node_ping',
            credentialBindingIds: ['credential_a'],
          },
        })),
        false,
      );
      await Promise.resolve();

      const channel = fakeSockets[1];
      channel.readyState = FakeWebSocket.OPEN;
      channel.emit('open');
      channel.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'platform.credential_data_channel_ready',
          protocolVersion: 1,
          nodeId,
          credentialBindingId: 'credential_a',
          epochId: 'epoch_node_ping',
          revision: 1,
        })),
        false,
      );

      for (let probe = 0; probe < 3; probe += 1) {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(channel.pingCount).toBe(probe + 1);
        channel.emit('pong');
      }

      expect(channel.terminateCount).toBe(0);
      expect(bridge.credentialDataChannelState()).toMatchObject({ desired: 1, ready: 1, livenessTimeouts: 0 });
    } finally {
      bridge.stop();
    }
  });

  it('recovers four stale channels without leaking or starving the four handshake slots', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(
        control.sent
          .filter((message): message is string => typeof message === 'string')
          .map((message) => JSON.parse(message) as Record<string, unknown>)
          .find((message) => message.type === 'provider.hello')?.nodeId,
      );
      const credentialBindingIds = Array.from({ length: 8 }, (_, index) => `credential_${index}`);
      control.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.ready',
            nodeId,
            credentialDataChannels: {
              protocolVersion: 1,
              epochId: 'epoch_four_stale',
              revision: 1,
              connectionToken: 'epoch_token_four_stale',
              credentialBindingIds,
            },
          }),
        ),
        false,
      );
      await Promise.resolve();

      for (const credentialBindingId of credentialBindingIds) {
        const socket = fakeSockets.find(
          (candidate) => candidate.options?.headers?.['x-provider-data-channel'] === credentialBindingId,
        );
        expect(socket).toBeDefined();
        if (!socket) throw new Error(`missing fake socket for ${credentialBindingId}`);
        socket.readyState = FakeWebSocket.OPEN;
        socket.emit('open');
        socket.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'platform.credential_data_channel_ready',
              protocolVersion: 1,
              nodeId,
              credentialBindingId,
              epochId: 'epoch_four_stale',
              revision: 1,
            }),
          ),
          false,
        );
        await Promise.resolve();
      }
      expect(bridge.credentialDataChannelState()).toMatchObject({ desired: 8, ready: 8 });

      await vi.advanceTimersByTimeAsync(60_000);
      for (const credentialBindingId of credentialBindingIds.slice(4)) {
        const socket = fakeSockets.find(
          (candidate) => candidate.options?.headers?.['x-provider-data-channel'] === credentialBindingId,
        );
        expect(socket).toBeDefined();
        if (!socket) throw new Error(`missing fake socket for ${credentialBindingId}`);
        socket.emit('ping');
      }
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fakeSockets.slice(1, 5).every((socket) => socket.terminateCount === 1)).toBe(true);
      expect(bridge.credentialDataChannelState()).toMatchObject({
        desired: 8,
        ready: 4,
        reconnecting: 4,
        livenessTimeouts: 4,
      });

      await vi.advanceTimersByTimeAsync(3_000);
      expect(bridge.credentialDataChannelState()).toMatchObject({
        desired: 8,
        ready: 4,
        connecting: 4,
        reconnecting: 0,
        pending: 0,
      });
      expect(fakeSockets).toHaveLength(13);
    } finally {
      bridge.stop();
    }
  });

  it('caps concurrent channel handshakes and advances when one credential becomes ready', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello')?.nodeId);
      control.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'platform.ready',
          nodeId,
          credentialDataChannels: {
            protocolVersion: 1,
            epochId: 'epoch_capped',
            revision: 1,
            connectionToken: 'epoch_token_capped',
            credentialBindingIds: [
              'credential_a',
              'credential_b',
              'credential_c',
              'credential_d',
              'credential_e',
            ],
          },
        })),
        false,
      );
      await Promise.resolve();

      expect(fakeSockets).toHaveLength(5);
      const firstDataChannel = fakeSockets[1];
      const credentialChannelState = () => (bridge as unknown as {
        credentialDataChannels: {
          channels: Map<string, { state: string }>;
        };
      }).credentialDataChannels.channels.get('credential_a')?.state;
      firstDataChannel.readyState = FakeWebSocket.OPEN;
      firstDataChannel.emit('open');
      expect(credentialChannelState()).toBe('awaiting_ready');
      firstDataChannel.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'platform.credential_data_channel_ready',
          protocolVersion: 1,
          nodeId,
          credentialBindingId: 'credential_a',
          epochId: 'epoch_capped',
          revision: 1,
        })),
        false,
      );
      await Promise.resolve();
      expect(credentialChannelState()).toBe('ready');

      expect(firstDataChannel.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>))
        .toContainEqual(expect.objectContaining({
          type: 'provider.credential_data_channel_ready',
          credentialBindingId: 'credential_a',
        }));
      expect(fakeSockets).toHaveLength(6);
      expect(fakeSockets[5].options?.headers?.['x-provider-data-channel']).toBe('credential_e');
    }
    finally {
      bridge.stop();
    }
  });

  it('accepts Platform channel policies without applying a local total-count cap', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello')?.nodeId);
      const credentialBindingIds = Array.from(
        { length: 32 },
        (_, index) => `credential_${String(index + 1).padStart(2, '0')}`,
      );

      control.emit('message', Buffer.from(JSON.stringify({
        type: 'platform.ready',
        nodeId,
        credentialDataChannels: {
          protocolVersion: 1,
          epochId: 'epoch_32',
          revision: 1,
          connectionToken: 'epoch_token_32',
          credentialBindingIds,
        },
      })), false);
      await Promise.resolve();

      // The four-at-a-time handshake guard remains independent of Platform policy.
      expect(fakeSockets).toHaveLength(5);
      expect(fakeSockets.slice(1).map((socket) => socket.options?.headers?.['x-provider-data-channel']))
        .toEqual(credentialBindingIds.slice(0, 4));

      control.emit('message', Buffer.from(JSON.stringify({
        type: 'platform.credential_data_channels_updated',
        nodeId,
        plan: {
          protocolVersion: 1,
          epochId: 'epoch_32',
          revision: 2,
          connectionToken: 'epoch_token_32',
          credentialBindingIds: Array.from({ length: 65 }, (_, index) => `credential_over_${index}`),
        },
      })), false);
      await Promise.resolve();

      expect(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>))
        .toContainEqual(expect.objectContaining({
          type: 'provider.credential_data_channels_applied',
          epochId: 'epoch_32',
          revision: 2,
        }));
      expect(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>))
        .not.toContainEqual(expect.objectContaining({
          type: 'provider.credential_data_channels_resync_requested',
        }));
    }
    finally {
      bridge.stop();
    }
  });

  it('keeps an unchanged credential handshake valid across a newer plan revision', async () => {
    const bridge = await makeBridge(false, true);
    try {
      bridge.start();
      const control = fakeSockets[0];
      control.readyState = FakeWebSocket.OPEN;
      control.emit('open');
      const nodeId = String(control.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello')?.nodeId);
      const initialPlan = {
        protocolVersion: 1,
        epochId: 'epoch_revision_race',
        revision: 1,
        connectionToken: 'epoch_token_revision_race',
        credentialBindingIds: ['credential_a', 'credential_b', 'credential_c'],
      };
      control.emit('message', Buffer.from(JSON.stringify({
        type: 'platform.ready',
        nodeId,
        credentialDataChannels: initialPlan,
      })), false);
      await Promise.resolve();

      const firstDataChannel = fakeSockets[1];
      firstDataChannel.readyState = FakeWebSocket.OPEN;
      firstDataChannel.emit('open');
      control.emit('message', Buffer.from(JSON.stringify({
        type: 'platform.credential_data_channels_updated',
        nodeId,
        plan: {
          ...initialPlan,
          revision: 2,
          credentialBindingIds: [
            'credential_a',
            'credential_b',
            'credential_c',
            'credential_d',
          ],
        },
      })), false);
      await Promise.resolve();

      firstDataChannel.emit('message', Buffer.from(JSON.stringify({
        type: 'platform.credential_data_channel_ready',
        protocolVersion: 1,
        nodeId,
        credentialBindingId: 'credential_a',
        epochId: initialPlan.epochId,
        revision: initialPlan.revision,
      })), false);
      await Promise.resolve();

      expect((bridge as unknown as {
        credentialDataChannels: {
          channels: Map<string, { state: string }>;
        };
      }).credentialDataChannels.channels.get('credential_a')?.state).toBe('ready');
      expect(firstDataChannel.sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>))
        .toContainEqual(expect.objectContaining({
          type: 'provider.credential_data_channel_ready',
          credentialBindingId: 'credential_a',
          revision: 1,
        }));
    }
    finally {
      bridge.stop();
    }
  });

  it('advertises and routes Jimeng video control messages through the authenticated socket', async () => {
    const { defaultConfig } = await import('../src/provider-node/config.js');
    const { ProviderBridge } = await import('../src/provider-node/bridge.js');
    const config = defaultConfig();
    const execute = vi.fn();
    const cancel = vi.fn();
    const refreshUsage = vi.fn();
    const cancelUsage = vi.fn();
    const cancelAll = vi.fn();
    const jimengVideo = {
      capability: () => ({
        protocolVersions: [1],
        cliVersion: '1.4.14',
        generationModes: ['text_to_video'],
        upstreamModelVersions: ['seedance2.0mini'],
        resolutions: ['720p'],
      }),
      usageCapability: () => ({ protocolVersions: [1], cliVersion: '1.4.14' }),
      execute,
      cancel,
      refreshUsage,
      cancelUsage,
      cancelAll,
    };
    const bridge = new ProviderBridge(() => config, { jimengVideo: jimengVideo as never });
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');
      const hello = fakeSockets[0].sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello');
      expect(hello).toMatchObject({
        controlCapabilities: {
          jimengVideo: {
            protocolVersions: [1],
            cliVersion: '1.4.14',
            generationModes: ['text_to_video'],
            upstreamModelVersions: ['seedance2.0mini'],
          },
          jimengUsage: {
            protocolVersions: [1],
            cliVersion: '1.4.14',
          },
        },
      });

      const command = {
        type: 'platform.jimeng_video_execute',
        protocolVersion: 1,
        requestId: 'request-1',
        videoJobId: 'video-job-1',
        providerId: config.providerId,
        nodeId: config.nodeId,
        deadlineMs: 10_000,
        encodedCredentialBundle: '{}',
        operation: {
          type: 'submit',
          mode: 'text_to_video',
          modelVersion: 'seedance2.0mini',
          prompt: 'a cat',
          durationSeconds: 5,
          ratio: '16:9',
          resolution: '720p',
        },
      };
      fakeSockets[0].emit('message', Buffer.from(JSON.stringify(command)), false);
      expect(execute).toHaveBeenCalledWith(command, expect.any(Function));

      const cancellation = {
        type: 'platform.jimeng_video_cancel',
        protocolVersion: 1,
        requestId: 'request-1',
        videoJobId: 'video-job-1',
        nodeId: config.nodeId,
      };
      fakeSockets[0].emit('message', Buffer.from(JSON.stringify(cancellation)), false);
      expect(cancel).toHaveBeenCalledWith(cancellation);

      const usageRefresh = {
        type: 'platform.jimeng_usage_refresh',
        protocolVersion: 1,
        requestId: 'usage-request-1',
        providerId: config.providerId,
        nodeId: config.nodeId,
        credentialBindingId: 'credential-1',
        deadlineMs: 10_000,
        encodedCredentialBundle: '{}',
      };
      fakeSockets[0].emit('message', Buffer.from(JSON.stringify(usageRefresh)), false);
      expect(refreshUsage).toHaveBeenCalledWith(usageRefresh, expect.any(Function));

      const usageCancel = {
        type: 'platform.jimeng_usage_cancel',
        protocolVersion: 1,
        requestId: 'usage-request-1',
        nodeId: config.nodeId,
        credentialBindingId: 'credential-1',
      };
      fakeSockets[0].emit('message', Buffer.from(JSON.stringify(usageCancel)), false);
      expect(cancelUsage).toHaveBeenCalledWith(usageCancel);
    } finally {
      bridge.stop();
      expect(cancelAll).toHaveBeenCalled();
    }
  });

  it('publishes newly installed Jimeng capabilities without reconnecting', async () => {
    const { defaultConfig } = await import('../src/provider-node/config.js');
    const { ProviderBridge } = await import('../src/provider-node/bridge.js');
    const bridge = new ProviderBridge(() => defaultConfig());
    const jimengAuthorization = {
      capability: () => ({ protocolVersions: [1], cliVersion: '1.4.15' }),
      start: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(),
    };
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');

      bridge.setJimengHandlers({ authorization: jimengAuthorization as never });

      expect(fakeSockets).toHaveLength(1);
      const hellos = fakeSockets[0].sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .filter((message) => message.type === 'provider.hello');
      expect(hellos).toHaveLength(2);
      expect(hellos[1]).toMatchObject({
        controlCapabilities: {
          jimengAuth: { protocolVersions: [1], cliVersion: '1.4.15' },
        },
      });
    } finally {
      bridge.stop();
    }
  });

  it('advertises remote Jimeng CLI installation and returns the correlated result', async () => {
    const { defaultConfig } = await import('../src/provider-node/config.js');
    const { ProviderBridge } = await import('../src/provider-node/bridge.js');
    const config = defaultConfig();
    const install = vi.fn(async () => ({ cliVersion: 'a857341-dirty' }));
    const bridge = new ProviderBridge(() => config, { jimengCliInstall: { install } });
    try {
      bridge.start();
      fakeSockets[0].readyState = FakeWebSocket.OPEN;
      fakeSockets[0].emit('open');
      const initialHello = fakeSockets[0].sent
        .filter((message): message is string => typeof message === 'string')
        .map((message) => JSON.parse(message) as Record<string, unknown>)
        .find((message) => message.type === 'provider.hello');
      expect(initialHello).toMatchObject({
        controlCapabilities: { jimengCliInstall: { protocolVersions: [1] } },
      });

      fakeSockets[0].emit(
        'message',
        Buffer.from(
          JSON.stringify({
            type: 'platform.jimeng_cli_install',
            protocolVersion: 1,
            requestId: 'install-1',
            providerId: config.providerId,
            nodeId: config.nodeId,
          }),
        ),
        false,
      );

      await vi.waitFor(() => {
        const result = fakeSockets[0].sent
          .filter((message): message is string => typeof message === 'string')
          .map((message) => JSON.parse(message) as Record<string, unknown>)
          .find((message) => message.type === 'provider.jimeng_cli_install_completed');
        expect(result).toMatchObject({
          requestId: 'install-1',
          nodeId: config.nodeId,
          cliVersion: 'a857341-dirty',
        });
      });
      expect(install).toHaveBeenCalledTimes(1);
    } finally {
      bridge.stop();
    }
  });
});
