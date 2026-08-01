import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const AUTH_FILE_RELATIVE_PATH = join('.local', 'share', 'dreamina', 'byted_cli_user_token.json');
const KEYRING_SERVICE = 'dreamina';
const KEYRING_ACCOUNT = 'byted_cli_user_token';
const WINDOWS_TARGET = `${KEYRING_SERVICE}:${KEYRING_ACCOUNT}`;
const MAX_SECRET_BYTES = 64 * 1024;
const NATIVE_COMMAND_TIMEOUT_MS = 10_000;

export type SupportedDreaminaPlatform = 'linux' | 'darwin' | 'win32';

export interface JimengCredentialStore {
  snapshot(): Promise<Buffer | undefined>;
  capture(): Promise<Buffer>;
  restore(snapshot: Buffer | undefined): Promise<void>;
}

export interface JimengCredentialStoreOptions {
  platform: SupportedDreaminaPlatform;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  runNativeCommand?: NativeCommandRunner;
}

export interface NativeCommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export type NativeCommandRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: Buffer; timeoutMs: number },
) => Promise<NativeCommandResult>;

export function createJimengCredentialStore(options: JimengCredentialStoreOptions): JimengCredentialStore {
  if (options.platform === 'linux') return new LinuxCredentialStore(options.homeDir);
  if (options.platform === 'darwin') {
    return new MacOsCredentialStore(options.env, options.runNativeCommand ?? runNativeCommand);
  }
  return new WindowsCredentialStore(options.env, options.runNativeCommand ?? runNativeCommand);
}

export function isSupportedDreaminaPlatform(platform: NodeJS.Platform): platform is SupportedDreaminaPlatform {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}

export function decodeGoKeyringSecret(stored: Buffer): Buffer {
  const value = stored.toString('utf8');
  if (value.startsWith('go-keyring-base64:')) {
    return Buffer.from(value.slice('go-keyring-base64:'.length), 'base64');
  }
  if (value.startsWith('go-keyring-encoded:')) {
    return Buffer.from(value.slice('go-keyring-encoded:'.length), 'hex');
  }
  return Buffer.from(stored);
}

class LinuxCredentialStore implements JimengCredentialStore {
  constructor(private readonly homeDir: string) {}

  async snapshot(): Promise<undefined> {
    return undefined;
  }

  async capture(): Promise<Buffer> {
    const path = join(this.homeDir, AUTH_FILE_RELATIVE_PATH);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('jimeng_credential_auth_file_permissions_invalid');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async restore(_snapshot: undefined): Promise<void> {}
}

class MacOsCredentialStore implements JimengCredentialStore {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly run: NativeCommandRunner,
  ) {}

  async snapshot(): Promise<Buffer | undefined> {
    const result = await this.run(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT, '-w'],
      { env: this.env, timeoutMs: NATIVE_COMMAND_TIMEOUT_MS },
    );
    if (result.code === 44) return undefined;
    assertNativeSuccess(result);
    return trimSingleTrailingNewline(result.stdout);
  }

  async capture(): Promise<Buffer> {
    const stored = await this.snapshot();
    if (!stored) throw new Error('jimeng_credential_not_found');
    return decodeGoKeyringSecret(stored);
  }

  async restore(snapshot: Buffer | undefined): Promise<void> {
    if (!snapshot) {
      const result = await this.run(
        '/usr/bin/security',
        ['delete-generic-password', '-s', KEYRING_SERVICE, '-a', KEYRING_ACCOUNT],
        { env: this.env, timeoutMs: NATIVE_COMMAND_TIMEOUT_MS },
      );
      if (result.code !== 0 && result.code !== 44) assertNativeSuccess(result);
      return;
    }
    const current = await this.snapshot();
    if (!current?.equals(snapshot)) throw new Error('jimeng_credential_store_failed');
  }
}

class WindowsCredentialStore implements JimengCredentialStore {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly run: NativeCommandRunner,
  ) {}

  async snapshot(): Promise<Buffer | undefined> {
    const result = await this.invoke('read');
    if (result.code === 3) return undefined;
    assertNativeSuccess(result);
    const encoded = result.stdout.toString('utf8').trim();
    return encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  }

  async capture(): Promise<Buffer> {
    const stored = await this.snapshot();
    if (!stored) throw new Error('jimeng_credential_not_found');
    return decodeGoKeyringSecret(stored);
  }

  async restore(snapshot: Buffer | undefined): Promise<void> {
    const result = await this.invoke(snapshot ? 'write' : 'delete', snapshot);
    if (!snapshot && result.code === 3) return;
    assertNativeSuccess(result);
  }

  private invoke(operation: 'read' | 'write' | 'delete', input?: Buffer): Promise<NativeCommandResult> {
    const script = windowsCredentialScript(operation, WINDOWS_TARGET);
    return this.run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      {
        env: this.env,
        input: input ? Buffer.from(input.toString('base64'), 'utf8') : undefined,
        timeoutMs: NATIVE_COMMAND_TIMEOUT_MS,
      },
    );
  }
}

function windowsCredentialScript(operation: 'read' | 'write' | 'delete', target: string): string {
  const escapedTarget = target.replaceAll("'", "''");
  return `$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class WokeyCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Read(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Write(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("advapi32", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Delete(string target, UInt32 type, UInt32 flags);
  [DllImport("advapi32", SetLastError=true)] public static extern void CredFree(IntPtr buffer);
}
'@
$target='${escapedTarget}'
try {
  if ('${operation}' -eq 'read') {
    $ptr=[IntPtr]::Zero
    if (-not [WokeyCred]::Read($target,1,0,[ref]$ptr)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }; exit 2 }
    try { $c=[Runtime.InteropServices.Marshal]::PtrToStructure($ptr,[type][WokeyCred+CREDENTIAL]); $b=New-Object byte[] $c.CredentialBlobSize; if ($b.Length) {[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$b.Length)}; [Console]::Out.Write([Convert]::ToBase64String($b)) } finally { [WokeyCred]::CredFree($ptr) }
  } elseif ('${operation}' -eq 'write') {
    $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
    try { if ($b.Length) {[Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)}; $c=New-Object WokeyCred+CREDENTIAL; $c.Type=1; $c.TargetName=$target; $c.CredentialBlobSize=$b.Length; $c.CredentialBlob=$p; $c.Persist=2; $c.UserName='${KEYRING_ACCOUNT}'; if (-not [WokeyCred]::Write([ref]$c,0)) { exit 2 } } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($p) }
  } else { if (-not [WokeyCred]::Delete($target,1,0)) { if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }; exit 2 } }
} catch { exit 2 }
`;
}

function assertNativeSuccess(result: NativeCommandResult): void {
  if (result.code !== 0) throw new Error('jimeng_credential_store_failed');
}

function trimSingleTrailingNewline(value: Buffer): Buffer {
  if (value.at(-1) === 0x0a) {
    const end = value.at(-2) === 0x0d ? value.length - 2 : value.length - 1;
    return value.subarray(0, end);
  }
  return value;
}

function runNativeCommand(
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: Buffer; timeoutMs: number },
): Promise<NativeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Prevent macOS `security -w` from reopening an interactive /dev/tty;
      // the secret and its confirmation must be consumed from the stdin pipe.
      detached: process.platform === 'darwin',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: NativeCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_SECRET_BYTES) {
        child.kill();
        finish(new Error('jimeng_credential_store_output_too_large'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk));
    child.once('error', finish);
    child.once('exit', (code) => finish(undefined, { code: code ?? 2, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    child.stdin.end(options.input);
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('jimeng_credential_store_timeout'));
    }, options.timeoutMs);
    timer.unref?.();
  });
}
