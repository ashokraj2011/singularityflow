import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  attemptRepair, authorizeRepair, cancelRepair, diagnoseFault, effectiveRepairPolicy, faultRepairStateRoot,
  createFaultRepairApi, listFaults, listRepairs, normalizeFaultRepairPolicy, readRepair, reportFault, requestRepair,
  parseVerificationArgv, parseVerificationCommand, sanitizeFaultText, verificationSandboxKind,
  wrapCommandWithFaultRepair
} from '../src/fault-repair.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { canonicalJson } from '../src/specifications.mjs';
import { initializeDefinition } from '../src/config.mjs';

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

test('an omitted occurredAt remains idempotent and abbreviated local commits are canonicalized', async (t) => {
  const root = await repository(t);
  const request = envelope({ occurredAt: undefined, idempotencyKey: 'without-time' });
  const first = await reportFault(root, request);
  const second = await reportFault(root, request);
  assert.equal(second.idempotent, true);
  assert.equal(second.fault.faultId, first.fault.faultId);

  const abbreviated = await reportFault(root, envelope({
    correlationId: 'short-sha',
    build: { id: 'short', commit: git(root, 'rev-parse', '--short=7', 'HEAD') }
  }));
  assert.equal(abbreviated.fault.build.commit, git(root, 'rev-parse', 'HEAD'));
  const repair = await requestRepair(root, abbreviated.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  });
  await assert.doesNotReject(authorizeRepair(root, repair.repair.repairId, {
    confirmation: repair.plan.integrity.sha256
  }));
});

test('redaction covers common credential shapes before storage', () => {
  const result = sanitizeFaultText('password=hunter2 sk-abcdefghijklmnopq https://user:pass@example.test');
  assert.doesNotMatch(result.text, /hunter2|sk-abcdefghijklmnopq|user:pass/);
  assert.deepEqual(result.redactions.map((entry) => entry.rule), ['assignment', 'openai-token', 'url-credentials']);

  for (const secret of [
    '{"token":"example-secret-value"}',
    '{"access_token":"example-secret-value"}',
    'client_secret=example-secret-value',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
    'postgres://user:password@example.test/database',
    'redis://:redis-password@example.test/0',
    'Endpoint=sb://example.test/;SharedAccessKey=service-bus-secret;',
    'Server=db;User Id=person;Password=connection-secret;'
  ]) {
    const sanitized = sanitizeFaultText(secret);
    assert.doesNotMatch(sanitized.text, /example-secret-value|signature|private-material|user:password|redis-password|service-bus-secret|connection-secret/);
    assert.ok(sanitized.redactions.length, secret);
  }

  const escaped = sanitizeFaultText(JSON.stringify({ nested: { token: 'prefix"still-secret' } }));
  assert.deepEqual(JSON.parse(escaped.text), { nested: { token: '[REDACTED]' } });
  assert.doesNotMatch(escaped.text, /still-secret/);
});

test('sandbox detection proves isolation works instead of trusting an installed binary', () => {
  const calls = [];
  const unusable = verificationSandboxKind({
    platform: 'linux',
    execute: (command, args) => {
      calls.push([command, args]);
      return { status: args.includes('--version') ? 0 : 1 };
    }
  });
  assert.equal(unusable, 'disposable-worktree-only');
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(([, args]) => args.includes('--unshare-net') && args.includes('--ro-bind')));
  assert.ok(calls.every(([, args]) => !args.includes('--version')));

  const usable = verificationSandboxKind({
    platform: 'linux',
    execute: (command, args) => ({
      status: command === '/usr/bin/bwrap' && args.includes('--unshare-net') ? 0 : 1
    })
  });
  assert.equal(usable, 'bubblewrap:/usr/bin/bwrap');
});

test('structured argv preserves Windows paths and exit codes accept the platform DWORD range', async (t) => {
  const expected = ['C:\\Program Files\\nodejs\\node.exe', '--version'];
  assert.deepEqual(parseVerificationCommand('"C:\\Program Files\\nodejs\\node.exe" --version'), expected);
  assert.deepEqual(parseVerificationArgv(JSON.stringify(expected)), expected);
  const root = await repository(t);
  const recorded = await reportFault(root, envelope({
    correlationId: 'windows-exit',
    failure: { ...envelope().failure, exitCode: 0xc0000005 }
  }));
  assert.equal(recorded.fault.failure.exitCode, 0xc0000005);
  await assert.rejects(reportFault(root, envelope({
    correlationId: 'invalid-windows-exit',
    failure: { ...envelope().failure, exitCode: 0x1_0000_0000 }
  })), (error) => error.code === 'FAULT_FIELD_INVALID');
});

test('a mutable occurrence group must pass integrity before a new immutable fault is written', async (t) => {
  const root = await repository(t);
  const first = await reportFault(root, envelope({ correlationId: 'group-first' }));
  const groupFile = path.join(faultRepairStateRoot(root), 'groups', `${first.fault.signature.slice(7)}.json`);
  const group = JSON.parse(await readFile(groupFile, 'utf8'));
  group.count = 9000;
  await writeFile(groupFile, `${JSON.stringify(group, null, 2)}\n`);
  await assert.rejects(
    reportFault(root, envelope({ correlationId: 'group-second' })),
    (error) => error.code === 'FAULT_RECORD_INTEGRITY_INVALID'
  );
  assert.equal((await listFaults(root)).length, 1);

  group.count = 1;
  group.occurrences = first.fault.faultId;
  delete group.integrity;
  group.integrity = {
    algorithm: 'sha256',
    sha256: createHash('sha256').update(canonicalJson(group)).digest('hex')
  };
  await writeFile(groupFile, `${JSON.stringify(group, null, 2)}\n`);
  await assert.rejects(
    reportFault(root, envelope({ correlationId: 'group-invalid-shape' })),
    (error) => error.code === 'FAULT_RECORD_INTEGRITY_INVALID'
  );
  assert.equal((await listFaults(root)).length, 1);
});

test('JSON and OAuth credentials are redacted before content-addressed evidence is persisted', async (t) => {
  const root = await repository(t);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwb2MifQ.signature';
  const recorded = await reportFault(root, envelope({
    correlationId: 'structured-secrets',
    failure: { ...envelope().failure, message: 'client_secret=oauth-secret' },
    evidence: [{
      type: 'stderr', mediaType: 'application/json',
      inline: JSON.stringify({ token: 'json-secret', access_token: 'oauth-token', jwt })
    }]
  }));
  assert.equal(recorded.fault.redaction.applied, true);
  const stored = await allStoredText(faultRepairStateRoot(root));
  assert.doesNotMatch(stored, /oauth-secret|json-secret|oauth-token|eyJhbGci/);
  assert.match(stored, /REDACTED/);
});

test('fault policy rejects scalar path and environment collections', () => {
  assert.throws(() => normalizeFaultRepairPolicy({ protectedPaths: 'singularity' }), /must be an array/);
  assert.throws(() => normalizeFaultRepairPolicy({ environmentCeilings: 'guided' }), /must be an object/);
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

test('the in-process API resolves governed policy and caller policy can only narrow it', async (t) => {
  const root = await repository(t);
  await initializeDefinition(root);
  const configuration = path.join(root, 'singularity', 'workflow.yml');
  const configured = (await readFile(configuration, 'utf8')).replace('maxAttempts: 3', 'maxAttempts: 1');
  await writeFile(configuration, configured);
  const api = createFaultRepairApi(root, { policy: { maxAttempts: 20 } });
  const fault = await api.fault.report(envelope({ correlationId: 'api-governed' }));
  const result = await api.repair.request({
    faultId: fault.faultId,
    mode: 'guided',
    allowedPaths: ['value.txt'],
    verification: [['node', '--version']]
  });
  assert.equal(result.plan.budgets.maxAttempts, 1);
  const ciFault = await api.fault.report(envelope({ correlationId: 'api-ci', environment: 'ci' }));
  const ciRepair = await api.repair.request({
    faultId: ciFault.faultId,
    allowedPaths: ['value.txt'],
    verification: [['node', '--version']]
  });
  assert.equal(ciRepair.repair.status, 'proposed');
  await assert.rejects(
    api.repair.request({ faultId: fault.faultId, allowedPaths: 'value.txt', verification: [] }),
    (error) => error.code === 'REPAIR_SCOPE_INVALID'
  );
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

test('diagnostic path hints never become repair authority without an explicit allow-path', async (t) => {
  const root = await repository(t);
  await writeFile(path.join(root, 'unrelated-dirty.txt'), 'not part of the repair\n');
  const reported = await reportFault(root, envelope());
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', verification: [['node', '--version']]
  });
  assert.ok(requested.diagnosis.affectedPaths.includes('unrelated-dirty.txt'));
  assert.deepEqual(requested.plan.allowedPaths, []);
  assert.equal(requested.repair.status, 'needs-human');
  assert.equal(requested.repair.stopReason, 'scope-required');
  await assert.rejects(requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['.'], verification: [['node', '--version']]
  }), (error) => error.code === 'REPAIR_SCOPE_INVALID');
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
  assert.notEqual(requested.plan.tools.externalFilesystem, 'denied');
  assert.match(requested.plan.tools.commandTrust, /explicit-plan-confirmation/);
  if (requested.plan.tools.sandbox !== 'disposable-worktree-only') {
    assert.equal(requested.plan.tools.externalFilesystem, 'host-read-permitted; external-writes-denied');
  }
  const hash = requested.plan.integrity.sha256;

  await assert.rejects(authorizeRepair(root, requested.repair.repairId, { confirmation: 'wrong' }),
    (error) => error.code === 'REPAIR_CONFIRMATION_MISMATCH');
  assert.equal(git(root, 'branch', '--list', `sflow/repair/${requested.repair.repairId.toLowerCase()}`), '');

  const authorized = await authorizeRepair(root, requested.repair.repairId, { confirmation: hash });
  assert.equal(authorized.repair.status, 'awaiting-patch');
  assert.equal(git(root, 'status', '--short'), originalStatus);
  assert.equal(await readFile(path.join(root, 'developer-notes.txt'), 'utf8'), 'preserve me\n');
  assert.equal((await readRepair(authorized.repair.workspace.path, requested.repair.repairId)).repairId, requested.repair.repairId);
  assert.equal((await listFaults(authorized.repair.workspace.path))[0].faultId, reported.fault.faultId);

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

test('authorization is anchored to the immutable plan rather than a rehashed state projection', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope());
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  });
  const stateFile = path.join(faultRepairStateRoot(root), 'repairs', requested.repair.repairId, 'state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.plan.allowedPaths.push('outside.txt');
  delete state.plan.integrity;
  state.plan.integrity = {
    algorithm: 'sha256',
    sha256: createHash('sha256').update(canonicalJson(state.plan)).digest('hex')
  };
  delete state.integrity;
  state.integrity = {
    algorithm: 'sha256',
    sha256: createHash('sha256').update(canonicalJson(state)).digest('hex')
  };
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(authorizeRepair(root, requested.repair.repairId, {
    confirmation: state.plan.integrity.sha256
  }), (error) => error.code === 'REPAIR_PLAN_CHANGED');
});

test('verification runs with a scrubbed environment in a disposable worktree', async (t) => {
  const root = await repository(t);
  const prior = process.env.REPAIR_TEST_SECRET;
  process.env.REPAIR_TEST_SECRET = 'must-not-leak';
  try {
    const reported = await reportFault(root, envelope({ failure: { ...envelope().failure, commandArgv: null } }));
    const requested = await requestRepair(root, reported.fault.faultId, {
      mode: 'guided', allowedPaths: ['value.txt'],
      verification: [[process.execPath, '-e', "const fs=require('fs');fs.writeFileSync('outside.txt','verifier');process.exit(process.env.REPAIR_TEST_SECRET?9:0)"]]
    });
    await authorizeRepair(root, requested.repair.repairId, { confirmation: requested.plan.integrity.sha256 });
    const patch = path.join(root, 'isolated.patch');
    await writeFile(patch, 'diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-wrong\n+right\n');
    const result = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
    assert.equal(result.repair.status, 'resolved', JSON.stringify(result.attempt.verification, null, 2));
    assert.equal(result.attempt.verification[0].status, 'passed');
    assert.equal(await readFile(path.join(result.repair.workspace.path, 'value.txt'), 'utf8'), 'right\n');
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8').catch(() => null), null);
    assert.doesNotMatch(await allStoredText(faultRepairStateRoot(root)), /must-not-leak/);
  } finally {
    if (prior == null) delete process.env.REPAIR_TEST_SECRET;
    else process.env.REPAIR_TEST_SECRET = prior;
  }
});

test('unsafe verifier programs are rejected before a plan is persisted', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope());
  await assert.rejects(requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['git', 'push', 'origin', 'HEAD']]
  }), (error) => error.code === 'REPAIR_VERIFICATION_UNSAFE');
  assert.equal((await listFaults(root))[0].repair, null);
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

test('new-file patches retain content-aware retry state', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope({ failure: { ...envelope().failure, commandArgv: null } }));
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['created.txt'],
    verification: [[process.execPath, '-e', 'process.exit(1)']]
  });
  await authorizeRepair(root, requested.repair.repairId, { confirmation: requested.plan.integrity.sha256 });
  const patch = path.join(root, 'new-file.patch');
  await writeFile(patch, 'diff --git a/created.txt b/created.txt\nnew file mode 100644\n--- /dev/null\n+++ b/created.txt\n@@ -0,0 +1 @@\n+created\n');
  const first = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
  assert.equal(first.repair.status, 'retry-ready');
  assert.deepEqual(first.attempt.changedPaths, ['created.txt']);
  await authorizeRepair(root, requested.repair.repairId, { confirmation: requested.plan.integrity.sha256 });
  const second = await attemptRepair(root, requested.repair.repairId, { patchFile: patch });
  assert.equal(second.repair.status, 'needs-human');
  assert.notEqual(second.repair.stopReason, 'unexpected-mutation');
});

test('a proposed CI repair can be reviewed and replanned in an authorized local context', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope({ environment: 'ci' }));
  const proposed = await requestRepair(root, reported.fault.faultId, {
    allowedPaths: ['value.txt'], verification: [['node', '--version']], executionEnvironment: 'ci'
  });
  assert.equal(proposed.repair.status, 'proposed');
  const repeated = await requestRepair(root, reported.fault.faultId, {
    allowedPaths: ['value.txt'], verification: [['node', '--version']], executionEnvironment: 'ci'
  });
  assert.equal(repeated.joined, true);
  assert.equal(repeated.repair.planGeneration, 1);
  const local = await requestRepair(root, reported.fault.faultId, {
    allowedPaths: ['value.txt'], verification: [['node', '--version']], executionEnvironment: 'local'
  });
  assert.equal(local.replanned, true);
  assert.equal(local.repair.repairId, proposed.repair.repairId);
  assert.equal(local.repair.status, 'awaiting-authorization');
  assert.equal(local.repair.planGeneration, 2);
  assert.deepEqual(local.repair.planHistory.map((entry) => entry.generation), [1, 2]);
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

test('intent faults require a durable challenge and repeated Fix actions join the same repair', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope({
    failure: { ...envelope().failure, type: 'requirement', message: 'approved intent contradicts observed behavior' }
  }));
  const requested = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  });
  assert.equal(requested.repair.status, 'challenge-required');
  assert.equal(requested.repair.workspace, null);
  assert.equal(requested.repair.finalDisposition, null);
  const repeated = await requestRepair(root, reported.fault.faultId, {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  });
  assert.equal(repeated.joined, true);
  assert.equal(repeated.repair.repairId, requested.repair.repairId);
  assert.equal((await listRepairs(root)).length, 1);
});

test('diagnosis-only repair states remain joinable instead of multiplying on Fix', async (t) => {
  const root = await repository(t);
  const reported = await reportFault(root, envelope({
    environment: 'production',
    failure: { ...envelope().failure, type: 'production', message: 'production failure' }
  }));
  const options = {
    mode: 'guided', allowedPaths: ['value.txt'], verification: [['node', '--version']]
  };
  const first = await requestRepair(root, reported.fault.faultId, options);
  const second = await requestRepair(root, reported.fault.faultId, options);
  assert.equal(first.repair.status, 'diagnosis-ready');
  assert.equal(second.joined, true);
  assert.equal(second.repair.repairId, first.repair.repairId);
  assert.equal((await listRepairs(root)).length, 1);
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
    const signalled = await wrapCommandWithFaultRepair(root, [
      process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"
    ], { echo: false });
    assert.notEqual(signalled.exitCode, 0);
    assert.match(signalled.fault.faultId, /^FLT-/);
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
  assert.equal(home.next[0].fallback.command, 'singularity-flow fix FLT-ABC');
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
