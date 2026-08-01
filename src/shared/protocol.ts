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

export type ProviderRouteMode = 'dev_mock' | 'dev_compatible' | 'official_exit';

export type ProviderNodeRuntimeMode = 'development' | 'official_exit';

export interface ProviderOfficialExitMetadata {
  routeMode: 'official_exit';
  dataProtocols?: OfficialExitDataProtocol[];
}

export type OfficialExitDataProtocol = 'json_base64_v1' | 'binary_v1';
export type OfficialExitEarlyDataProtocol = 'buffered_v1';
export type OfficialExitTrafficClass = 'interactive' | 'bulk';

export interface OfficialExitBulkTransferCapabilities {
  minInitialWindowBytes: number;
  maxInitialWindowBytes: number;
  maxConnectionQueueBytes: number;
}

export interface ProviderTransportCapabilities {
  officialExitDataProtocols?: OfficialExitDataProtocol[];
  officialExitEarlyDataProtocols?: OfficialExitEarlyDataProtocol[];
  officialExitBulkTransfer?: OfficialExitBulkTransferCapabilities;
  flowControl?: Array<'credit_v1'>;
  maxBinaryFrameBytes?: number;
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

export const JIMENG_AUTH_CONTROL_PROTOCOL_VERSION = 1;
export type JimengAuthControlProtocolVersion = typeof JIMENG_AUTH_CONTROL_PROTOCOL_VERSION;
export const JIMENG_CLI_INSTALL_PROTOCOL_VERSION = 1;
export type JimengCliInstallProtocolVersion = typeof JIMENG_CLI_INSTALL_PROTOCOL_VERSION;
export const JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION = 2;
export type JimengVideoControlProtocolVersion = typeof JIMENG_VIDEO_CONTROL_PROTOCOL_VERSION;
export const JIMENG_USAGE_CONTROL_PROTOCOL_VERSION = 1;
export type JimengUsageControlProtocolVersion = typeof JIMENG_USAGE_CONTROL_PROTOCOL_VERSION;

export interface ProviderNodeControlCapabilities {
  jimengCliInstall?: {
    protocolVersions: JimengCliInstallProtocolVersion[];
  };
  jimengAuth?: {
    protocolVersions: JimengAuthControlProtocolVersion[];
    cliVersion: string;
  };
  jimengVideo?: {
    protocolVersions: JimengVideoControlProtocolVersion[];
    cliVersion: string;
    generationModes: Array<'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference'>;
    upstreamModelVersions: string[];
    resolutions: string[];
  };
  jimengUsage?: {
    protocolVersions: JimengUsageControlProtocolVersion[];
    cliVersion: string;
  };
}

export interface ProviderHello {
  type: 'provider.hello';
  nodeId: string;
  providerId: string;
  nodeVersion: string;
  nodeBuildHash?: string;
  runtimeMode?: ProviderNodeRuntimeMode;
  capabilities: ProviderNodeCapability[];
  transportCapabilities?: ProviderTransportCapabilities;
  controlCapabilities?: ProviderNodeControlCapabilities;
  officialExit?: OfficialExitHealth;
  acceptingSessions?: boolean;
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
  acceptingSessions?: boolean;
}

export interface ProviderDrainNotice {
  type: 'provider.drain';
  requestId: string;
  nodeId: string;
  acceptingSessions: false;
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

export interface PlatformProviderReady {
  type: 'platform.ready';
  nodeId: string;
  transport?: {
    officialExitDataProtocol: OfficialExitDataProtocol;
    officialExitEarlyDataProtocol?: OfficialExitEarlyDataProtocol;
    flowControl?: 'credit_v1';
    initialWindowBytes?: number;
    maxBinaryFrameBytes?: number;
    bulkTransfer?: {
      initialWindowBytes: number;
      connectionQueueBudgetBytes: number;
    };
  };
}

export interface PlatformDrainAck {
  type: 'platform.drain_ack';
  requestId: string;
  nodeId: string;
}

export interface PlatformJimengAuthStart {
  type: 'platform.jimeng_auth_start';
  protocolVersion: JimengAuthControlProtocolVersion;
  requestId: string;
  flowId: string;
  providerId: string;
  nodeId: string;
  deadlineMs: number;
}

export interface PlatformJimengAuthCancel {
  type: 'platform.jimeng_auth_cancel';
  protocolVersion: JimengAuthControlProtocolVersion;
  requestId: string;
  flowId: string;
  nodeId: string;
}

export interface ProviderJimengAuthStarted {
  type: 'provider.jimeng_auth_started';
  protocolVersion: JimengAuthControlProtocolVersion;
  requestId: string;
  flowId: string;
  nodeId: string;
  verificationUri: string;
  verificationUriComplete?: string;
  userCode: string;
  expiresAt: string;
}

export interface ProviderJimengAuthCompleted {
  type: 'provider.jimeng_auth_completed';
  protocolVersion: JimengAuthControlProtocolVersion;
  requestId: string;
  flowId: string;
  nodeId: string;
  encodedCredentialBundle: string;
}

export type JimengAuthFailureStage =
  | 'launch'
  | 'device_authorization'
  | 'user_authorization'
  | 'credential_validation'
  | 'credential_capture'
  | 'cleanup';

export interface ProviderJimengAuthFailed {
  type: 'provider.jimeng_auth_failed';
  protocolVersion: JimengAuthControlProtocolVersion;
  requestId: string;
  flowId: string;
  nodeId: string;
  stage: JimengAuthFailureStage;
  errorCode: string;
  retryable: boolean;
}

export interface PlatformJimengCliInstall {
  type: 'platform.jimeng_cli_install';
  protocolVersion: JimengCliInstallProtocolVersion;
  requestId: string;
  providerId: string;
  nodeId: string;
}

export interface ProviderJimengCliInstallCompleted {
  type: 'provider.jimeng_cli_install_completed';
  protocolVersion: JimengCliInstallProtocolVersion;
  requestId: string;
  nodeId: string;
  cliVersion: string;
}

export interface ProviderJimengCliInstallFailed {
  type: 'provider.jimeng_cli_install_failed';
  protocolVersion: JimengCliInstallProtocolVersion;
  requestId: string;
  nodeId: string;
  errorCode: string;
  retryable: boolean;
}

export interface PlatformJimengUsageRefresh {
  type: 'platform.jimeng_usage_refresh';
  protocolVersion: JimengUsageControlProtocolVersion;
  requestId: string;
  providerId: string;
  nodeId: string;
  credentialBindingId: string;
  deadlineMs: number;
  encodedCredentialBundle: string;
}

export interface PlatformJimengUsageCancel {
  type: 'platform.jimeng_usage_cancel';
  protocolVersion: JimengUsageControlProtocolVersion;
  requestId: string;
  nodeId: string;
  credentialBindingId: string;
}

export interface ProviderJimengUsageCompleted {
  type: 'provider.jimeng_usage_completed';
  protocolVersion: JimengUsageControlProtocolVersion;
  requestId: string;
  nodeId: string;
  credentialBindingId: string;
  totalCredit: number;
  checkedAt: string;
  encodedCredentialBundle: string;
}

export interface ProviderJimengUsageFailed {
  type: 'provider.jimeng_usage_failed';
  protocolVersion: JimengUsageControlProtocolVersion;
  requestId: string;
  nodeId: string;
  credentialBindingId: string;
  errorCode: string;
  retryable: boolean;
}

export interface PlatformJimengVideoExecute {
  type: 'platform.jimeng_video_execute';
  protocolVersion: JimengVideoControlProtocolVersion;
  requestId: string;
  videoJobId: string;
  providerId: string;
  nodeId: string;
  deadlineMs: number;
  encodedCredentialBundle: string;
  operation:
    | {
        type: 'submit';
        mode: 'text_to_video' | 'image_to_video' | 'first_last_frames' | 'multimodal_reference';
        modelVersion: string;
        prompt: string;
        durationSeconds: number;
        ratio: string;
        resolution: string;
        mediaInputs: Array<{
          id: string;
          kind: 'image' | 'video' | 'audio';
          role?: 'first_frame' | 'last_frame' | 'reference';
          filename: string;
          contentType: string;
          bytes: number;
          sha256: string;
          downloadUrl: string;
        }>;
      }
    | {
        type: 'query';
        submitId: string;
        encodedTaskStateBundle: string;
        artifactUpload: { url: string; maxBytes: number };
      };
}

export interface PlatformJimengVideoCancel {
  type: 'platform.jimeng_video_cancel';
  protocolVersion: JimengVideoControlProtocolVersion;
  requestId: string;
  videoJobId: string;
  nodeId: string;
}

export interface ProviderJimengVideoCompleted {
  type: 'provider.jimeng_video_completed';
  protocolVersion: JimengVideoControlProtocolVersion;
  requestId: string;
  videoJobId: string;
  nodeId: string;
  operation: 'submit' | 'query';
  submitId: string;
  reusedSubmission: boolean;
  encodedTaskStateBundle: string;
  encodedCredentialBundle?: string;
  credentialChanged: boolean;
  upstreamResult: Record<string, unknown>;
  outputArtifact?: { contentType: 'video/mp4'; bytes: number; sha256: string };
}

export type JimengVideoFailureStage =
  | 'validation'
  | 'receipt'
  | 'credential_injection'
  | 'media_transfer'
  | 'task_state_restore'
  | 'cli_execution'
  | 'task_state_capture'
  | 'credential_capture'
  | 'cleanup';

export interface ProviderJimengVideoFailed {
  type: 'provider.jimeng_video_failed';
  protocolVersion: JimengVideoControlProtocolVersion;
  requestId: string;
  videoJobId: string;
  nodeId: string;
  operation: 'submit' | 'query';
  stage: JimengVideoFailureStage;
  errorCode: string;
  retryable: boolean;
  submissionUnknown: boolean;
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
  dataProtocol?: OfficialExitDataProtocol;
  earlyDataProtocol?: OfficialExitEarlyDataProtocol;
  trafficClass?: OfficialExitTrafficClass;
  initialWindowBytes?: number;
}

export interface OfficialExitOpenResponse {
  type: 'official_exit.open_response';
  sessionId: string;
  accepted: boolean;
  reasonCode?: string;
  transportDiagnostic?: OfficialExitTransportDiagnostic;
}

export interface OfficialExitTransportDiagnostic {
  version: 1;
  stage: 'connect' | 'socket';
  outcome: 'connected' | 'failed' | 'closed';
  reasonCode?: string;
  addressFamily?: 'ipv4' | 'ipv6';
  remoteAddress?: string;
  connectMs?: number;
  elapsedMs?: number;
  bytesFromUpstream?: number;
  bytesToUpstream?: number;
  dataProtocol?: OfficialExitDataProtocol;
  webSocketBytesFromPlatform?: number;
  webSocketBytesToPlatform?: number;
  backpressureCount?: number;
  peakBufferedBytes?: number;
  earlyDataBytes?: number;
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
  transportDiagnostic?: OfficialExitTransportDiagnostic;
}

export interface OfficialExitError {
  type: 'official_exit.error';
  sessionId: string;
  errorCode: string;
  errorMessage?: string;
  retryable?: boolean;
  transportDiagnostic?: OfficialExitTransportDiagnostic;
}

export type ProviderToPlatformMessage =
  | ProviderHello
  | ProviderHeartbeat
  | ProviderDrainNotice
  | ProviderCredentialMirrorUpdate
  | ProviderJimengAuthStarted
  | ProviderJimengAuthCompleted
  | ProviderJimengAuthFailed
  | ProviderJimengCliInstallCompleted
  | ProviderJimengCliInstallFailed
  | ProviderJimengUsageCompleted
  | ProviderJimengUsageFailed
  | OfficialExitOpenResponse
  | OfficialExitDataFrame
  | OfficialExitClose
  | OfficialExitError;
export type PlatformToProviderMessage =
  | PlatformProviderReady
  | PlatformDrainAck
  | PlatformCredentialMirrorUpdateAck
  | PlatformCredentialRefreshHint
  | PlatformUpgradeAvailable
  | PlatformJimengAuthStart
  | PlatformJimengAuthCancel
  | PlatformJimengCliInstall
  | PlatformJimengUsageRefresh
  | PlatformJimengUsageCancel
  | OfficialExitOpenRequest
  | OfficialExitDataFrame
  | OfficialExitClose;

export function providerCapabilityRouteMode(capability: ProviderNodeCapability): ProviderRouteMode {
  if (capability.routeMode) return capability.routeMode;
  if ('vendor' in capability && capability.vendor === 'mock') return 'dev_mock';
  return 'dev_compatible';
}
