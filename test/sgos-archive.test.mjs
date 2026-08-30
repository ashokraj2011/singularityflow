import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { schemaCensus } from '../src/schema-census.mjs';
import {
  createGvmProcess, createGvmProgram, createGvmTaskAttempt, createPolicySnapshot,
  createResourceLease
} from '../src/sgos/contracts.mjs';
import { createPinnedPolicyBundle } from '../src/sgos/pinned-policy.mjs';
import { SGOS_INSTALLED_LIMITS } from '../src/sgos/limits.mjs';
import {
  archiveSgosProcess,
  buildSgosProcessBinding,
  createSgosProcess,
  listSgosProcesses,
  currentSgosExecutionOwnerFingerprint,
  registerSgosExecutionOwner,
  planSgosProcessArchive,
  planSgosProcessQuarantine,
  putSgosImmutableRecord,
  quarantineSgosProcess,
  setSgosStoreFaultBoundaryForTests,
  sgosProcessDirectory,
  writeSgosExecutionLease
} from '../src/sgos/store.mjs';

const h = (digit) => `sha256:${digit.repeat(64)}`;
const timestamp = '2026-08-29T12:00:00.000Z';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-archive-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'SGOS Archive Tester']);
  git(root, ['config', 'user.email', 'sgos.archive@example.test']);
  await writeFile(path.join(root, 'README.md'), '# SGOS archive fixture\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
}

function seal(record, hashField) {
  const core = structuredClone(record);
  delete core[hashField];
  return { ...core, [hashField]: `sha256:${recordSha256(core)}` };
}

function storedProcessV2(current) {
  const record = structuredClone(current);
  delete record.processSha256;
  delete record.controlEventSha256;
  record.schemaVersion = 2;
  return seal(record, 'processSha256');
}

async function processFixture(root, processId, {
  bindingVersion = 1,
  humanRequestVersion = null,
  corruptBinding = false,
  liveLease = false,
  unsafeSymlink = false
} = {}) {
  const directory = sgosProcessDirectory(root, processId);
  await mkdir(path.join(directory, 'bindings'), { recursive: true });
  let binding;
  if (bindingVersion === 2) {
    binding = buildSgosProcessBinding(root, {
      processId,
      subjectId: 'repository-subject',
      subjectAuthority: null,
      configurationAuthority: null,
      expectedProcessRevision: 0
    });
  } else {
    binding = seal({
      schemaVersion: bindingVersion,
      kind: 'process-binding',
      processId,
      subjectId: 'repository-subject'
    }, 'bindingSha256');
  }
  if (corruptBinding) binding = { ...binding, subjectId: 'changed-after-hash' };
  await writeFile(path.join(
    directory, 'bindings', `${binding.bindingSha256.slice('sha256:'.length)}.json`
  ), `${JSON.stringify(binding)}\n`);
  const openHumanRequests = [];
  if (humanRequestVersion != null) {
    const request = seal({
      schemaVersion: humanRequestVersion,
      kind: 'human-request',
      requestId: 'HRQ-ARCHIVE-REQUEST',
      processId
    }, 'requestSha256');
    const requestDirectory = path.join(directory, 'human-requests');
    await mkdir(requestDirectory, { recursive: true });
    await writeFile(path.join(
      requestDirectory, `${request.requestSha256.slice('sha256:'.length)}.json`
    ), `${JSON.stringify(request)}\n`);
    openHumanRequests.push(request.requestSha256);
  }
  const state = seal({
    schemaVersion: 1,
    kind: 'gvm-process',
    processId,
    processBindingSha256: binding.bindingSha256,
    openHumanRequests,
    activeLeases: []
  }, 'processSha256');
  await writeFile(path.join(directory, 'state.json'), `${JSON.stringify(state)}\n`);
  if (liveLease) {
    const leaseId = 'lease-live-owner';
    const leaseDirectory = path.join(directory, 'execution-leases');
    await mkdir(leaseDirectory, { recursive: true });
    const liveOwnerLease = {
      schemaVersion: 2,
      kind: 'sgos-execution-lease',
      leaseId,
      processId,
      attemptId: 'attempt-live-owner',
      taskInstanceId: 'task-live-owner',
      ownerId: 'owner-live',
      ownerPid: process.pid,
      ownerStartFingerprint: currentSgosExecutionOwnerFingerprint(),
      beforeProcessSha256: h('1'),
      beforeProcessRevision: 1,
      executionHandleSha256: h('2'),
      attemptSha256: h('3'),
      acquiredAt: timestamp,
      heartbeatAt: timestamp
    };
    registerSgosExecutionOwner(liveOwnerLease);
    await writeFile(path.join(leaseDirectory, `${encodeURIComponent(leaseId)}.json`),
      canonicalJson(liveOwnerLease));
  }
  if (unsafeSymlink) {
    await symlink(path.join(root, 'README.md'), path.join(directory, 'unsafe-link'));
  }
  return { binding, directory };
}

async function currentProcessFixture(root, processId, {
  terminalBeforeReceipt = true,
  leaseOwnerPid = null,
  corruptCurrentAttempt = false,
  multipleTerminalAttempts = false,
  storedProcessVersion = 3,
  terminalStatus = 'succeeded'
} = {}) {
  const directory = sgosProcessDirectory(root, processId);
  const configurationAuthority = {
    kind: 'approved-configuration-ref',
    ref: 'refs/heads/sflow/config',
    commit: '0123456789abcdef0123456789abcdef01234567',
    workflowBlobSha256: h('8')
  };
  const binding = buildSgosProcessBinding(root, {
    processId,
    subjectId: 'repository-subject',
    subjectAuthority: null,
    configurationAuthority,
    expectedProcessRevision: 0
  });
  await mkdir(path.join(directory, 'bindings'), { recursive: true });
  await writeFile(path.join(
    directory, 'bindings', `${binding.bindingSha256.slice('sha256:'.length)}.json`
  ), canonicalJson(binding));
  const program = createGvmProgram({
    intentIrSha256: h('1'),
    workflowSha256: h('2'),
    ratificationSha256: h('3'),
    policySnapshotSha256: h('9'),
    registrySnapshotSha256: h('7'),
    storageProfileSha256: h('6'),
    taskTemplates: [
      {
        taskTemplateId: 'task', opcode: 'END', dependsOn: [], inputs: [],
        resources: { reads: [], writes: [], devices: [], externalEffects: [] },
        retry: { maximumAttempts: 1 }
      },
      ...(multipleTerminalAttempts ? [{
        taskTemplateId: 'task-second', opcode: 'END', dependsOn: [], inputs: [],
        resources: { reads: [], writes: [], devices: [], externalEffects: [] },
        retry: { maximumAttempts: 1 }
      }] : [])
    ],
    edges: [], joins: [],
    budgets: { maximumTasks: multipleTerminalAttempts ? 2 : 1, maximumAttempts: 1 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [
      { taskTemplateId: 'task', state: 'succeeded' },
      ...(multipleTerminalAttempts
        ? [{ taskTemplateId: 'task-second', state: 'succeeded' }] : [])
    ],
    compiler: { id: 'sflow-gvm-compiler', version: '2' }
  });
  // The no-attempt fixture deliberately remains an incomplete creation seed. Interrupted current
  // fixtures, however, must carry their exact Program bytes so quarantine validates authority and
  // materialization from the moved snapshot rather than consulting the old Process directory.
  if (terminalBeforeReceipt) {
    await mkdir(path.join(directory, 'programs'), { recursive: true });
    await writeFile(path.join(
      directory, 'programs', `${program.programSha256.slice('sha256:'.length)}.json`
    ), canonicalJson(program));
  }
  const taskInstanceId = `TSK-${recordSha256({ processId, taskTemplateId: 'task' })
    .slice(0, 24).toUpperCase()}`;
  const attempt = terminalBeforeReceipt ? createGvmTaskAttempt({
    processId,
    taskInstanceId,
    attemptNumber: 1,
    parentAttemptId: null,
    reason: 'initial',
    taskContractSha256: h('4'),
    executionHandleSha256: h('5'),
    status: terminalStatus,
    startedAt: timestamp,
    completedAt: timestamp
  }) : null;
  const secondTaskInstanceId = `TSK-${recordSha256({ processId, taskTemplateId: 'task-second' })
    .slice(0, 24).toUpperCase()}`;
  const secondAttempt = multipleTerminalAttempts ? createGvmTaskAttempt({
    processId,
    taskInstanceId: secondTaskInstanceId,
    attemptNumber: 1,
    parentAttemptId: null,
    reason: 'initial',
    taskContractSha256: h('4'),
    executionHandleSha256: h('a'),
    status: 'succeeded',
    startedAt: timestamp,
    completedAt: timestamp
  }) : null;
  if (attempt || secondAttempt) {
    await mkdir(path.join(directory, 'attempts'), { recursive: true });
    const storedAttempt = corruptCurrentAttempt
      ? seal({ ...attempt, unsupportedCurrentField: true }, 'attemptSha256')
      : attempt;
    for (const record of [storedAttempt, secondAttempt].filter(Boolean)) {
      await writeFile(path.join(
        directory, 'attempts', `${record.attemptSha256.slice('sha256:'.length)}.json`
      ), canonicalJson(record));
    }
  }
  const leaseId = leaseOwnerPid == null ? null : 'lease-interrupted-owner';
  const programSha256 = program.programSha256;
  const programId = program.programId;
  const authorityBinding = {
    kind: 'repository',
    subjectId: binding.subjectId,
    subjectAuthority: null,
    branch: binding.branch,
    baselineRevision: binding.baselineRevision,
    baselineSnapshotSha256: h('2'),
    authority: 'existing-repository-baseline',
    configurationAuthority,
    humanAuthorityRequirements: [],
    executionAdmission: {
      admitted: true,
      programId,
      programSha256,
      provenance: {
        method: 'approved-program-authority',
        programSha256,
        ratificationSha256: h('3'),
        source: {
          kind: configurationAuthority.kind,
          ref: configurationAuthority.ref,
          commit: configurationAuthority.commit,
          sourceCommit: configurationAuthority.commit,
          path: `singularity/sgos/program-authorities/${programSha256.slice('sha256:'.length)}.json`,
          blobSha256: h('6'),
          configurationAuthority
        }
      },
      safety: {
        safe: true,
        programId,
        programSha256,
        compiler: { id: 'sflow-gvm-compiler', version: '2' },
        graph: {
          taskCount: 1,
          edgeCount: 0,
          roots: ['task'],
          terminalTaskIds: ['task'],
          topologicalOrder: ['task']
        },
        registry: { verified: true, registrySnapshotSha256: program.registrySnapshotSha256 }
      }
    }
  };
  const currentState = createGvmProcess({
    processId,
    programSha256,
    policySnapshotSha256: program.policySnapshotSha256,
    processBindingSha256: binding.bindingSha256,
    status: 'running',
    taskInstances: {
      [taskInstanceId]: {
        taskInstanceId,
        taskTemplateId: 'task',
        state: terminalBeforeReceipt ? 'running' : 'ready',
        predecessorTaskInstanceIds: [],
        inputRefs: [],
        outputRefs: [],
        attemptIds: attempt ? [attempt.attemptId] : [],
        receiptSha256: null,
        invalidatedBy: null,
        revision: 1
      },
      ...(secondAttempt ? {
        [secondTaskInstanceId]: {
          taskInstanceId: secondTaskInstanceId,
          taskTemplateId: 'task-second',
          state: 'running',
          predecessorTaskInstanceIds: [],
          inputRefs: [],
          outputRefs: [],
          attemptIds: [secondAttempt.attemptId],
          receiptSha256: null,
          invalidatedBy: null,
          revision: 1
        }
      } : {})
    },
    activeExecutions: [attempt, secondAttempt].filter(Boolean).map((entry) => entry.attemptId),
    openHumanRequests: [],
    activeLeases: leaseId ? [leaseId] : [],
    currentCheckpointSha256: null,
    processRevision: 1,
    authorityBinding,
    taskContractSha256: h('4'),
    createdAt: timestamp,
    updatedAt: timestamp
  });
  const state = storedProcessVersion === 2 ? storedProcessV2(currentState) : currentState;
  await writeFile(path.join(directory, 'state.json'), canonicalJson(state));
  if (attempt || secondAttempt) {
    await mkdir(path.join(directory, 'resource-leases'), { recursive: true });
    for (const [boundAttempt, boundTaskInstanceId] of [
      [attempt, taskInstanceId], [secondAttempt, secondTaskInstanceId]
    ].filter(([entry]) => entry != null)) {
      const resourceLease = createResourceLease({
        processId,
        taskInstanceId: boundTaskInstanceId,
        attemptId: boundAttempt.attemptId,
        resources: [],
        acquiredAt: timestamp,
        expiresAt: '2099-01-01T00:00:00.000Z'
      });
      await writeFile(path.join(
        directory, 'resource-leases',
        `${resourceLease.leaseSha256.slice('sha256:'.length)}.json`
      ), canonicalJson(resourceLease));
    }
  }
  if (leaseId) {
    const leaseDirectory = path.join(directory, 'execution-leases');
    await mkdir(leaseDirectory, { recursive: true });
    const lease = {
      schemaVersion: 2,
      kind: 'sgos-execution-lease',
      leaseId,
      processId,
      attemptId: attempt.attemptId,
      taskInstanceId,
      ownerId: 'owner-interrupted',
      ownerPid: leaseOwnerPid,
      ownerStartFingerprint: leaseOwnerPid === process.pid
        ? currentSgosExecutionOwnerFingerprint() : h('e'),
      beforeProcessSha256: state.processSha256,
      beforeProcessRevision: state.processRevision,
      executionHandleSha256: attempt.executionHandleSha256,
      attemptSha256: attempt.attemptSha256,
      acquiredAt: timestamp,
      heartbeatAt: timestamp
    };
    if (leaseOwnerPid === process.pid) registerSgosExecutionOwner(lease);
    await writeFile(path.join(leaseDirectory, `${leaseId}.json`), canonicalJson(lease));
  }
  return { attempt, binding, directory, state };
}

async function creationSeedFixture(root, processId, { promoteGenesis = false } = {}) {
  const configurationAuthority = {
    kind: 'approved-configuration-ref',
    ref: 'refs/heads/sflow/config',
    commit: '0123456789abcdef0123456789abcdef01234567',
    workflowBlobSha256: h('8')
  };
  const program = createGvmProgram({
    intentIrSha256: h('1'),
    workflowSha256: h('2'),
    ratificationSha256: h('3'),
    policySnapshotSha256: h('4'),
    registrySnapshotSha256: h('5'),
    storageProfileSha256: h('6'),
    taskTemplates: [{
      taskTemplateId: 'finish', opcode: 'END', dependsOn: [], inputs: [],
      retry: { maximumAttempts: 1 }
    }],
    edges: [], joins: [], budgets: { maximumTasks: 1, maximumAttempts: 1 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: 'finish', state: 'succeeded' }],
    compiler: { id: 'sflow-gvm-compiler', version: '2' }
  });
  const binding = buildSgosProcessBinding(root, {
    processId,
    subjectId: 'repository-subject',
    subjectAuthority: null,
    configurationAuthority,
    expectedProcessRevision: 0
  });
  await putSgosImmutableRecord(root, processId, 'gvm-program', program);
  await putSgosImmutableRecord(root, processId, 'process-binding', binding);
  const taskInstanceId = `TSK-${recordSha256({ processId, taskTemplateId: 'finish' })
    .slice(0, 24).toUpperCase()}`;
  const authorityBinding = {
    kind: 'repository',
    subjectId: binding.subjectId,
    subjectAuthority: null,
    branch: binding.branch,
    baselineRevision: binding.baselineRevision,
    baselineSnapshotSha256: h('7'),
    authority: 'existing-repository-baseline',
    configurationAuthority,
    humanAuthorityRequirements: [],
    executionAdmission: {
      admitted: true,
      programId: program.programId,
      programSha256: program.programSha256,
      provenance: {
        method: 'approved-program-authority',
        programSha256: program.programSha256,
        ratificationSha256: program.ratificationSha256,
        source: {
          kind: configurationAuthority.kind,
          ref: configurationAuthority.ref,
          commit: configurationAuthority.commit,
          sourceCommit: configurationAuthority.commit,
          path: `singularity/sgos/program-authorities/${program.programSha256.slice('sha256:'.length)}.json`,
          blobSha256: h('9'),
          configurationAuthority
        }
      },
      safety: {
        safe: true,
        programId: program.programId,
        programSha256: program.programSha256,
        compiler: { id: 'sflow-gvm-compiler', version: '2' },
        graph: {
          taskCount: 1,
          edgeCount: 0,
          roots: ['finish'],
          terminalTaskIds: ['finish'],
          topologicalOrder: ['finish']
        },
        registry: { verified: true, registrySnapshotSha256: program.registrySnapshotSha256 }
      }
    }
  };
  const creationValue = {
    processId,
    programSha256: program.programSha256,
    policySnapshotSha256: program.policySnapshotSha256,
    processBindingSha256: binding.bindingSha256,
    status: 'running',
    taskInstances: {
      [taskInstanceId]: {
        taskInstanceId,
        taskTemplateId: 'finish',
        state: 'ready',
        predecessorTaskInstanceIds: [],
        inputRefs: [],
        outputRefs: [],
        attemptIds: [],
        receiptSha256: null,
        invalidatedBy: null,
        revision: 1
      }
    },
    activeExecutions: [],
    openHumanRequests: [],
    activeLeases: [],
    currentCheckpointSha256: null,
    taskContractSha256: h('a'),
    authorityBinding,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const state = promoteGenesis
    ? await createSgosProcess(root, creationValue)
    : createGvmProcess({ ...creationValue, processRevision: 1 });
  const directory = sgosProcessDirectory(root, processId);
  if (!promoteGenesis) {
    await writeFile(path.join(directory, 'state.json'), canonicalJson(state));
  }
  return { binding, creationValue, directory, program, state, taskInstanceId };
}

function quarantineAbsolute(root, label) {
  assert.match(label, /^\$git\//);
  return path.join(root, '.git', 'singularity-flow', ...label.slice('$git/'.length).split('/'));
}

test('v1 SGOS Process quarantine is plan-first, stale-proof, byte-preserving, and leaves census healthy', async () => {
  const root = await repository();
  const processId = 'PROC-ARCHIVE-PRESERVE';
  const fixture = await processFixture(root, processId);
  const stateBefore = await readFile(path.join(fixture.directory, 'state.json'));
  const bindingBefore = await readFile(path.join(
    fixture.directory, 'bindings', `${fixture.binding.bindingSha256.slice('sha256:'.length)}.json`
  ));
  const before = await schemaCensus(root);
  assert.equal(before.totals.outsideRange, 2);
  assert.equal((await doctorSnapshot(root, { offline: true, probeModelProvider: false }))
    .checks.find((entry) => entry.id === 'schema-migrations')?.status, 'fail');

  const plan = await planSgosProcessQuarantine(root, processId);
  assert.equal(plan.status, 'quarantine-ready');
  assert.equal(plan.reason, 'legacy-v1-authority-unreadable');
  assert.equal(plan.confirmationSha256, plan.treeSha256);
  assert.deepEqual(plan.quarantinedReferences.map((entry) => entry.family),
    ['gvm-process', 'process-binding']);
  assert.equal(plan.resumable, false);
  assert.equal(plan.restorable, false);
  assert.equal(plan.successClaimed, false);
  assert.equal(await readFile(path.join(fixture.directory, 'state.json'), 'utf8'), stateBefore.toString('utf8'));

  await assert.rejects(
    () => quarantineSgosProcess(root, processId, { confirmationSha256: h('f') }),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_STALE'
  );
  assert.equal(await readFile(path.join(fixture.directory, 'state.json'), 'utf8'), stateBefore.toString('utf8'));

  const quarantined = await quarantineSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(quarantined.quarantined, true);
  const quarantine = quarantineAbsolute(root, quarantined.quarantine);
  await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(quarantine, 'state.json')), stateBefore);
  assert.deepEqual(await readFile(path.join(
    quarantine, 'bindings', `${fixture.binding.bindingSha256.slice('sha256:'.length)}.json`
  )), bindingBefore);

  const after = await schemaCensus(root);
  assert.equal(after.totals.outsideRange, 0);
  assert.equal(after.totals.unregistered, 0);
  assert.equal((await doctorSnapshot(root, { offline: true, probeModelProvider: false }))
    .checks.find((entry) => entry.id === 'schema-migrations')?.status, 'pass');
});

test('configured policy still permits exact preserve-only quarantine of unreadable legacy state', async () => {
  const root = await repository();
  await initializeDefinition(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initialize approved configuration']);
  const authorityRevision = git(root, ['rev-parse', 'HEAD']);
  const policy = createPinnedPolicyBundle({
    snapshot: createPolicySnapshot({
      authorityRevision,
      lawSha256: h('1'), registrySha256: h('2'), executionUnitPolicySha256: h('3'),
      devicePolicySha256: h('4'), storagePolicySha256: h('5'), memoryPolicySha256: h('6'),
      humanAuthoritySha256: h('7'), governedRootsSha256: h('8'),
      verificationPolicySha256: h('9'), publicationPolicySha256: h('a')
    })
  });
  const policyDirectory = path.join(root, 'singularity', 'sgos', 'policy');
  await mkdir(policyDirectory, { recursive: true });
  await writeFile(path.join(policyDirectory, 'current.json'), canonicalJson(policy));
  git(root, ['add', 'singularity/sgos/policy/current.json']);
  git(root, ['commit', '-qm', 'publish current SGOS policy']);
  git(root, ['branch', 'sflow/config']);

  const processId = 'PROC-CONFIGURED-LEGACY';
  const fixture = await processFixture(root, processId);
  const stateBefore = await readFile(path.join(fixture.directory, 'state.json'));
  const plan = await planSgosProcessQuarantine(root, processId);
  const quarantined = await quarantineSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(quarantined.status, 'quarantined');
  assert.deepEqual(await readFile(path.join(
    quarantineAbsolute(root, quarantined.quarantine), 'state.json'
  )), stateBefore);
});

test('SGOS Process quarantine rehashes under lock and refuses a changed tree', async () => {
  const root = await repository();
  const processId = 'PROC-ARCHIVE-STALE';
  const fixture = await processFixture(root, processId);
  const plan = await planSgosProcessQuarantine(root, processId);
  await mkdir(path.join(fixture.directory, 'late-empty-directory'));
  await assert.rejects(
    () => quarantineSgosProcess(root, processId, { confirmationSha256: plan.confirmationSha256 }),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_STALE'
  );
  await access(path.join(fixture.directory, 'state.json'));
});

test('competing exact SGOS Process quarantine confirmations converge on one atomic move', async () => {
  const root = await repository();
  const processId = 'PROC-ARCHIVE-RACE';
  await processFixture(root, processId);
  const plan = await planSgosProcessQuarantine(root, processId);
  const settled = await Promise.allSettled([
    quarantineSgosProcess(root, processId, { confirmationSha256: plan.confirmationSha256 }),
    quarantineSgosProcess(root, processId, { confirmationSha256: plan.confirmationSha256 })
  ]);
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 2);
  const [completed, repeated] = settled.map((entry) => entry.value);
  assert.equal(repeated.quarantine, completed.quarantine);
  assert.equal(repeated.confirmationSha256, completed.confirmationSha256);
  await access(path.join(quarantineAbsolute(root, completed.quarantine), 'state.json'));
  await assert.rejects(() => access(sgosProcessDirectory(root, processId)), { code: 'ENOENT' });
});

test('quarantine retry recognizes the exact moved tree after rename or directory-sync failure', async () => {
  for (const boundary of ['quarantine-rename', 'quarantine-source-parent-sync']) {
    const root = await repository();
    const processId = `PROC-ARCHIVE-RETRY-${boundary.toUpperCase()}`;
    const fixture = await processFixture(root, processId);
    const plan = await planSgosProcessQuarantine(root, processId);
    setSgosStoreFaultBoundaryForTests(boundary, { code: 'EIO' });
    try {
      await assert.rejects(
        () => quarantineSgosProcess(root, processId, {
          confirmationSha256: plan.confirmationSha256
        }),
        (error) => error.code === 'EIO'
      );
    } finally {
      setSgosStoreFaultBoundaryForTests(null);
    }
    await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
    const recovered = await quarantineSgosProcess(root, processId, {
      confirmationSha256: plan.confirmationSha256
    });
    assert.equal(recovered.status, 'quarantined');
    assert.equal(recovered.confirmationSha256, plan.confirmationSha256);
    await access(path.join(quarantineAbsolute(root, recovered.quarantine), 'state.json'));
    const repeated = await quarantineSgosProcess(root, processId, {
      confirmationSha256: plan.confirmationSha256
    });
    assert.equal(repeated.confirmationSha256, recovered.confirmationSha256);
  }
});

test('current terminal-crash quarantine retry validates entirely from the exact moved snapshot', async () => {
  const root = await repository();
  const processId = 'PROC-ARCHIVE-RETRY-CURRENT-TERMINAL';
  const fixture = await currentProcessFixture(root, processId);
  const plan = await planSgosProcessQuarantine(root, processId);
  assert.equal(plan.reason, 'terminal-attempt-before-receipt');
  setSgosStoreFaultBoundaryForTests('quarantine-rename', { code: 'EIO' });
  try {
    await assert.rejects(
      () => quarantineSgosProcess(root, processId, {
        confirmationSha256: plan.confirmationSha256
      }),
      (error) => error.code === 'EIO'
    );
  } finally {
    setSgosStoreFaultBoundaryForTests(null);
  }
  await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
  const recovered = await quarantineSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(recovered.reason, 'terminal-attempt-before-receipt');
  assert.equal(recovered.interruptedTask.attemptSha256, fixture.attempt.attemptSha256);
  await access(path.join(quarantineAbsolute(root, recovered.quarantine), 'state.json'));
});

test('quarantine and execution-lease publication are serialized without recreating a moved Process', async () => {
  const root = await repository();
  const processId = 'PROC-ARCHIVE-LEASE-RACE';
  const fixture = await processFixture(root, processId);
  const plan = await planSgosProcessQuarantine(root, processId);
  const lease = {
    kind: 'sgos-execution-lease',
    leaseId: 'lease-racing-archive',
    processId,
    attemptId: 'attempt-racing-archive',
    taskInstanceId: 'task-racing-archive',
    ownerId: 'owner-racing-archive',
    ownerPid: process.pid,
    ownerStartFingerprint: currentSgosExecutionOwnerFingerprint(),
    beforeProcessSha256: h('1'),
    beforeProcessRevision: 1,
    executionHandleSha256: h('2'),
    attemptSha256: h('3'),
    acquiredAt: timestamp,
    heartbeatAt: timestamp
  };
  registerSgosExecutionOwner({ ...lease, schemaVersion: 1 });
  const settled = await Promise.allSettled([
    quarantineSgosProcess(root, processId, { confirmationSha256: plan.confirmationSha256 }),
    writeSgosExecutionLease(root, processId, lease)
  ]);
  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
  const quarantined = settled[0].status === 'fulfilled';
  if (quarantined) {
    await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
    await access(path.join(quarantineAbsolute(root, settled[0].value.quarantine), 'state.json'));
  } else {
    await access(path.join(fixture.directory, 'state.json'));
    assert.equal(settled[0].reason?.code, 'SGOS_PROCESS_QUARANTINE_LIVE');
  }
});

test('SGOS Process quarantine refuses live leases and unsafe filesystem entries', async () => {
  const liveRoot = await repository();
  const liveId = 'PROC-ARCHIVE-LIVE';
  await processFixture(liveRoot, liveId, { liveLease: true });
  await assert.rejects(
    () => planSgosProcessQuarantine(liveRoot, liveId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_LIVE'
  );

  const unsafeRoot = await repository();
  const unsafeId = 'PROC-ARCHIVE-UNSAFE';
  await processFixture(unsafeRoot, unsafeId, { unsafeSymlink: true });
  await assert.rejects(
    () => planSgosProcessQuarantine(unsafeRoot, unsafeId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_UNSAFE'
  );
});

test('SGOS Process quarantine accepts only unreadable v1 authority records', async () => {
  const requestRoot = await repository();
  const requestId = 'PROC-ARCHIVE-REQUEST';
  await processFixture(requestRoot, requestId, { bindingVersion: 2, humanRequestVersion: 1 });
  const requestPlan = await planSgosProcessQuarantine(requestRoot, requestId);
  assert.deepEqual(requestPlan.quarantinedReferences.map((entry) => entry.family),
    ['gvm-process', 'human-request']);

  const currentRoot = await repository();
  const currentId = 'PROC-ARCHIVE-CURRENT';
  await processFixture(currentRoot, currentId, { bindingVersion: 2 });
  const stateOnlyPlan = await planSgosProcessQuarantine(currentRoot, currentId);
  assert.deepEqual(stateOnlyPlan.quarantinedReferences.map((entry) => entry.family),
    ['gvm-process']);

  const futureRoot = await repository();
  const futureId = 'PROC-ARCHIVE-FUTURE';
  await processFixture(futureRoot, futureId, { bindingVersion: 3 });
  await assert.rejects(
    () => planSgosProcessQuarantine(futureRoot, futureId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_FUTURE_SCHEMA'
  );

  const corruptRoot = await repository();
  const corruptId = 'PROC-ARCHIVE-CORRUPT';
  await processFixture(corruptRoot, corruptId, { corruptBinding: true });
  await assert.rejects(
    () => planSgosProcessQuarantine(corruptRoot, corruptId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );
});

test('readable v2 terminal-attempt-before-receipt quarantine preserves exact bytes without claiming success', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-TERMINAL';
  const fixture = await currentProcessFixture(root, processId, { storedProcessVersion: 2 });
  const stateBytes = await readFile(path.join(fixture.directory, 'state.json'));
  const attemptRelative = path.join(
    'attempts', `${fixture.attempt.attemptSha256.slice('sha256:'.length)}.json`
  );
  const attemptBytes = await readFile(path.join(fixture.directory, attemptRelative));

  const plan = await planSgosProcessQuarantine(root, processId);
  assert.equal(plan.status, 'quarantine-ready');
  assert.equal(plan.reason, 'terminal-attempt-before-receipt');
  assert.equal(plan.interruptedTask.attemptId, fixture.attempt.attemptId);
  assert.equal(plan.interruptedTask.receiptPresent, false);
  assert.equal(plan.interruptedTask.liveLeasePresent, false);
  assert.equal(plan.successClaimed, false);

  const result = await quarantineSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(result.quarantined, true);
  const quarantine = quarantineAbsolute(root, result.quarantine);
  assert.deepEqual(await readFile(path.join(quarantine, 'state.json')), stateBytes);
  assert.deepEqual(await readFile(path.join(quarantine, attemptRelative)), attemptBytes);
  await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
});

test('failed terminal before evidence is quarantinable but never retryable or successful', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-FAILED-TERMINAL';
  const fixture = await currentProcessFixture(root, processId, { terminalStatus: 'failed' });
  const stateBytes = await readFile(path.join(fixture.directory, 'state.json'));

  const plan = await planSgosProcessQuarantine(root, processId);
  assert.equal(plan.reason, 'failed-terminal-before-evidence');
  assert.equal(plan.retryable, false);
  assert.equal(plan.resumable, false);
  assert.equal(plan.successClaimed, false);
  assert.equal(plan.interruptedTask.terminalAttemptStatus, 'failed');
  assert.equal(plan.interruptedTask.evidencePresent, false);
  assert.equal(plan.interruptedTask.receiptPresent, false);

  const result = await quarantineSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(result.retryable, false);
  assert.deepEqual(await readFile(path.join(
    quarantineAbsolute(root, result.quarantine), 'state.json'
  )), stateBytes);
});

test('quarantine preserves recognized pending-writer bytes without parsing or restoring them', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-PENDING-WRITER';
  const fixture = await processFixture(root, processId);
  const pendingName = 'state.json.pending-4242-11111111-1111-4111-8111-111111111111';
  const pendingBytes = Buffer.from('incomplete writer bytes; deliberately not JSON\n');
  await writeFile(path.join(fixture.directory, pendingName), pendingBytes);

  const census = await schemaCensus(root);
  assert.equal(census.totals.unreadable, 0, 'schema fsck must not parse staging bytes');
  const plan = await planSgosProcessQuarantine(root, processId);
  assert.equal(plan.pendingWriterLeftovers.length, 1);
  assert.deepEqual(plan.pendingWriterLeftovers[0], {
    path: pendingName,
    targetPath: 'state.json',
    family: 'gvm-process',
    writerPid: 4242,
    stagingId: '11111111-1111-4111-8111-111111111111',
    bytes: pendingBytes.length,
    sha256: plan.pendingWriterLeftovers[0].sha256
  });
  assert.equal(plan.retryable, false);
  assert.equal(plan.limits.maximumPendingWriterFiles,
    SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles);
  assert.ok(plan.limits.maximumFiles >= 7 * SGOS_INSTALLED_LIMITS.maximumAttemptRecords
    + 3 * SGOS_INSTALLED_LIMITS.maximumControlRecords
    + SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles);
  assert.equal(plan.limits.maximumTreeBytes,
    SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes
      + (2 * SGOS_INSTALLED_LIMITS.maximumControlRecords
        + SGOS_INSTALLED_LIMITS.maximumExecutionLeases
        + SGOS_INSTALLED_LIMITS.maximumPendingWriterFiles
        + 4) * SGOS_INSTALLED_LIMITS.maximumRecordBytes);

  const changedPendingBytes = Buffer.from('changed incomplete writer bytes; still not JSON\n');
  await writeFile(path.join(fixture.directory, pendingName), changedPendingBytes);
  await assert.rejects(
    () => quarantineSgosProcess(root, processId, {
      confirmationSha256: plan.confirmationSha256
    }),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_STALE'
  );
  const refreshed = await planSgosProcessQuarantine(root, processId);
  const result = await quarantineSgosProcess(root, processId, {
    confirmationSha256: refreshed.confirmationSha256
  });
  const quarantine = quarantineAbsolute(root, result.quarantine);
  assert.deepEqual(await readFile(path.join(quarantine, pendingName)), changedPendingBytes);
  await assert.rejects(() => access(fixture.directory), { code: 'ENOENT' });
});

test('pending-like files outside the exact SGOS writer pattern remain corrupt input', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-FAKE-PENDING';
  const fixture = await processFixture(root, processId);
  await writeFile(path.join(fixture.directory, 'state.json.pending-manual'), 'not trusted\n');
  await assert.rejects(
    () => planSgosProcessQuarantine(root, processId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );
});

test('interrupted creation seed remains visible beside healthy peers and quarantines after authority drift', async () => {
  const root = await repository();
  const healthyId = 'PROC-CREATION-HEALTHY';
  const seedId = 'PROC-CREATION-INTERRUPTED';
  const healthy = await creationSeedFixture(root, healthyId, { promoteGenesis: true });
  const seed = await creationSeedFixture(root, seedId);
  const seedBytes = await readFile(path.join(seed.directory, 'state.json'));

  await writeFile(path.join(root, 'AUTHORITY-CHANGED.md'), '# authority advanced\n');
  git(root, ['add', 'AUTHORITY-CHANGED.md']);
  git(root, ['commit', '-qm', 'advance authority after interrupted creation']);

  const inventory = await listSgosProcesses(root);
  const available = inventory.find((entry) => entry.processId === healthyId);
  const unavailable = inventory.find((entry) => entry.processId === seedId);
  assert.equal(available.processSha256, healthy.state.processSha256);
  assert.equal(unavailable.kind, 'sgos-process-unavailable');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.error.code, 'SGOS_CONTROL_LINEAGE_INVALID');
  assert.equal(unavailable.successClaimed, false);
  assert.equal(unavailable.resumable, false);

  const plan = await planSgosProcessQuarantine(root, seedId);
  assert.equal(plan.reason, 'interrupted-creation-seed');
  assert.equal(plan.creationSeed.processRevision, 1);
  assert.equal(plan.creationSeed.controlEventSha256, null);
  assert.equal(plan.creationSeed.programSha256, seed.program.programSha256);
  assert.equal(plan.creationSeed.processBindingSha256, seed.binding.bindingSha256);
  assert.equal(plan.creationSeed.taskCount, 1);
  assert.equal(plan.retryable, false);
  assert.equal(plan.successClaimed, false);
  const result = await quarantineSgosProcess(root, seedId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.deepEqual(await readFile(path.join(
    quarantineAbsolute(root, result.quarantine), 'state.json'
  )), seedBytes);
  assert.deepEqual((await listSgosProcesses(root)).map((entry) => entry.processId), [healthyId]);
});

test('creation-seed quarantine requires exact Program, Binding, and task materialization', async () => {
  for (const missing of ['program', 'binding']) {
    const root = await repository();
    const processId = `PROC-CREATION-MISSING-${missing.toUpperCase()}`;
    const fixture = await creationSeedFixture(root, processId);
    const target = missing === 'program'
      ? path.join(fixture.directory, 'programs',
        `${fixture.program.programSha256.slice('sha256:'.length)}.json`)
      : path.join(fixture.directory, 'bindings',
        `${fixture.binding.bindingSha256.slice('sha256:'.length)}.json`);
    await rm(target);
    await assert.rejects(
      () => planSgosProcessQuarantine(root, processId),
      (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT',
      missing
    );
  }

  const root = await repository();
  const processId = 'PROC-CREATION-MATERIALIZATION';
  const fixture = await creationSeedFixture(root, processId);
  const changed = structuredClone(fixture.state);
  changed.taskInstances[fixture.taskInstanceId].state = 'waiting';
  const resealed = seal(changed, 'processSha256');
  await writeFile(path.join(fixture.directory, 'state.json'), `${JSON.stringify(resealed)}\n`);
  await assert.rejects(
    () => planSgosProcessQuarantine(root, processId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );
});

test('all SGOS writers enforce the same per-record byte ceiling used by quarantine', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-WRITER-BOUND';
  const program = createGvmProgram({
    intentIrSha256: h('1'),
    workflowSha256: h('2'),
    ratificationSha256: h('3'),
    policySnapshotSha256: h('4'),
    registrySnapshotSha256: h('5'),
    storageProfileSha256: h('6'),
    taskTemplates: [{
      taskTemplateId: 'oversized', opcode: 'END',
      metadata: { padding: 'x'.repeat(SGOS_INSTALLED_LIMITS.maximumRecordBytes) }
    }],
    edges: [], joins: [], budgets: { maximumTasks: 1, maximumAttempts: 1 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: 'oversized', state: 'succeeded' }],
    compiler: { id: 'sflow-gvm-compiler', version: '2' }
  });
  await assert.rejects(
    () => putSgosImmutableRecord(root, processId, 'gvm-program', program),
    (error) => error.code === 'SGOS_RECORD_BUDGET_EXCEEDED'
      && error.details?.maximumBytes === SGOS_INSTALLED_LIMITS.maximumRecordBytes
  );
});

test('current-version quarantine allows a dead lease but refuses a live owner', async () => {
  const deadRoot = await repository();
  const deadId = 'PROC-QUARANTINE-DEAD-LEASE';
  await currentProcessFixture(deadRoot, deadId, { leaseOwnerPid: 2_147_483_647 });
  const deadPlan = await planSgosProcessQuarantine(deadRoot, deadId);
  assert.equal(deadPlan.reason, 'terminal-attempt-before-receipt');

  const liveRoot = await repository();
  const liveId = 'PROC-QUARANTINE-LIVE-V2';
  await currentProcessFixture(liveRoot, liveId, { leaseOwnerPid: process.pid });
  await assert.rejects(
    () => planSgosProcessQuarantine(liveRoot, liveId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_LIVE'
  );
});

test('current-version quarantine validates every record and accepts exactly one interrupted task', async () => {
  const healthyRoot = await repository();
  const healthyId = 'PROC-QUARANTINE-HEALTHY';
  await currentProcessFixture(healthyRoot, healthyId, { terminalBeforeReceipt: false });
  await assert.rejects(
    () => planSgosProcessQuarantine(healthyRoot, healthyId),
    // A revision-one/null-head Process with no execution history is a creation seed. This fixture
    // deliberately omits its Program, so it is corrupt rather than a valid no-op quarantine.
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );

  const corruptRoot = await repository();
  const corruptId = 'PROC-QUARANTINE-CURRENT-CORRUPT';
  await currentProcessFixture(corruptRoot, corruptId, { corruptCurrentAttempt: true });
  await assert.rejects(
    () => planSgosProcessQuarantine(corruptRoot, corruptId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );

  const ambiguousRoot = await repository();
  const ambiguousId = 'PROC-QUARANTINE-MULTIPLE';
  await currentProcessFixture(ambiguousRoot, ambiguousId, { multipleTerminalAttempts: true });
  await assert.rejects(
    () => planSgosProcessQuarantine(ambiguousRoot, ambiguousId),
    (error) => error.code === 'SGOS_PROCESS_QUARANTINE_CORRUPT'
  );
});

test('archive API compatibility aliases return quarantine-labelled plans and outcomes', async () => {
  const root = await repository();
  const processId = 'PROC-QUARANTINE-ALIAS';
  await processFixture(root, processId);
  const plan = await planSgosProcessArchive(root, processId);
  assert.equal(plan.kind, 'sgos-process-quarantine-plan');
  assert.equal(plan.status, 'quarantine-ready');
  const result = await archiveSgosProcess(root, processId, {
    confirmationSha256: plan.confirmationSha256
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(result.quarantined, true);
  assert.equal(Object.hasOwn(result, 'archived'), false);
});
