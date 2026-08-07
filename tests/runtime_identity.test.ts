import { describe, expect, it } from 'vitest';
import { currentProviderNodeRuntimeIdentity } from '../src/provider-node/runtime-identity.js';

describe('Provider Node runtime identity', () => {
  it('reports reusable system and CPU information without Kimi-specific state', () => {
    expect(currentProviderNodeRuntimeIdentity()).toMatchObject({
      osType: expect.any(String),
      osVersion: expect.any(String),
      osArch: expect.any(String),
    });
    expect(currentProviderNodeRuntimeIdentity()).not.toHaveProperty('hostname');
    expect(currentProviderNodeRuntimeIdentity()).not.toHaveProperty('kimiDeviceId');
  });
});
