import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a blocked precheck plan explains the test-setup repair instead of ending with no next action', async (t) => {
  const root = await repository(t);
  const manifestFile = path.join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.scripts.test = 'node --test && playwright test';
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  run('git', ['add', 'package.json'], { cwd: root });
  run('git', ['commit', '-qm', 'composite test script'], { cwd: root });

  const result = spawnSync(process.execPath, [cli, 'precheck', '--run', '--json'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.plan.status, 'blocked');
  assert.equal(payload.outcome.messageId, 'precheck.run-blocked');
  assert.equal(payload.data.plan.structuredTestContract.status, 'missing');
  assert.equal(payload.next.length, 1);
  assert.equal(payload.next[0].id, 'precheck-repair-test-setup');
  assert.equal(payload.next[0].kind, 'remediation');
  assert.equal(payload.next[0].command, 'singularity-flow precheck --quick --json');
  assert.match(payload.next[0].label, /structured unit-test reporter/u);
  assert.equal(payload.next.some((step) => step.command.includes('--confirm-plan')), false);
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
