import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv[2] ?? 'all';
const SUITES = ['all', 'cli', 'vscode'];
if (!SUITES.includes(suite)) throw new Error(`Test suite must be one of: ${SUITES.join(', ')}.`);

/**
 * The VS Code extension is TypeScript, and its tests import the sources directly under
 * `--experimental-strip-types` rather than a built bundle — so they test what ships. Type stripping
 * arrived in Node 22.6, while this package supports Node 20, so the flag is added only when a
 * stripping test is actually selected and the running Node can do it.
 */
const [major, minor] = process.versions.node.split('.').map(Number);
const canStripTypes = major > 22 || (major === 22 && minor >= 6);

const files = (await readdir(path.join(root, 'test')))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();

const selected = [];
const skipped = [];
let needsStripping = false;
for (const name of files) {
  const relative = path.posix.join('test', name);
  const source = await readFile(path.join(root, relative), 'utf8');
  const kind = source.includes('apps/vscode') ? 'vscode' : 'cli';
  if (suite !== 'all' && suite !== kind) continue;
  if (kind === 'vscode' && !canStripTypes) { skipped.push(relative); continue; }
  if (kind === 'vscode') needsStripping = true;
  selected.push(relative);
}

if (skipped.length) {
  // Reported rather than silently dropped: a suite that quietly covers less than it claims is how a
  // regression ships green.
  console.warn(`Skipping ${skipped.length} VS Code test file(s) on Node ${process.versions.node}; type stripping needs Node 22.6 or newer: ${skipped.join(', ')}`);
}
if (!selected.length) {
  if (skipped.length) process.exit(0);
  throw new Error(`No ${suite} tests were discovered.`);
}

const flags = needsStripping ? ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'] : [];

const result = spawnSync(process.execPath, [...flags, '--test', ...selected], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
process.exitCode = result.status ?? 1;
