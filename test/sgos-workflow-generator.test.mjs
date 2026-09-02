import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isConfigurationAssetPath } from '../src/configuration-assets.mjs';
import {
  createSgosWorkflowRatificationPacket
} from '../src/sgos/authoring.mjs';
import { compileSgosProgram, registrySnapshotDigest } from '../src/sgos/compiler.mjs';
import {
  createIntentIr, createPolicySnapshot, createWorkflowRatification, sha256
} from '../src/sgos/contracts.mjs';
import {
  SGOS_BUILTIN_OPERATION_MANIFESTS
} from '../src/sgos/builtin-adapters.mjs';
import {
  createSgosGuidedWorkflow, createSgosWorkflowGuide
} from '../src/sgos/workflow-generator.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE_ROOT, 'bin', 'singularity-flow.mjs');
const STORAGE = `sha256:${'b'.repeat(64)}`;

function policy() {
  const component = (name) => sha256({ component: name });
  return createPolicySnapshot({
    authorityRevision: 'sflow/config@abc123',
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

function registry(extra = []) {
  const builtins = [
    'sflow.story.inspect', 'sflow.story.inspect.verify',
    'sflow.repository.assert-clean', 'sflow.repository.assert-clean.verify'
  ].map((id) => ({
    id,
    version: SGOS_BUILTIN_OPERATION_MANIFESTS[id].version,
    status: 'active',
    manifestSha256: SGOS_BUILTIN_OPERATION_MANIFESTS[id].manifestSha256
  }));
  const core = {
    kind: 'registry-snapshot',
    operations: [
      ...builtins,
      ...extra
    ],
    taskKinds: [],
    devices: []
  };
  return { ...core, registrySnapshotSha256: registrySnapshotDigest(core) };
}

function intent(overrides = {}) {
  const sourceRef = 'sgos-intent-confirmation:reviewed';
  return createIntentIr({
    intentId: 'INT-GUIDED',
    generation: 1,
    objective: {
      statement: 'Produce one independently verified report.',
      provenance: 'human-confirmed', sourceRef
    },
    outcomes: [],
    successCriteria: [{
      clauseId: 'SUCCESS-001', statement: 'The verifier accepts the report.',
      provenance: 'explicit', sourceRef, required: true
    }],
    constraints: [{
      clauseId: 'CON-001', statement: 'Use the registered core operation.',
      provenance: 'explicit', sourceRef, required: true
    }],
    invariants: [], preferences: [], nonGoals: [{
      clauseId: 'NON-GOAL-001', statement: 'Do not publish the report.',
      provenance: 'explicit', sourceRef, required: true
    }],
    assumptions: [], unknowns: [], contradictions: [], risks: [],
    evidenceExpectations: [], authorityRequirements: [], budgets: [],
    domainCandidates: [], workTypeCandidates: [],
    subjects: [{ kind: 'repository', id: 'fixture' }],
    ...overrides
  });
}

function selection(overrides = {}) {
  return {
    id: 'verified-report', title: 'Verified report', operation: 'sflow.story.inspect',
    verificationOperation: 'sflow.story.inspect.verify', storageProfileSha256: STORAGE,
    maximumAttempts: 1, outputRef: 'artifact:result', ...overrides
  };
}

test('workflow guide is deterministic, bounded, and exposes only registry-backed choices', () => {
  const first = createSgosWorkflowGuide({ intentIr: intent(), registrySnapshot: registry() });
  const second = createSgosWorkflowGuide({ intentIr: intent(), registrySnapshot: registry() });
  assert.deepEqual(first, second);
  assert.equal(first.scope.modelPolicy, 'never');
  assert.equal(first.scope.createsAuthority, false);
  assert.deepEqual(first.eligibleOperations.map((entry) => entry.id), [
    'sflow.repository.assert-clean', 'sflow.story.inspect'
  ]);
  assert.deepEqual(first.eligibleVerificationOperations.map((entry) => entry.id), [
    'sflow.repository.assert-clean.verify', 'sflow.story.inspect.verify'
  ]);
  assert.equal(first.defaults.declarationDirectory, 'singularity/sgos-drafts/<id>');
  assert.equal(first.blockers.length, 0);
  assert.match(first.guideSha256, /^sha256:[a-f0-9]{64}$/);
});

test('the recommended SGOS draft root is runtime state, not protected configuration', () => {
  assert.equal(isConfigurationAssetPath(
    'singularity/sgos-drafts/verified-report/workflow-declaration.json'
  ), false);
  assert.equal(isConfigurationAssetPath('singularity/templates/workflow-declaration.json'), true);
});

test('guided creator emits a finite run-to-END declaration and complete intent map', () => {
  const created = createSgosGuidedWorkflow({
    intentIr: intent(), policySnapshot: policy(), registrySnapshot: registry(),
    selection: selection()
  });
  assert.equal(created.authority.status, 'unratified');
  assert.deepEqual(Object.keys(created.declaration.spec.tasks), ['run', 'end']);
  assert.equal(created.declaration.spec.tasks.run.operation, 'sflow.story.inspect');
  assert.equal(created.declaration.spec.tasks.run.metadata.operationVersion, '2');
  assert.equal(created.declaration.spec.tasks.run.metadata.verification.operation,
    'sflow.story.inspect.verify');
  assert.equal(created.declaration.spec.tasks.run.metadata.verificationOperationVersion, '2');
  assert.deepEqual(created.declaration.spec.tasks.end.dependsOn, ['run']);
  assert.deepEqual(created.declaration.spec.intentWorkflowMap.clauses['SUCCESS-001'], [
    { kind: 'evidence-contract', targetId: 'run' }
  ]);
  assert.deepEqual(created.declaration.spec.intentWorkflowMap.clauses['NON-GOAL-001'], [
    { kind: 'explicit-non-goal', targetId: 'NON-GOAL-001' }
  ]);
  assert.match(created.workflow.workflowSha256, /^sha256:[a-f0-9]{64}$/);
});

test('a guided candidate pins real installed v2 manifests and compiles after ratification', () => {
  const intentIr = intent();
  const policySnapshot = policy();
  const registrySnapshot = registry();
  const created = createSgosGuidedWorkflow({
    intentIr, policySnapshot, registrySnapshot, selection: selection()
  });
  const packet = createSgosWorkflowRatificationPacket({
    intentIr,
    workflow: created.workflow,
    policySnapshot,
    registrySnapshot,
    storageProfileSha256: STORAGE
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: packet.intentIrSha256,
    workflowSha256: packet.workflowSha256,
    policySnapshotSha256: packet.policySnapshotSha256,
    registrySnapshotSha256: packet.registrySnapshotSha256,
    storageProfileSha256: packet.storageProfileSha256,
    packetSha256: packet.packetSha256,
    decision: 'ratified',
    principal: { kind: 'human', id: 'reviewer@example.test' },
    coverage: packet.coverage,
    decidedAt: '2026-09-02T00:00:00.000Z'
  });
  const compiled = compileSgosProgram({
    intentIr,
    workflow: created.workflow,
    ratification,
    policySnapshotSha256: policySnapshot.snapshotSha256,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    storageProfileSha256: STORAGE,
    registrySnapshot
  });
  const run = compiled.program.taskTemplates.find((entry) => entry.taskTemplateId === 'run');
  assert.equal(run.metadata.operationVersion, '2');
  assert.equal(run.metadata.operationManifestSha256,
    SGOS_BUILTIN_OPERATION_MANIFESTS['sflow.story.inspect'].manifestSha256);
  assert.equal(run.metadata.verificationOperationVersion, '2');
  assert.equal(run.metadata.verificationOperationManifestSha256,
    SGOS_BUILTIN_OPERATION_MANIFESTS['sflow.story.inspect.verify'].manifestSha256);
});

test('guided creator refuses unresolved human judgment and invented registry operations', () => {
  const sourceRef = 'sgos-intent-confirmation:reviewed';
  const withUnknown = intent({ unknowns: [{
    clauseId: 'UNKNOWN-001', statement: 'The target is not selected.',
    provenance: 'explicit', sourceRef, required: true
  }] });
  const guide = createSgosWorkflowGuide({ intentIr: withUnknown, registrySnapshot: registry() });
  assert.equal(guide.blockers[0].code, 'SGOS_WORKFLOW_GUIDE_HUMAN_DECISION_REQUIRED');
  assert.throws(() => createSgosGuidedWorkflow({
    intentIr: withUnknown, policySnapshot: policy(), registrySnapshot: registry(),
    selection: selection()
  }), (error) => error.code === 'SGOS_WORKFLOW_GUIDE_BLOCKED');
  assert.throws(() => createSgosGuidedWorkflow({
    intentIr: intent(), policySnapshot: policy(), registrySnapshot: registry(),
    selection: selection({ operation: 'core.invented' })
  }), (error) => error.code === 'SGOS_WORKFLOW_OPERATION_UNKNOWN');
});

test('guided authoring applies the compiler clause provenance and identifier preflight', () => {
  const duplicate = intent({
    constraints: [{
      clauseId: 'SUCCESS-001', statement: 'Duplicate a confirmed clause ID.',
      provenance: 'explicit', sourceRef: 'sgos-intent-confirmation:reviewed', required: true
    }]
  });
  assert.throws(
    () => createSgosWorkflowGuide({ intentIr: duplicate, registrySnapshot: registry() }),
    (error) => error.code === 'SGOS_INTENT_CLAUSE_DUPLICATE'
  );
  const unsafe = intent({
    constraints: [{
      clauseId: 'unsafe clause', statement: 'Use an unsafe ID.',
      provenance: 'explicit', sourceRef: 'sgos-intent-confirmation:reviewed', required: true
    }]
  });
  assert.throws(
    () => createSgosWorkflowGuide({ intentIr: unsafe, registrySnapshot: registry() }),
    (error) => error.code === 'SGOS_INTENT_CLAUSE_ID_INVALID'
  );
  const proposed = intent({
    risks: [{
      clauseId: 'MODEL-001', statement: 'Unconfirmed model proposal.',
      provenance: 'model-proposed', required: true
    }]
  });
  const guide = createSgosWorkflowGuide({ intentIr: proposed, registrySnapshot: registry() });
  assert.equal(guide.clauses.some((clause) => clause.clauseId === 'MODEL-001'), false);
});

test('guided creator requires a distinct verifier and keeps non-core Pack work explicit', () => {
  assert.throws(() => createSgosGuidedWorkflow({
    intentIr: intent(), policySnapshot: policy(), registrySnapshot: registry(),
    selection: selection({ verificationOperation: 'sflow.story.inspect' })
  }), (error) => error.code === 'SGOS_WORKFLOW_VERIFIER_NOT_INDEPENDENT');
  assert.throws(() => createSgosGuidedWorkflow({
    intentIr: intent(), policySnapshot: policy(), registrySnapshot: registry(),
    selection: selection({
      verificationOperation: 'sflow.repository.assert-clean.verify'
    })
  }), (error) => error.code === 'SGOS_WORKFLOW_VERIFIER_INCOMPATIBLE');
  const packManifest = `sha256:${'d'.repeat(64)}`;
  assert.throws(() => createSgosGuidedWorkflow({
    intentIr: intent(), policySnapshot: policy(),
    registrySnapshot: registry([{
      id: 'finance.run', version: '1', status: 'active', manifestSha256: packManifest
    }]),
    selection: selection({ operation: 'finance.run' })
  }), (error) => error.code === 'SGOS_WORKFLOW_OPERATION_UNSUPPORTED');
});

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function flow(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', NODE_ENV: 'test' }
  });
}

function replaceOption(args, option, value) {
  const next = [...args];
  next[next.indexOf(option) + 1] = value;
  return next;
}

test('CLI creates two non-overwriting review files and stops before authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-workflow-guide-'));
  t.after(async () => { await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true })); });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Guide Author');
  git(root, 'config', 'user.email', 'guide@example.test');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  await writeFile(path.join(root, 'intent-ir.json'), `${JSON.stringify(intent(), null, 2)}\n`);
  await writeFile(path.join(root, 'policy.json'), `${JSON.stringify(policy(), null, 2)}\n`);
  await writeFile(path.join(root, 'registry.json'), `${JSON.stringify(registry(), null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'reviewed SGOS inputs');

  const guide = flow(root, 'intent', 'workflow-guide', 'intent-ir.json',
    '--registry', 'registry.json', '--json', '--no-model');
  assert.equal(guide.status, 0, guide.stderr);
  const guideResult = JSON.parse(guide.stdout);
  assert.equal(guideResult.operation.id, 'intent.workflow-guide');
  assert.equal(guideResult.operation.classification, 'read');

  const args = [
    'intent', 'workflow-create', 'intent-ir.json', '--policy', 'policy.json',
    '--registry', 'registry.json', '--storage-profile-sha256', STORAGE,
    '--id', 'verified-report',
    '--operation', 'sflow.story.inspect',
    '--verification-operation', 'sflow.story.inspect.verify',
    '--declaration-out', 'singularity/sgos-drafts/verified-report/workflow-declaration.json',
    '--out', 'singularity/sgos-drafts/verified-report/workflow-ir.json', '--json', '--no-model'
  ];
  const created = flow(root, ...args);
  assert.equal(created.status, 0, created.stderr);
  const envelope = JSON.parse(created.stdout);
  assert.equal(envelope.operation.id, 'intent.workflow-create');
  assert.equal(envelope.operation.classification, 'mutation');
  assert.equal(envelope.data.result.authority.executable, false);
  const declaration = JSON.parse(await readFile(path.join(
    root, 'singularity/sgos-drafts/verified-report/workflow-declaration.json'
  )));
  const workflow = JSON.parse(await readFile(path.join(
    root, 'singularity/sgos-drafts/verified-report/workflow-ir.json'
  )));
  assert.equal(declaration.metadata.id, 'verified-report');
  assert.equal(declaration.metadata.title, 'verified-report');
  assert.equal(workflow.workflowSha256, envelope.data.result.workflow.workflowSha256);
  assert.deepEqual(envelope.data.result.next[0].arguments.slice(0, 3), [
    'intent', 'ratification-packet', 'intent-ir.json'
  ]);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'reviewed SGOS inputs');

  const repeated = flow(root, ...args);
  assert.equal(repeated.status, 0, repeated.stderr);
  await writeFile(path.join(
    root, 'singularity/sgos-drafts/verified-report/workflow-declaration.json'
  ), '{"reviewed":"different"}\n');
  const refused = flow(root, ...args);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never overwritten/);

  const protectedOutput = flow(root, ...replaceOption(
    args, '--declaration-out', 'singularity/templates/unsafe.json'
  ));
  assert.notEqual(protectedOutput.status, 0);
  assert.match(protectedOutput.stderr, /protected configuration path/);

  const gitOutput = flow(root, ...replaceOption(
    args, '--out', 'singularity/sgos-drafts/vendor/.git/unsafe.json'
  ));
  assert.notEqual(gitOutput.status, 0);
  assert.match(gitOutput.stderr, /Git administrative storage/);

  const caseAlias = flow(root, ...replaceOption(replaceOption(
    args, '--declaration-out', 'singularity/sgos-drafts/case-alias/Draft.json'
  ), '--out', 'singularity/sgos-drafts/case-alias/draft.json'));
  assert.notEqual(caseAlias.status, 0);
  assert.match(caseAlias.stderr, /two distinct repository files/);

  await symlink(
    process.platform === 'win32'
      ? path.join(root, 'singularity', 'sgos-drafts', 'verified-report')
      : 'verified-report',
    path.join(root, 'singularity', 'sgos-drafts', 'draft-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const linkedParent = flow(root, ...replaceOption(replaceOption(
    args, '--declaration-out', 'singularity/sgos-drafts/safe-before-link/workflow-declaration.json'
  ), '--out', 'singularity/sgos-drafts/draft-link/workflow-ir.json'));
  assert.notEqual(linkedParent.status, 0);
  assert.match(linkedParent.stderr, /symbolic-link or non-directory ancestor/);
  await assert.rejects(() => readFile(path.join(
    root, 'singularity/sgos-drafts/safe-before-link', 'workflow-declaration.json'
  )));
});
