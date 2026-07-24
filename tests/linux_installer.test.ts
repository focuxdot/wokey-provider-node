import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const installerPath = new URL('../packaging/install.sh', import.meta.url);
const installer = readFileSync(installerPath, 'utf8');
const sourceOnlyInstaller = installer.replace(/\nmain "\$@"\s*$/, '\n');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-linux-installer-'));
  temporaryDirectories.push(dir);
  return dir;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function runHarness(body: string, env: NodeJS.ProcessEnv = {}): string {
  const dir = temporaryDirectory();
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeExecutable(join(binDir, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n');
  writeExecutable(join(binDir, 'apt-get'), '#!/usr/bin/env bash\nexit 0\n');
  const harness = join(dir, 'harness.sh');
  writeExecutable(harness, `${sourceOnlyInstaller}\n${body}\n`);
  return execFileSync('bash', [harness], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Linux installer package handling', () => {
  it('runs Debian package commands non-interactively without restarting unrelated services', () => {
    const output = runHarness(
      `run_debian_noninteractive bash -c 'printf "%s|%s" "$DEBIAN_FRONTEND" "$NEEDRESTART_MODE"'`,
    );
    expect(output).toBe('noninteractive|l');
    expect(installer).not.toContain('NEEDRESTART_MODE=a');
    expect(installer).not.toMatch(/\bsudo\s+(?:-E\s+)?apt(?:-get)?\b/);
  });

  it.each([
    ['22.18.0-1nodesource1', 'yes'],
    ['20.19.4+dfsg-1', 'yes'],
    ['18.20.8+dfsg-1', 'no'],
  ])('recognizes whether dpkg can satisfy the Node.js dependency for %s', (version, expected) => {
    const dir = temporaryDirectory();
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, 'dpkg-query'),
      `#!/usr/bin/env bash
case "$*" in
  *Status*) printf 'install ok installed' ;;
  *Version*) printf '%s' "$FAKE_DPKG_VERSION" ;;
  *) exit 1 ;;
esac
`,
    );
    writeExecutable(
      join(binDir, 'dpkg'),
      `#!/usr/bin/env bash
version="$2"
major="\${version%%.*}"
[ "$1" = '--compare-versions' ] && [ "$3" = 'ge' ] && [ "$major" -ge "$4" ]
`,
    );
    const harness = join(dir, 'dpkg-harness.sh');
    writeExecutable(
      harness,
      `${sourceOnlyInstaller}
if dpkg_node_package_ok; then printf yes; else printf no; fi
`,
    );
    const output = execFileSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_DPKG_VERSION: version,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });
    expect(output).toBe(expected);
  });

  it('uses the Provider Node tarball when Node.js is not managed by dpkg', () => {
    const output = runHarness(`
prepare_tmpdir() { INSTALLER_TMPDIR=/tmp/wokey-installer-test; }
ensure_node() { :; }
dpkg_node_package_ok() { return 1; }
install_linux_tarball_artifact() { printf 'artifact=tarball arch=%s' "$1"; }
install_linux_deb
`);
    expect(output).toContain('Node.js 20+ is not managed by dpkg');
    expect(output).toContain('artifact=tarball arch=x64');
  });

  it('uses apt-get for the deb when dpkg records Node.js 20+', () => {
    const output = runHarness(`
prepare_tmpdir() { INSTALLER_TMPDIR=/tmp/wokey-installer-test; }
ensure_node() { :; }
dpkg_node_package_ok() { return 0; }
download() { :; }
verify_artifact() { :; }
run_debian_noninteractive() { printf 'package-command=%s\\n' "$*"; }
wokey-node() { :; }
install_linux_deb
`);
    expect(output).toContain('package-command=apt-get install -y /tmp/wokey-installer-test/wokey-provider-node_');
    expect(output).toContain('_amd64.deb');
  });
});
