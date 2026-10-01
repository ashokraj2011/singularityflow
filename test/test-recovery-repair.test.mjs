import assert from 'node:assert/strict';
import test from 'node:test';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';
import { sealTrpRecord, trpDigest } from '../src/test-recovery-policy.mjs';
import {
  assertTrpFeatureAdmission, completeTrpReadinessRepair, previewTrpReadinessRepair
} from '../src/test-recovery-repair.mjs';
import { helpTopicForError } from '../src/help-errors.mjs';

const BASE = 'a'.repeat(40);
const REPAIR = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const hash = value => trpDigest(value);

function fixture({ multi = false, optional = false } = {}) {
  const f = createTrpFixture();
  const repositories = [{ ...f.agreement.repositories[0], baselineDisposition: 'fix' }];
  if (multi || optional) repositories.push({ ...repositories[0], repositoryId: 'ui', required: !optional });
  const agreement = sealTrpRecord({ ...f.agreement, repositories });
  const workflow = { id: agreement.subject.workId, currentPhase: 'implementation',
    phases: {
      intake: { id: 'intake', generationPolicy: { task: 'document' } },
      specification: { id: 'specification', generationPolicy: { task: 'document' } },
      implementation: { id: 'implementation', generationPolicy: { task: 'code' } },
      legacy: { id: 'legacy', requiredArtifact: { kind: 'implementation-summary' } }
    },
    testRecovery: { agreementPath: 'context/test-recovery/agreements/revision-1.json',
      agreementSha256: agreement.recordSha256,
      readiness: { repositories: [{ repositoryId: 'service', status: 'failing-tests', baseCommit: BASE,
        receiptSha256: hash('original-readiness') }] } }
  };
  return { ...f, agreement, workflow };
}

function receipt(commit = REPAIR, changes = {}) {
  const core = { schemaVersion: 1, kind: 'repository-readiness-receipt', scope: 'dependency-test',
    sourceTrackedOnly: true, status: 'pass', sourceCommit: commit,
    sourceManifestSha256: hash('repaired-source'), repositoryFingerprint: hash('repository'),
    platform: 'darwin', arch: 'arm64', planId: hash('reviewed-plan'),
    structuredTestContract: { requiredForCode: true, commands: [{ id: 'unit', adapter: 'node-tap', minimumDiscovered: 1 }] },
    commandResults: [{ id: 'unit', purpose: 'test', status: 'pass', exitCode: 0 }],
    testObservations: [{ commandId: 'unit', adapter: 'node-tap', status: 'available',
      report: { sha256: hash('current-report') }, counts: { discovered: 2, passed: 2, failed: 0, skipped: 0 } }],
    ...changes
  };
  return { ...core, receiptSha256: hash(core) };
}

test('legacy Stories and non-code phases keep their original admission behavior', () => {
  const f = fixture();
  assert.deepEqual(assertTrpFeatureAdmission({ ...f.workflow, testRecovery: undefined }, 'implementation'),
    { enabled: false, featureCodingAllowed: true });
  assert.equal(assertTrpFeatureAdmission({ ...f.workflow, testRecovery: { agreement: f.agreement } }, 'implementation').enabled, false,
    'an inline agreement cannot opt a legacy Story in');
  for (const phase of ['intake', 'specification']) {
    assert.equal(assertTrpFeatureAdmission(f.workflow, phase).featureCodingAllowed, true);
  }
});

test('code admission requires the exact securely loaded agreement and resolves custom/legacy code phases', () => {
  const f = fixture();
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation'), { code: 'TRP_AGREEMENT_REQUIRED' });
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'missing', { agreement: f.agreement }), { code: 'TRP_READINESS_PHASE_INVALID' });
  assert.throws(() => assertTrpFeatureAdmission({ ...f.workflow, id: 'other-story' }, 'implementation', { agreement: f.agreement }), { code: 'TRP_AGREEMENT_REQUIRED' });
  for (const phase of ['implementation', 'legacy']) {
    assert.throws(() => assertTrpFeatureAdmission(f.workflow, phase, { agreement: f.agreement }), error => {
      assert.equal(error.code, 'TRP_FEATURE_ADMISSION_BLOCKED');
      assert.equal(error.details.blockers[0].id, 'readiness:service');
      assert.deepEqual(error.details.supportedNextActions[0].args,
        ['test-policy', 'repair', '--work-id', f.agreement.subject.workId, '--json']);
      assert.ok(error.details.blockers[0].preserved.includes('original baseline'));
      return true;
    });
  }
});

test('an authenticated initial pass admits features only; it is not candidate test execution evidence', () => {
  const f = fixture();
  f.workflow.testRecovery.readiness.repositories[0].status = 'pass';
  const result = assertTrpFeatureAdmission(f.workflow, 'implementation', { agreement: f.agreement });
  assert.equal(result.featureCodingAllowed, true);
  assert.equal(result.evidencePurpose, 'baseline-admission-only');
  delete f.workflow.testRecovery.readiness.repositories[0].receiptSha256;
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', { agreement: f.agreement }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
});

test('every required code repository blocks independently; optional references add no obligation', () => {
  const f = fixture({ multi: true });
  f.workflow.testRecovery.readiness.repositories[0].status = 'pass';
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', { agreement: f.agreement }), error => {
    assert.deepEqual(error.details.blockers.map(row => row.repositoryId), ['ui']);
    assert.equal(error.details.blockers[0].observedOutcome, 'unknown');
    return true;
  });
  const optional = fixture({ optional: true });
  optional.workflow.testRecovery.readiness.repositories[0].status = 'pass';
  assert.equal(assertTrpFeatureAdmission(optional.workflow, 'implementation', { agreement: optional.agreement }).featureCodingAllowed, true);
});

test('deserialized risk claims never admit features without a current runtime verifier', () => {
  const f = fixture();
  const decision = sealTrpRecord({ ...f.decision, agreementSha256: f.agreement.recordSha256 });
  const options = { agreement: f.agreement, verifiedDecisions: [decision] };
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', options), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', { ...options, verifyDecision: true }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', { ...options, verifyDecision: () => false }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  assert.equal(assertTrpFeatureAdmission(f.workflow, 'implementation', { ...options, verifyDecision: (_record, context) => {
    assert.equal(context.operation, 'generation-admission');
    assert.equal(context.repository.repositoryId, 'service');
    return true;
  } }).featureCodingAllowed, true);
  f.workflow.testRecovery.readiness.repositories[0].status = 'unknown';
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', { ...options, verifyDecision: () => true }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' },
    'unknown evidence cannot become accepted known failures');
});

test('a decision for another repository or ambiguous readiness cannot bypass admission', () => {
  const f = fixture();
  const decision = sealTrpRecord({ ...f.decision, agreementSha256: f.agreement.recordSha256,
    subject: { ...f.decision.subject, repositoryId: 'other' } });
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', {
    agreement: f.agreement, verifiedDecisions: [decision], verifyDecision: () => true
  }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
  f.workflow.testRecovery.readiness.repositories.push({ ...f.workflow.testRecovery.readiness.repositories[0], status: 'pass' });
  const ownDecision = sealTrpRecord({ ...f.decision, agreementSha256: f.agreement.recordSha256 });
  assert.throws(() => assertTrpFeatureAdmission(f.workflow, 'implementation', {
    agreement: f.agreement, verifiedDecisions: [ownDecision], verifyDecision: () => true
  }), { code: 'TRP_FEATURE_ADMISSION_BLOCKED' });
});

test('repair completion preserves original refs and records a separate immutable feature base', () => {
  const f = fixture();
  f.workflow.testRecovery.readiness.repositories[0].baselineSha256 = hash('original-failure');
  const currentReadiness = { repositories: { service: receipt() } };
  const before = structuredClone({ agreement: f.agreement, currentReadiness, original: f.workflow.testRecovery.readiness });
  const checkpoint = completeTrpReadinessRepair({ agreement: f.agreement, currentReadiness,
    baseCommit: BASE, repairCommit: REPAIR, originalReadiness: f.workflow.testRecovery.readiness,
    requiredRepositories: ['service'] });
  const row = checkpoint.repositories[0];
  assert.equal(row.originalBaseCommit, BASE);
  assert.equal(row.featureBaseCommit, REPAIR);
  assert.deepEqual(row.repairedBaselineRefs, [currentReadiness.repositories.service.receiptSha256]);
  assert.ok(row.originalBaselineRefs.includes(f.agreement.repositories[0].baselineRefs[0]));
  assert.ok(row.originalBaselineRefs.includes(hash('original-readiness')));
  assert.ok(row.originalBaselineRefs.includes(hash('original-failure')));
  assert.equal(checkpoint.evidencePurpose, 'baseline-admission-only');
  assert.equal(Object.isFrozen(checkpoint.repositories[0]), true);
  assert.deepEqual({ agreement: f.agreement, currentReadiness, original: f.workflow.testRecovery.readiness }, before);
});

test('runtime-only readiness repair needs no fake product-source commit', () => {
  const f = fixture();
  const checkpoint = completeTrpReadinessRepair({ agreement: f.agreement,
    currentReadiness: { repositories: [{ repositoryId: 'service', receipt: receipt(BASE) }] },
    baseCommit: BASE, repairCommit: BASE });
  assert.equal(checkpoint.repositories[0].featureBaseCommit, BASE);
});

test('repair completion rejects forged, failed, missing, stale and ambiguous current evidence', () => {
  const f = fixture();
  for (const bad of [
    { ...receipt(), receiptSha256: hash('forged') }, receipt(OTHER), receipt(REPAIR, { status: 'failing-tests' }),
    receipt(REPAIR, { commandResults: [{ id: 'unit', purpose: 'test', status: 'pass', exitCode: 1 }] }),
    receipt(REPAIR, { testObservations: [] }), receipt(REPAIR, { structuredTestContract: { commands: [] } }),
    receipt(REPAIR, { commandResults: [
      { id: 'unit', purpose: 'test', status: 'pass', exitCode: 0 },
      { id: 'unit', purpose: 'test', status: 'pass', exitCode: 0 }
    ] }),
    receipt(REPAIR, { testObservations: [{ commandId: 'unit', adapter: 'node-tap', status: 'available',
      report: null, counts: { discovered: 2, passed: 2, failed: 0, skipped: 0 } }] }),
    receipt(REPAIR, { testObservations: [{ commandId: 'unit', adapter: 'node-tap', status: 'available',
      report: { sha256: hash('report') }, counts: { discovered: 2, passed: 1, failed: 1, skipped: 0 } }] })
  ]) assert.throws(() => completeTrpReadinessRepair({ agreement: f.agreement,
    currentReadiness: { repositories: { service: bad } }, baseCommit: BASE, repairCommit: REPAIR }),
  { code: 'TRP_REPAIR_EVIDENCE_INVALID' });
});

test('completion cannot omit a required repository or silently use a different checkpoint', () => {
  const f = fixture({ multi: true });
  const options = { agreement: f.agreement, currentReadiness: { repositories: { service: receipt() } },
    baseCommit: BASE, repairCommit: REPAIR };
  assert.throws(() => completeTrpReadinessRepair(options), { code: 'TRP_REPAIR_EVIDENCE_INVALID' });
  assert.throws(() => completeTrpReadinessRepair({ ...options, requiredRepositories: ['service'] }), { code: 'TRP_READINESS_REPOSITORY_INVALID' });
  const complete = completeTrpReadinessRepair({ ...options,
    currentReadiness: { repositories: { service: receipt(), ui: receipt(OTHER) } },
    repairCommit: { service: REPAIR, ui: OTHER }, baseCommit: { service: BASE, ui: BASE } });
  assert.deepEqual(complete.repositories.map(row => row.featureBaseCommit), [REPAIR, OTHER]);
});

test('repair preview only reads the reviewed dependency/test plan and requires exact checkpoint binding', async () => {
  const f = fixture();
  let builds = 0;
  const buildPlan = async (root, options) => {
    builds += 1;
    assert.equal(root, '/reviewed/service');
    assert.equal(options.scope, 'dependency-test');
    return { planId: hash('plan'), sourceCommit: REPAIR, commands: [{ id: 'unit', argv: ['node', '--test'] }], blockers: [] };
  };
  const options = { agreement: f.agreement, repositoryId: 'service', baseCommit: BASE, repairCommit: REPAIR, buildPlan };
  const preview = await previewTrpReadinessRepair('/reviewed/service', options);
  assert.equal(builds, 1);
  assert.equal(preview.requiresHumanConfirmation, true);
  assert.equal(preview.featureCodingAllowed, false);
  assert.deepEqual(preview.execution, { function: 'executeRepositoryReadinessPlan', scope: 'dependency-test', confirmation: hash('plan') });
  assert.ok(preview.permittedRepairScope.includes('tests'));
  await assert.rejects(previewTrpReadinessRepair('/reviewed/service', { ...options, scope: 'full' }), { code: 'TRP_REPAIR_SCOPE_UNAVAILABLE' });
  assert.equal(builds, 1, 'unsupported scope does not even build an execution plan');
  await assert.rejects(previewTrpReadinessRepair('/reviewed/service', { ...options, repairCommit: OTHER }), { code: 'TRP_REPAIR_CHECKPOINT_STALE' });
});

test('readiness repair errors route to the TRP help topic', () => {
  assert.equal(helpTopicForError({ code: 'TRP_FEATURE_ADMISSION_BLOCKED' }), 'test-recovery');
});
