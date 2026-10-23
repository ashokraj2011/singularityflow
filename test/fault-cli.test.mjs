import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
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
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: 'utf8',
    // A developer's selected workspace must not redirect this isolated CLI fixture to another
    // checkout. The selection file is intentionally absent; no machine state is modified.
    env: {
      ...process.env,
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json')
    }
  });
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
  assert.match(previewEnvelope.next[0].command, /--verify-argv <JSON-ARGV>$/u);
  assert.doesNotMatch(previewEnvelope.next[0].command, /\["node"/u);
  assert.equal(git(root, 'status', '--short'), '');

  const structured = invoke(root, [
    'fix', fault.faultId, '--plan-only', '--allow-path', 'README.md',
    '--verify-argv', JSON.stringify(['C:\\Program Files\\nodejs\\node.exe', '--version']), '--json'
  ]);
  assert.equal(structured.status, 0, structured.stderr);
  assert.deepEqual(JSON.parse(structured.stdout).data.plan.verification[0].argv,
    ['C:\\Program Files\\nodejs\\node.exe', '--version']);
});

test('a repair awaiting its patch names the one patch file to write, in its attempt action', async () => {
  const root = await fixture();
  const { authorizeRepair, reportFault, requestRepair } = await import('../src/fault-repair.mjs');
  const reported = await reportFault(root, { source: 'test-runner', environment: 'local', severity: 'high',
    failure: { type: 'unit-test', command: 'node --version', commandArgv: ['node', '--version'], exitCode: 1, message: 'failed' } });
  const requested = await requestRepair(root, reported.fault.faultId, { mode: 'guided', allowedPaths: ['README.md'],
    verification: [[process.execPath, '--version']] });
  const before = JSON.parse(invoke(root, ['repair', 'status', requested.repair.repairId, '--json']).stdout);
  assert.doesNotMatch(JSON.stringify(before.next), /patch-drafts/u, 'nothing to write before authorization');
  await authorizeRepair(root, requested.repair.repairId, { confirmation: requested.plan.integrity.sha256 });
  const status = invoke(root, ['repair', 'status', requested.repair.repairId, '--json']);
  assert.equal(status.status, 0, status.stderr);
  const command = JSON.parse(status.stdout).next[0].command;
  const prefix = `singularity-flow repair attempt ${requested.repair.repairId} --patch `;
  assert.ok(command.startsWith(prefix), command);
  const draft = command.slice(prefix.length).replace(/^'(.*)'$/u, '$1');
  assert.ok(path.isAbsolute(draft), draft);
  assert.equal(path.basename(path.dirname(draft)), 'patch-drafts');
  assert.equal(path.basename(draft), `${requested.repair.repairId}.patch`);
  assert.ok((await stat(path.dirname(draft))).isDirectory(), 'the kernel prepares only the draft\'s parent');
  await assert.rejects(stat(draft), { code: 'ENOENT' });
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
