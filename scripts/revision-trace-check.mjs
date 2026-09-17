#!/usr/bin/env node
/** The release preflight checks actual REV capabilities against the checked-in trace claim. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRevisionTraceManifest } from '../src/revision/trace-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'revision-trace-manifest.json'), 'utf8'));
  const report = await validateRevisionTraceManifest(manifest, { repositoryRoot: root });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`REV release trace failed: ${error.message}\n`);
  process.exitCode = 1;
}
