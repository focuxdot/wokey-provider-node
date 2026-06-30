import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProviderNodeBuildInfo } from '../src/provider-node/build-info.js';
import { defaultConfig, deriveProviderNodeId, loadConfig, redactConfig, saveConfig } from '../src/provider-node/config.js';

describe('provider node config', () => {
  it('derives stable machine-bound node ids without exposing the machine id', () => {
    const first = deriveProviderNodeId('darwin', 'ABCDEF12-3456-7890-ABCD-EF1234567890');
    const second = deriveProviderNodeId('darwin', 'abcdef12-3456-7890-abcd-ef1234567890');
    const otherOs = deriveProviderNodeId('linux', 'abcdef12-3456-7890-abcd-ef1234567890');

    expect(first).toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(first).not.toContain('abcdef12');
    expect(otherOs).not.toBe(first);
  });

  it('rejects unusable machine ids for deterministic node id derivation', () => {
    expect(deriveProviderNodeId('linux', '')).toBeUndefined();
    expect(deriveProviderNodeId('linux', '00000000000000000000000000000000')).toBeUndefined();
    expect(deriveProviderNodeId('linux', 'uninitialized')).toBeUndefined();
  });

  it('keeps an existing persisted node id instead of migrating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.nodeId = 'node_existing';
      saveConfig(path, config);

      expect(loadConfig(path).nodeId).toBe('node_existing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults a fresh config to the direct node endpoint', () => {
    expect(defaultConfig().platformWsUrl).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
  });

  it('migrates a legacy wokey.ai platform ws url to the direct node endpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.platformWsUrl = 'wss://www.wokey.ai/internal/provider/connect';
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      expect(loadConfig(path).platformWsUrl).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a node bound to the legacy apex host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.platformWsUrl = 'wss://wokey.ai/internal/provider/connect';
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      expect(loadConfig(path).platformWsUrl).toBe('wss://node.wokey.ai:8443/internal/provider/connect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a custom platform ws url untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.platformWsUrl = 'wss://staging.example.com:9443/internal/provider/connect';
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      expect(loadConfig(path).platformWsUrl).toBe('wss://staging.example.com:9443/internal/provider/connect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a local-development platform ws url untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.platformWsUrl = 'ws://127.0.0.1:8780/internal/provider/connect';
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      expect(loadConfig(path).platformWsUrl).toBe('ws://127.0.0.1:8780/internal/provider/connect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports runtime package build info instead of stale persisted versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.nodeVersion = '0.0.1';
      config.nodeBuildHash = 'old-build';
      saveConfig(path, config);

      const buildInfo = getProviderNodeBuildInfo();
      const loaded = loadConfig(path);
      expect(loaded.nodeVersion).toBe(buildInfo.version);
      expect(loaded.nodeBuildHash).toBe(buildInfo.buildHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops legacy node concurrency fields from persisted configs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig() as ReturnType<typeof defaultConfig> & Record<string, unknown>;
      config.maxConcurrency = 4;
      config.nodeMaxConcurrency = 4;
      config.officialExit = {
        enabled: true,
        maxConcurrency: 4,
        nodeMaxConcurrency: 4,
      } as typeof config.officialExit & Record<string, unknown>;
      config.capability = {
        ...config.capability,
        maxConcurrency: 4,
        nodeMaxConcurrency: 4,
      } as typeof config.capability & Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const loaded = loadConfig(path) as ReturnType<typeof loadConfig> & Record<string, unknown>;
      expect(loaded.maxConcurrency).toBeUndefined();
      expect(loaded.nodeMaxConcurrency).toBeUndefined();
      expect((loaded.officialExit as Record<string, unknown>).maxConcurrency).toBeUndefined();
      expect((loaded.officialExit as Record<string, unknown>).nodeMaxConcurrency).toBeUndefined();
      expect((loaded.capability as Record<string, unknown>).maxConcurrency).toBeUndefined();
      expect((loaded.capability as Record<string, unknown>).nodeMaxConcurrency).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops legacy official-exit capability policy fields from persisted configs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig() as ReturnType<typeof defaultConfig> & Record<string, unknown>;
      config.officialExit = {
        enabled: true,
        legacyNumber: 20,
        legacyNested: { a: 1, b: 512 },
        legacyList: ['x', 'y'],
        legacyString: 'gone',
      } as typeof config.officialExit & Record<string, unknown>;
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const officialExit = loadConfig(path).officialExit as Record<string, unknown>;
      expect(officialExit).toEqual({ enabled: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('encrypts local node/upstream secrets and redacts status output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.providerNodeSecret = 'node-secret-plain';
      config.upstream = {
        mode: 'anthropic-oauth',
        apiKey: 'sk-plain',
        oauth: {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          idToken: 'id-secret',
          expiresAt: Date.now() + 60_000,
        },
      };
      config.officialExit = { enabled: true };

      saveConfig(path, config);
      const raw = readFileSync(path, 'utf8');
      expect(raw).not.toContain('node-secret-plain');
      expect(raw).not.toContain('access-secret');
      expect(raw).not.toContain('refresh-secret');
      expect(raw).not.toContain('sk-plain');

      const loaded = loadConfig(path);
      expect(loaded.providerNodeSecret).toBe('node-secret-plain');
      expect(loaded.upstream.apiKey).toBe('sk-plain');
      expect(loaded.upstream.oauth?.accessToken).toBe('access-secret');
      expect(loaded.upstream.oauth?.refreshToken).toBe('refresh-secret');
      expect(loaded.officialExit).toEqual({ enabled: true });

      const redacted = redactConfig(loaded);
      expect(redacted.providerNodeSecret).toBe('***');
      expect(redacted.upstream.apiKey).toBe('***');
      expect(redacted.upstream.oauth?.accessToken).toBe('***');
      expect(redacted.upstream.oauth?.refreshToken).toBe('***');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads legacy plaintext node secrets and encrypts them on next save', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.providerNodeSecret = 'legacy-node-secret';
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);

      const loaded = loadConfig(path);
      expect(loaded.providerNodeSecret).toBe('legacy-node-secret');

      saveConfig(path, loaded);
      expect(readFileSync(path, 'utf8')).not.toContain('legacy-node-secret');
      expect(loadConfig(path).providerNodeSecret).toBe('legacy-node-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists Codex auth.json mirror state for one-way sync', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
    try {
      const path = join(dir, 'provider-node.json');
      const config = defaultConfig();
      config.localAuth = {
        codexAuthJsonMirror: {
          enabled: true,
          credentialBindingId: '42',
          path: '/Users/test/.codex/auth.json',
          tokenFingerprint: 'fp_test',
          authIdentityFingerprint: 'identity_fp_test',
          organizationId: 'account_test',
          accountEmail: 'test@example.com',
          lastCheckedAt: '2026-06-01T00:00:00.000Z',
          lastSyncedAt: '2026-06-01T00:00:00.000Z',
        },
      };

      saveConfig(path, config);
      expect(loadConfig(path).localAuth?.codexAuthJsonMirror).toMatchObject({
        enabled: true,
        credentialBindingId: '42',
        path: '/Users/test/.codex/auth.json',
        tokenFingerprint: 'fp_test',
        authIdentityFingerprint: 'identity_fp_test',
        organizationId: 'account_test',
        accountEmail: 'test@example.com',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
