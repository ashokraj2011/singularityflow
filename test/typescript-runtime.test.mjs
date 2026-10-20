import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { nodeTypeScriptFlags } from '../scripts/typescript-runtime.mjs';

test('TypeScript source execution uses the bounded loader throughout supported Node 20', () => {
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '20.0.0'), [
    '--experimental-loader', pathToFileURL(path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')).href
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '20.20.2'), [
    '--experimental-loader', pathToFileURL(path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')).href
  ]);
});

test('TypeScript source execution selects native stripping only when Node provides it', () => {
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '22.5.1'), [
    '--experimental-loader', pathToFileURL(path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')).href
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '22.6.0'), [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning'
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '24.1.0'), [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning'
  ]);
  assert.throws(() => nodeTypeScriptFlags('/fixture', '19.9.0'), /Node\.js 20 or newer/);
});

test('loader URLs round-trip native paths with spaces, percent signs and fragment characters', () => {
  const root = path.resolve('fixture with spaces % #');
  const flags = nodeTypeScriptFlags(root, '20.20.2');
  assert.equal(flags[1], pathToFileURL(path.join(root, 'scripts', 'typescript-test-loader.mjs')).href);
  assert.equal(new URL(flags[1]).protocol, 'file:');
  assert.match(flags[1], /%20/u);
  assert.match(flags[1], /%25/u);
  assert.match(flags[1], /%23/u);
});

test('the compatibility loader actually executes TypeScript through a URL on the native host', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow loader % #-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'typed value % #.ts');
  await writeFile(fixture, 'export const value: number = 42;\n');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [...nodeTypeScriptFlags(root, '20.20.2'),
    '--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(fixture).href)})).value)`],
  { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42');
});
