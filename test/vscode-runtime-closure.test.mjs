/**
 * VS Code's runtimes never bundle the CLI (2026-11-26, itw-all2): state.mjs, which the gateway runtime bundles, loaded a
 * refactor's code-step gate, whose `work behaviour` path imported task-amendment.mjs and from there src/cli.mjs and the
 * installer script, whose top-level await esbuild refuses in a CommonJS bundle, and the extension did not build. The gate
 * stays in refactor-behaviour.mjs and the person's choice in refactor-behaviour-decide.mjs, which only the CLI loads.
 *
 * This builds the extension as `cd apps/vscode && node esbuild.mjs` does, into a folder of its own, and reads each
 * runtime's source map: no runtime reaches the CLI, the installer script or the task-change code.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEVER = Object.freeze(['src/cli.mjs', 'scripts/install-staged-artifacts.mjs', 'src/task-amendment.mjs', 'src/refactor-behaviour-decide.mjs']);

test('no VS Code runtime, the gateway runtime among them, bundles the CLI, the installer script or the task-change code', { timeout: 300_000 }, async (t) => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-closure-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const built = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: path.join(root, 'apps', 'vscode'), encoding: 'utf8', timeout: 240_000,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_VSCODE_TEST_OUTDIR: out } });
  assert.equal(built.status, 0, `the extension builds: ${built.stderr.slice(-2000)}`);
  const maps = (await readdir(out)).filter((name) => name.endsWith('.cjs.map')).sort();
  assert.ok(maps.includes('gateway-runtime.cjs.map'), maps.join(', '));
  const reached = [];
  for (const name of maps) {
    const { sources = [] } = JSON.parse(await readFile(path.join(out, name), 'utf8'));
    const files = sources.map((source) => path.relative(root, path.resolve(out, source)).split(path.sep).join('/'));
    if (name === 'gateway-runtime.cjs.map') assert.ok(files.includes('src/state.mjs'), 'the gateway runtime bundles the Story kernel, as this guards');
    for (const file of files) if (NEVER.includes(file)) reached.push(`${name}: ${file}`);
  }
  assert.deepEqual(reached, []);
});
