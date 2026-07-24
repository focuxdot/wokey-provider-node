import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateNodeId } from '../shared/ids.js';
import type { ProviderCapabilityVendor } from '../shared/protocol.js';
import { getProviderNodeBuildInfo } from './build-info.js';

export type ProviderUpstreamMode = 'mock' | 'openai-compatible' | 'anthropic-oauth' | 'codex-oauth' | 'xai-oauth';
export type ProviderNodeRuntimeMode = 'development' | 'official_exit';

export interface ProviderOAuthConfig {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  expiresAt?: number;
  scope?: string;
  organizationId?: string;
  accountEmail?: string;
  subscriptionType?: string;
  subscriptionDisplayName?: string;
  claudeCodeUserId?: string;
  claudeCodeAccountUuid?: string;
  accessTokenReceivedAt?: string;
  accessTokenSource?: string;
  lastRefreshAt?: string;
}

export interface ProviderUpstreamConfig {
  mode: ProviderUpstreamMode;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  oauth?: ProviderOAuthConfig;
}

export interface ProviderOfficialExitConfig {
  enabled: boolean;
}

export interface ProviderLocalAuthConfig {
  credentialBindings?: Partial<Record<'codex-auth-json' | 'claude-code', {
    credentialBindingId: string;
    identityFingerprint: string;
    path?: string;
    updatedAt: string;
  }>>;
  codexAuthJsonMirror?: {
    enabled: boolean;
    credentialBindingId?: string;
    path?: string;
    tokenFingerprint?: string;
    authIdentityFingerprint?: string;
    organizationId?: string;
    accountEmail?: string;
    lastCheckedAt?: string;
    lastSyncedAt?: string;
    lastError?: string;
  };
}

export interface ProviderNodeConfig {
  nodeId: string;
  providerId: string;
  platformWsUrl: string;
  providerNodeSecret: string;
  nodeVersion: string;
  nodeBuildHash?: string;
  runtimeMode?: ProviderNodeRuntimeMode;
  officialExit?: ProviderOfficialExitConfig;
  localAuth?: ProviderLocalAuthConfig;
  autoUpdate?: boolean;
  // Which platform endpoint to try first: false/undefined = direct primary,
  // true = CDN-proxied fallback. Set when bind learns the direct endpoint is
  // unreachable, and updated whenever the bridge settles on an endpoint, so a
  // node on a network that blocks the direct IP skips the dead primary on every
  // (re)connect instead of eating a handshake timeout each time.
  preferFallbackEndpoint?: boolean;
  upstream: ProviderUpstreamConfig;
  capability: {
    model: string;
    vendor: ProviderCapabilityVendor;
    routeMode?: 'dev_mock' | 'dev_compatible' | 'official_exit';
    supportsStreaming: boolean;
    supportsTools: boolean;
  };
}

const ENCRYPTED_PREFIX = 'enc:v1:';
type OAuthSecretField = 'accessToken' | 'refreshToken' | 'idToken';
const SECRET_FIELDS: OAuthSecretField[] = ['accessToken', 'refreshToken', 'idToken'];

// Fixed salt for deriving the at-rest key from an operator-supplied passphrase.
// An env-provided key has nowhere to persist a per-install random salt, so the
// scrypt work factor (not salt uniqueness) is what protects a low-entropy value.
const MASTER_KEY_SCRYPT_SALT = 'wokey-provider-node:master-key:v1';

// Default Platform bridge endpoint for a fresh install. A bound node may be told
// to use a different endpoint at runtime; this constant is only the bootstrap
// default before the node receives that instruction.
const DEFAULT_PLATFORM_WS_URL = 'wss://node.wokey.ai:8443/internal/provider/connect';

// The default endpoint is the direct-IP origin primary. Some networks — notably
// mainland China ISPs that block the bare origin IP but not the domain — cannot
// reach it, so the bridge and bind path retry through a CDN-proxied host that
// resolves to non-blocked edge IPs. This is a runtime fallback only: the primary
// stays the persisted source of truth (see migrateLegacyPlatformWsUrl), so the
// proxied host is never written to config.
const PLATFORM_PRIMARY_HOST = 'node.wokey.ai';
const PLATFORM_FALLBACK_HOST = 'nodey.wokey.ai';

// Returns the CDN-proxied fallback for a primary platform URL (ws/wss or
// http/https — host swap only, scheme/port/path preserved), or null when the URL
// is not the production primary host (custom/local-dev hosts have no fallback).
export function platformFallbackUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.hostname !== PLATFORM_PRIMARY_HOST) return null;
  url.hostname = PLATFORM_FALLBACK_HOST;
  return url.toString();
}

export function defaultConfig(): ProviderNodeConfig {
  const buildInfo = getProviderNodeBuildInfo();
  return {
    nodeId: generateProviderNodeId(),
    providerId: 'dev',
    platformWsUrl: DEFAULT_PLATFORM_WS_URL,
    providerNodeSecret: 'dev-provider-secret',
    nodeVersion: buildInfo.version,
    nodeBuildHash: buildInfo.buildHash,
    runtimeMode: 'development',
    officialExit: {
      enabled: false,
    },
    upstream: {
      mode: 'mock',
    },
    capability: {
      model: 'claude-code-max',
      vendor: 'mock',
      supportsStreaming: true,
      supportsTools: false,
    },
  };
}

export function generateProviderNodeId(): string {
  return generateNodeId();
}

export function loadConfig(path: string): ProviderNodeConfig {
  if (!existsSync(path)) {
    const config = defaultConfig();
    saveConfig(path, config);
    return config;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProviderNodeConfig>;
  return decryptConfig(path, applyRuntimeBuildInfo(migrateLegacyPlatformWsUrl(mergeConfig(defaultConfig(), parsed))));
}

export function saveConfig(path: string, config: ProviderNodeConfig): void {
  // The config holds the node↔Platform secret (providerNodeSecret) and account
  // metadata. Keep it owner-only so other local users on a shared host cannot
  // read it; chmod after write so an existing loose-permission file is tightened.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(encryptConfig(path, config), null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort; non-POSIX filesystems may not support chmod.
  }
}

export function redactConfig(value: ProviderNodeConfig): ProviderNodeConfig {
  return {
    ...value,
    providerNodeSecret: value.providerNodeSecret ? '***' : '',
    upstream: {
      ...value.upstream,
      apiKey: value.upstream.apiKey ? '***' : undefined,
      oauth: redactOAuth(value.upstream.oauth),
    },
  };
}

function redactOAuth(oauth?: ProviderOAuthConfig): ProviderOAuthConfig | undefined {
  if (!oauth) return undefined;
  return {
    ...oauth,
    accessToken: oauth.accessToken ? '***' : undefined,
    refreshToken: oauth.refreshToken ? '***' : undefined,
    idToken: oauth.idToken ? '***' : undefined,
  };
}

function mergeConfig(defaults: ProviderNodeConfig, parsed: Partial<ProviderNodeConfig> & Record<string, unknown>): ProviderNodeConfig {
  const {
    region: _region,
    exitRegion: _exitRegion,
    maxConcurrency: _maxConcurrency,
    nodeMaxConcurrency: _nodeMaxConcurrency,
    ...parsedWithoutLegacyLocation
  } = parsed;
  // Carry forward only known official-exit fields; any legacy Platform-pushed keys
  // are dropped by allowlist, so their names need not be enumerated here.
  const parsedOfficialExit: ProviderOfficialExitConfig | undefined = parsed.officialExit
    ? (() => {
      const source = parsed.officialExit as unknown as Record<string, unknown>;
      const enabled = typeof source.enabled === 'boolean' ? source.enabled : Boolean(defaults.officialExit?.enabled);
      return { enabled };
    })()
    : undefined;
  const parsedCapability = parsed.capability
    ? (() => {
      const source = parsed.capability as Partial<ProviderNodeConfig['capability']>;
      const capability: Partial<ProviderNodeConfig['capability']> = {};
      if (source.model !== undefined) capability.model = source.model;
      if (source.vendor !== undefined) capability.vendor = source.vendor;
      if (source.routeMode !== undefined) capability.routeMode = source.routeMode;
      if (source.supportsStreaming !== undefined) capability.supportsStreaming = source.supportsStreaming;
      if (source.supportsTools !== undefined) capability.supportsTools = source.supportsTools;
      return capability;
    })()
    : undefined;
  return {
    ...defaults,
    ...parsedWithoutLegacyLocation,
    upstream: {
      ...defaults.upstream,
      ...parsed.upstream,
      oauth: {
        ...defaults.upstream.oauth,
        ...parsed.upstream?.oauth,
      },
    },
    officialExit: parsedOfficialExit ? {
      ...defaults.officialExit,
      ...parsedOfficialExit,
    } : defaults.officialExit,
    capability: {
      ...defaults.capability,
      ...parsedCapability,
    },
    localAuth: parsed.localAuth ? {
      ...defaults.localAuth,
      credentialBindings: parsed.localAuth.credentialBindings ? {
        ...parsed.localAuth.credentialBindings,
      } : defaults.localAuth?.credentialBindings,
      codexAuthJsonMirror: parsed.localAuth.codexAuthJsonMirror ? {
        ...parsed.localAuth.codexAuthJsonMirror,
      } : defaults.localAuth?.codexAuthJsonMirror,
    } : defaults.localAuth,
  };
}

export function applyRuntimeBuildInfo(config: ProviderNodeConfig): ProviderNodeConfig {
  const buildInfo = getProviderNodeBuildInfo();
  return {
    ...config,
    nodeVersion: buildInfo.version,
    nodeBuildHash: buildInfo.buildHash,
  };
}

// A node may have persisted an older wokey.ai control-plane host and must move to
// the direct node endpoint. We match the wokey.ai domain (apex or any subdomain)
// rather than "anything that isn't node.wokey.ai" on purpose: local-dev
// (127.0.0.1) and explicitly configured custom Platform hosts must be left alone, never
// silently repointed. node.wokey.ai is already the target, so it falls outside
// the match.
function isLegacyPlatformWsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'node.wokey.ai') return false;
  return host === 'wokey.ai' || host.endsWith('.wokey.ai');
}

export function migrateLegacyPlatformWsUrl(config: ProviderNodeConfig): ProviderNodeConfig {
  let parsed: URL;
  try {
    parsed = new URL(config.platformWsUrl);
  } catch {
    return config;
  }
  if (parsed.pathname !== '/internal/provider/connect') return config;
  if (!isLegacyPlatformWsHost(parsed.hostname)) return config;
  return { ...config, platformWsUrl: DEFAULT_PLATFORM_WS_URL };
}

function encryptConfig(path: string, config: ProviderNodeConfig): ProviderNodeConfig {
  const copy = structuredClone(config);
  if (copy.providerNodeSecret) copy.providerNodeSecret = encryptSecret(path, copy.providerNodeSecret);
  encryptUpstreamSecrets(path, copy.upstream);
  return copy;
}

function decryptConfig(path: string, config: ProviderNodeConfig): ProviderNodeConfig {
  const copy = structuredClone(config);
  if (copy.providerNodeSecret) copy.providerNodeSecret = decryptSecret(path, copy.providerNodeSecret);
  decryptUpstreamSecrets(path, copy.upstream);
  return copy;
}

function encryptUpstreamSecrets(path: string, upstream: ProviderUpstreamConfig): void {
  if (upstream.apiKey) upstream.apiKey = encryptSecret(path, upstream.apiKey);
  if (!upstream.oauth) return;
  for (const field of SECRET_FIELDS) {
    const value = upstream.oauth[field];
    if (value) upstream.oauth[field] = encryptSecret(path, value);
  }
}

function decryptUpstreamSecrets(path: string, upstream: ProviderUpstreamConfig): void {
  if (upstream.apiKey) upstream.apiKey = decryptSecret(path, upstream.apiKey);
  if (!upstream.oauth) return;
  for (const field of SECRET_FIELDS) {
    const value = upstream.oauth[field];
    if (value) upstream.oauth[field] = decryptSecret(path, value);
  }
}

function encryptSecret(path: string, value: string): string {
  if (value.startsWith(ENCRYPTED_PREFIX)) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getMasterKey(path), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENCRYPTED_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64url')}`;
}

function decryptSecret(path: string, value: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const raw = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', getMasterKey(path), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function getMasterKey(configPath: string): Buffer {
  // Operator-supplied key: derive via scrypt rather than a bare hash so a
  // human-chosen passphrase still costs real work to brute-force. Prefer
  // supplying 32 bytes of high-entropy material (see .env.example).
  const envKey = process.env.PROVIDER_NODE_MASTER_KEY;
  if (envKey) return scryptSync(envKey, MASTER_KEY_SCRYPT_SALT, 32);

  // Auto-generated key file: the stored material is already 32 random bytes, so
  // a single hash is sufficient. The file is owner-only (0600) in its 0700 dir.
  const keyPath = `${configPath}.key`;
  if (existsSync(keyPath)) {
    return createHash('sha256').update(readFileSync(keyPath, 'utf8').trim()).digest();
  }

  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  const keyMaterial = randomBytes(32).toString('base64url');
  writeFileSync(keyPath, `${keyMaterial}\n`, { mode: 0o600 });
  return createHash('sha256').update(keyMaterial).digest();
}
