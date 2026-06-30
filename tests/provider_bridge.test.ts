import { describe, expect, it } from 'vitest';
import {
  buildProviderBridgeWebSocketConnection,
  normalizeProviderBridgeCloseReason,
  shouldSuppressProviderBridgeReconnect,
} from '../src/provider-node/bridge.js';

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
