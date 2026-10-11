/**
 * Every name the shipped JavaScript uses is defined.
 *
 * A removed declaration with a surviving use is a ReferenceError only on the path that reaches it,
 * and those paths can be rare: the terminal gate read `grounding.record` after the registered World
 * Model was removed, and failed only when the final phase had been authored by a governed agent;
 * `workspace prune` read a `compatibility` binding that an earlier refactor dropped. The TypeScript
 * checker reports such names (TS2304) over plain JavaScript without types, so this test runs it over
 * the CLI, its entry point and the plugin's scripts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Node globals the DOM library does not declare. Node's own `process` and `Buffer` are reported
// under a different code (TS2580), so they never reach this list.
const NODE_GLOBALS = new Set(['setImmediate', 'clearImmediate']);

function typescriptCompiler() {
  try { return createRequire(path.join(root, 'package.json')).resolve('typescript/bin/tsc'); }
  catch { return null; }
}

test('every name the CLI source, its entry point and the plugin scripts use is defined', { timeout: 180_000 }, async (t) => {
  const tsc = typescriptCompiler();
  if (!tsc) return t.skip('typescript is not installed');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-undefined-names-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'tsconfig.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true, types: [],
      target: 'es2023', lib: ['es2023', 'dom'], module: 'nodenext', moduleResolution: 'nodenext',
      maxNodeModuleJsDepth: 0
    },
    include: ['src/**/*.mjs', 'bin/*.mjs', 'plugin/**/*.mjs']
      .filter((pattern) => existsSync(path.join(root, pattern.split('/')[0])))
      .map((pattern) => path.join(root, pattern))
  }));
  const result = spawnSync(process.execPath, [tsc, '-p', config], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.equal(result.error, undefined, String(result.error));
  const undefinedNames = result.stdout.split('\n')
    .map((line) => line.match(/^(.+?)\((\d+),\d+\): error TS2304: Cannot find name '([^']+)'/u))
    .filter((match) => match && !NODE_GLOBALS.has(match[3]))
    .map(([, file, line, name]) => `${path.relative(root, file)}:${line} ${name}`);
  assert.ok(result.stdout.includes('error TS'), 'the checker ran and reported its usual type findings');
  assert.deepEqual(undefinedNames, [], `undefined names would throw ReferenceError when reached:\n${undefinedNames.join('\n')}`);
});

test('workspace prune reports what it removed', async (t) => {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-prune-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'singularity-flow.mjs'), '--no-model', 'workspace', 'prune', '--json'], {
    cwd: state, encoding: 'utf8',
    env: {
      ...process.env, HOME: state, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(state, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json')
    }
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout).removed, []);
});
