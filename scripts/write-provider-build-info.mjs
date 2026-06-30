#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const rootDir = process.env.ROOT_DIR || process.cwd();
const outputPath = process.env.PROVIDER_NODE_BUILD_INFO_PATH
  || join(rootDir, 'dist', 'provider-node', 'build-info.json');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const commit = process.env.PROVIDER_NODE_GIT_COMMIT || git(['rev-parse', '--short=12', 'HEAD']) || 'unknown';
const dirty = process.env.PROVIDER_NODE_GIT_DIRTY
  ? process.env.PROVIDER_NODE_GIT_DIRTY === '1'
  : git(['status', '--porcelain']).length > 0;
const buildHash = process.env.PROVIDER_NODE_BUILD_HASH || `${commit}${dirty ? '-dirty' : ''}`;

const info = {
  version: pkg.version,
  buildHash,
  gitCommit: commit,
  dirty,
  builtAt: process.env.PROVIDER_NODE_BUILD_AT || new Date().toISOString(),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(info, null, 2)}\n`);
console.log(`Wrote Provider Node build info: ${outputPath}`);
