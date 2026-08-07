import { execFileSync } from 'node:child_process';
import { release, type, arch } from 'node:os';
import type { ProviderNodeRuntimeIdentity } from '../shared/protocol.js';

export function currentProviderNodeRuntimeIdentity(): ProviderNodeRuntimeIdentity {
  const osType = type();
  return {
    osType,
    osVersion: osType === 'Darwin' ? (readMacOsProductVersion() ?? release()) : release(),
    osArch: arch(),
  };
}

function readMacOsProductVersion(): string | undefined {
  try {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      timeout: 1_000,
    }).trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}
