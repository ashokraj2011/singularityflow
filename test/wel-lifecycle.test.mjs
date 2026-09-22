import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';
import { SGOS_COMPILER_ID } from '../src/sgos/compiler.mjs';
import { createGvmProgram } from '../src/sgos/contracts.mjs';
import { buildSgosTaskAttempt, buildSgosTaskReceipt } from '../src/sgos/evidence.mjs';
import {
  buildWelLifecycleJoin, unavailableWelTestLifecycle, validateWelLifecycleJoin,
  validateWelSgosOwnerSnapshot, validateWelTestLifecycle, welEnforcementReadiness,
  WEL_EXTERNAL_ENFORCEMENT_GAPS
} from '../src/wel-lifecycle.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const H = (character) => `sha256:${character.repeat(64)}`;

function program() {
  return createGvmProgram({
    intentIrSha256: H('1'), workflowSha256: H('2'), ratificationSha256: H('3'),
    policySnapshotSha256: H('4'), registrySnapshotSha256: H('5'),
    storageProfileSha256: H('6'),
    taskTemplates: [{
      taskTemplateId: '10-test', opcode: 'VERIFY', operation: 'wel.test', dependsOn: [],
      resources: { reads: [], writes: [], devices: [], externalEffects: [] },
      evidence: { required: ['candidate', 'authenticated-test-result'] }, authority: {},
      recovery: { failedExecution: 'retry-safe' }, intentClauseIds: [], inputs: [], outputs: [],
      retry: { maximumAttempts: 2 }, policySnapshotSha256: H('4'), material: true,
      metadata: {
        sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: H('7')
      }
    }, {
      taskTemplateId: '90-end', opcode: 'END', operation: 'wel.end', dependsOn: ['10-test'],
      resources: { reads: [], writes: [], devices: [], externalEffects: [] },
      evidence: {}, authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
      retry: { maximumAttempts: 1 }, policySnapshotSha256: H('4'), material: false,
      metadata: {
        sourceConstruct: 'end', operationVersion: '1', operationManifestSha256: H('7')
      }
    }],
    edges: [{ from: '10-test', to: '90-end' }], joins: [],
    budgets: { maximumTasks: 2, maximumAttempts: 2 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: '90-end', state: 'succeeded' }],
    compiler: { id: SGOS_COMPILER_ID, version: '2' }
  });
}

function fixture() {
  const candidate = {
    candidateId: 'CAN-WEL-LIFECYCLE-001', normalizedEventSha256: H('a'),
    candidateSha256: H('b'), retainedCandidateSha256: H('c'),
    candidateTree: 'd'.repeat(40), candidateCommit: 'e'.repeat(40),
    verificationReceiptSha256: H('f'), verificationProfileSha256: H('0')
  };
  const taskContractSha256 = H('8');
  const first = buildSgosTaskAttempt({
    attemptId: 'ATT-WEL-0001', processId: 'PROC-WEL-0001', taskInstanceId: 'TSK-WEL-0001',
    attemptNumber: 1, parentAttemptId: null, reason: 'initial', taskContractSha256,
    executionHandleSha256: H('9'), status: 'failed',
    startedAt: '2026-09-22T00:00:00.000Z', completedAt: '2026-09-22T00:01:00.000Z'
  });
  const second = buildSgosTaskAttempt({
    attemptId: 'ATT-WEL-0002', processId: 'PROC-WEL-0001', taskInstanceId: 'TSK-WEL-0001',
    attemptNumber: 2, parentAttemptId: first.attemptId, reason: 'retry', taskContractSha256,
    executionHandleSha256: H('9'), status: 'succeeded',
    startedAt: '2026-09-22T00:02:00.000Z', completedAt: '2026-09-22T00:03:00.000Z'
  });
  const decisionSha256 = H('a');
  const receipt = buildSgosTaskReceipt({
    processId: second.processId, taskInstanceId: second.taskInstanceId,
    attemptId: second.attemptId, attemptSha256: second.attemptSha256,
    candidateSha256: candidate.candidateSha256, evidenceRefs: [H('3')],
    humanDecisionRefs: [decisionSha256], verification: { status: 'passed', checksSha256: H('2') },
    completedAt: '2026-09-22T00:03:00.000Z'
  });
  return {
    workId: 'WEL-LIFECYCLE-1', phaseId: 'implementation', generation: 1,
    testExecutionSha256: H('3'), candidate, program: program(), attempts: [first, second],
    taskReceipt: receipt,
    approval: {
      decisionSha256, decision: 'approved', evidenceCommit: '1'.repeat(40),
      witnessMappingsSha256: H('4'), mappingSha256s: [H('5')]
    },
    publication: {
      status: 'published', publishedCommit: '2'.repeat(40),
      publishedTree: candidate.candidateTree, transactionSha256: H('6'),
      eventSha256: candidate.normalizedEventSha256, candidateSha256: candidate.candidateSha256
    }
  };
}

test('the WEL lifecycle join binds Candidate, Program, retry lineage, approval, and publication', () => {
  const joined = buildWelLifecycleJoin(fixture());
  assert.deepEqual(validateWelLifecycleJoin(joined), { valid: true, reason: null });
  assert.equal(joined.attempt.attemptNumber, 2);
  assert.deepEqual(joined.attempt.attempts.map((entry) => [entry.attemptNumber, entry.parentAttemptId]), [
    [1, null], [2, 'ATT-WEL-0001']
  ]);
  assert.equal(joined.taskReceiptSha256, fixture().taskReceipt.receiptSha256);
  assert.equal(joined.status, 'joined-observe-only');
  assert.equal(joined.authenticatedExecution, null);
  assert.equal(joined.enforcementEligible, false);
  assert.deepEqual(joined.gaps, WEL_EXTERNAL_ENFORCEMENT_GAPS);
});

test('retry and Candidate cross-owner mismatches fail before a join exists', () => {
  const brokenRetry = fixture();
  brokenRetry.attempts[1] = buildSgosTaskAttempt({
    attemptId: 'ATT-WEL-0002', processId: 'PROC-WEL-0001', taskInstanceId: 'TSK-WEL-0001',
    attemptNumber: 2, parentAttemptId: 'ATT-WEL-FOREIGN', reason: 'retry',
    taskContractSha256: H('8'), executionHandleSha256: H('9'), status: 'succeeded',
    startedAt: '2026-09-22T00:02:00.000Z', completedAt: '2026-09-22T00:03:00.000Z'
  });
  assert.throws(
    () => buildWelLifecycleJoin(brokenRetry),
    (error) => error.code === 'WEL_ATTEMPT_LINEAGE_INVALID'
  );

  const brokenCandidate = fixture();
  brokenCandidate.taskReceipt = buildSgosTaskReceipt({
    processId: brokenCandidate.attempts[1].processId,
    taskInstanceId: brokenCandidate.attempts[1].taskInstanceId,
    attemptId: brokenCandidate.attempts[1].attemptId,
    attemptSha256: brokenCandidate.attempts[1].attemptSha256,
    candidateSha256: H('9'), humanDecisionRefs: [brokenCandidate.approval.decisionSha256],
    verification: { status: 'passed' }, completedAt: '2026-09-22T00:03:00.000Z'
  });
  assert.throws(() => buildWelLifecycleJoin(brokenCandidate), /task receipt and lifecycle Candidate differ/);

  const changedTaskContract = fixture();
  changedTaskContract.attempts[1] = buildSgosTaskAttempt({
    attemptId: 'ATT-WEL-0002', processId: 'PROC-WEL-0001', taskInstanceId: 'TSK-WEL-0001',
    attemptNumber: 2, parentAttemptId: changedTaskContract.attempts[0].attemptId,
    reason: 'retry', taskContractSha256: H('7'), executionHandleSha256: H('9'),
    status: 'succeeded', startedAt: '2026-09-22T00:02:00.000Z',
    completedAt: '2026-09-22T00:03:00.000Z'
  });
  assert.throws(
    () => buildWelLifecycleJoin(changedTaskContract),
    (error) => error.code === 'WEL_ATTEMPT_LINEAGE_INVALID'
  );
});

test('SGOS owner snapshot verification requires exact immutable attempts and receipt', () => {
  const source = fixture();
  const joined = buildWelLifecycleJoin(source);
  const process = {
    processSha256: H('9'), programSha256: source.program.programSha256,
    policySnapshotSha256: source.program.policySnapshotSha256,
    taskContractSha256: joined.attempt.taskContractSha256,
    taskInstances: {
      [joined.attempt.taskInstanceId]: {
        taskInstanceId: joined.attempt.taskInstanceId,
        attemptIds: source.attempts.map((attempt) => attempt.attemptId),
        receiptSha256: source.taskReceipt.receiptSha256
      }
    }
  };
  assert.deepEqual(validateWelSgosOwnerSnapshot(joined, {
    process, program: source.program, attempts: source.attempts, receipt: source.taskReceipt
  }), { valid: true, reason: null });

  const replacedAttempt = buildSgosTaskAttempt({
    ...source.attempts[1], attemptSha256: undefined, executionHandleSha256: H('7')
  });
  assert.equal(validateWelSgosOwnerSnapshot(joined, {
    process, program: source.program,
    attempts: [source.attempts[0], replacedAttempt], receipt: source.taskReceipt
  }).reason, 'sgos-owner-attempt-mismatch');

  const replacedReceipt = buildSgosTaskReceipt({
    ...source.taskReceipt, receiptSha256: undefined, outputRefs: [H('7')]
  });
  assert.equal(validateWelSgosOwnerSnapshot(joined, {
    process, program: source.program, attempts: source.attempts, receipt: replacedReceipt
  }).reason, 'sgos-owner-receipt-mismatch');
});

test('readiness exposes recovery owners while enforcement remains unavailable', () => {
  const joined = buildWelLifecycleJoin(fixture());
  const readiness = welEnforcementReadiness({
    enrollment: { mode: 'enforce', rollout: { enrollment: 'new-story-only' } },
    lifecycleJoin: joined
  });
  assert.equal(readiness.enrolled, true);
  assert.equal(readiness.lifecycleJoined, false,
    'a caller-supplied structurally valid join is not SGOS owner verification');
  assert.equal(readiness.lifecycleVerification, 'structure-only');
  assert.equal(readiness.readinessScope, 'foundation-projection');
  assert.ok(readiness.gaps.includes('WEL_LIFECYCLE_OWNER_VERIFICATION_UNAVAILABLE'));
  const forgedOwnerToken = {
    schemaVersion: 1, kind: 'wel-lifecycle-sgos-owner-verification',
    joinSha256: joined.joinSha256, processSha256: H('1'),
    programSha256: joined.program.programSha256,
    taskContractSha256: joined.attempt.taskContractSha256
  };
  const forged = welEnforcementReadiness({
    enrollment: { mode: 'enforce', rollout: { enrollment: 'new-story-only' } },
    lifecycleJoin: joined,
    lifecycleOwnerVerification: forgedOwnerToken
  });
  assert.equal(forged.lifecycleJoined, false,
    'a structurally plausible caller token must not impersonate an SGOS owner read');
  assert.equal(forged.lifecycleVerification, 'structure-only');
  assert.equal(readiness.status, 'unavailable');
  assert.equal(readiness.enforcementAvailable, false);
  assert.equal(readiness.authority, 'none');
  assert.ok(readiness.gaps.includes('WEL_AUTHENTICATED_RUNNER_UNAVAILABLE'));
  assert.ok(readiness.gaps.includes('CAB_RUNNER_INTEGRATION_NOT_INSTALLED'));
  assert.deepEqual(readiness.nextActions.map((entry) => entry.owner), [
    'sgos-candidate', 'sgos-runtime', 'phase-approval', 'publication-unit-of-work',
    'sgos-retry', 'reviewed-configuration'
  ]);
  assert.throws(
    () => normalizeCodeDeliveryPolicy({ tests: { testcaseExact: { mode: 'enforce' } } }),
    (error) => error.code === 'WEL_ENFORCEMENT_UNAVAILABLE'
      && error.details?.enforcementAvailable === false
  );
});

test('test-execution v4 migration and current defaults cannot invent lifecycle authority', () => {
  assert.equal(currentSchemaVersion('test-execution'), 4);
  const migrated = readRecord('test-execution', {
    schemaVersion: 3, kind: 'test-execution', candidate: { candidateSha256: H('a') },
    program: { programSha256: H('b') }, attempt: { attemptSha256: H('c') },
    testcaseObservation: { status: 'observed', assurance: 'testcase-local-observed' }
  }).record;
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.candidate.candidateSha256, H('a'),
    'v3 top-level bytes remain historical; the v4 join must not reinterpret them');
  assert.equal(migrated.lifecycle.status, 'unavailable');
  assert.equal(migrated.lifecycle.candidate, null);
  assert.deepEqual(migrated.lifecycle.retryLineage, []);
  assert.equal(migrated.lifecycle.enforcementEligible, false);
  assert.equal(validateWelTestLifecycle(migrated.lifecycle), true);

  const current = unavailableWelTestLifecycle({ observed: true });
  assert.equal(validateWelTestLifecycle(current), true);
  assert.equal(validateWelTestLifecycle({ ...current, enforcementEligible: true }), false);
  assert.equal(validateWelTestLifecycle({ ...current, unexpected: null }), false,
    'the runtime validator must match the closed JSON schema');
});

test('WEL lifecycle and readiness schemas freeze fail-closed fields', async () => {
  const lifecycleSchema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas', 'wel-test-lifecycle.schema.json'
  ), 'utf8'));
  const readinessSchema = JSON.parse(await readFile(path.join(
    repositoryRoot, 'schemas', 'wel-enforcement-readiness.schema.json'
  ), 'utf8'));
  assert.equal(lifecycleSchema.additionalProperties, false);
  assert.equal(lifecycleSchema.properties.status.const, 'unavailable');
  assert.equal(lifecycleSchema.properties.enforcementEligible.const, false);
  assert.equal(lifecycleSchema.properties.gaps.oneOf.length, 2);
  assert.deepEqual(
    lifecycleSchema.properties.gaps.oneOf.map((entry) => [entry.minItems, entry.maxItems]),
    [[8, 8], [9, 9]],
    'the schema must admit only the two exact runtime gap projections'
  );
  assert.equal(readinessSchema.additionalProperties, false);
  assert.equal(readinessSchema.properties.status.const, 'unavailable');
  assert.equal(readinessSchema.properties.enforcementAvailable.const, false);
  assert.equal(readinessSchema.properties.authority.const, 'none');
  assert.equal(readinessSchema.properties.readinessScope.const, 'foundation-projection');
  assert.equal(readinessSchema.properties.lifecycleJoined.const, false,
    'schema-only consumers must not accept an authority-inflating joined claim');
  const readiness = welEnforcementReadiness();
  assert.deepEqual(Object.keys(readiness).sort(), [...readinessSchema.required].sort(),
    'the public readiness projection drifted from its closed schema');
  assert.ok(Object.keys(readiness).every((field) => readinessSchema.properties[field]),
    'the public readiness projection contains an undeclared field');
  const story = welEnforcementReadiness({ story: {
    workId: 'WEL-SCHEMA-1', enrollmentClassification: 'legacy',
    enrollmentReason: 'creation-anchor-unavailable', creationCommit: null
  } }).story;
  const storySchema = readinessSchema.properties.story.oneOf.find((entry) => entry.type === 'object');
  assert.deepEqual(Object.keys(story).sort(), [...storySchema.required].sort(),
    'the optional Story projection drifted from its closed schema');
  assert.ok(Object.keys(story).every((field) => storySchema.properties[field]),
    'the optional Story projection contains an undeclared field');
});

test('the public WEL readiness command is read-only and fail-closed', () => {
  const operation = resolveOperation({
    requestedCommand: 'delivery', positionals: ['delivery', 'wel-readiness'],
    options: { json: true }
  });
  assert.equal(operation.id, 'delivery.wel-readiness');
  assert.equal(operation.classification, 'read');
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'bin', 'singularity-flow.mjs'),
    'delivery', 'wel-readiness', '--json'
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.operation.id, 'delivery.wel-readiness');
  assert.equal(report.effects.stateChanged, false);
  assert.equal(report.effects.filesChanged, false);
  assert.equal(report.data.status, 'unavailable');
  assert.equal(report.data.enforcementAvailable, false);
  assert.equal(report.data.authority, 'none');
  assert.equal(report.data.readinessScope, 'foundation-projection');
  assert.equal(report.data.lifecycleVerification, 'not-loaded');
  assert.equal(report.data.lifecycleJoined, false);
});

test('repository WEL readiness does not require mutable workflow configuration', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-config-free-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const git = spawnSync('git', ['init', '-b', 'main'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(git.status, 0, git.stderr || git.stdout);

  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, 'bin', 'singularity-flow.mjs'),
    'delivery', 'wel-readiness', '--json'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.operation.id, 'delivery.wel-readiness');
  assert.equal(report.effects.stateChanged, false);
  assert.equal(report.effects.filesChanged, false);
  assert.equal(report.data.status, 'unavailable');
  assert.equal(report.data.enforcementAvailable, false);
  assert.equal(report.data.authority, 'none');
  assert.equal(report.data.lifecycleJoined, false);
});

test('Story WEL readiness resolves the accepted execution closure after live root drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-accepted-story-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const cli = (...args) => spawnSync(process.execPath, [
    path.join(repositoryRoot, 'bin', 'singularity-flow.mjs'), '--no-model', ...args
  ], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'WEL Tester' }
  });
  assert.equal(git('init', '-b', 'main').status, 0);
  assert.equal(git('config', 'user.name', 'WEL Tester').status, 0);
  assert.equal(git('config', 'user.email', 'wel@example.test').status, 0);
  assert.equal(cli('init').status, 0);
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) {
    authority.allowAnyGitIdentity = true;
  }
  await writeFile(configPath, YAML.stringify(config));
  assert.equal(git('add', '.').status, 0);
  assert.equal(git('commit', '-m', 'initialize WEL accepted-story fixture').status, 0);
  assert.equal(spawnSync('git', ['init', '--bare', '-b', 'main', remote], {
    cwd: root, encoding: 'utf8'
  }).status, 0);
  assert.equal(git('remote', 'add', 'origin', remote).status, 0);
  assert.equal(git('push', '-u', 'origin', 'main').status, 0);
  const started = cli(
    'start', 'WEL-PINNED-1', '--from-branch', 'main', '--work-type', 'chore',
    '--title', 'Pinned readiness', '--description', 'Verify accepted Story execution lookup.'
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);

  const drifted = YAML.parse(await readFile(configPath, 'utf8'));
  drifted.workItemRoot = 'singularity/moved-work-items';
  await writeFile(configPath, YAML.stringify(drifted));
  const result = cli('delivery', 'wel-readiness', '--work-id', 'WEL-PINNED-1', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.data.story.workId, 'WEL-PINNED-1');
  assert.equal(report.data.readinessScope, 'foundation-projection');
  assert.equal(report.data.lifecycleJoined, false);
});
