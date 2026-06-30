import type { OfficialExitVendorId } from './official-exit-vendors.js';

export type ProviderCapabilityVendor = OfficialExitVendorId | 'mock';

export interface ProviderCapability {
  model: string;
  vendor: ProviderCapabilityVendor;
  routeMode?: ProviderRouteMode;
  supportsStreaming: boolean;
  supportsTools: boolean;
  officialExit?: ProviderOfficialExitMetadata;
}

export type ProviderRouteMode =
  | 'dev_mock'
  | 'dev_compatible'
  | 'official_exit';

export type ProviderNodeRuntimeMode = 'development' | 'official_exit';

export interface ProviderOfficialExitMetadata {
  routeMode: 'official_exit';
}

export interface ProviderOfficialExitCapability {
  routeMode: 'official_exit';
  officialExit: ProviderOfficialExitMetadata;
}

export type ProviderNodeCapability = ProviderCapability | ProviderOfficialExitCapability;

export interface OfficialExitHealth {
  status: 'healthy' | 'degraded';
  activeSessions: number;
  recentConnectErrorRate: number;
  recentTimeoutRate: number;
  avgConnectLatencyMs?: number;
  avgBytesPerSession?: number;
  observedExitIp?: string;
  lastCheckAt: string;
  reasonCodes: string[];
}

export interface ProviderHello {
  type: 'provider.hello';
  nodeId: string;
  providerId: string;
  nodeVersion: string;
  nodeBuildHash?: string;
  runtimeMode?: ProviderNodeRuntimeMode;
  capabilities: ProviderNodeCapability[];
  officialExit?: OfficialExitHealth;
}

export interface ProviderHeartbeat {
  type: 'provider.heartbeat';
  nodeId: string;
  inFlight: number;
  healthy: boolean;
  lastErrorCode?: string;
  riskState?: 'ready' | 'cooling_down' | 'auth_invalid';
  cooldownUntil?: string;
  consecutiveFailures?: number;
  capabilities?: ProviderNodeCapability[];
  officialExit?: OfficialExitHealth;
}

export interface ProviderCredentialMirrorUpdate {
  type: 'provider.credential_mirror_update';
  requestId: string;
  credentialBindingId: string;
  vendor: 'openai' | 'anthropic';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  organizationId?: string;
  accountEmail?: string;
  subscriptionType?: string;
  subscriptionDisplayName?: string;
  accessTokenReceivedAt?: string;
  accessTokenSource?: string;
  lastRefreshAt?: string;
}

export interface PlatformCredentialMirrorUpdateAck {
  type: 'platform.credential_mirror_update_ack';
  requestId: string;
  credentialBindingId: string;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface PlatformCredentialRefreshHint {
  type: 'platform.credential_refresh_hint';
  credentialBindingId: string;
  vendor: 'openai' | 'anthropic';
  refreshedAt: string;
  expiresAt?: number;
}

export interface PlatformUpgradeAvailable {
  type: 'platform.upgrade_available';
  version: string;
  hashes: Record<string, string>;
  urgent: boolean;
}

// Only the fields the node actually consumes to open and bound the relay socket.
// Platform may send additional routing/policy fields; they are ignored here and
// deliberately not declared, to keep Platform-internal vocabulary out of the
// public node.
export interface OfficialExitOpenRequest {
  type: 'official_exit.open';
  sessionId: string;
  routeMode: 'official_exit';
  providerId: string;
  nodeId: string;
  targetHost: string;
  targetPort: number;
  deadlineMs: number;
  maxBytesIn?: number;
  maxBytesOut?: number;
}

export interface OfficialExitOpenResponse {
  type: 'official_exit.open_response';
  sessionId: string;
  accepted: boolean;
  reasonCode?: string;
}

export interface OfficialExitDataFrame {
  type: 'official_exit.data';
  sessionId: string;
  seq: number;
  payloadBase64: string;
}

export interface OfficialExitClose {
  type: 'official_exit.close';
  sessionId: string;
  reasonCode?: string;
}

export interface OfficialExitError {
  type: 'official_exit.error';
  sessionId: string;
  errorCode: string;
  errorMessage?: string;
  retryable?: boolean;
}

export type ProviderToPlatformMessage =
  | ProviderHello
  | ProviderHeartbeat
  | ProviderCredentialMirrorUpdate
  | OfficialExitOpenResponse
  | OfficialExitDataFrame
  | OfficialExitClose
  | OfficialExitError;
export type PlatformToProviderMessage =
  | PlatformCredentialMirrorUpdateAck
  | PlatformCredentialRefreshHint
  | PlatformUpgradeAvailable
  | OfficialExitOpenRequest
  | OfficialExitDataFrame
  | OfficialExitClose;

export function providerCapabilityRouteMode(capability: ProviderNodeCapability): ProviderRouteMode {
  if (capability.routeMode) return capability.routeMode;
  if ('vendor' in capability && capability.vendor === 'mock') return 'dev_mock';
  return 'dev_compatible';
}
