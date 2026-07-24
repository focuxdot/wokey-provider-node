import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildProviderBridgeWebSocketConnection,
  normalizeProviderBridgeCloseReason,
  shouldSuppressProviderBridgeReconnect,
} from '../src/provider-node/bridge.js';

// Minimal controllable WebSocket so the failover state machine can be driven
// (the real `ws` would open real sockets). buildProviderBridgeWebSocketConnection
// tests above don't instantiate it, so mocking the module is safe for them.
const { FakeWebSocket, fakeSockets } = vi.hoisted(() => {
  const sockets: Array<{
    url: string;
    readyState: number;
    sent: Array<string | Buffer>;
    emit: (event: string, ...args: unknown[]) => void;
  }> = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    url: string;
    sent: Array<string | Buffer> = [];
    private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(url: string) {
      this.url = url;
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
    ping() {}
    send(data: string | Buffer) {
      this.sent.push(data);
    }
  }
  return { FakeWebSocket, fakeSockets: sockets };
});
vi.mock('ws', () => ({ default: FakeWebSocket }));

describe('ProviderBridge reconnect policy', () => {
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

  async function makeBridge(preferFallbackEndpoint = false) {
    const { defaultConfig } = await import('../src/provider-node/config.js');
    const { ProviderBridge } = await import('../src/provider-node/bridge.js');
    const config = {
      ...defaultConfig(),
      platformWsUrl: 'wss://node.wokey.ai:8443/internal/provider/connect',
      preferFallbackEndpoint,
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
      const heartbeat = messages.find((message) => (
        message.type === 'provider.heartbeat'
        && message.acceptingSessions === false
      ));
      const notice = messages.find((message) => message.type === 'provider.drain');

      expect(heartbeat).toMatchObject({ acceptingSessions: false });
      expect(notice).toMatchObject({
        nodeId: expect.any(String),
        acceptingSessions: false,
      });

      fakeSockets[0].emit('message', Buffer.from(JSON.stringify({
        type: 'platform.drain_ack',
        requestId: notice?.requestId,
        nodeId: notice?.nodeId,
      })), false);
      await drainPromise;
    } finally {
      bridge.stop();
    }
  });
});
