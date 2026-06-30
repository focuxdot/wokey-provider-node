#!/usr/bin/env node
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const rootDir = process.env.ROOT_DIR || join(import.meta.dirname, '..');

await rm(join(rootDir, 'dist'), { force: true, recursive: true });
