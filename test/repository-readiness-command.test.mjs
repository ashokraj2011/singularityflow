import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { run } from '../src/util.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

test('an empty repository records no-command readiness in one invocation, without pretending tests ran', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ready-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['-c', 'user.name=Readiness', '-c', 'user.email=ready@example.test',
    'commit', '--allow-empty', '-qm', 'empty base'], { cwd: root });
  const result = spawnSync(process.execPath, [cli, 'precheck', '--run', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.operation.id, 'precheck.run.execute');
  assert.equal(payload.data.execution, 'no-commands-applicable');
  assert.equal(payload.data.receipt.status, 'pass');
  assert.deepEqual(payload.data.receipt.commandResults, []);
  assert.deepEqual(payload.data.receipt.testObservations, []);
  const { collectRepositoryReadinessEvidence } = await import('../src/repository-readiness-evidence.mjs');
  run('git', ['-c', 'user.name=Readiness', '-c', 'user.email=ready@example.test',
    'commit', '--allow-empty', '-qm', 'new base'], { cwd: root });
  const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const entries = [{ id: 'lifecycle', root, baseCommit }];
  assert.equal((await collectRepositoryReadinessEvidence(entries)).repositories.lifecycle.status, 'missing');
  const preview = (await collectRepositoryReadinessEvidence(entries, { previewEmpty: true })).repositories.lifecycle;
  assert.equal(preview.status, 'no-commands-applicable');
  assert.equal(preview.receiptSha256, null, 'a preview is not execution evidence');
  assert.equal((await collectRepositoryReadinessEvidence(entries)).repositories.lifecycle.status, 'missing');
  assert.equal((await collectRepositoryReadinessEvidence(entries, { recordEmpty: true })).repositories.lifecycle.status, 'pass');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, '');
  run('git', ['-c', 'user.name=Readiness', '-c', 'user.email=ready@example.test',
    'commit', '--allow-empty', '-qm', 'isolated Story base'], { cwd: root });
  await writeFile(path.join(root, 'unrelated.txt'), 'preserve outside the new Story');
  const dirtyBase = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const isolated = await collectRepositoryReadinessEvidence([{ id: 'lifecycle', root, baseCommit: dirtyBase }], { recordEmpty: true });
  assert.equal(isolated.repositories.lifecycle.status, 'pass', 'no-command evidence covers only the clean tracked base');
  assert.equal(await readFile(path.join(root, 'unrelated.txt'), 'utf8'), 'preserve outside the new Story');
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  run('git', ['-c', 'user.name=Readiness', '-c', 'user.email=ready@example.test',
    'commit', '--allow-empty', '-qm', 'untracked executable input'], { cwd: root });
  const unsafe = await collectRepositoryReadinessEvidence([{ id: 'lifecycle', root,
    baseCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim() }], { recordEmpty: true });
  assert.notEqual(unsafe.repositories.lifecycle.status, 'pass', 'a newly discovered command cannot run implicitly');
});

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

test('selected-base CLI plans and executes exact tests without using dirty open-Story input', async (t) => {
  const root = await repository(t);
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  const base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'open-story');
  await writeFile(path.join(root, 'sample.test.mjs'), 'throw new Error("dirty Story test must not run");\n');
  const runBaseline = args => {
    const result = spawnSync(process.execPath, [cli, 'precheck', '--run', '--base-commit', base,
      '--scope', 'dependency-test', '--json', ...args], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const preview = runBaseline([]);
  assert.equal(preview.operation.classification, 'read');
  assert.equal(preview.data.plan.sourceCommit, base);
  assert.ok(preview.next.some(action => action.command.includes(`--base-commit ${base}`)));
  const result = runBaseline(['--confirm-plan', preview.data.plan.planId]);
  assert.equal(result.data.receipt.status, 'pass');
  assert.equal(result.data.receipt.sourceCommit, base);
  assert.equal(git('branch', '--show-current'), 'open-story');
  assert.match(await readFile(path.join(root, 'sample.test.mjs'), 'utf8'), /dirty Story/);
  assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
});

test('no-command readiness binds the selected base across governance-only changes, never changed code', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ready-selected-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, { cwd: root }).stdout.trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Readiness');
  git('config', 'user.email', 'readiness@example.test');
  git('commit', '--allow-empty', '-qm', 'empty application');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-q', '-c', 'configuration-review');
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 1\n');
  git('add', '.');
  git('commit', '-qm', 'governance only');
  const original = git('rev-parse', 'HEAD');
  const { collectRepositoryReadinessEvidence } = await import('../src/repository-readiness-evidence.mjs');
  const entries = [{ id: 'repo', root, baseCommit: base }];
  const preview = (await collectRepositoryReadinessEvidence(entries, { previewEmpty: true })).repositories.repo;
  assert.equal(preview.status, 'no-commands-applicable');
  assert.equal(preview.sourceCommit, base);
  assert.equal((await collectRepositoryReadinessEvidence(entries)).repositories.repo.status, 'missing');
  const recorded = (await collectRepositoryReadinessEvidence(entries, { recordEmpty: true })).repositories.repo;
  assert.equal(recorded.status, 'pass');
  assert.equal(recorded.sourceCommit, base);
  assert.deepEqual(recorded.commandResults, []);
  assert.equal(git('rev-parse', 'HEAD'), original);
  assert.equal(git('branch', '--show-current'), 'configuration-review');
  assert.equal(git('status', '--porcelain'), '');
  const { inspectRepositoryReadinessReceipt } = await import('../src/initialization/runtime-readiness.mjs');
  git('switch', '-q', 'main');
  assert.equal((await inspectRepositoryReadinessReceipt(root, { scope: 'dependency-test' })).status, 'pass',
    'the same plan recomputes when the exact base is later checked out');
  await writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}');
  git('add', '.');
  git('commit', '-qm', 'application with tests');
  const codeBase = git('rev-parse', 'HEAD');
  git('switch', '-q', 'configuration-review');
  const unsafe = (await collectRepositoryReadinessEvidence([{ id: 'repo', root, baseCommit: codeBase }],
    { recordEmpty: true, previewEmpty: true })).repositories.repo;
  assert.equal(unsafe.status, 'missing', 'a manifest absent from this checkout must not be treated as absent from the selected base');
});

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
