import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  candidateManifestSha256, createActionEvidence, createAgentProposal, createCandidateSnapshot,
  createGvmCheckpoint, createGvmProcess, createGvmProgram, createGvmTaskAttempt,
  createGvmTaskReceipt, createHumanRequest, createHumanResponse, createIntentEnvelope,
  createIntentIr, createPolicySnapshot, createProcessBinding, createSgosControlSuccessor,
  createSgosControlEvent, createSgosRecordIndex, createSgosTransitionIntent, createWorkflowIr,
  createSgosReplayPlan,
  MAXIMUM_SGOS_PROCESS_RECORD_BYTES, MAXIMUM_SGOS_PROCESS_RECORD_COUNT,
  MAXIMUM_SGOS_RECORD_BYTES, MAXIMUM_SGOS_RECORD_INDEX_DELTA,
  SGOS_RECORD_INDEX_FAMILIES,
  createWorkflowRatification, createWorkObject, policyComponentSha256, recordSelfSha256,
  sgosContractFamilies, sha256, validateCandidateSnapshot, validatePolicySnapshot,
  validateProcessBinding, validateSgosRecord, validateSgosRecordIndex,
  validateSgosTransitionIntent
} from '../src/sgos/contracts.mjs';
import { SGOS_INSTALLED_LIMITS } from '../src/sgos/limits.mjs';
import { compareSgosCodePoints } from '../src/sgos/order.mjs';
import { currentSchemaVersion, migrationRegistrySnapshot, readRecord } from '../src/schema-migrations.mjs';

const at = '2026-08-29T10:00:00.000Z';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const principal = Object.freeze({ id: 'human@example.test', kind: 'human', name: 'Human Reviewer' });
const d = (name) => sha256(`fixture:${name}`);
const configurationAuthority = Object.freeze({
  kind: 'approved-configuration-ref',
  ref: 'refs/remotes/origin/sflow/config',
  commit: '0123456789abcdef0123456789abcdef01234567',
  workflowBlobSha256: d('approved-workflow')
});

function policyInput() {
  return {
    authorityRevision: 'refs/heads/sflow/config@0123456789abcdef',
    lawSha256: policyComponentSha256({ law: 'v1' }),
    registrySha256: policyComponentSha256({ registry: 'v1' }),
    executionUnitPolicySha256: policyComponentSha256({ units: ['local'] }),
    devicePolicySha256: policyComponentSha256({ devices: [] }),
    storagePolicySha256: policyComponentSha256({ primary: 'git' }),
    memoryPolicySha256: policyComponentSha256({ durable: false }),
    humanAuthoritySha256: policyComponentSha256({ approvers: ['human@example.test'] }),
    governedRootsSha256: policyComponentSha256({ roots: ['src'] }),
    verificationPolicySha256: policyComponentSha256({ checks: ['unit'] }),
    publicationPolicySha256: policyComponentSha256({ remote: 'origin' })
  };
}

function candidateResources() {
  return [
    {
      path: 'src/old.mjs', type: 'file', mode: null, contentSha256: null,
      operation: 'deleted', renameFrom: null, renameTo: null, deletion: true
    },
    {
      path: 'src/link', type: 'symlink', mode: '120000', contentSha256: d('link-target'),
      operation: 'added', renameFrom: null, renameTo: null, deletion: false
    },
    {
      path: 'src/new-name.mjs', type: 'file', mode: '100755', contentSha256: d('renamed'),
      operation: 'renamed', renameFrom: 'src/name.mjs', renameTo: 'src/new-name.mjs', deletion: false
    }
  ];
}

test('SGOS durable families expose exact readable versions and refuse future versions', () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  assert.equal(sgosContractFamilies().length, 25);
  for (const family of sgosContractFamilies()) {
    const current = family === 'gvm-process'
      ? 3
      : ['process-binding', 'human-request', 'gvm-task-receipt'].includes(family) ? 2 : 1;
    assert.equal(currentSchemaVersion(family), current);
    assert.equal(registry.get(family)?.immutable,
      !['gvm-process', 'sgos-transition-intent'].includes(family));
    assert.throws(
      () => readRecord(family, { schemaVersion: current + 1 }),
      (error) => error.code === 'SCHEMA_VERSION_FUTURE'
    );
  }
  for (const family of ['process-binding', 'gvm-process', 'human-request', 'gvm-task-receipt']) {
    assert.throws(
      () => readRecord(family, { schemaVersion: 1 }),
      (error) => error.code === 'SCHEMA_VERSION_ARCHIVED'
    );
  }
  const migratedProcess = readRecord('gvm-process', { schemaVersion: 2 }).record;
  assert.equal(migratedProcess.controlEventSha256, null);
  assert.equal(migratedProcess.recordIndexSha256, null);
});

test('SGOS canonical ordering is locale-independent across contracts, runtime, and projections', async () => {
  assert.deepEqual(['😀', 'ä', 'z', 'A'].sort(compareSgosCodePoints), ['A', 'z', 'ä', '😀']);
  for (const file of [
    'src/sgos/contracts.mjs', 'src/sgos/runtime.mjs', 'src/sgos/projection.mjs',
    'src/commands/sgos.mjs'
  ]) {
    assert.doesNotMatch(await readFile(path.join(root, file), 'utf8'), /\.localeCompare\(/, file);
  }
});

test('the umbrella JSON Schema covers every closed SGOS record vocabulary', async () => {
  const schema = JSON.parse(await readFile(path.join(root, 'schemas', 'sgos-contract.schema.json'), 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.oneOf.length, sgosContractFamilies().length);
  const kinds = Object.values(schema.$defs)
    .map((definition) => definition?.properties?.kind?.const)
    .filter(Boolean)
    .sort();
  assert.deepEqual(kinds, [...sgosContractFamilies()].sort());
  for (const definition of Object.values(schema.$defs).filter((entry) => entry?.properties?.kind?.const)) {
    assert.equal(definition.additionalProperties, false, definition.properties.kind.const);
    for (const required of definition.required ?? []) {
      assert.ok(Object.hasOwn(definition.properties ?? {}, required),
        `${definition.properties.kind.const} requires undeclared property ${required}`);
    }
    assert.ok(definition.required.includes(definition.properties.kind.const === 'gvm-process'
      ? 'processSha256'
      : Object.keys(definition.properties).find((key) => key.endsWith('Sha256') && definition.required.includes(key))));
  }

  const resolvePointer = (reference) => reference.slice(2).split('/').reduce((value, encoded) =>
    value?.[encoded.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
      assert.notEqual(resolvePointer(value.$ref), undefined, `unresolved schema reference ${value.$ref}`);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(schema);

  assert.equal(schema.$defs.gvmProcess.properties.schemaVersion.const, 3);
  assert.ok(schema.$defs.gvmProcess.required.includes('recordIndexSha256'));
  assert.ok(schema.$defs.sgosControlEvent.required.includes('recordIndexSha256'));
  for (const field of ['cumulativeInfrastructureBytes', 'cumulativeInfrastructureRecords']) {
    assert.ok(schema.$defs.sgosControlSuccessor.required.includes(field));
    assert.deepEqual(schema.$defs.sgosControlSuccessor.properties[field], {
      type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER
    });
  }
  assert.deepEqual({
    maximumRecordBytes: MAXIMUM_SGOS_RECORD_BYTES,
    maximumProcessRecordBytes: MAXIMUM_SGOS_PROCESS_RECORD_BYTES,
    maximumProcessRecords: MAXIMUM_SGOS_PROCESS_RECORD_COUNT,
    maximumRecordIndexDeltaEntries: MAXIMUM_SGOS_RECORD_INDEX_DELTA
  }, {
    maximumRecordBytes: SGOS_INSTALLED_LIMITS.maximumRecordBytes,
    maximumProcessRecordBytes: SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes,
    maximumProcessRecords: SGOS_INSTALLED_LIMITS.maximumProcessRecords,
    maximumRecordIndexDeltaEntries: SGOS_INSTALLED_LIMITS.maximumRecordIndexDeltaEntries
  });
  assert.equal(schema.$defs.sgosRecordIndexDelta.properties.bytes.maximum,
    SGOS_INSTALLED_LIMITS.maximumRecordBytes);
  assert.equal(schema.$defs.sgosRecordIndex.properties.delta.maxItems,
    SGOS_INSTALLED_LIMITS.maximumRecordIndexDeltaEntries);
  assert.equal(schema.$defs.sgosRecordIndex.properties.totalRecordCount.maximum,
    SGOS_INSTALLED_LIMITS.maximumProcessRecords);
  assert.equal(schema.$defs.sgosRecordIndex.properties.totalBytes.maximum,
    SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes);
  assert.deepEqual(
    [...schema.$defs.sgosRecordIndexDelta.properties.family.enum].sort(),
    [...SGOS_RECORD_INDEX_FAMILIES].sort(),
    'the portable schema must accept every record family emitted by the runtime index'
  );
  assert.deepEqual(
    Object.keys(schema.$defs.sgosRecordIndexFamilyCounts.properties).sort(),
    [...SGOS_RECORD_INDEX_FAMILIES].sort(),
    'the portable schema must accept cumulative counts for every runtime record family'
  );
  assert.deepEqual(schema.$defs.processAuthorityBinding.properties.kind.enum, ['story', 'repository']);
  assert.deepEqual(schema.$defs.processAuthorityBinding.oneOf.map((branch) => ({
    kind: branch.properties.kind.const,
    authority: branch.properties.authority.const,
    subjectAuthority: branch.properties.subjectAuthority.type
      ?? branch.properties.subjectAuthority.$ref
  })), [
    {
      kind: 'story', authority: 'existing-story-lifecycle',
      subjectAuthority: '#/$defs/storySubjectAuthority'
    },
    {
      kind: 'repository', authority: 'existing-repository-baseline',
      subjectAuthority: 'null'
    }
  ]);
  for (const field of ['startedAt', 'completedAt']) {
    assert.deepEqual(schema.$defs.gvmTaskAttempt.properties[field].oneOf, [
      { $ref: '#/$defs/timestamp' }, { type: 'null' }
    ], `gvm-task-attempt.${field}`);
  }
});

test('SGOS control successors bind exact safe cumulative infrastructure counters', () => {
  const input = {
    processId: 'PROC-SUCCESSOR', beforeProcessSha256: d('before-process'),
    controlEventSha256: d('control-event'), controlDepth: 1,
    operatorTransitionCount: 0, cumulativeInfrastructureBytes: 4096,
    cumulativeInfrastructureRecords: 3
  };
  const successor = createSgosControlSuccessor(input);
  assert.equal(successor.cumulativeInfrastructureBytes, 4096);
  assert.equal(successor.cumulativeInfrastructureRecords, 3);
  assert.equal(successor.successorSha256,
    recordSelfSha256(successor, 'successorSha256'));
  for (const [field, value] of [
    ['cumulativeInfrastructureBytes', -1],
    ['cumulativeInfrastructureRecords', 0.5],
    ['cumulativeInfrastructureBytes', Number.MAX_SAFE_INTEGER + 1]
  ]) {
    assert.throws(() => createSgosControlSuccessor({ ...input, [field]: value }),
      /safe integer/);
  }
  const missing = { ...input };
  delete missing.cumulativeInfrastructureRecords;
  assert.throws(() => createSgosControlSuccessor(missing), /missing required field/);
});

test('SGOS record indexes form a bounded, sorted, cumulative immutable chain', () => {
  const processId = 'PROC-INDEX001';
  const genesis = createSgosRecordIndex({
    processId, sequence: 0, priorIndexSha256: null, delta: [], familyCounts: {},
    totalRecordCount: 0, totalBytes: 0
  });
  assert.equal(genesis.schemaVersion, currentSchemaVersion('sgos-record-index'));
  assert.equal(genesis.recordIndexSha256, recordSelfSha256(genesis, 'recordIndexSha256'));
  assert.deepEqual(validateSgosRecordIndex(genesis), genesis);
  assert.ok(Object.isFrozen(genesis));

  const delta = [
    {
      family: 'action-evidence', recordSha256: d('indexed-evidence'),
      attemptId: 'ATT-INDEX001', taskInstanceId: 'verify', bytes: 160
    },
    {
      family: 'gvm-task-attempt', recordSha256: d('indexed-attempt'),
      attemptId: 'ATT-INDEX001', taskInstanceId: 'verify', bytes: 96
    }
  ];
  const next = createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256, delta,
    familyCounts: { 'action-evidence': 1, 'gvm-task-attempt': 1 },
    totalRecordCount: 2, totalBytes: 256
  });
  assert.equal(next.priorIndexSha256, genesis.recordIndexSha256);
  assert.equal(next.totalRecordCount, 2);
  assert.deepEqual(validateSgosRecordIndex(next), next);

  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256,
    delta: [...delta].reverse(),
    familyCounts: { 'action-evidence': 1, 'gvm-task-attempt': 1 },
    totalRecordCount: 2, totalBytes: 256
  }), /strictly sorted/);
  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256,
    delta: [{ family: 'sgos-control-event', recordSha256: d('cycle'), bytes: 64 }],
    familyCounts: {}, totalRecordCount: 0, totalBytes: 64
  }), /must be one of/);
  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256,
    delta: [delta[0], delta[0]], familyCounts: { 'action-evidence': 2 },
    totalRecordCount: 2, totalBytes: 320
  }), /duplicate records/);
  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256,
    delta: [delta[0]], familyCounts: { 'action-evidence': 1 },
    totalRecordCount: 2, totalBytes: 160
  }), /must equal the cumulative/);
  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 1, priorIndexSha256: genesis.recordIndexSha256,
    delta: [delta[0]], familyCounts: { 'gvm-task-attempt': 1 },
    totalRecordCount: 1, totalBytes: 160
  }), /action-evidence cannot be smaller/);
  assert.throws(() => createSgosRecordIndex({
    processId, sequence: 0, priorIndexSha256: null, delta: [delta[0]],
    familyCounts: { 'action-evidence': 1 }, totalRecordCount: 1, totalBytes: 160
  }), /genesis must be an empty/);
  assert.throws(() => validateSgosRecordIndex({ ...next, totalBytes: 257 }), /does not match/);
});

test('replay plans bind one canonical exact prior-task projection', () => {
  const plan = createSgosReplayPlan({
    processId: 'PROC-REPLAY01',
    expectedProcessRevision: 7,
    expectedProcessSha256: d('replay-process'),
    programSha256: d('replay-program'),
    policySnapshotSha256: d('replay-policy'),
    processBindingSha256: d('replay-binding'),
    fromCheckpointSha256: d('replay-checkpoint'),
    taskInstanceIds: ['ignored-and-derived'],
    priorTasks: [{
      taskInstanceId: 'TSK-REPLAY01', taskTemplateId: '20-work', state: 'succeeded',
      revision: 3, inputRefs: [], attemptIds: ['ATT-REPLAY01'],
      receiptSha256: d('replay-receipt'), outputRefs: [d('replay-output')],
      invalidatedBy: null
    }],
    createdAt: at
  });
  assert.deepEqual(plan.taskInstanceIds, ['TSK-REPLAY01']);
  assert.equal(plan.replayPlanSha256, recordSelfSha256(plan, 'replayPlanSha256'));
  assert.throws(() => validateSgosRecord({
    ...plan,
    priorTasks: [{ ...plan.priorTasks[0], attemptIds: [] }]
  }), /does not match the canonical record/);
});

test('SGOS transition intents bind one exact sorted reservation delta and control edge', () => {
  const processId = 'PROC-INTENT01';
  const beforeProcessSha256 = d('intent-before-process');
  const priorRecordIndexSha256 = d('intent-prior-index');
  const nextRecordIndexSha256 = d('intent-next-index');
  const controlEvent = createSgosControlEvent({
    processId,
    processCoreSha256: d('intent-core'),
    priorControlEventSha256: null,
    beforeProcessSha256,
    beforeProcessRevision: 1,
    controlDepth: 1,
    operatorTransitionCount: 1,
    recordIndexSha256: nextRecordIndexSha256,
    action: 'process-paused',
    result: {
      status: 'paused', taskInstances: {}, activeExecutions: [], openHumanRequests: [],
      activeLeases: [], currentCheckpointSha256: null, processRevision: 2, updatedAt: at
    },
    createdAt: at
  });
  const reservations = [
    { family: 'action-evidence', recordSha256: d('intent-evidence'), bytes: 128 },
    { family: 'gvm-task-attempt', recordSha256: d('intent-attempt'), bytes: 256 }
  ];
  const intent = createSgosTransitionIntent({
    processId, beforeProcessSha256, beforeProcessRevision: 1,
    priorRecordIndexSha256, reservations, nextRecordIndexSha256, controlEvent,
    successorSha256: d('intent-successor'),
    candidateProcessSha256: d('intent-candidate')
  });
  assert.equal(intent.schemaVersion, currentSchemaVersion('sgos-transition-intent'));
  assert.equal(intent.intentSha256, recordSelfSha256(intent, 'intentSha256'));
  assert.deepEqual(validateSgosTransitionIntent(intent), intent);
  const intentInput = structuredClone(intent);
  delete intentInput.intentSha256;
  assert.throws(() => createSgosTransitionIntent({
    ...intentInput, reservations: [...reservations].reverse()
  }), /unique and canonically sorted/);
  assert.throws(() => createSgosTransitionIntent({
    ...intentInput,
    controlEvent: { ...controlEvent, beforeProcessSha256: d('other-predecessor') }
  }), /does not match the canonical record|does not bind its predecessor/);
  assert.throws(() => createSgosTransitionIntent({
    ...intentInput,
    reservations: [{ ...reservations[0], bytes: MAXIMUM_SGOS_RECORD_BYTES + 1 }]
  }), /installed .*record bound/);
});

test('GVM Task Attempt timestamps match runtime nullable and optional semantics', () => {
  const base = {
    processId: 'PROC-TIMESTAMPS', taskInstanceId: 'verify', attemptNumber: 1,
    parentAttemptId: null, reason: 'initial', taskContractSha256: d('task-contract'),
    executionHandleSha256: d('execution-handle'), status: 'running'
  };
  const running = createGvmTaskAttempt({ ...base, startedAt: at, completedAt: null });
  assert.equal(running.startedAt, at);
  assert.equal(running.completedAt, null);
  const omitted = createGvmTaskAttempt(base);
  assert.equal(Object.hasOwn(omitted, 'startedAt'), false);
  assert.equal(Object.hasOwn(omitted, 'completedAt'), false);
  assert.throws(() => createGvmTaskAttempt({
    ...base, startedAt: 'not-a-timestamp', completedAt: null
  }), /RFC 3339/);
  assert.throws(() => createGvmTaskAttempt({
    ...base, startedAt: at, completedAt: 'not-a-timestamp'
  }), /RFC 3339/);
});

test('policy snapshots pin every component, have deterministic IDs, and reject unknown or tampered data', () => {
  const source = policyInput();
  const first = createPolicySnapshot(source);
  source.lawSha256 = d('mutated-after-create');
  const second = createPolicySnapshot(policyInput());

  assert.equal(first.policyId, second.policyId);
  assert.equal(first.snapshotSha256, second.snapshotSha256);
  assert.notEqual(first.lawSha256, source.lawSha256);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first));
  assert.equal(recordSelfSha256(first, 'snapshotSha256'), first.snapshotSha256);
  assert.deepEqual(validatePolicySnapshot(first), first);

  assert.throws(() => createPolicySnapshot({ ...policyInput(), hiddenRelaxation: true }), /unknown field/);
  assert.throws(() => validatePolicySnapshot({ ...first, lawSha256: d('tamper') }), /does not match/);
  assert.throws(() => createPolicySnapshot({ ...policyInput(), lawSha256: 'a'.repeat(64) }), /sha256:/);
});

test('agent proposals retain exact bounded bytes without claiming verification or approval', () => {
  const output = Buffer.from('proposal bytes', 'utf8');
  const proposal = createAgentProposal({
    processId: 'PROC-123456', taskInstanceId: 'task-1', attemptId: 'ATT-123456',
    contractSha256: d('agent-contract'),
    executionUnitManifestSha256: d('copilot-manifest'),
    provider: 'copilot-cli', providerInvocationId: 'invocation-1',
    providerAuditRef: 'model-invocation:invocation-1',
    mediaType: 'text/plain; charset=utf-8', contentEncoding: 'base64',
    outputBase64: output.toString('base64'), outputBytes: output.length,
    outputSha256: sha256(output),
    assurance: {
      kind: 'proposal-only', authority: 'none',
      verification: 'not-performed', approval: 'not-granted'
    },
    createdAt: at
  });
  assert.equal(Buffer.from(proposal.outputBase64, 'base64').toString('utf8'),
    'proposal bytes');
  assert.match(proposal.proposalSha256, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => validateSgosRecord({
    ...proposal,
    assurance: { ...proposal.assurance, verification: 'passed' }
  }));
  assert.throws(() => validateSgosRecord({ ...proposal, outputBytes: output.length + 1 }));
});

test('candidate manifests are storage-neutral, canonical, and bind path/type/mode/content/rename/deletion', () => {
  const resources = candidateResources();
  const common = {
    subject: { kind: 'repository-tree', id: 'payments-api' },
    baseline: { revision: '0123456789abcdef', snapshotSha256: d('baseline') },
    createdBy: principal,
    createdAt: at
  };
  const first = createCandidateSnapshot({ ...common, resources });
  const second = createCandidateSnapshot({ ...common, resources: [...resources].reverse() });

  assert.equal(first.candidateId, second.candidateId);
  assert.equal(first.candidateSha256, second.candidateSha256);
  assert.equal(first.candidate.manifestSha256, candidateManifestSha256(resources));
  assert.deepEqual(first.resources.map((entry) => entry.path), [
    'src/link', 'src/new-name.mjs', 'src/old.mjs'
  ]);
  assert.equal(first.resources[1].renameFrom, 'src/name.mjs');
  assert.equal(first.resources[2].deletion, true);
  assert.doesNotMatch(JSON.stringify(first), /gitObject|gitTree|objectId/);
  assert.deepEqual(validateCandidateSnapshot(first), first);

  assert.throws(() => createCandidateSnapshot({
    ...common,
    resources: [{ ...resources[0], contentSha256: d('illegal-deletion-content') }]
  }), /deletion/);
  assert.throws(() => createCandidateSnapshot({
    ...common,
    resources: [{ ...resources[1], path: '../escape' }]
  }), /repository-relative/);
  assert.throws(() => validateCandidateSnapshot({
    ...first,
    resources: first.resources.map((entry, index) => index ? entry : { ...entry, mode: '100644' })
  }), /does not match|symlink/);
});

test('process binding is exact, self-hashed, and worktree-specific', () => {
  const baselineRevision = '0'.repeat(40);
  const subjectAuthority = {
    kind: 'governed-story-baseline',
    subjectId: 'payments-api',
    revision: baselineRevision,
    path: 'singularity/work-items/payments-api/workflow.json',
    blobSha256: d('story-blob'),
    stateSha256: d('story-state')
  };
  const base = {
    processId: 'PROC-123456',
    subjectId: 'payments-api',
    subjectAuthority,
    configurationAuthority,
    repositoryIdentity: d('repository'),
    gitCommonDirectory: '/workspace/repository/.git',
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/feature',
    canonicalWorktreeRoot: '/workspace/feature',
    branch: 'feature/sgos',
    baselineRevision,
    expectedProcessRevision: 7
  };
  const first = createProcessBinding(base);
  const otherWorktree = createProcessBinding({
    ...base,
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/other',
    canonicalWorktreeRoot: '/workspace/other'
  });
  const otherConfiguration = createProcessBinding({
    ...base,
    configurationAuthority: { ...configurationAuthority, workflowBlobSha256: d('other-workflow') }
  });
  const otherStory = createProcessBinding({
    ...base,
    subjectAuthority: { ...subjectAuthority, blobSha256: d('other-story-blob') }
  });
  assert.notEqual(first.bindingSha256, otherWorktree.bindingSha256);
  assert.notEqual(first.bindingSha256, otherConfiguration.bindingSha256);
  assert.notEqual(first.bindingSha256, otherStory.bindingSha256);
  assert.equal(recordSelfSha256(first, 'bindingSha256'), first.bindingSha256);
  assert.deepEqual(validateProcessBinding(first), first);
  assert.throws(() => createProcessBinding({ ...base, canonicalWorktreeRoot: 'relative/root' }), /absolute path/);
  assert.throws(() => createProcessBinding({ ...base, expectedProcessRevision: -1 }), />= 0/);
  assert.throws(() => createProcessBinding({
    ...base, subjectAuthority: { ...subjectAuthority, subjectId: 'other-story' }
  }), /bound subject/);
});

test('intent, workflow, ratification, Program, runtime, human, evidence, and UI records form one hashed chain', () => {
  const policy = createPolicySnapshot(policyInput());
  const envelope = createIntentEnvelope({
    generation: 1,
    principal,
    source: { kind: 'natural-language', revision: null },
    rawRef: 'sfref:intents/raw/one',
    rawSha256: d('raw-intent'),
    attachments: [],
    capturedAt: at
  });
  const intent = createIntentIr({
    intentId: envelope.intentId,
    generation: 1,
    objective: { statement: 'Produce a verified result', provenance: 'explicit' },
    outcomes: [],
    successCriteria: [{ id: 'SC-1', statement: 'Verification passes', provenance: 'explicit', required: true }],
    constraints: [], invariants: [], preferences: [], nonGoals: [], assumptions: [], unknowns: [],
    contradictions: [], risks: [],
    subjects: [{ kind: 'repository', id: 'payments-api' }],
    evidenceExpectations: [], authorityRequirements: [], budgets: [],
    domainCandidates: [], workTypeCandidates: []
  });
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1',
    version: '1',
    intentIrSha256: intent.intentIrSha256,
    policySnapshotSha256: policy.snapshotSha256,
    metadata: { id: 'verified-result', version: '1', domainPack: 'software-delivery' },
    spec: {
      inputs: {},
      tasks: {
        verify: {
          kind: 'task', opcode: 'VERIFY', operation: 'code.verify', dependsOn: [],
          resources: { reads: ['src'], writes: [], devices: [], externalEffects: [] },
          intentClauseIds: ['SC-1'], material: true
        }
      },
      joins: {}, terminalConditions: [{ task: 'verify', state: 'succeeded' }], budgets: {},
      recovery: {}, evidence: {}, authority: {}, storageRequirements: {},
      intentWorkflowMap: {
        clauses: { 'SC-1': [{ kind: 'task', targetId: 'verify' }] },
        tasks: { verify: [{ kind: 'intent-clause', sourceId: 'SC-1' }] }
      }
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intent.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: policy.snapshotSha256,
    registrySnapshotSha256: d('registry'),
    storageProfileSha256: d('storage-profile'),
    packetSha256: d('ratification-packet'),
    decision: 'ratified', principal, decidedAt: at
  });
  const program = createGvmProgram({
    intentIrSha256: intent.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    ratificationSha256: ratification.ratificationSha256,
    policySnapshotSha256: policy.snapshotSha256,
    registrySnapshotSha256: ratification.registrySnapshotSha256,
    storageProfileSha256: ratification.storageProfileSha256,
    taskTemplates: [{
      id: 'verify', opcode: 'VERIFY', operation: 'code.verify', dependsOn: [],
      resources: { reads: ['src'], writes: [], devices: [], externalEffects: [] },
      intentClauseIds: ['SC-1']
    }],
    edges: [], joins: [], budgets: {}, recoveryPolicy: {},
    terminalConditions: [{ task: 'verify', state: 'succeeded' }],
    compiler: { id: 'sflow-gvm-compiler', version: '2' }
  });
  const binding = createProcessBinding({
    processId: 'PROC-123456', subjectId: 'payments-api', repositoryIdentity: d('repository'),
    subjectAuthority: null,
    configurationAuthority,
    gitCommonDirectory: '/workspace/repository/.git',
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/feature',
    canonicalWorktreeRoot: '/workspace/feature', branch: 'feature/sgos',
    baselineRevision: '0123456789abcdef0123456789abcdef01234567', expectedProcessRevision: 0
  });
  const attempt = createGvmTaskAttempt({
    processId: binding.processId, taskInstanceId: 'verify', attemptNumber: 1,
    parentAttemptId: null, reason: 'initial', taskContractSha256: d('task-contract'),
    executionHandleSha256: d('execution-handle'), status: 'running', startedAt: at,
    completedAt: null
  });
  const candidate = createCandidateSnapshot({
    subject: { kind: 'repository-tree', id: 'payments-api' },
    baseline: { revision: '0123456789abcdef', snapshotSha256: d('baseline') },
    resources: candidateResources(), createdBy: principal, createdAt: at
  });
  const receipt = createGvmTaskReceipt({
    processId: binding.processId, taskInstanceId: 'verify', attemptId: attempt.attemptId,
    attemptSha256: attempt.attemptSha256,
    inputRefs: [], outputRefs: [], candidateSha256: candidate.candidateSha256,
    evidenceRefs: ['sfref:evidence/one'], effectRefs: [], humanDecisionRefs: [],
    verification: { status: 'passed', checksSha256: d('checks') }, completedAt: at
  });
  const checkpoint = createGvmCheckpoint({
    processId: binding.processId, processRevision: 1, programSha256: program.programSha256,
    policySnapshotSha256: policy.snapshotSha256, processBindingSha256: binding.bindingSha256,
    taskStates: { verify: 'succeeded' }, readyTaskIds: [], activeExecutions: [],
    openHumanRequests: [], activeLeases: [], priorCheckpointSha256: null, createdAt: at
  });
  const process = createGvmProcess({
    processId: binding.processId, programSha256: program.programSha256,
    policySnapshotSha256: policy.snapshotSha256, processBindingSha256: binding.bindingSha256,
    status: 'succeeded',
    taskInstances: {
      verify: {
        taskInstanceId: 'verify', taskTemplateId: 'verify', state: 'succeeded',
        predecessorTaskInstanceIds: [], inputRefs: [], outputRefs: [],
        attemptIds: [attempt.attemptId], receiptSha256: receipt.receiptSha256,
        invalidatedBy: null, revision: 1
      }
    },
    activeExecutions: [], openHumanRequests: [], activeLeases: [],
    currentCheckpointSha256: checkpoint.checkpointSha256, processRevision: 1,
    authorityBinding: {
      kind: 'repository', subjectId: binding.subjectId, subjectAuthority: null,
      branch: binding.branch, baselineRevision: binding.baselineRevision,
      baselineSnapshotSha256: d('process-baseline'),
      authority: 'existing-repository-baseline', configurationAuthority,
      humanAuthorityRequirements: [],
      executionAdmission: {
        admitted: true, programId: program.programId, programSha256: program.programSha256,
        provenance: {
          method: 'approved-program-authority', programSha256: program.programSha256,
          ratificationSha256: program.ratificationSha256,
          source: {
            kind: configurationAuthority.kind, ref: configurationAuthority.ref,
            commit: configurationAuthority.commit, sourceCommit: configurationAuthority.commit,
            path: `singularity/sgos/program-authorities/${program.programSha256.slice(7)}.json`,
            blobSha256: d('program-authority'), configurationAuthority
          }
        },
        safety: {
          safe: true, programId: program.programId, programSha256: program.programSha256,
          compiler: program.compiler,
          graph: {
            taskCount: 1, edgeCount: 0, roots: ['verify'], terminalTaskIds: ['verify'],
            topologicalOrder: ['verify']
          },
          registry: { verified: false, registrySnapshotSha256: program.registrySnapshotSha256 }
        }
      }
    },
    taskContractSha256: d('task-contract'),
    createdAt: at, updatedAt: at
  });
  assert.equal(process.schemaVersion, 3);
  assert.equal(process.recordIndexSha256, null);
  const processWithAuthority = (authorityBinding) => {
    const seed = structuredClone(process);
    delete seed.processSha256;
    seed.authorityBinding = authorityBinding;
    return seed;
  };
  const storyAuthorityBinding = {
    ...process.authorityBinding,
    kind: 'story',
    subjectAuthority: {
      kind: 'governed-story-baseline', subjectId: binding.subjectId,
      revision: binding.baselineRevision,
      path: `singularity/work-items/${binding.subjectId}/workflow.json`,
      blobSha256: d('story-blob'), stateSha256: d('story-state')
    },
    authority: 'existing-story-lifecycle'
  };
  assert.equal(createGvmProcess(processWithAuthority(storyAuthorityBinding))
    .authorityBinding.subjectAuthority.kind, 'governed-story-baseline');
  assert.throws(() => createGvmProcess(processWithAuthority({
    ...process.authorityBinding, kind: 'workspace'
  })), /must be one of: story, repository/);
  assert.throws(() => createGvmProcess(processWithAuthority({
    ...storyAuthorityBinding, subjectAuthority: null
  })), /subjectAuthority is required/);
  assert.throws(() => createGvmProcess(processWithAuthority({
    ...process.authorityBinding, subjectAuthority: storyAuthorityBinding.subjectAuthority
  })), /subjectAuthority must be null/);
  assert.throws(() => createGvmProcess(processWithAuthority({
    ...process.authorityBinding, authority: 'existing-story-lifecycle'
  })), /existing-repository-baseline/);
  const request = createHumanRequest({
    requestType: 'approval', processId: process.processId, taskInstanceId: 'verify',
    checkpointSha256: checkpoint.checkpointSha256, requestedBy: principal,
    authorityRequired: { kind: 'reviewer', id: 'release-reviewer' },
    configurationAuthority,
    prompt: { title: 'Approve', detail: 'Review the exact packet.' },
    options: [{ id: 'approve', label: 'Approve' }], inputSchema: null,
    sensitiveMode: 'none', externalUrl: null, secretBroker: null,
    subjectSha256: candidate.candidateSha256, policySnapshotSha256: policy.snapshotSha256,
    status: 'open', createdAt: at, expiresAt: null
  });
  const response = createHumanResponse({
    requestSha256: request.requestSha256, processId: process.processId,
    taskInstanceId: 'verify', actor: principal, decision: 'approved',
    input: { optionId: 'approve' }, respondedAt: at
  });
  const evidence = createActionEvidence({
    processId: process.processId, taskInstanceId: 'verify', attemptId: attempt.attemptId,
    principalSha256: d('principal'), delegationSha256: d('delegation'),
    programSha256: program.programSha256, taskContractSha256: d('task-contract'),
    executionUnitManifestSha256: d('unit'), deviceManifestSha256: d('device'),
    argumentsSha256: d('arguments'), preStateSha256: d('pre'),
    rawResultSha256: d('raw-result'), postStateSha256: candidate.candidateSha256,
    verification: { status: 'passed' }, cost: { currency: 'USD', amount: 0 }, latencyMs: 10,
    gaps: [], evidenceRefs: [receipt.receiptSha256], effectRefs: [],
    humanDecisionRefs: [response.responseSha256], contradictions: [], createdAt: at
  });
  const workObject = createWorkObject({
    processId: process.processId, taskInstanceId: 'verify', createdAt: at,
    view: {
      type: 'form', schema: { type: 'object' }, dataRef: 'sfref:human/request',
      actions: [{
        id: 'request.respond', label: 'Choose', operation: 'request.respond',
        inputSchema: { type: 'object' }
      }]
    }
  });

  for (const record of [
    envelope, intent, workflow, ratification, program, binding, attempt, candidate, receipt,
    checkpoint, process, request, response, evidence, workObject
  ]) assert.deepEqual(validateSgosRecord(record), record);
  assert.equal(program.ratificationSha256, ratification.ratificationSha256);
  assert.equal(process.currentCheckpointSha256, checkpoint.checkpointSha256);
  assert.equal(response.requestSha256, request.requestSha256);
  assert.equal(evidence.postStateSha256, candidate.candidateSha256);
});

test('creators never invent timestamps and closed vocabularies fail closed', () => {
  assert.throws(() => createIntentEnvelope({
    generation: 1, principal, source: { kind: 'natural-language', revision: null },
    rawRef: 'sfref:raw', rawSha256: d('raw'), attachments: []
  }), /capturedAt/);
  assert.throws(() => createIntentEnvelope({
    generation: 1, principal, source: { kind: 'model-guessed', revision: null },
    rawRef: 'sfref:raw', rawSha256: d('raw'), attachments: [], capturedAt: at
  }), /must be one of/);
  assert.throws(() => createWorkObject({
    processId: 'PROC-123456', taskInstanceId: null,
    view: {
      type: 'form', schema: {}, dataRef: 'sfref:data',
      actions: [{ id: 'unsafe', label: 'Unsafe', operation: 'javascript.eval', inputSchema: {} }]
    }
  }), /must be one of/);
});
