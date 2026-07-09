#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const expectedVersion = pkg.version;

function assertMatch(path, pattern, label) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`${label} default version not found in ${path}`);
  }
  if (match[1] !== expectedVersion) {
    throw new Error(`${label} default version is ${match[1]}, expected ${expectedVersion}`);
  }
}

function assertNoAmbiguousPowerShellQueryInterpolation(path) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const match = /\$[A-Za-z_][A-Za-z0-9_]*\?/.exec(source);
  if (match) {
    throw new Error(
      `${path} contains ambiguous PowerShell interpolation before ?: ${match[0]}. ` +
        'Use $' +
        '{var}? or $($var)? so the query marker is not parsed as part of the variable name.',
    );
  }
}

assertMatch(
  'packaging/install.sh',
  /VERSION="\$\{WOKEY_PROVIDER_NODE_VERSION:-(\d+\.\d+\.\d+)\}"/,
  'shell installer',
);
assertMatch(
  'packaging/install.ps1',
  /\$Version = if \(\$env:WOKEY_PROVIDER_NODE_VERSION\) \{ \$env:WOKEY_PROVIDER_NODE_VERSION \} else \{ "(\d+\.\d+\.\d+)" \}/,
  'PowerShell installer',
);
assertNoAmbiguousPowerShellQueryInterpolation('packaging/install.ps1');

console.log(`Installer defaults match package version ${expectedVersion}`);
