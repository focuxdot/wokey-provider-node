import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DreaminaCliInstallError,
  DreaminaCliInstaller,
  dreaminaCliArtifact,
} from '../src/provider-node/jimeng-cli-installer.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'wokey-jimeng-installer-test-'));
  tempDirs.push(path);
  return path;
}

function officialResponse(bytes: Buffer, md5 = createHash('md5').update(bytes).digest('base64')): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-length': String(bytes.length),
      'content-md5': md5,
    },
  });
}

describe('DreaminaCliInstaller', () => {
  it('downloads, verifies, and installs the official artifact into the default path', async () => {
    const homeDir = await tempHome();
    const bytes = Buffer.from('verified dreamina binary');
    const fetchImpl = vi.fn(async () => officialResponse(bytes));
    const verifyBinary = vi.fn(async () => '1.4.15');
    const installer = new DreaminaCliInstaller({ platform: 'linux', arch: 'x64', homeDir, fetchImpl, verifyBinary });

    const result = await installer.install();

    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/dreamina_cli_linux_amd64$/), { redirect: 'follow' });
    expect(await readFile(result.path)).toEqual(bytes);
    expect(result).toMatchObject({ version: '1.4.15', bytes: bytes.length });
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(installer.status()).toMatchObject({ supported: true, status: 'succeeded', version: '1.4.15' });
  });

  it('rejects a checksum mismatch without replacing an existing executable', async () => {
    const homeDir = await tempHome();
    const targetPath = join(homeDir, 'custom-dreamina');
    await writeFile(targetPath, 'existing binary');
    const installer = new DreaminaCliInstaller({
      platform: 'darwin',
      arch: 'arm64',
      configuredPath: targetPath,
      fetchImpl: async () => officialResponse(Buffer.from('tampered'), Buffer.from('wrong').toString('base64')),
      verifyBinary: async () => '1.4.15',
    });

    await expect(installer.install()).rejects.toMatchObject<DreaminaCliInstallError>({
      code: 'jimeng_cli_install_checksum_mismatch',
    });
    expect(await readFile(targetPath, 'utf8')).toBe('existing binary');
    expect(installer.status()).toMatchObject({ status: 'failed', errorCode: 'jimeng_cli_install_checksum_mismatch' });
  });

  it('coalesces concurrent clicks into one download', async () => {
    const homeDir = await tempHome();
    const bytes = Buffer.from('binary');
    const fetchImpl = vi.fn(async () => officialResponse(bytes));
    const installer = new DreaminaCliInstaller({
      platform: 'linux',
      arch: 'arm64',
      homeDir,
      fetchImpl,
      verifyBinary: async () => '1.4.15',
    });

    const [first, second] = await Promise.all([installer.install(), installer.install()]);

    expect(first.path).toBe(second.path);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported platform and architecture combinations', async () => {
    expect(dreaminaCliArtifact('win32', 'arm64')).toBeUndefined();
    const installer = new DreaminaCliInstaller({ platform: 'win32', arch: 'arm64' });
    expect(installer.status()).toMatchObject({ supported: false, status: 'idle' });
    await expect(installer.install()).rejects.toMatchObject({ code: 'jimeng_cli_install_unsupported' });
  });
});
