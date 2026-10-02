import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateTestRecoveryGate, sealTrpRecord, trpDigest, trpEnvironmentDigest } from '../src/test-recovery-policy.mjs';
import { normalizeTestRecoveryPolicy } from '../src/test-recovery-intake.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';

const change = (record, update) => { const copy = structuredClone(record); update(copy); return sealTrpRecord(copy); };
function boundedFixture() {
  const f = createTrpFixture();
  const compatible = { id: 'baseline-compatibility', sha256: trpDigest('approved outside-source roots, cases, env, toolchain and deps') };
  const baseline = change(f.baseline, value => { value.dependencies.push(compatible); });
  const agreement = change(f.agreement, value => { value.repositories[0].baselineRefs = [baseline.recordSha256]; });
  const selection = change(f.selection, value => { value.agreementSha256 = agreement.recordSha256; });
  const observation = change(f.observation, value => {
    value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256;
    value.dependencies = [{ id: 'application-source-and-dependencies', sha256: trpDigest('fresh changed source') }, compatible];
    value.environment.dependencySha256 = trpDigest('fresh full local filesystem');
    value.sourceManifestSha256 = trpDigest('fresh changed candidate');
  });
  const decision = change(f.decision, value => {
    value.agreementSha256 = agreement.recordSha256; value.anchorObservationDigest = baseline.recordSha256;
    value.applicability.baselineSha256 = baseline.recordSha256; value.applicability.dependencies = [compatible];
    value.applicability.environmentSha256 = trpEnvironmentDigest(baseline.environment);
  });
  return { ...f.input, agreement, selection, observations: [observation], baselines: [baseline], decisions: [decision],
    candidateDependencies: observation.dependencies, candidateEnvironment: observation.environment };
}

test('known baseline accepts fresh source only under an exact authenticated compatibility dependency', () => {
  const input = boundedFixture();
  const result = evaluateTestRecoveryGate(input);
  assert.equal(result.gateDecision, 'allow-with-risk');
  assert.equal(result.dispositions[0].observedOutcome, 'failed');
  assert.equal(result.dispositions[0].disposition, 'accepted-known-failures');
  const changedCandidate = input.candidateDependencies.map(entry => entry.id === 'application-source-and-dependencies'
    ? { ...entry, sha256: trpDigest('source changed again without execution') } : entry);
  assert.equal(evaluateTestRecoveryGate({ ...input, candidateDependencies: changedCandidate }).gateDecision, 'block');
});

test('known compatibility never accepts changed assertion, cause, environment or outside-scope dependencies', () => {
  for (const mutate of [
    value => { value.cases.find(entry => entry.outcome === 'failed').semanticsSha256 = trpDigest('changed assertion'); },
    value => { value.cases.find(entry => entry.outcome === 'failed').causeSha256 = trpDigest('new cause'); },
    value => { value.environment.runtimeSha256 = trpDigest('changed child environment'); },
    value => { value.dependencies.find(entry => entry.id === 'baseline-compatibility').sha256 = trpDigest('changed fixture or toolchain'); }
  ]) {
    const input = boundedFixture(); const observation = change(input.observations[0], mutate);
    const result = evaluateTestRecoveryGate({ ...input, observations: [observation],
      candidateDependencies: observation.dependencies, candidateEnvironment: observation.environment });
    assert.equal(result.gateDecision, 'block');
  }
});

test('all pinned phase baselines authenticate without crossing same-named phase obligations', () => {
  const input = boundedFixture();
  const other = change(input.baselines[0], value => { value.id = 'other-phase-baseline'; value.subject.phaseId = 'release'; });
  const agreement = change(input.agreement, value => { value.repositories[0].baselineRefs.push(other.recordSha256); });
  const selection = change(input.selection, value => { value.agreementSha256 = agreement.recordSha256; });
  const observation = change(input.observations[0], value => { value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256; });
  const decision = change(input.decisions[0], value => { value.agreementSha256 = agreement.recordSha256; });
  const current = { ...input, agreement, selection, observations: [observation], decisions: [decision] };
  assert.equal(evaluateTestRecoveryGate({ ...current, baselines: [input.baselines[0], other] }).gateDecision, 'allow-with-risk');
  assert.equal(evaluateTestRecoveryGate(current).gateDecision, 'block', 'every pinned baseline reference remains authenticated');
  const wrongPhase = change(decision, value => { value.anchorObservationDigest = other.recordSha256; value.applicability.baselineSha256 = other.recordSha256; });
  assert.equal(evaluateTestRecoveryGate({ ...current, baselines: [input.baselines[0], other], decisions: [wrongPhase] }).gateDecision, 'block');
});

test('case inventories pin external runtimes and bounded mutable source roots without upgrading old declarations', () => {
  const base = { enabled: true, riskAuthorities: ['risk-reviewers'], enabledRiskCategories: ['known-test-failure'], allowEvidenceReuse: true,
    caseInventory: [{ phaseId: 'implementation', commandId: 'tests', dependencyScope: 'repository-and-node-builtins-only',
      tests: [{ id: 'case-a', path: 'test/service.test.mjs', name: 'contract' }] }] };
  assert.equal(Object.hasOwn(normalizeTestRecoveryPolicy(base).caseInventory[0], 'adapter'), false);
  for (const root of ['.', 'test', 'test/service.test.mjs', 'node_modules', 'fixtures', 'src/../lib', 'src/config']) {
    assert.throws(() => normalizeTestRecoveryPolicy({ ...base, caseInventory: [{ ...base.caseInventory[0], baselineMutableRoots: [root] }] }));
  }
  assert.deepEqual(normalizeTestRecoveryPolicy({ ...base, caseInventory: [{ ...base.caseInventory[0], baselineMutableRoots: ['src'] }] }).caseInventory[0].baselineMutableRoots, ['src']);
  const python = { ...base.caseInventory[0], adapter: 'pytest-junit-v1', dependencyScope: 'repository-and-declared-runtime-only',
    runtime: { executableSha256: trpDigest('python bytes'), dependencyRoots: ['/opt/qualified-python'] },
    tests: [{ id: 'case-a', path: 'test/test_service.py', name: 'test_contract', className: 'test.test_service' }] };
  assert.equal(normalizeTestRecoveryPolicy({ ...base, caseInventory: [python] }).caseInventory[0].adapter, 'pytest-junit-v1');
  for (const entry of [{ ...python, runtime: { ...python.runtime, dependencyRoots: ['/'] } },
    { ...python, tests: [{ ...python.tests[0], className: '' }] }, { ...python, dependencyScope: 'repository-and-node-builtins-only' }]) {
    assert.throws(() => normalizeTestRecoveryPolicy({ ...base, caseInventory: [entry] }));
  }
});
