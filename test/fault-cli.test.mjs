import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fault-cli-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CLI Test');
  git(root, 'config', 'user.email', 'cli@example.test');
  await writeFile(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

function invoke(root, args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

test('fault report/list/show and fix preview are reachable through the public CLI', async () => {
  const root = await fixture();
  const reported = invoke(root, [
    'fault', 'report', '--source', 'ci', '--environment', 'ci', '--type', 'unit-test',
    '--message', 'test failed', '--json'
  ]);
  assert.equal(reported.status, 0, reported.stderr);
  const reportedEnvelope = JSON.parse(reported.stdout);
  assert.equal(reportedEnvelope.resultType, 'command-result');
  assert.equal(reportedEnvelope.effects.stateChanged, true);
  const fault = reportedEnvelope.data.fault;
  assert.match(fault.faultId, /^FLT-/);

  const listed = invoke(root, ['fault', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).data.faults[0].faultId, fault.faultId);

  const shown = invoke(root, ['fault', 'show', fault.faultId, '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).data.fault.integrity.sha256, fault.integrity.sha256);

  const preview = invoke(root, [
    'fix', fault.faultId, '--plan-only', '--allow-path', 'README.md', '--verify', 'node --version', '--json'
  ]);
  assert.equal(preview.status, 0, preview.stderr);
  const previewEnvelope = JSON.parse(preview.stdout);
  assert.equal(previewEnvelope.effects.stateChanged, false);
  const plan = previewEnvelope.data;
  assert.equal(plan.persisted, false);
  // The failure was observed in CI, but local review uses the fail-closed local execution ceiling.
  assert.equal(plan.repair.executionMode, 'diagnose');
  assert.equal(git(root, 'status', '--short'), '');

  const structured = invoke(root, [
    'fix', fault.faultId, '--plan-only', '--allow-path', 'README.md',
    '--verify-argv', JSON.stringify(['C:\\Program Files\\nodejs\\node.exe', '--version']), '--json'
  ]);
  assert.equal(structured.status, 0, structured.stderr);
  assert.deepEqual(JSON.parse(structured.stdout).data.plan.verification[0].argv,
    ['C:\\Program Files\\nodejs\\node.exe', '--version']);
});

test('fault report accepts structured command argv and unsigned Windows termination codes', async () => {
  const root = await fixture();
  const argv = ['C:\\Program Files\\nodejs\\node.exe', 'test.js'];
  const result = invoke(root, [
    'fault', 'report', '--source', 'windows-ci', '--environment', 'ci', '--type', 'runtime',
    '--command-argv', JSON.stringify(argv), '--exit-code', String(0xc0000005), '--json'
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fault = JSON.parse(result.stdout).data.fault;
  assert.deepEqual(fault.failure.commandArgv, argv);
  assert.equal(fault.failure.exitCode, 0xc0000005);
});

test('run --repair-on-fault preserves the command exit code and emits a structured fault', async () => {
  const root = await fixture();
  const result = invoke(root, [
    'run', '--repair-on-fault', '--json', '--', process.execPath, '-e', 'process.exit(7)'
  ]);
  assert.equal(result.status, 7, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.exitCode, 7);
  assert.match(payload.fault.faultId, /^FLT-/);
  assert.equal(payload.repair.status, 'diagnosis-ready');
  assert.equal(git(root, 'status', '--short'), '');
});
