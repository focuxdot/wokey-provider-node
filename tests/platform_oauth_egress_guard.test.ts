import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(here, '..', 'src', 'provider-node');

describe('Platform-owned OAuth egress guard', () => {
  it('keeps active Provider Node runtime code off vendor OAuth HTTP modules', () => {
    const server = readFileSync(join(sourceDir, 'server.ts'), 'utf8');
    const bridge = readFileSync(join(sourceDir, 'bridge.ts'), 'utf8');

    expect(server).toContain('/internal/provider/oauth/');
    expect(server).toContain('PROVIDER_OAUTH_EGRESS_CONTROL_PROTOCOL_VERSION');
    expect(server).not.toMatch(/from ['"]\.\/oauth\.js['"]/);
    expect(server).not.toMatch(/from ['"]\.\/cursor-auth\.js['"]/);
    expect(bridge).not.toMatch(/from ['"]\.\/cursor-auth\.js['"]/);
    expect(bridge).not.toContain('platform.cursor_auth_start');
    expect(bridge).not.toContain('platform.cursor_auth_cancel');
    expect(existsSync(join(sourceDir, 'oauth.ts'))).toBe(false);
    expect(existsSync(join(sourceDir, 'cursor-auth.ts'))).toBe(false);
  });

  it('advertises only the versioned Platform-persona OAuth capability', () => {
    const bridge = readFileSync(join(sourceDir, 'bridge.ts'), 'utf8');
    expect(bridge).toContain('credentialOAuthEgress');
    expect(bridge).toContain("implementation: 'platform_persona'");
    expect(bridge).not.toContain("implementation: 'native_oauth'");
  });
});
