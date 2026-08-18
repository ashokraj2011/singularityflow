import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  attemptRepair, authorizeRepair, cancelRepair, diagnoseFault, effectiveRepairPolicy, faultRepairStateRoot,
  createFaultRepairApi, listFaults, readRepair, reportFault, requestRepair, sanitizeFaultText, wrapCommandWithFaultRepair
} from '../src/fault-repair.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-fault-repair-'));
  t.after(async () => {
    // Git worktree metadata points into this directory; the OS temp cleaner removes it later.
  });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fault Test');
  git(root, 'config', 'user.email', 'fault@example.test');
  await writeFile(path.join(root, 'value.txt'), 'wrong\n');
  git(root, 'add', 'value.txt');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

function envelope(extra = {}) {
  return {
    source: 'test-runner', environment: 'local', severity: 'high',
    occurredAt: '2026-08-18T00:00:00.000Z', correlationId: 'build-19:test-3',
    failure: {
      type: 'unit-test', command: 'node verify.mjs', commandArgv: ['node', 'verify.mjs'],
      exitCode: 1, message: 'expected right, received wrong'
    },
    ...extra
  };
}

async function allStoredText(directory) {
  const parts = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) parts.push(await readFile(target, 'utf8'));
    }
  }
  await walk(directory);
  return parts.join('\n');
}

test('fault intake is immutable, idempotent, redacted, grouped, and leaves the checkout clean', async (t) => {
  const root = await repository(t);
  const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890';
  const first = await reportFault(root, envelope({
    idempotencyKey: 'run-19',
    failure: { ...envelope().failure, message: `token=${secret} Authorization: Bearer bearer-value` },
    evidence: [{ type: 'stderr', inline: `failed with password=hunter2 ${secret}`, mediaType: 'text/plain' }]
  }));
  const second = await reportFault(root, envelope({
    idempotencyKey: 'run-19',
    failure: { ...envelope().failure, message: `token=${secret} Authorization: Bearer bearer-value` },
    evidence: [{ type: 'stderr', inline: `failed with password=hunter2 ${secret}`, mediaType: 'text/plain' }]
  }));
  assert.equal(second.fault.faultId, first.fault.faultId);
  assert.equal(second.idempotent, true);
  assert.equal(first.fault.redaction.applied, true);
  assert.match(first.fault.failure.message, /\[REDACTED/);
  assert.doesNotMatch(await allStoredText(faultRepairStateRoot(root)), /hunter2|bearer-value|github_pat_/);
  assert.equal(git(root, 'status', '--short'), '');

  const occurrence = await reportFault(root, envelope({
    correlationId: 'build-19:test-4',
    failure: { ...envelope().failure, message: `token=${secret} Authorization: Bearer bearer-value` }
  }));
  assert.equal(occurrence.fault.signature, first.fault.signature);
  assert.equal(occurrence.fault.occurrenceGroup, first.fault.occurrenceGroup);
  assert.equal((await listFaults(root)).length, 2);

  await assert.rejects(
    reportFault(root, envelope({ idempotencyKey: 'run-19', severity: 'critical' })),
    (error) => error.code === 'FAULT_IDEMPOTENCY_CONFLICT'
  );
  await assert.rejects(reportFault(root, { ...envelope(), schemaVersion: 2 }),
    (error) => error.code === 'FAULT_SCHEMA_UNSUPPORTED');
});

test('redaction covers common credential shapes before storage', () => {
  const result = sanitizeFaultText('password=hunter2 sk-abcdefghijklmnopq https://user:pass@example.test');
  assert.doesNotMatch(result.text, /hunter2|sk-abcdefghijklmnopq|user:pass/);
  assert.deepEqual(result.redactions.map((entry) => entry.rule), ['assignment', 'openai-token', 'url-credentials']);
});

test('local evidence is repository-bounded and the API returns the documented fault shape', async (t) => {
  const root = await repository(t);
  const outside = path.join(os.tmpdir(), `outside-fault-${Date.now()}.log`);
  await writeFile(outside, 'outside\n');
  await assert.rejects(reportFault(root, envelope({
    evidence: [{ type: 'log', localPath: outside, mediaType: 'text/plain' }]
  })), (error) => error.code === 'FAULT_EVIDENCE_PATH_UNSAFE');
  const api = createFaultRepairApi(root);
  const fault = await api.fault.report(envelope({ correlationId: 'api' }));
  assert.match(fault.faultId, /^FLT-/);
  assert.equal(fault.recordType, 'fault-envelope');
});

test('diagnosis is model-free and production/security policy cannot authorize mutation', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope());
  const diagnosis = await diagnoseFault(root, reported.fault.faultId);
  assert.equal(diagnosis.provenance.mode, 'deterministic');
  assert.equal(diagnosis.provenance.model, null);
  assert.deepEqual(diagnosis.hypotheses, []);

  for (const constrained of [
    { ...reported.fault, environment: 'production' },
    { ...reported.fault, failure: { ...reported.fault.failure, type: 'security' } }
  ]) {
    const effective = effectiveRepairPolicy(constrained, { boundedAuto: true }, { mode: 'bounded-auto' });
    assert.equal(effective.ceiling, 'diagnose');
  }
});

test('guided repair binds exact authorization, scopes patches, isolates bytes, and verifies before resolution', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'developer-notes.txt'), 'preserve me\n');
  const originalStatus = git(root, 'status', '--short');
  const remoteRefs = git(root, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/remotes');
  const reported = await reportFault(root, envelope({
    failure: { ...envelope().failure, commandArgv: null }
  }));
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'],
    verification: [[process.execPath, '-e', "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='right'?0:1)"]]
  });
  assert.equal(requested.repair.status, 'awaiting-authorization');
  const hash = requested.plan.integrity.sha256;

  await assert.rejects(authorizeRepair(root, requested.repair.repairId, { confirmation: 'wrong' }),
    (error) => error.code === 'REPAIR_CONFIRMATION_MISMATCH');
  assert.equal(git(root, 'branch', '--list', `sflow/repair/${requested.repair.repairId.toLowerCase()}`), '');

  const authorized = await authorizeRepair(root, requested.repair.repairId, { confirmation: hash });
  assert.equal(authorized.repair.status, 'awaiting-patch');
  assert.equal(git(root, 'status', '--short'), originalStatus);
  assert.equal(await readFile(path.join(root, 'developer-notes.txt'), 'utf8'), 'preserve me\n');

  const outside = path.join(root, 'outside.patch');
  await writeFile(outside, 'diff --git a/other.txt b/other.txt\n--- a/other.txt\n+++ b/other.txt\n@@ -1 +1 @@\n-old\n+new\n');
  await assert.rejects(attemptRepair(root, requested.repair.repairId, { patchFile: outside }),
    (error) => error.code === 'REPAIR_SCOPE_VIOLATION');
  assert.equal((await readRepair(root, requested.repair.repairId)).status, 'awaiting-patch');

  const patch = path.join(root, 'candidate.patch');
  await writeFile(patch, 'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-wrong\n+right\n');
  const attempted = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
  assert.equal(attempted.repair.status, 'resolved');
  assert.equal(attempted.receipt.finalDisposition, 'resolved');
  assert.equal(attempted.receipt.occurrenceGroup, reported.fault.occurrenceGroup);
  assert.equal(attempted.receipt.authoritySnapshot, reported.fault.identity.authoritySnapshot);
  assert.equal(attempted.receipt.diagnosis.provenance.model, null);
  assert.equal(attempted.receipt.attempts[0].verification[0].status, 'passed');
  assert.equal(attempted.receipt.preservation.developerWorktree, 'untouched');
  assert.equal(await readFile(path.join(root, 'value.txt'), 'utf8'), 'wrong\n');
  const finalStatus = git(root, 'status', '--short').split('\n').sort();
  assert.deepEqual(finalStatus, ['?? candidate.patch', '?? developer-notes.txt', '?? outside.patch']);
  assert.equal(git(root, 'for-each-ref', '--format=%(refname):%(objectname)', 'refs/remotes'), remoteRefs);
});

test('each guided retry requires a fresh authorization and cancellation preserves its workspace', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope());
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'],
    verification: [[process.execPath, '-e', "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='right'?0:1)"]]
  });
  const planHash = requested.plan.integrity.sha256;
  await authorizeRepair(root, requested.repair.repairId, { confirmation: planHash });
  const patch = path.join(root, 'still-failing.patch');
  await writeFile(patch, 'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-wrong\n+still-wrong\n');

  const first = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
  assert.equal(first.repair.status, 'retry-ready');
  await assert.rejects(
    attemptRepair(root, requested.repair.repairId, { patchFile: patch }),
    (error) => error.code === 'REPAIR_STATE_INVALID'
  );

  const reauthorized = await authorizeRepair(root, requested.repair.repairId, { confirmation: planHash });
  assert.equal(reauthorized.repair.status, 'awaiting-patch');
  const stopped = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
  assert.equal(stopped.repair.status, 'needs-human');
  assert.equal(stopped.repair.stopReason, 'no-progress');

  const workspace = stopped.repair.workspace.path;
  const cancelled = await cancelRepair(root, requested.repair.repairId, { reason: 'developer will repair manually' });
  assert.equal(cancelled.repair.status, 'cancelled');
  assert.equal(cancelled.receipt.preservation.isolatedWorktree, 'preserved');
  assert.equal(await readFile(path.join(workspace, 'value.txt'), 'utf8'), 'still-wrong\n');
});

test('bounded auto fails closed when no approved autonomous adapter is installed', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope());
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'bounded-auto', allowedPaths: ['value.txt'], verification: [['node', '--version']],
    policy: { boundedAuto: true, environmentCeilings: { local: 'bounded-auto' } }
  });
  assert.equal(requested.repair.status, 'needs-human');
  assert.equal(requested.repair.stopReason, 'adapter-authorization-required');
  assert.equal(requested.repair.workspace, null);
});

test('intent faults open a challenge disposition and never create a repair workspace', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope({
    failure: { ...envelope().failure, type: 'requirement', message: 'approved intent contradicts observed behavior' }
  }));
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  });
  assert.equal(requested.repair.status, 'challenge-opened');
  assert.equal(requested.repair.workspace, null);
  assert.equal(requested.repair.finalDisposition.status, 'challenge-opened');
});

test('command wrapper records failures and recursion guard prevents a child repair', async (t) => {
  const root = await repository(t);
  const prior = process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION;
  const priorRepair = process.env.SINGULARITY_FLOW_REPAIR_ID;
  process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION = '1';
  process.env.SINGULARITY_FLOW_REPAIR_ID = 'RPR-PARENT';
  try {
    const result = await wrapCommandWithFaultRepair(root, [process.execPath, '-e', 'process.exit(7)'], { echo: false });
    assert.equal(result.exitCode, 7);
    assert.equal(result.nested, true);
    assert.ok(result.fault.faultId.startsWith('FLT-'));
    assert.equal(result.fault.parentRepairId, 'RPR-PARENT');
    assert.equal(result.repair, null);
  } finally {
    if (prior == null) delete process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION;
    else process.env.SINGULARITY_FLOW_REPAIR_NO_RECURSION = prior;
    if (priorRepair == null) delete process.env.SINGULARITY_FLOW_REPAIR_ID;
    else process.env.SINGULARITY_FLOW_REPAIR_ID = priorRepair;
  }
});

test('Home promotes a redacted fault repair without displacing interrupted publication recovery', () => {
  const empty = {
    'recovery-required': [], 'waiting-on-you': [], active: [],
    'waiting-on-others': [], 'recently-completed': []
  };
  const fault = {
    faultId: 'FLT-ABC', severity: 'high', source: 'ci', environment: 'ci', occurredAt: '2026-08-18T00:00:00Z',
    failure: { type: 'unit-test', message: 'redacted summary' }, disposition: 'recorded', repair: null
  };
  const home = homeOverviewResult({
    workspace: { id: 'w', name: 'Workspace' }, records: { groups: empty, items: [] }, faults: [fault], otherWorkspaces: 0
  });
  assert.equal(home.next[0].id, 'fault:fix:FLT-ABC');
  assert.equal(home.next[0].emphasis, 'primary');
  assert.equal(home.next[0].confirmation, 'ceremony');
  assert.equal(home.next[0].fallback.skill, '/sf-fix FLT-ABC');
  assert.equal(home.data.faults[0].summary, 'redacted summary');
  assert.equal(Object.hasOwn(home.data.faults[0], 'evidence'), false);

  const recovery = { id: 'WRK-9', kind: 'story', title: 'Recover', group: 'recovery-required', phase: 'release', blockers: [], rail: [], nextAction: null };
  const groups = { ...empty, 'recovery-required': [recovery] };
  const recovering = homeOverviewResult({
    workspace: { id: 'w', name: 'Workspace' }, records: { groups, items: [recovery] }, faults: [fault], otherWorkspaces: 0
  });
  assert.equal(recovering.next[0].id, 'home:work.continue');
  assert.equal(recovering.next[0].emphasis, 'primary');
  assert.equal(recovering.next.find((entry) => entry.id.startsWith('fault:fix')).emphasis, 'secondary');
  assert.equal(recovering.next.filter((entry) => entry.emphasis === 'primary').length, 1);
});
