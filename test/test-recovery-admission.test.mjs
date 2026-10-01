import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { normalizeTestRecoveryPolicy, previewTestRecoveryIntake } from '../src/test-recovery-intake.mjs';
import { createWorkflow, loadConfig, workDir, preparePhase, beginPhaseGeneration, publishGeneration,
  loadStoryTestRecoveryAgreement, assertStoryTestRecoveryFeatureAdmission } from '../src/state.mjs';
import { trpDigest } from '../src/test-recovery-policy.mjs';
import { appendTrpRepairEvidence, appendTrpReadinessCheckpoint } from '../src/test-recovery-store.mjs';
import { applyCapabilityPolicyToWorkResolution, resolveLifecycleCapability } from '../src/capability-context.mjs';

function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
async function fixture(t, { enabled = true, baselineStatus = 'failing-tests', id = 'TRP-REPAIR' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'TRP Owner'); git(root, 'config', 'user.email', 'trp@example.com');
  await writeFile(path.join(root, 'README.md'), '# Existing source\n');
  await initializeDefinition(root); git(root, 'add', '.'); git(root, 'commit', '-qm', 'Initial repository');
  const baseCommit = git(root, 'rev-parse', 'HEAD'); git(root, 'switch', '-q', '-c', id);
  const config = await loadConfig(root); config.git.publish = 'off';
  if (enabled) config.testRecovery = normalizeTestRecoveryPolicy({ enabled: true });
  const resolved = resolveWorkType(config, 'feature');
  resolved.plannedClaims = { mode: 'opt-out', clausePhases: [], owners: {}, reason: 'This isolated readiness test has no specification phase.' };
  resolved.spec = { ...resolved.spec, acceptance: 'off' };
  const implementation = resolved.phases.find((phase) => phase.id === 'implementation');
  resolved.phases = [{ ...implementation, order: 0, inputs: [], clarification: { ...implementation.clarification, mode: 'off' },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['implementation'] }, qualityCommands: [] }];
  const readinessRepositories = [{ id: 'lifecycle', baseCommit, baseBranch: 'main' }];
  const repositoryReadiness = { repositories: { lifecycle: { status: baselineStatus, sourceCommit: baseCommit,
    baselineSha256: trpDigest('failed-baseline'), receiptSha256: baselineStatus === 'pass' ? trpDigest('unverified-pass') : null,
    scope: 'dependency-test', structuredTestContract: { commands: [{ id: 'unit-tests', launcher: 'node', workingDirectory: '.', adapter: 'node-tap', reportPath: '.sflow/results/test.tap' }] }, testObservations: [] } } };
  const plan = previewTestRecoveryIntake({ definition: config, workId: id, workType: 'feature', repositories: readinessRepositories,
    repositoryReadiness, choices: { baselineDisposition: 'fix', executionMode: 'changed-and-affected', baselineScope: 'reuse' },
    phaseDefinitions: applyCapabilityPolicyToWorkResolution(resolved, await resolveLifecycleCapability(root)).phases });
  const options = { id, title: 'Repair an existing failing baseline', source: { type: 'manual', key: id, title: 'Repair an existing failing baseline',
    description: 'The existing test failure must be repairable before feature implementation.', acceptanceCriteria: ['Preserve work and fix the baseline.'] },
    baseBranch: 'main', baseCommit, workType: 'feature', agent: 'developer', resolved, readinessRepositories, repositoryReadiness, testRecoveryPlan: enabled ? plan : null };
  return { root, config, options, plan, item: workDir(root, config, id) };
}

test('a first code phase records failing-baseline repair without opening feature generation or throwing after mutation', async (t) => {
  const value = await fixture(t);
  const workflow = await createWorkflow(value.root, value.config, value.options);
  assert.equal(workflow.testRecovery.route, 'readiness-repair');
  assert.equal(workflow.phases.implementation.generation, 0);
  assert.equal(workflow.phases.implementation.generationIntent, undefined);
  const saved = JSON.parse(await readFile(path.join(value.item, 'workflow.json'), 'utf8'));
  assert.equal(saved.testRecovery.agreementSha256, workflow.resolution.testRecoveryAgreement.agreementSha256);
  const agreement = await loadStoryTestRecoveryAgreement(value.root, value.config, workflow);
  assert.equal(agreement.confirmedPlanSha256, value.plan.planDigest);
  assert.equal(agreement.repositories[0].baselineDisposition, 'fix');
  assert.equal(agreement.repositories[0].execution.mode, 'changed-and-affected');
  for (const invoke of [
    () => preparePhase(value.root, value.config, workflow, 'implementation'),
    () => beginPhaseGeneration(value.root, value.config, workflow, { phaseId: 'implementation' }),
    () => publishGeneration(value.root, value.config, workflow, { phaseId: 'implementation' })
  ]) await assert.rejects(invoke, { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  assert.equal(await readFile(path.join(value.item, 'workflow.json'), 'utf8'), JSON.stringify(saved, null, 2) + '\n');
});

test('stale or weakened client previews fail before Story files are written', async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(value.plan); changed.policy.maxDistinctAutomaticAttempts = 99;
  await assert.rejects(createWorkflow(value.root, value.config, { ...value.options, testRecoveryPlan: changed }), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
  await assert.rejects(access(path.join(value.item, 'workflow.json')), { code: 'ENOENT' });
  await assert.rejects(createWorkflow(value.root, value.config, { ...value.options, testRecoveryPlan: null }), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
});

test('caller preview cannot enable an unapproved legacy workflow', async (t) => {
  const value = await fixture(t, { enabled: false });
  await assert.rejects(createWorkflow(value.root, value.config, { ...value.options, testRecoveryPlan: { enabled: true, choices: {} } }), { code: 'TRP_NOT_ENABLED' });
  await assert.rejects(access(path.join(value.item, 'workflow.json')), { code: 'ENOENT' });
});

test('claimed passing readiness must match authenticated host-local receipt before creation', async (t) => {
  const value = await fixture(t, { baselineStatus: 'pass' });
  await assert.rejects(createWorkflow(value.root, value.config, value.options), { code: 'TRP_INTAKE_EVIDENCE_STALE' });
  await assert.rejects(access(path.join(value.item, 'workflow.json')), { code: 'ENOENT' });
});

test('editing mutable readiness and agreement references cannot unlock feature coding', async (t) => {
  const value = await fixture(t);
  const workflow = await createWorkflow(value.root, value.config, value.options);
  const tampered = structuredClone(workflow);
  tampered.testRecovery.readiness.repositories[0].status = 'pass';
  tampered.testRecovery.readiness.repositories[0].receiptSha256 = trpDigest('invented');
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, value.config, tampered, tampered.phases.implementation), { code: 'TRP_READINESS_EVIDENCE_REQUIRED' });
  tampered.testRecovery.agreementSha256 = trpDigest('replacement');
  await assert.rejects(loadStoryTestRecoveryAgreement(value.root, value.config, tampered), { code: 'TRP_AGREEMENT_REQUIRED' });
});

test('retained pins and accepted snapshot forbid stripping TRP fields before direct phase begin', async (t) => {
  const value = await fixture(t);
  const workflow = await createWorkflow(value.root, value.config, value.options);
  git(value.root, 'add', '--', path.relative(value.root, value.item));
  git(value.root, 'commit', '-qm', 'Accept Story with required baseline repair');
  const before = git(value.root, 'status', '--porcelain');
  for (const stripAll of [false, true]) {
    const tampered = structuredClone(workflow);
    delete tampered.testRecovery;
    delete tampered.resolution.testRecovery;
    if (stripAll) {
      delete tampered.resolution.testRecoveryAgreement;
      delete tampered.resolution.testRecoveryInitialReadiness;
    }
    await assert.rejects(beginPhaseGeneration(value.root, value.config, tampered, { phaseId: 'implementation' }),
      { code: stripAll ? 'WFA_SNAPSHOT_INVALID' : 'TRP_AGREEMENT_REQUIRED' });
    assert.equal(tampered.phases.implementation.generationIntent, undefined);
    assert.equal(tampered.workIntervals?.current ?? null, null);
    assert.equal(git(value.root, 'status', '--porcelain'), before, 'refusal precedes any interval or generation receipt write');
  }
});

test('ordinary legacy Stories retain admission with and without a workflow snapshot', async (t) => {
  assert.deepEqual(await assertStoryTestRecoveryFeatureAdmission('/not-a-repository', {},
    { workItem: { id: 'LEGACY' }, resolution: {} }, { id: 'implementation' }),
  { enabled: false, featureCodingAllowed: true });
  const value = await fixture(t, { enabled: false });
  const workflow = await createWorkflow(value.root, value.config, value.options);
  assert.ok(workflow.workflowSnapshot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(await assertStoryTestRecoveryFeatureAdmission(value.root, value.config, workflow,
      workflow.phases.implementation), { enabled: false, featureCodingAllowed: true });
  }
  assert.equal(workflow.phases.implementation.generationIntent.generation, 1);
});

test('even committed self-hashed green checkpoints cannot admit product changes as baseline repair', async (t) => {
  const value = await fixture(t);
  const workflow = await createWorkflow(value.root, value.config, value.options);
  await writeFile(path.join(value.root, 'product.mjs'), 'export const unreviewedFeature = true;\n');
  git(value.root, 'add', '.'); git(value.root, 'commit', '-qm', 'Candidate that includes feature work');
  const repairCommit = git(value.root, 'rev-parse', 'HEAD');
  const raw = { kind: 'repository-readiness-receipt', sourceCommit: repairCommit, status: 'pass' };
  const receipt = { ...raw, receiptSha256: trpDigest(raw) };
  await appendTrpRepairEvidence(value.item, receipt);
  const row = { repositoryId: 'lifecycle', status: 'pass', baseCommit: repairCommit,
    originalBaseCommit: value.options.baseCommit, featureBaseCommit: repairCommit,
    receiptSha256: receipt.receiptSha256, sourceManifestSha256: trpDigest('manifest'), planId: trpDigest('plan'),
    platform: process.platform, arch: process.arch, originalBaselineRefs: [trpDigest('failed-baseline')],
    repairedBaselineRefs: [receipt.receiptSha256] };
  const core = { schemaVersion: 1, agreementSha256: workflow.testRecovery.agreementSha256,
    evidencePurpose: 'baseline-admission-only', repositories: [row] };
  const checkpoint = { ...core, checkpointSha256: trpDigest(core) };
  await appendTrpReadinessCheckpoint(value.item, checkpoint);
  workflow.testRecovery.readiness = checkpoint;
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, value.config, workflow,
    workflow.phases.implementation), { code: 'TRP_REPAIR_PUBLICATION_REQUIRED' });
  git(value.root, 'add', '.'); git(value.root, 'commit', '-qm', 'Fabricated public green checkpoint');
  await assert.rejects(assertStoryTestRecoveryFeatureAdmission(value.root, value.config, workflow,
    workflow.phases.implementation), (error) => error.code === 'TRP_REPAIR_SCOPE_UNAVAILABLE'
      && error.details.scope.blockers.some((entry) => entry.newPath === 'product.mjs'));
  assert.equal(workflow.phases.implementation.generation, 0);
});
