import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  candidateManifestSha256, createActionEvidence, createCandidateSnapshot,
  createGvmCheckpoint, createGvmProcess, createGvmProgram, createGvmTaskAttempt,
  createGvmTaskReceipt, createHumanRequest, createHumanResponse, createIntentEnvelope,
  createIntentIr, createPolicySnapshot, createProcessBinding, createWorkflowIr,
  createWorkflowRatification, createWorkObject, policyComponentSha256, recordSelfSha256,
  sgosContractFamilies, sha256, validateCandidateSnapshot, validatePolicySnapshot,
  validateProcessBinding, validateSgosRecord
} from '../src/sgos/contracts.mjs';
import { compareSgosCodePoints } from '../src/sgos/order.mjs';
import { currentSchemaVersion, migrationRegistrySnapshot, readRecord } from '../src/schema-migrations.mjs';

const at = '2026-08-29T10:00:00.000Z';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const principal = Object.freeze({ id: 'human@example.test', kind: 'human', name: 'Human Reviewer' });
const d = (name) => sha256(`fixture:${name}`);

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

test('all SGOS durable contract families are v1 registered and refuse future versions', () => {
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  assert.equal(sgosContractFamilies().length, 16);
  for (const family of sgosContractFamilies()) {
    assert.equal(currentSchemaVersion(family), 1);
    assert.equal(registry.get(family)?.immutable, family !== 'gvm-process');
    assert.throws(
      () => readRecord(family, { schemaVersion: 2 }),
      (error) => error.code === 'SCHEMA_VERSION_FUTURE'
    );
  }
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
  const base = {
    processId: 'PROC-123456',
    subjectId: 'payments-api',
    repositoryIdentity: d('repository'),
    gitCommonDirectory: '/workspace/repository/.git',
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/feature',
    canonicalWorktreeRoot: '/workspace/feature',
    branch: 'feature/sgos',
    baselineRevision: '0123456789abcdef',
    expectedProcessRevision: 7
  };
  const first = createProcessBinding(base);
  const otherWorktree = createProcessBinding({
    ...base,
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/other',
    canonicalWorktreeRoot: '/workspace/other'
  });
  assert.notEqual(first.bindingSha256, otherWorktree.bindingSha256);
  assert.equal(recordSelfSha256(first, 'bindingSha256'), first.bindingSha256);
  assert.deepEqual(validateProcessBinding(first), first);
  assert.throws(() => createProcessBinding({ ...base, canonicalWorktreeRoot: 'relative/root' }), /absolute path/);
  assert.throws(() => createProcessBinding({ ...base, expectedProcessRevision: -1 }), />= 0/);
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
    compiler: { id: 'sflow-gvm-compiler', version: '1' }
  });
  const binding = createProcessBinding({
    processId: 'PROC-123456', subjectId: 'payments-api', repositoryIdentity: d('repository'),
    gitCommonDirectory: '/workspace/repository/.git',
    worktreeGitDirectory: '/workspace/repository/.git/worktrees/feature',
    canonicalWorktreeRoot: '/workspace/feature', branch: 'feature/sgos',
    baselineRevision: '0123456789abcdef', expectedProcessRevision: 0
  });
  const attempt = createGvmTaskAttempt({
    processId: binding.processId, taskInstanceId: 'verify', attemptNumber: 1,
    parentAttemptId: null, reason: 'initial', taskContractSha256: d('task-contract'),
    executionHandleSha256: d('execution-handle'), status: 'running', startedAt: at
  });
  const candidate = createCandidateSnapshot({
    subject: { kind: 'repository-tree', id: 'payments-api' },
    baseline: { revision: '0123456789abcdef', snapshotSha256: d('baseline') },
    resources: candidateResources(), createdBy: principal, createdAt: at
  });
  const receipt = createGvmTaskReceipt({
    processId: binding.processId, taskInstanceId: 'verify', attemptId: attempt.attemptId,
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
    createdAt: at, updatedAt: at
  });
  const request = createHumanRequest({
    requestType: 'approval', processId: process.processId, taskInstanceId: 'verify',
    checkpointSha256: checkpoint.checkpointSha256, requestedBy: principal,
    authorityRequired: { kind: 'reviewer', id: 'release-reviewer' },
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
        id: 'choose-option', label: 'Choose', operation: 'human-request.respond',
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
