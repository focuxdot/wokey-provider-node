import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const wrapper = readFileSync(new URL('../packaging/linux/provider-node', import.meta.url), 'utf8');
const sourceOnlyWrapper = wrapper.replace(/\ncase "\$\{1:-menu\}" in[\s\S]*$/, '\n');
const temporaryDirectories: string[] = [];

function runHarness(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wokey-linux-wrapper-'));
  temporaryDirectories.push(dir);
  const harness = join(dir, 'harness.sh');
  writeFileSync(harness, `${sourceOnlyWrapper}\n${body}\n`, 'utf8');
  chmodSync(harness, 0o755);
  return execFileSync('sh', [harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      PROVIDER_NODE_DATA_DIR: join(dir, 'home', '.config', 'wokey-provider-node'),
    },
  });
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Linux wrapper uninstall', () => {
  it('removes a deb installation with one command while preserving user data', () => {
    const output = runHarness(`
is_docker() { return 1; }
is_deb_install() { return 0; }
remove_user_service_for_uninstall() { echo service-removed; }
remove_deb_runtime() { echo 'root-command=apt-get remove -y wokey-provider-node'; }
uninstall_node
`);

    expect(output).toContain('service-removed');
    expect(output).toContain('root-command=apt-get remove -y wokey-provider-node');
    expect(output).toContain('User data was kept at:');
  });

  it('removes tarball paths and local data only with --purge', () => {
    const output = runHarness(`
is_docker() { return 1; }
is_deb_install() { return 1; }
remove_user_service_for_uninstall() { echo service-removed; }
run_as_root() { printf 'root-command=%s\\n' "$*"; }
remove_local_data() { echo data-removed; }
uninstall_node --purge
`);

    expect(output).toContain('root-command=rm -f /usr/local/bin/wokey-node');
    expect(output).toContain('root-command=rm -rf /opt/wokey-provider-node');
    expect(output).toContain('data-removed');
    expect(output).toContain('User data was removed from:');
  });
});
