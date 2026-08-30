import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { createGvmProgram, createPolicySnapshot } from '../src/sgos/contracts.mjs';
import { SGOS_COMPILER_ID } from '../src/sgos/compiler.mjs';
import {
  applyPinnedSgosPolicyAmendment,
  assertSgosProcessPolicyAuthority,
  createPinnedPolicyApproval,
  createPinnedPolicyBundle,
  fsckPinnedSgosPolicyRuntime,
  planPinnedSgosPolicyAmendment,
  readPinnedSgosPolicyForProcess,
  setSgosPolicyAuthorityReadObserverForTests
} from '../src/sgos/pinned-policy.mjs';
import { platformPrincipalId } from '../src/sgos/platform/authority.mjs';
import {
  mutateSgosProcess, readSgosProcess
} from '../src/sgos/store.mjs';
import {
  pauseSgosProcess, recoverInterruptedSgosExecution, respondToSgosHumanRequest,
  resumeSgosProcess, runReadySgosTasks, startSgosProcess, stepSgosProcess,
  stopSgosProcess
} from '../src/sgos/runtime.mjs';
import {
  forkSgosProcess, planSgosProcessFork, planSgosProcessReplay, replaySgosProcess
} from '../src/sgos/lineage.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

const d = (character) => `sha256:${character.repeat(64)}`;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function flowResult(root, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
}

function flowJson(root, ...args) {
  const result = flowResult(root, ...args, '--json');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.resultType, 'command-result');
  return envelope.data.result;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Policy Reviewer');
  git(root, 'config', 'user.email', 'policy.reviewer@example.test');
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.approvalAuthorities['architecture-reviewers'] = {
    label: 'Policy reviewers', allowAnyGitIdentity: false,
    members: [{ name: 'Policy Reviewer', email: 'policy.reviewer@example.test' }]
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base approved policy authority');
  git(root, 'branch', 'sflow/config');
  return { root, base: git(root, 'rev-parse', 'sflow/config') };
}

function snapshot(authorityRevision, overrides = {}) {
  return createPolicySnapshot({
    authorityRevision,
    lawSha256: d('1'),
    registrySha256: d('2'),
    executionUnitPolicySha256: d('3'),
    devicePolicySha256: d('4'),
    storagePolicySha256: d('5'),
    memoryPolicySha256: d('6'),
    humanAuthoritySha256: d('7'),
    governedRootsSha256: d('8'),
    verificationPolicySha256: d('9'),
    publicationPolicySha256: d('a'),
    ...overrides
  });
}

function writeConfigCommit(root, files, message = 'publish policy candidate') {
  const parent = git(root, 'rev-parse', 'sflow/config');
  const index = path.join(root, `.policy-index-${Date.now()}-${Math.random()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout.trim();
  };
  run('read-tree', parent);
  for (const [relative, value] of Object.entries(files)) {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const oid = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root, encoding: 'utf8', input: bytes
    }).stdout.trim();
    run('update-index', '--add', '--cacheinfo', `100644,${oid},${relative}`);
  }
  const tree = run('write-tree');
  const commit = spawnSync('git', ['commit-tree', tree, '-p', parent], {
    cwd: root, encoding: 'utf8', input: `${message}\n`
  });
  if (commit.status !== 0) throw new Error(commit.stderr);
  const next = commit.stdout.trim();
  git(root, 'update-ref', 'refs/heads/sflow/config', next, parent);
  return next;
}

async function publishPair(root, current, candidate, extra = {}) {
  return writeConfigCommit(root, {
    'singularity/sgos/policy/current.json': current,
    'singularity/sgos/policy/candidate.json': candidate,
    ...extra
  });
}

function program(policySnapshotSha256) {
  return createGvmProgram({
    intentIrSha256: d('b'), workflowSha256: d('c'), ratificationSha256: d('d'),
    policySnapshotSha256, registrySnapshotSha256: d('e'), storageProfileSha256: d('f'),
    taskTemplates: [
      {
        taskTemplateId: 'end', opcode: 'END', operation: 'core.end', dependsOn: ['noop'],
        resources: { reads: [], writes: [], devices: [], externalEffects: [] }, evidence: {},
        authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
        retry: { maximumAttempts: 1 }, policySnapshotSha256, material: false,
        metadata: { sourceConstruct: 'end', operationVersion: '1', operationManifestSha256: d('0') }
      },
      {
        taskTemplateId: 'noop', opcode: 'NOOP', operation: 'core.noop', dependsOn: [],
        resources: { reads: [], writes: [], devices: [], externalEffects: [] }, evidence: {},
        authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
        retry: { maximumAttempts: 1 }, policySnapshotSha256, material: false,
        metadata: { sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: d('0') }
      }
    ],
    edges: [{ from: 'noop', to: 'end' }], joins: [],
    budgets: { maximumTasks: 2, maximumAttempts: 1 }, recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
    // This fixture intentionally exercises the pre-Capability-Pack compatibility
    // path. Compiler v3 Programs must be created from an exact signed compile
    // result and cannot be fabricated from Program bytes alone.
    compiler: { id: SGOS_COMPILER_ID, version: '2' }
  });
}

async function startProcesses(root, policySnapshotSha256, count = 2) {
  const compiled = program(policySnapshotSha256);
  const published = await publishSgosProgramAuthority(root, compiled);
  const processes = [];
  for (let index = 0; index < count; index += 1) {
    processes.push((await startSgosProcess(root, {
      program: compiled,
      taskContractSha256: d('1'),
      subject: {
        kind: 'repository', id: `policy-fixture-${index}`, branch: 'main',
        baselineRevision: git(root, 'rev-parse', 'HEAD')
      },
      clock: `2026-08-30T10:0${index}:00.000Z`
    })).process);
  }
  return { compiled, processes, authorityCommit: published.commit };
}

test('pinned policy plan classifies only old-policy-declared exact targets as tightening', async (t) => {
  const { root, base } = await repository(t);
  const next = snapshot(base, { lawSha256: d('b'), registrySha256: d('c') });
  const current = createPinnedPolicyBundle({
    snapshot: snapshot(base),
    automaticTightening: { enabled: true, components: { lawSha256: [next.lawSha256] } }
  });
  const candidate = createPinnedPolicyBundle({ snapshot: next });
  await publishPair(root, current, candidate);

  const planned = await planPinnedSgosPolicyAmendment(root);
  assert.equal(planned.mutation, false);
  assert.equal(planned.diff.classification, 'mixed');
  assert.deepEqual(planned.diff.changes.map(({ component, classification }) => ({ component, classification })), [
    { component: 'lawSha256', classification: 'tightening' },
    { component: 'registrySha256', classification: 'weakening' }
  ]);
  assert.equal(planned.plan.requiresHumanApproval, true);
});

test('policy CLI exposes read-only status/plan/fsck and revision-plus-digest-bound apply', async (t) => {
  const { root, base } = await repository(t);
  const next = snapshot(base, { lawSha256: d('b') });
  const current = createPinnedPolicyBundle({
    snapshot: snapshot(base),
    automaticTightening: { enabled: true, components: { lawSha256: [next.lawSha256] } }
  });
  const candidate = createPinnedPolicyBundle({ snapshot: next });
  await publishPair(root, current, candidate);

  const before = flowJson(root, 'policy', 'status');
  assert.equal(before.initialized, false);
  assert.equal(before.revision, 0);

  const planned = flowJson(root, 'policy', 'plan');
  assert.equal(planned.mutation, false);
  assert.equal(planned.plan.runtimeRevision, 0);
  assert.equal(planned.diff.classification, 'tightening');

  const missingRevision = flowResult(root, 'policy', 'apply',
    '--confirm', planned.confirmationSha256, '--json');
  assert.equal(missingRevision.status, 1);
  assert.match(missingRevision.stderr, /exact non-negative revision/);
  assert.equal(flowJson(root, 'policy', 'status').initialized, false);

  const applied = flowJson(root, 'policy', 'apply',
    '--expected-revision', '0', '--confirm', planned.confirmationSha256);
  assert.equal(applied.state.revision, 1);
  assert.equal(applied.state.activePolicySnapshotSha256, candidate.snapshot.snapshotSha256);

  const status = flowJson(root, 'policy', 'status');
  assert.equal(status.initialized, true);
  assert.equal(status.revision, 1);
  const fsck = flowJson(root, 'policy', 'fsck');
  assert.equal(fsck.valid, true);
});

test('a weakening requires an exact approved human policy.amend decision', async (t) => {
  const { root, base } = await repository(t);
  const current = createPinnedPolicyBundle({ snapshot: snapshot(base) });
  const candidate = createPinnedPolicyBundle({
    snapshot: snapshot(base, { publicationPolicySha256: d('b') })
  });
  await publishPair(root, current, candidate);
  const unapproved = await planPinnedSgosPolicyAmendment(root);
  assert.equal(unapproved.diff.classification, 'weakening');
  assert.equal(unapproved.approval, null);
  await assert.rejects(
    () => applyPinnedSgosPolicyAmendment(root, {
      confirmationSha256: unapproved.confirmationSha256,
      expectedRevision: unapproved.plan.runtimeRevision
    }),
    (error) => error.code === 'SGOS_POLICY_HUMAN_APPROVAL_REQUIRED'
  );

  const approval = createPinnedPolicyApproval({
    fromPolicySnapshotSha256: current.snapshot.snapshotSha256,
    toPolicySnapshotSha256: candidate.snapshot.snapshotSha256,
    diffSha256: unapproved.diff.diffSha256,
    decision: 'approved',
    approvedBy: platformPrincipalId({ email: 'policy.reviewer@example.test' }),
    approvedAt: '2026-08-30T10:00:00.000Z'
  });
  await publishPair(root, current, candidate, {
    [`singularity/sgos/policy/approvals/${candidate.snapshot.snapshotSha256.slice(7)}.json`]: approval
  });
  const approved = await planPinnedSgosPolicyAmendment(root);
  assert.equal(approved.approval.approvalSha256, approval.approvalSha256);
  const applied = await applyPinnedSgosPolicyAmendment(root, {
    confirmationSha256: approved.confirmationSha256,
    expectedRevision: approved.plan.runtimeRevision
  });
  assert.equal(applied.state.activePolicySnapshotSha256, candidate.snapshot.snapshotSha256);
});

test('dirty candidate, stale confirmation, and candidate self-authorization all fail closed', async (t) => {
  const dirtyFixture = await repository(t);
  const current = createPinnedPolicyBundle({ snapshot: snapshot(dirtyFixture.base) });
  const candidate = createPinnedPolicyBundle({ snapshot: snapshot(dirtyFixture.base, { lawSha256: d('b') }) });
  await publishPair(dirtyFixture.root, current, candidate);
  await mkdir(path.join(dirtyFixture.root, 'singularity', 'sgos', 'policy'), { recursive: true });
  await writeFile(path.join(dirtyFixture.root, 'singularity', 'sgos', 'policy', 'candidate.json'), '{}\n');
  await assert.rejects(
    () => planPinnedSgosPolicyAmendment(dirtyFixture.root),
    (error) => error.code === 'SGOS_POLICY_CANDIDATE_DIRTY'
  );
  await rm(path.join(dirtyFixture.root, 'singularity', 'sgos'), { recursive: true, force: true });

  const oldPlan = await planPinnedSgosPolicyAmendment(dirtyFixture.root);
  const changedCandidate = createPinnedPolicyBundle({
    snapshot: snapshot(dirtyFixture.base, { lawSha256: d('c') })
  });
  await publishPair(dirtyFixture.root, current, changedCandidate, {}, 'change candidate');
  await assert.rejects(
    () => applyPinnedSgosPolicyAmendment(dirtyFixture.root, {
      confirmationSha256: oldPlan.confirmationSha256,
      expectedRevision: oldPlan.plan.runtimeRevision
    }),
    (error) => error.code === 'SGOS_POLICY_PLAN_STALE'
  );

  const self = await repository(t);
  const workflow = YAML.parse(await readFile(path.join(self.root, 'singularity', 'workflow.yml'), 'utf8'));
  workflow.approvalAuthorities['architecture-reviewers'].members = [
    { name: 'Candidate Attacker', email: 'candidate.attacker@example.test' }
  ];
  const nextWorkflow = YAML.stringify(workflow);
  const workflowOid = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: self.root, encoding: 'utf8', input: nextWorkflow
  }).stdout.trim();
  const parent = git(self.root, 'rev-parse', 'sflow/config');
  const index = path.join(self.root, '.self-auth.index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  spawnSync('git', ['read-tree', parent], { cwd: self.root, env });
  spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${workflowOid},singularity/workflow.yml`], { cwd: self.root, env });
  const currentSelf = createPinnedPolicyBundle({ snapshot: snapshot(self.base) });
  const candidateSelf = createPinnedPolicyBundle({ snapshot: snapshot(self.base, { lawSha256: d('b') }) });
  for (const [relative, value] of Object.entries({
    'singularity/sgos/policy/current.json': currentSelf,
    'singularity/sgos/policy/candidate.json': candidateSelf
  })) {
    const oid = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: self.root, encoding: 'utf8', input: `${JSON.stringify(value, null, 2)}\n`
    }).stdout.trim();
    spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${oid},${relative}`], { cwd: self.root, env });
  }
  const tree = spawnSync('git', ['write-tree'], { cwd: self.root, env, encoding: 'utf8' }).stdout.trim();
  const commit = spawnSync('git', ['commit-tree', tree, '-p', parent], {
    cwd: self.root, encoding: 'utf8', input: 'candidate tries to authorize itself\n'
  }).stdout.trim();
  git(self.root, 'update-ref', 'refs/heads/sflow/config', commit, parent);
  git(self.root, 'reset', '--hard', commit);
  git(self.root, 'config', 'user.name', 'Candidate Attacker');
  git(self.root, 'config', 'user.email', 'candidate.attacker@example.test');
  const selfPlan = await planPinnedSgosPolicyAmendment(self.root);
  await assert.rejects(
    () => applyPinnedSgosPolicyAmendment(self.root, {
      confirmationSha256: selfPlan.confirmationSha256,
      expectedRevision: selfPlan.plan.runtimeRevision
    }),
    (error) => error.code === 'SGOS_PLATFORM_MUTATION_UNAUTHORIZED'
  );
});

test('policy authority preserves unconfigured compatibility and admits only the exact configured start snapshot', async (t) => {
  const { root, base } = await repository(t);
  const unconfigured = await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.start', processId: 'PROC-unconfigured', policySnapshotSha256: d('0')
  });
  assert.equal(unconfigured.status, 'unconfigured');
  assert.equal(unconfigured.executionAllowed, true);

  const current = createPinnedPolicyBundle({ snapshot: snapshot(base) });
  writeConfigCommit(root, { 'singularity/sgos/policy/current.json': current });
  const admitted = await assertSgosProcessPolicyAuthority(root, {
    operation: 'process.start', processId: 'PROC-new001',
    policySnapshotSha256: current.snapshot.snapshotSha256
  });
  assert.equal(admitted.status, 'approved-current');
  let authorityReads = 0;
  setSgosPolicyAuthorityReadObserverForTests(() => { authorityReads += 1; });
  t.after(() => setSgosPolicyAuthorityReadObserverForTests(null));
  const started = await startProcesses(root, current.snapshot.snapshotSha256, 1);
  assert.equal(authorityReads, 1,
    'start, create, and genesis publication reuse one verified policy-authority witness');
  assert.equal(started.processes[0].policySnapshotSha256, current.snapshot.snapshotSha256,
    'runtime and store start boundaries both admit the exact configured snapshot before creation');
  authorityReads = 0;
  await stepSgosProcess(root, started.processes[0].processId);
  assert.equal(authorityReads, 1,
    'one public task step performs one full policy-authority read across all internal CAS writes');
  authorityReads = 0;
  const stepped = await readSgosProcess(root, started.processes[0].processId);
  await assert.rejects(
    () => mutateSgosProcess(root, stepped.processId, () => {
      throw new Error('direct-store-test-stop');
    }, { expectedRevision: stepped.processRevision }),
    /direct-store-test-stop/
  );
  assert.equal(authorityReads, 1,
    'a direct low-level store call has no inherited witness and performs its own full preflight');
  setSgosPolicyAuthorityReadObserverForTests(null);
  await assert.rejects(
    () => assertSgosProcessPolicyAuthority(root, {
      operation: 'process.start', processId: 'PROC-stale001', policySnapshotSha256: d('0')
    }),
    (error) => error.code === 'SGOS_POLICY_START_SNAPSHOT_STALE'
      && /policy status/.test(error.details?.remedy ?? '')
  );
});

test('selective invalidation preserves Process bytes and policy rotation advances only by receipt', async (t) => {
  const { root } = await repository(t);
  const beforeAuthority = git(root, 'rev-parse', 'sflow/config');
  const originalSnapshot = snapshot(beforeAuthority);
  const started = await startProcesses(root, originalSnapshot.snapshotSha256);
  const nextSnapshot = snapshot(started.authorityCommit, { lawSha256: d('b') });
  const afterSnapshot = snapshot(started.authorityCommit, { lawSha256: d('c') });
  const current = createPinnedPolicyBundle({
    snapshot: originalSnapshot,
    automaticTightening: { enabled: true, components: { lawSha256: [nextSnapshot.lawSha256] } }
  });
  const candidate = createPinnedPolicyBundle({
    snapshot: nextSnapshot,
    automaticTightening: { enabled: true, components: { lawSha256: [afterSnapshot.lawSha256] } }
  });
  await publishPair(root, current, candidate);
  const selected = started.processes[0].processId;
  const untouched = started.processes[1].processId;
  const selectedBefore = await readSgosProcess(root, selected);
  const plan = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds: [selected] });
  assert.deepEqual(plan.impact.selectedProcessIds, [selected]);
  const applied = await applyPinnedSgosPolicyAmendment(root, {
    confirmationSha256: plan.confirmationSha256,
    expectedRevision: plan.plan.runtimeRevision,
    invalidateProcessIds: [selected]
  });
  assert.equal(applied.invalidations.length, 1);
  assert.deepEqual(await readSgosProcess(root, selected), selectedBefore);
  assert.equal((await readPinnedSgosPolicyForProcess(root, selected)).status, 'invalidated');
  assert.equal((await readPinnedSgosPolicyForProcess(root, untouched)).status, 'pinned');
  await assert.rejects(
    () => stepSgosProcess(root, selected),
    (error) => error.code === 'SGOS_POLICY_PROCESS_INVALIDATED'
  );
  await assert.rejects(
    () => runReadySgosTasks(root, selected),
    (error) => error.code === 'SGOS_POLICY_PROCESS_INVALIDATED'
  );
  const refusedMutations = [
    ['pause', () => pauseSgosProcess(root, selected)],
    ['stop', () => stopSgosProcess(root, selected)],
    ['resume', () => resumeSgosProcess(root, selected)],
    ['human response', () => respondToSgosHumanRequest(root, selected)],
    ['recovery', () => recoverInterruptedSgosExecution(root, selected, { resolution: 'fail' })],
    ['replay plan', () => planSgosProcessReplay(root, selected)],
    ['replay', () => replaySgosProcess(root, selected, { confirmationSha256: d('f') })],
    ['fork plan', () => planSgosProcessFork(root, selected)],
    ['fork', () => forkSgosProcess(root, selected, { confirmationSha256: d('f') })],
    ['store publication', () => mutateSgosProcess(root, selected, () => {
      throw new Error('mutation callback must never run after policy invalidation');
    }, { expectedRevision: selectedBefore.processRevision })]
  ];
  for (const [label, action] of refusedMutations) {
    await assert.rejects(action, (error) => {
      assert.equal(error.code, 'SGOS_POLICY_PROCESS_INVALIDATED', label);
      assert.match(error.details?.remedy ?? '', /start a new Process/);
      return true;
    });
  }
  assert.deepEqual(await readSgosProcess(root, selected), selectedBefore,
    'policy refusal must precede every Process transition or reconciliation write');
  assert.equal((await fsckPinnedSgosPolicyRuntime(root)).valid, true);

  await assert.rejects(
    () => planPinnedSgosPolicyAmendment(root),
    (error) => error.code === 'SGOS_POLICY_ROTATION_REQUIRED'
  );
  await publishPair(root, candidate, createPinnedPolicyBundle({ snapshot: afterSnapshot }));
  const rotated = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds: [] });
  const second = await applyPinnedSgosPolicyAmendment(root, {
    confirmationSha256: rotated.confirmationSha256,
    expectedRevision: rotated.plan.runtimeRevision,
    invalidateProcessIds: []
  });
  assert.equal(second.state.revision, 2);
  assert.equal(second.state.activePolicySnapshotSha256, afterSnapshot.snapshotSha256);

  const common = git(root, 'rev-parse', '--git-common-dir');
  const invalidationFile = path.resolve(root, common, 'singularity-flow', 'sgos',
    'policy-runtime', 'invalidations', encodeURIComponent(selected),
    `${applied.invalidations[0].invalidationSha256.slice(7)}.json`);
  const tampered = JSON.parse(await readFile(invalidationFile, 'utf8'));
  tampered.effect = 'continue-silently';
  await writeFile(invalidationFile, `${JSON.stringify(tampered, null, 2)}\n`);
  const damaged = await fsckPinnedSgosPolicyRuntime(root);
  assert.equal(damaged.valid, false);
  assert.ok(damaged.errors.some((entry) =>
    ['SGOS_POLICY_RUNTIME_INVALID', 'SGOS_POLICY_RECORD_TAMPERED'].includes(entry.code)));
});

test('a missing selected invalidation fails closed instead of re-authorizing its Process', async (t) => {
  const { root } = await repository(t);
  const originalSnapshot = snapshot(git(root, 'rev-parse', 'sflow/config'));
  const started = await startProcesses(root, originalSnapshot.snapshotSha256);
  const nextSnapshot = snapshot(started.authorityCommit, { lawSha256: d('b') });
  const current = createPinnedPolicyBundle({
    snapshot: originalSnapshot,
    automaticTightening: { enabled: true, components: { lawSha256: [nextSnapshot.lawSha256] } }
  });
  await publishPair(root, current, createPinnedPolicyBundle({ snapshot: nextSnapshot }));
  const selected = started.processes[0].processId;
  const unaffected = started.processes[1].processId;
  const selectedBefore = await readSgosProcess(root, selected);
  const plan = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds: [selected] });
  const applied = await applyPinnedSgosPolicyAmendment(root, {
    confirmationSha256: plan.confirmationSha256,
    expectedRevision: plan.plan.runtimeRevision,
    invalidateProcessIds: [selected]
  });
  const common = git(root, 'rev-parse', '--git-common-dir');
  const invalidationFile = path.resolve(root, common, 'singularity-flow', 'sgos',
    'policy-runtime', 'invalidations', encodeURIComponent(selected),
    `${applied.invalidations[0].invalidationSha256.slice(7)}.json`);
  await rm(invalidationFile);

  await assert.rejects(() => readPinnedSgosPolicyForProcess(root, selected), (error) => {
    assert.equal(error.code, 'SGOS_POLICY_LINEAGE_INVALID');
    assert.match(error.message, /missing the required invalidation/);
    return true;
  });
  await assert.rejects(
    () => stepSgosProcess(root, selected),
    (error) => error.code === 'SGOS_POLICY_LINEAGE_INVALID'
  );
  assert.deepEqual(await readSgosProcess(root, selected), selectedBefore,
    'lineage refusal must happen before the Process can mutate');
  assert.equal((await readPinnedSgosPolicyForProcess(root, unaffected)).status, 'pinned',
    'an exact impact proves that an unselected Process remains runnable');
});

test('missing local amendment authority cannot silently continue either invalidated or unaffected Processes', async (t) => {
  const { root } = await repository(t);
  const originalSnapshot = snapshot(git(root, 'rev-parse', 'sflow/config'));
  const started = await startProcesses(root, originalSnapshot.snapshotSha256);
  const nextSnapshot = snapshot(started.authorityCommit, { lawSha256: d('b') });
  const current = createPinnedPolicyBundle({
    snapshot: originalSnapshot,
    automaticTightening: { enabled: true, components: { lawSha256: [nextSnapshot.lawSha256] } }
  });
  const candidate = createPinnedPolicyBundle({ snapshot: nextSnapshot });
  await publishPair(root, current, candidate);
  const selected = started.processes[0].processId;
  const unaffected = started.processes[1].processId;
  const plan = await planPinnedSgosPolicyAmendment(root, { invalidateProcessIds: [selected] });
  await applyPinnedSgosPolicyAmendment(root, {
    confirmationSha256: plan.confirmationSha256,
    expectedRevision: plan.plan.runtimeRevision,
    invalidateProcessIds: [selected]
  });
  const selectedBefore = await readSgosProcess(root, selected);
  const unaffectedBefore = await readSgosProcess(root, unaffected);

  const common = git(root, 'rev-parse', '--git-common-dir');
  await rm(path.resolve(root, common, 'singularity-flow', 'sgos', 'policy-runtime'), {
    recursive: true, force: true
  });
  for (const processId of [selected, unaffected]) {
    await assert.rejects(() => stepSgosProcess(root, processId), (error) => {
      assert.equal(error.code, 'SGOS_POLICY_AUTHORITY_UNESTABLISHED');
      assert.match(error.message, /another clone/);
      assert.match(error.details?.remedy ?? '', /administrator-reviewed machine transfer/);
      return true;
    });
  }
  assert.deepEqual(await readSgosProcess(root, selected), selectedBefore);
  assert.deepEqual(await readSgosProcess(root, unaffected), unaffectedBefore);
});
