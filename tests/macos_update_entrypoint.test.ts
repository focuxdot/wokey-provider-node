import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('macOS one-line update entrypoint', () => {
  const script = readFileSync('packaging/migrate-macos-v0.1.71.sh', 'utf8');
  const shellVariable = (name: string) => `$${`{${name}}`}`;

  it('fails outside macOS and verifies the downloaded installer before executing it', () => {
    expect(script).toContain('"$(uname -s)" != "Darwin"');
    expect(script).toContain('checksums.txt');
    expect(script).toContain('VERSION="0.1.71"');
    expect(script).toContain(`/releases/download/v${shellVariable('VERSION')}`);
    expect(script).toContain('$2 == "install.sh"');
    expect(script).toContain('shasum -a 256');
    expect(script.indexOf('ACTUAL_SHA256=')).toBeLessThan(script.lastIndexOf(`bash "${shellVariable('INSTALLER')}"`));
  });
});
