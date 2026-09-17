import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { run } from '../src/util.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ready-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'ready-command', version: '1.0.0', private: true,
    packageManager: 'npm@10.8.0',
    scripts: { build: 'node -e ""', test: 'node --test' }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'ready-command', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'ready-command', version: '1.0.0' } }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'sample.test.mjs'), 'import test from "node:test"; test("ok", () => {});\n');
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Ready Command'], { cwd: root });
  run('git', ['config', 'user.email', 'ready@example.test'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

test('precheck dependency-test scope previews only locked dependencies and existing tests', async (t) => {
  const root = await repository(t);
  const result = spawnSync(process.execPath, [cli,
    'precheck', '--run', '--scope', 'dependency-test', '--json'
  ], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.operation.id, 'precheck.run.plan');
  assert.equal(payload.effects.stateChanged, false);
  assert.match(payload.data.plan.planId, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(payload.data.plan.scope, 'dependency-test');
  assert.deepEqual(payload.data.plan.commands.map((command) => command.purpose), ['dependency', 'test']);
  assert.deepEqual(payload.data.plan.commands[0].argv, ['npm', 'ci']);
  assert.equal(payload.data.plan.structuredTestContract.status, 'available');
  assert.equal(payload.next[0].skill, '/sf-ready');
  assert.equal(payload.next[0].copilotCommand, '/sf-ready');
  assert.match(payload.next[0].command, new RegExp(payload.data.plan.planId, 'u'));
  assert.match(payload.next[0].command, /--scope dependency-test/u);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');
});

test('precheck defaults to the safe dependency-test scope', async (t) => {
  const root = await repository(t);
  const result = spawnSync(process.execPath, [cli, 'precheck', '--run', '--json'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.plan.scope, 'dependency-test');
  assert.deepEqual(payload.data.plan.commands.map((command) => command.purpose),
    ['dependency', 'test']);
});

test('precheck execution refuses a non-current plan digest before any command runs', async (t) => {
  const root = await repository(t);
  const result = spawnSync(process.execPath, [cli,
    'precheck', '--run', '--scope', 'dependency-test',
    '--confirm-plan', `sha256:${'0'.repeat(64)}`, '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /REPOSITORY_READINESS_CONFIRMATION_MISMATCH|confirmation must equal/u);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');
});

test('precheck refuses an unknown readiness scope before running repository commands', async (t) => {
  const root = await repository(t);
  const result = spawnSync(process.execPath, [cli,
    'precheck', '--run', '--scope', 'everything', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /scope.*full.*dependency-test|REPOSITORY_READINESS_SCOPE_INVALID/iu);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');
});
