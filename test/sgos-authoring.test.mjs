import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  approveSgosProgramAuthority,
  createSgosIntentConfirmationPacket,
  createSgosIntentIrFromConfirmedAnswers,
  createSgosProgramAuthorityProposal,
  createSgosWorkflowCandidate,
  createSgosWorkflowRatification,
  createSgosWorkflowRatificationPacket
} from '../src/sgos/authoring.mjs';
import { compileSgosProgram, registrySnapshotDigest } from '../src/sgos/compiler.mjs';
import {
  createIntentEnvelope,
  createPolicySnapshot,
  sha256,
  validateIntentIr,
  validateWorkflowIr,
  validateWorkflowRatification
} from '../src/sgos/contracts.mjs';
import {
  createSgosProgramAuthorityRecord,
  sgosProgramAuthorityPath
} from '../src/sgos/program-trust.mjs';

const STORAGE_SHA256 = `sha256:${'b'.repeat(64)}`;
const MANIFEST_SHA256 = `sha256:${'c'.repeat(64)}`;
const OBSERVED_ACTOR_ID = `git-email:${createHash('sha256')
  .update('observed@example.test').digest('hex')}`;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sflow(root, args, env = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', NO_COLOR: '1', ...env }
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

async function writeJson(root, name, value) {
  await writeFile(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  return name;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-authoring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Observed Reviewer');
  git(root, 'config', 'user.email', 'observed@example.test');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), `version: 1
approvalSecurity:
  profile: team
  allowSelfApproval: true
  autoEnrollNewIdentities: false
approvalAuthorities:
  product-approvers:
    allowAnyGitIdentity: false
    members:
      - name: Observed Reviewer
        email: observed@example.test
  architecture-reviewers:
    allowAnyGitIdentity: false
    members:
      - name: Observed Reviewer
        email: observed@example.test
`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'approved SGOS authoring authority');
  git(root, 'branch', 'sflow/config');
  return root;
}

function policySnapshot() {
  const component = (value) => sha256({ component: value });
  return createPolicySnapshot({
    authorityRevision: 'approved-config@abc123',
    lawSha256: component('law'),
    registrySha256: component('registry'),
    executionUnitPolicySha256: component('execution-unit'),
    devicePolicySha256: component('device'),
    storagePolicySha256: component('storage'),
    memoryPolicySha256: component('memory'),
    humanAuthoritySha256: component('human'),
    governedRootsSha256: component('roots'),
    verificationPolicySha256: component('verification'),
    publicationPolicySha256: component('publication')
  });
}

function registrySnapshot() {
  const core = {
    kind: 'registry-snapshot',
    operations: [
      { id: 'core.run', version: '1', status: 'active', manifestSha256: MANIFEST_SHA256 },
      { id: 'core.verify', version: '1', status: 'active', manifestSha256: MANIFEST_SHA256 }
    ],
    taskKinds: [],
    devices: []
  };
  return { ...core, registrySnapshotSha256: registrySnapshotDigest(core) };
}

function envelope() {
  const rawSha256 = sha256('Run one exact governed operation.');
  return createIntentEnvelope({
    generation: 1,
    // The source principal is deliberately not the person confirming the answers.
    principal: { kind: 'external', id: 'source-system' },
    source: { kind: 'natural-language', revision: null },
    rawRef: `inline:${rawSha256}`,
    rawSha256,
    attachments: [],
    capturedAt: '2026-08-30T00:00:00.000Z'
  });
}

function answers() {
  return {
    objective: {
      statement: 'Run one exact governed operation.',
      provenance: 'human-confirmed'
    },
    successCriteria: [{
      clauseId: 'SUCCESS-001',
      statement: 'Independent verification passes.',
      provenance: 'explicit',
      required: true
    }],
    subjects: [{ kind: 'repository', id: 'fixture-repository' }]
  };
}

function workflowDeclaration(intentIr) {
  const objectiveId = `${intentIr.intentId}:objective`;
  const coverage = {
    clauses: {
      [objectiveId]: [{ kind: 'task', targetId: 'run' }],
      'SUCCESS-001': [{ kind: 'evidence-contract', targetId: 'run' }]
    },
    tasks: {
      run: [{ kind: 'intent-clause', sourceId: objectiveId }]
    }
  };
  return {
    version: '1',
    metadata: { id: 'authoring-fixture', version: '1', domainPack: 'core' },
    spec: {
      inputs: {},
      // Deliberately reverse lexical order; authoring canonicalizes the map.
      tasks: {
        run: {
          kind: 'task',
          opcode: 'KERNEL',
          operation: 'core.run',
          dependsOn: [],
          resources: {
            reads: [], writes: ['artifact:result'], devices: [], externalEffects: []
          },
          evidence: { required: ['candidate-snapshot', 'verification-result'] },
          authority: {},
          recovery: {},
          intentClauseIds: [objectiveId],
          material: true,
          metadata: { verification: { kind: 'kernel', operation: 'core.verify' } },
          inputs: [],
          outputs: [{ ref: 'artifact:result' }],
          retry: { maximumAttempts: 1 }
        },
        end: {
          kind: 'end', opcode: 'END', dependsOn: ['run'], material: false
        }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 },
      recovery: {},
      evidence: {},
      authority: {},
      storageRequirements: { profileSha256: STORAGE_SHA256 },
      intentWorkflowMap: coverage
    }
  };
}

async function authoringChain(t) {
  const root = await repository(t);
  const intentEnvelope = envelope();
  const confirmedAnswers = answers();
  const intentPacket = createSgosIntentConfirmationPacket(intentEnvelope, confirmedAnswers);
  const intentIr = await createSgosIntentIrFromConfirmedAnswers(root, {
    envelope: intentEnvelope,
    answers: confirmedAnswers,
    confirmationSha256: intentPacket.packetSha256,
    confirmedAt: '2026-08-30T00:01:00.000Z'
  });
  const policy = policySnapshot();
  const workflow = createSgosWorkflowCandidate({
    intentIr,
    policySnapshot: policy,
    declaration: workflowDeclaration(intentIr)
  });
  const registry = registrySnapshot();
  const packetRequest = {
    intentIr,
    workflow,
    policySnapshot: policy,
    registrySnapshot: registry,
    storageProfileSha256: STORAGE_SHA256,
    coverage: workflow.spec.intentWorkflowMap
  };
  const ratificationPacket = createSgosWorkflowRatificationPacket(packetRequest);
  const ratification = await createSgosWorkflowRatification(root, {
    ...packetRequest,
    confirmationSha256: ratificationPacket.packetSha256,
    decidedAt: '2026-08-30T00:02:00.000Z'
  });
  const compileRequest = {
    intentIr,
    workflow,
    ratification,
    policySnapshotSha256: policy.snapshotSha256,
    registrySnapshotSha256: registry.registrySnapshotSha256,
    registrySnapshot: registry,
    storageProfileSha256: STORAGE_SHA256
  };
  const program = compileSgosProgram(compileRequest).program;
  return {
    root, intentEnvelope, confirmedAnswers, intentPacket, intentIr, policy, workflow,
    registry, packetRequest, ratificationPacket, ratification, compileRequest, program
  };
}

test('confirmed answers create a deterministic Intent IR without changing provenance', async (t) => {
  const root = await repository(t);
  const intentEnvelope = envelope();
  const confirmedAnswers = answers();
  const untouched = structuredClone(confirmedAnswers);
  const packet = createSgosIntentConfirmationPacket(intentEnvelope, confirmedAnswers);
  const request = {
    envelope: intentEnvelope,
    answers: confirmedAnswers,
    confirmationSha256: packet.packetSha256,
    confirmedAt: '2026-08-30T00:01:00.000Z'
  };
  const first = await createSgosIntentIrFromConfirmedAnswers(root, request);
  const second = await createSgosIntentIrFromConfirmedAnswers(root, request);

  assert.deepEqual(validateIntentIr(first), first);
  assert.deepEqual(first, second);
  assert.equal(first.intentId, intentEnvelope.intentId);
  assert.equal(first.objective.provenance, 'human-confirmed');
  assert.equal(first.successCriteria[0].provenance, 'explicit');
  assert.match(first.objective.sourceRef, /^sgos-intent-confirmation:[a-f0-9]{64}$/);
  assert.deepEqual(confirmedAnswers, untouched);
  assert.equal(Object.isFrozen(first), true);
});

test('intent authoring refuses stale confirmation and every provenance upgrade route', async (t) => {
  const root = await repository(t);
  const intentEnvelope = envelope();
  const proposed = answers();
  proposed.risks = [{
    clauseId: 'MODEL-RISK',
    statement: 'A model suggested this.',
    provenance: 'model-proposed'
  }];
  assert.throws(
    () => createSgosIntentConfirmationPacket(intentEnvelope, proposed),
    (error) => error.code === 'SGOS_INTENT_PROVENANCE_REFUSED'
  );

  const packet = createSgosIntentConfirmationPacket(intentEnvelope, answers());
  await assert.rejects(
    () => createSgosIntentIrFromConfirmedAnswers(root, {
      envelope: intentEnvelope,
      answers: { ...answers(), nonGoals: [{
        clauseId: 'NEW', statement: 'Changed after preview.', provenance: 'explicit'
      }] },
      confirmationSha256: packet.packetSha256,
      confirmedAt: '2026-08-30T00:01:00.000Z'
    }),
    (error) => error.code === 'SGOS_INTENT_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    () => createSgosIntentIrFromConfirmedAnswers(root, {
      envelope: intentEnvelope,
      answers: answers(),
      confirmationSha256: packet.packetSha256,
      confirmedAt: '2026-08-30T00:01:00.000Z',
      principal: { kind: 'human', id: 'attacker@example.test' }
    }),
    (error) => error.code === 'SGOS_AUTHORING_INPUT_INVALID'
  );
  await assert.rejects(
    () => createSgosIntentIrFromConfirmedAnswers(root, {
      envelope: intentEnvelope,
      answers: answers(),
      confirmationSha256: packet.packetSha256,
      confirmedAt: '2026-02-30T00:01:00.000Z'
    }),
    (error) => error.code === 'SGOS_AUTHORING_TIMESTAMP_REQUIRED'
  );

  // Merely changing mutable repository identity cannot manufacture membership in the approved
  // sflow/config product authority.
  git(root, 'config', 'user.name', 'Unapproved Attacker');
  git(root, 'config', 'user.email', 'attacker@example.test');
  await assert.rejects(
    () => createSgosIntentIrFromConfirmedAnswers(root, {
      envelope: intentEnvelope,
      answers: answers(),
      confirmationSha256: packet.packetSha256,
      confirmedAt: '2026-08-30T00:01:00.000Z'
    }),
    (error) => error.code === 'SGOS_PLATFORM_MUTATION_UNAUTHORIZED'
  );
});

test('Workflow IR authoring pins exact Intent and Policy records and finite task ceilings', async (t) => {
  const { intentIr, policy, workflow } = await authoringChain(t);
  assert.deepEqual(validateWorkflowIr(workflow), workflow);
  assert.equal(workflow.intentIrSha256, intentIr.intentIrSha256);
  assert.equal(workflow.policySnapshotSha256, policy.snapshotSha256);
  assert.deepEqual(Object.keys(workflow.spec.tasks), ['end', 'run']);
  assert.equal(workflow.spec.tasks.end.retry.maximumAttempts, 1);
  assert.equal(workflow.spec.tasks.end.policySnapshotSha256, policy.snapshotSha256);

  const unbounded = workflowDeclaration(intentIr);
  unbounded.spec.budgets.maximumTasks = 1;
  assert.throws(
    () => createSgosWorkflowCandidate({
      intentIr, policySnapshot: policy, declaration: unbounded
    }),
    (error) => error.code === 'SGOS_WORKFLOW_BOUND_INVALID'
  );
  const stale = workflowDeclaration(intentIr);
  stale.spec.tasks.run.policySnapshotSha256 = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => createSgosWorkflowCandidate({
      intentIr, policySnapshot: policy, declaration: stale
    }),
    (error) => error.code === 'SGOS_WORKFLOW_POLICY_MISMATCH'
  );
  const cycle = workflowDeclaration(intentIr);
  cycle.spec.tasks.run.dependsOn = ['end'];
  assert.throws(
    () => createSgosWorkflowCandidate({
      intentIr, policySnapshot: policy, declaration: cycle
    }),
    (error) => error.code === 'SGOS_WORKFLOW_CYCLE'
  );
});

test('ratification binds exact Intent, Workflow, Policy, Registry, storage, packet, and observed human', async (t) => {
  const chain = await authoringChain(t);
  assert.deepEqual(validateWorkflowRatification(chain.ratification), chain.ratification);
  assert.equal(chain.ratification.intentIrSha256, chain.intentIr.intentIrSha256);
  assert.equal(chain.ratification.workflowSha256, chain.workflow.workflowSha256);
  assert.equal(chain.ratification.policySnapshotSha256, chain.policy.snapshotSha256);
  assert.equal(chain.ratification.registrySnapshotSha256,
    chain.registry.registrySnapshotSha256);
  assert.equal(chain.ratification.storageProfileSha256, STORAGE_SHA256);
  assert.equal(chain.ratification.packetSha256, chain.ratificationPacket.packetSha256);
  assert.equal(chain.ratification.principal.kind, 'human');
  assert.equal(chain.ratification.principal.id, OBSERVED_ACTOR_ID);
  assert.match(chain.ratification.principal.authoritySha256, /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    () => createSgosWorkflowRatification(chain.root, {
      ...chain.packetRequest,
      confirmationSha256: `sha256:${'0'.repeat(64)}`,
      decidedAt: '2026-08-30T00:02:00.000Z'
    }),
    (error) => error.code === 'SGOS_WORKFLOW_RATIFICATION_REQUIRED'
  );
  await assert.rejects(
    () => createSgosWorkflowRatification(chain.root, {
      ...chain.packetRequest,
      confirmationSha256: chain.ratificationPacket.packetSha256,
      decidedAt: '2026-08-30T00:02:00.000Z',
      principal: { kind: 'human', id: 'attacker@example.test' }
    }),
    (error) => error.code === 'SGOS_AUTHORING_INPUT_INVALID'
  );
  const changedRegistry = structuredClone(chain.registry);
  changedRegistry.operations[0].version = '2';
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      registrySnapshot: changedRegistry
    }),
    (error) => error.code === 'SGOS_PINNED_REGISTRY_MISMATCH'
  );
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      storageProfileSha256: `sha256:${'d'.repeat(64)}`
    }),
    (error) => error.code === 'SGOS_WORKFLOW_STORAGE_MISMATCH'
  );
  const unknownCoverage = structuredClone(chain.packetRequest.coverage);
  unknownCoverage.clauses.UNKNOWN = [{ kind: 'task', targetId: 'run' }];
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      coverage: unknownCoverage
    }),
    (error) => error.code === 'SGOS_WORKFLOW_COVERAGE_INVALID'
  );
  const oneWayCoverage = structuredClone(chain.packetRequest.coverage);
  oneWayCoverage.tasks = {};
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      coverage: oneWayCoverage
    }),
    (error) => error.code === 'SGOS_WORKFLOW_COVERAGE_INVALID'
  );
  const fabricatedTask = structuredClone(chain.packetRequest.coverage);
  fabricatedTask.clauses[`${chain.intentIr.intentId}:objective`] = [
    { kind: 'task', targetId: 'fabricated-task' }
  ];
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      coverage: fabricatedTask
    }),
    (error) => error.code === 'SGOS_WORKFLOW_COVERAGE_INVALID'
  );
  const fabricatedEvidence = structuredClone(chain.packetRequest.coverage);
  fabricatedEvidence.clauses['SUCCESS-001'] = [
    { kind: 'evidence-contract', targetId: 'end' }
  ];
  assert.throws(
    () => createSgosWorkflowRatificationPacket({
      ...chain.packetRequest,
      coverage: fabricatedEvidence
    }),
    (error) => error.code === 'SGOS_WORKFLOW_COVERAGE_INVALID'
  );
  for (const [kind, sourceId] of [
    ['policy', `sha256:${'0'.repeat(64)}`],
    ['domain', 'fabricated-domain-pack']
  ]) {
    const fabricatedOrigin = structuredClone(chain.packetRequest.coverage);
    fabricatedOrigin.tasks.run.push({ kind, sourceId });
    assert.throws(
      () => createSgosWorkflowRatificationPacket({
        ...chain.packetRequest,
        coverage: fabricatedOrigin
      }),
      (error) => error.code === 'SGOS_WORKFLOW_COVERAGE_INVALID'
    );
  }
  assert.throws(
    () => compileSgosProgram({
      ...chain.compileRequest,
      intentWorkflowMap: { clauses: {}, tasks: {} }
    }),
    (error) => error.code === 'SGOS_UNRATIFIED_COVERAGE'
  );
});

test('Program authority proposal emits the existing approved record for only the confirmed Program', async (t) => {
  const chain = await authoringChain(t);
  const proposal = createSgosProgramAuthorityProposal(chain.program);
  assert.equal(proposal.path, sgosProgramAuthorityPath(chain.program));
  assert.equal(proposal.programSha256, chain.program.programSha256);
  assert.equal(proposal.ratificationSha256, chain.ratification.ratificationSha256);
  assert.equal(proposal.publicationRequired, 'sflow/config');
  const approved = await approveSgosProgramAuthority(chain.root, {
    program: chain.program,
    confirmationSha256: proposal.proposalSha256,
    approvedAt: '2026-08-30T00:03:00.000Z'
  });
  assert.equal(approved.authorityStatus, 'proposal-only');
  assert.equal(approved.path, proposal.path);
  assert.deepEqual(approved.record, createSgosProgramAuthorityRecord(chain.program, {
    approvedBy: approved.record.approvedBy,
    approvedAt: '2026-08-30T00:03:00.000Z'
  }));
  assert.deepEqual(approved.record.approvedBy, {
    kind: 'human', id: OBSERVED_ACTOR_ID,
    authoritySha256: approved.record.approvedBy.authoritySha256
  });
  assert.match(approved.record.approvedBy.authoritySha256, /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    () => approveSgosProgramAuthority(chain.root, {
      program: chain.program,
      confirmationSha256: `sha256:${'0'.repeat(64)}`,
      approvedAt: '2026-08-30T00:03:00.000Z'
    }),
    (error) => error.code === 'SGOS_PROGRAM_AUTHORITY_CONFIRMATION_REQUIRED'
  );
  await assert.rejects(
    () => approveSgosProgramAuthority(chain.root, {
      program: chain.program,
      confirmationSha256: proposal.proposalSha256,
      approvedAt: '2026-08-30T00:03:00.000Z',
      approvedBy: { kind: 'human', id: 'attacker@example.test' }
    }),
    (error) => error.code === 'SGOS_AUTHORING_INPUT_INVALID'
  );
});

test('CLI exposes the complete explicit Intent and Workflow authoring ceremony', async (t) => {
  const root = await repository(t);
  const envelopeFile = await writeJson(root, 'intent-envelope.json', envelope());
  const answersFile = await writeJson(root, 'intent-answers.json', answers());

  const packetResult = sflow(root, [
    'intent', 'packet', envelopeFile, '--answers', answersFile,
    '--out', 'intent-packet.json', '--json'
  ]);
  assert.equal(packetResult.operation.id, 'intent.packet');
  assert.equal(packetResult.operation.classification, 'mutation');
  assert.equal(packetResult.data.output, 'intent-packet.json');
  const packet = packetResult.data.result;

  const confirmedResult = sflow(root, [
    'intent', 'confirm', envelopeFile, '--answers', answersFile,
    '--confirm', packet.packetSha256, '--confirmed-at', '2026-08-30T00:01:00Z',
    '--out', 'intent-ir.json', '--json'
  ]);
  assert.equal(confirmedResult.operation.id, 'intent.confirm');
  const intentIr = confirmedResult.data.result;

  const policy = policySnapshot();
  await writeJson(root, 'policy.json', policy);
  await writeJson(root, 'workflow-declaration.json', workflowDeclaration(intentIr));
  const workflowResult = sflow(root, [
    'intent', 'workflow', 'intent-ir.json', '--policy', 'policy.json',
    '--declaration', 'workflow-declaration.json', '--out', 'workflow.json', '--json'
  ]);
  assert.equal(workflowResult.operation.id, 'intent.workflow');

  const registry = registrySnapshot();
  await writeJson(root, 'registry.json', registry);
  const packet2Result = sflow(root, [
    'intent', 'ratification-packet', 'intent-ir.json', '--workflow', 'workflow.json',
    '--policy', 'policy.json', '--registry', 'registry.json',
    '--storage-profile-sha256', STORAGE_SHA256,
    '--out', 'ratification-packet.json', '--json'
  ]);
  assert.equal(packet2Result.operation.id, 'intent.ratification-packet');

  const ratificationResult = sflow(root, [
    'intent', 'ratify', 'intent-ir.json', '--workflow', 'workflow.json',
    '--policy', 'policy.json', '--registry', 'registry.json',
    '--storage-profile-sha256', STORAGE_SHA256,
    '--confirm', packet2Result.data.result.packetSha256,
    '--decided-at', '2026-08-30T00:02:00Z',
    '--out', 'ratification.json', '--json'
  ]);
  assert.equal(ratificationResult.operation.id, 'intent.ratify');

  const compiledResult = sflow(root, [
    'intent', 'compile', 'intent-ir.json', '--workflow', 'workflow.json',
    '--ratification', 'ratification.json', '--policy', 'policy.json',
    '--registry', 'registry.json', '--out', 'program.json', '--json'
  ]);
  assert.equal(compiledResult.operation.id, 'intent.compile');

  const approvalPreview = sflow(root, ['program', 'approve', 'program.json', '--json']);
  assert.equal(approvalPreview.operation.id, 'program.approve.plan');
  assert.equal(approvalPreview.operation.classification, 'read');
  assert.equal(approvalPreview.effects.stateChanged, false);
  assert.equal(approvalPreview.data.result.publicationRequired, 'sflow/config');
  assert.deepEqual(
    JSON.parse(await readFile(path.join(root, 'intent-packet.json'), 'utf8')),
    packet
  );
});

test('confirmed Program approval publishes only a normal configuration review proposal', async (t) => {
  const chain = await authoringChain(t);
  const remoteBase = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-authoring-remote-'));
  t.after(() => rm(remoteBase, { recursive: true, force: true }));
  const remote = path.join(remoteBase, 'application.git');
  git(chain.root, 'init', '-q', '--bare', '--initial-branch=main', remote);
  git(chain.root, 'remote', 'add', 'origin', remote);
  git(chain.root, 'push', '-q', '-u', 'origin', 'main');
  git(chain.root, 'push', '-q', 'origin', 'sflow/config');
  await writeJson(chain.root, 'program.json', chain.program);
  const applicationHead = git(chain.root, 'rev-parse', 'HEAD');
  const configurationHead = git(chain.root, '--git-dir', remote, 'rev-parse', 'sflow/config');
  const applicationStatus = git(chain.root, 'status', '--porcelain=v1');

  const preview = sflow(chain.root, ['program', 'approve', 'program.json', '--json']);
  const outbox = path.join(remoteBase, 'transport-outbox');
  const applied = sflow(chain.root, [
    'program', 'approve', 'program.json',
    '--confirm', preview.data.result.proposalSha256,
    '--approved-at', '2026-08-30T00:03:00Z', '--json'
  ], { SINGULARITY_FLOW_TRANSPORT_OUTBOX: outbox });

  assert.equal(applied.operation.id, 'program.approve');
  assert.equal(applied.operation.classification, 'mutation');
  assert.equal(applied.effects.publicationCreated, true);
  assert.equal(applied.effects.externalSystemsChanged, true);
  assert.equal(applied.data.result.authorityStatus, 'proposal-only');
  const publication = applied.data.result.publication;
  assert.equal(publication.baseBranch, 'sflow/config');
  assert.equal(publication.reviewRequired, true);
  assert.match(publication.branch,
    /^sflow\/config-change\/workflow\/sgos-program-authority-/);
  assert.deepEqual(publication.files, [applied.data.result.path]);

  assert.equal(git(chain.root, 'rev-parse', 'HEAD'), applicationHead);
  assert.equal(git(chain.root, 'branch', '--show-current'), 'main');
  assert.equal(git(chain.root, 'status', '--porcelain=v1'), applicationStatus);
  assert.equal(git(chain.root, '--git-dir', remote, 'rev-parse', 'sflow/config'), configurationHead,
    'publishing a proposal must not advance approved configuration');
  assert.deepEqual(JSON.parse(git(chain.root, '--git-dir', remote, 'show',
    `${publication.branch}:${applied.data.result.path}`)),
  applied.data.result.record, 'review branch contains the proposed authority record');
  await assert.rejects(
    () => readFile(path.join(chain.root, ...applied.data.result.path.split('/')), 'utf8'),
    { code: 'ENOENT' }
  );
});
