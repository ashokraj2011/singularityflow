#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeTypeScriptFlags } from './typescript-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [modulePath, ...moduleArguments] = process.argv.slice(2);
if (!modulePath) throw new Error('Usage: node scripts/run-typescript-module.mjs <module.ts|module.mjs> [arguments...]');

const result = spawnSync(process.execPath, [
  ...nodeTypeScriptFlags(root), modulePath, ...moduleArguments
], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });

if (result.error) throw result.error;
if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exitCode = result.status ?? 1;
}
