import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const installer = readFileSync(new URL('../packaging/install.sh', import.meta.url), 'utf8');
const sourceOnlyInstaller = installer.replace(/\nmain "\$@"\s*$/, '\n');
const temporaryDirectories: string[] = [];

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'darwin')('macOS installer', () => {
  it('persists a non-standard Node path before the package postinstall starts the LaunchAgent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wokey-macos-installer-'));
    temporaryDirectories.push(dir);
    const home = join(dir, 'home');
    const binDir = join(dir, 'conda', 'bin');
    const nodePath = join(binDir, 'node');
    const hintPath = join(home, 'Library', 'Application Support', 'Wokey Provider Node', 'node-path');
    mkdirSync(home);
    mkdirSync(binDir, { recursive: true });
    writeExecutable(
      nodePath,
      `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then printf '%s\\n' "$0"; else printf 'v22.22.2\\n'; fi
`,
    );
    writeExecutable(
      join(binDir, 'sudo'),
      `#!/usr/bin/env bash
printf 'hint-before-installer=%s\\n' "$(cat "$WOKEY_TEST_NODE_HINT")"
`,
    );
    writeExecutable(join(binDir, 'wokey-node'), '#!/usr/bin/env bash\nexit 0\n');
    const harness = join(dir, 'harness.sh');
    writeExecutable(
      harness,
      `${sourceOnlyInstaller}
prepare_tmpdir() { INSTALLER_TMPDIR="${dir}/download"; mkdir -p "$INSTALLER_TMPDIR"; }
ensure_node() { :; }
download() { :; }
verify_artifact() { :; }
install_macos
`,
    );

    const output = execFileSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        WOKEY_TEST_NODE_HINT: hintPath,
      },
    });

    expect(output).toContain(`Saved Node.js path for the macOS background service: ${nodePath}`);
    expect(output).toContain(`hint-before-installer=${nodePath}`);
    expect(readFileSync(hintPath, 'utf8')).toBe(`${nodePath}\n`);
  }, 15_000);
});
