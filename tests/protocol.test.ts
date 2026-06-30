import { describe, expect, it } from 'vitest';
import { providerCapabilityRouteMode } from '../src/shared/protocol.js';

describe('protocol helpers', () => {
  it('derives provider capability route modes', () => {
    expect(providerCapabilityRouteMode({
      model: 'claude-code-max',
      vendor: 'mock',
      supportsStreaming: true,
      supportsTools: false,
    })).toBe('dev_mock');

    expect(providerCapabilityRouteMode({
      model: 'claude-code-max',
      vendor: 'anthropic',
      supportsStreaming: true,
      supportsTools: false,
    })).toBe('dev_compatible');
  });
});
