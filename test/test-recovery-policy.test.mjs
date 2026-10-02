import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateTestRecoveryGate, sealTrpRecord, validateTrpRecord, trpDigest, trpIssueIdentity, TRP_SCHEMAS, TRP_POLICY_SCHEMA } from '../src/test-recovery-policy.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';

function change(record, update) { const copy = structuredClone(record); update(copy); return sealTrpRecord(copy); }
function evaluate(fixture, overrides = {}) { return evaluateTestRecoveryGate({ ...fixture.input, ...overrides }); }
function denied(result) { assert.equal(result.gateDecision, 'block'); assert.ok(result.remainingBlockers.length > 0); }
test('structured command identities remain exact in agreements, baselines, observations and decisions', () => {
  const fixture = createTrpFixture();
  for (const commandId of ['.-python-tests', './module/maven-tests']) {
    const agreement = change(fixture.agreement, value => {
      value.repositories[0].mandatoryObligations[0].id = commandId;
    });
    assert.equal(agreement.repositories[0].mandatoryObligations[0].id, commandId);
    for (const record of [fixture.baseline, fixture.observation, fixture.decision]) {
      const changed = change(record, value => { value.obligationId = commandId; });
      validateTrpRecord(changed);
      assert.equal(changed.obligationId, commandId);
      assert.throws(() => change(record, value => { value.obligationId = ''; }), /invalid string/u);
    }
  }
});
test('cause identity groups genuine retries but separates repository and exact failing cases', () => {
  const fixture = createTrpFixture();
  const input = { category: 'new-test-failure', obligationId: 'unit-tests', message: 'Required check failed', observation: fixture.observation };
  const expected = trpIssueIdentity(input);
  const repeated = structuredClone(fixture.observation);
  repeated.subject.generation += 1; repeated.subject.phaseId = 'release'; repeated.id = 'another-report';
  repeated.sourceRevision = 'other-source'; repeated.cases.reverse();
  assert.deepEqual(trpIssueIdentity({ ...input, observation: repeated }), expected);
  for (const mutate of [
    value => { value.subject.repositoryId = 'another-repository'; },
    value => { value.subject.validationEpoch += 1; },
    value => { value.cases.find(entry => entry.outcome === 'failed').id = 'another-test'; },
    value => { value.cases.find(entry => entry.outcome === 'failed').causeSha256 = fixture.hash('another-cause'); },
    value => { value.selectorSha256 = fixture.hash('another-selector'); }
  ]) {
    const changed = structuredClone(fixture.observation); mutate(changed);
    assert.notEqual(trpIssueIdentity({ ...input, observation: changed }).causeFingerprint, expected.causeFingerprint);
  }
});
function passing(record) {
  return change(record, (value) => { value.observedOutcome = 'passed'; value.processExitCode = 0;
    value.cases.forEach((entry) => { entry.outcome = 'passed'; entry.causeSha256 = null; });
    value.counts = { discovered: 2, passed: 2, failed: 0, skipped: 0, notRun: 0 }; });
}
function withSelection(fixture, selection) {
  return { selection, observations: [change(fixture.observation, (value) => { value.selectionSha256 = selection.recordSha256; })] };
}

test('every lifecycle gate retains failed observations and evaluates the same known failure', () => {
  const fixture = createTrpFixture();
  const before = JSON.stringify(fixture.input);
  for (const operation of fixture.decision.transitions) {
    const result = evaluate(fixture, { operation });
    assert.equal(result.operationReadiness, 'ready', operation);
    assert.equal(result.gateDecision, 'allow-with-risk', operation);
    assert.equal(result.dispositions[0].observedOutcome, 'failed');
    assert.equal(result.dispositions[0].disposition, 'accepted-known-failures');
    assert.equal(result.normalApprovalRequired, true);
    assert.ok(Object.isFrozen(result.dispositions[0]));
    validateTrpRecord(result);
  }
  assert.equal(JSON.stringify(fixture.input), before);
});

test('closed schemas reject unknown authority-bearing fields and unsupported versions', () => {
  const fixture = createTrpFixture();
  for (const record of [fixture.agreement, fixture.baseline, fixture.observation, fixture.selection, fixture.decision]) {
    assert.throws(() => change(record, (value) => { value.authorized = true; }), /unknown field/u);
    assert.throws(() => change(record, (value) => { value.schemaVersion = 2; }), /expected 1/u);
  }
  assert.throws(() => change(fixture.decision, (value) => { value.applicability.waiveIntegrity = true; }), /unknown field/u);
  assert.throws(() => change(fixture.agreement, (value) => { value.id = '../escape'; }), /invalid string/u);
});

test('canonical hashes normalize declared sets and object keys, preserving ordered arrays', () => {
  const fixture = createTrpFixture();
  const shuffled = change(fixture.observation, (value) => { value.expectedTestIds.reverse(); value.cases.reverse(); value.dependencies.reverse(); });
  assert.equal(shuffled.recordSha256, fixture.observation.recordSha256);
  assert.equal(trpDigest({ a: 1, b: 2 }), trpDigest({ b: 2, a: 1 }));
  assert.notEqual(trpDigest(['node', '--test']), trpDigest(['--test', 'node']));
  assert.throws(() => validateTrpRecord({ ...fixture.decision, reason: 'Tampered acceptance text.' }), /digest mismatch/u);
});

test('count-only and ambiguous observations cannot be sealed as complete identities', () => {
  const fixture = createTrpFixture();
  assert.throws(() => change(fixture.baseline, (value) => { value.cases = []; }), /Counts do not match/u);
  assert.throws(() => change(fixture.baseline, (value) => { value.cases[1].id = value.cases[0].id; }), /Duplicate identity/u);
  assert.throws(() => change(fixture.baseline, (value) => { value.expectedTestIds.push('missing'); }), /every expected test/u);
  const observation = change(fixture.observation, (value) => { value.identityCompleteness = 'ambiguous'; });
  denied(evaluate(fixture, { observations: [observation] }));
});

test('new failure identity blocks even when the failed total does not change', () => {
  const fixture = createTrpFixture();
  const observation = change(fixture.observation, (value) => {
    value.cases.find((entry) => entry.id === 'test:A').outcome = 'passed';
    value.cases.find((entry) => entry.id === 'test:B').outcome = 'failed';
  });
  const result = evaluate(fixture, { observations: [observation] });
  denied(result);
  assert.equal(result.dispositions[0].disposition, 'repair-required');
});

test('changed assertions, cause, selector, dependency, and environment cannot inherit acceptance', () => {
  for (const edit of [
    (value) => { value.cases.find((entry) => entry.id === 'test:A').semanticsSha256 = trpDigest('changed assertion'); },
    (value) => { value.cases.find((entry) => entry.id === 'test:A').causeSha256 = trpDigest('new cause'); },
    (value) => { value.selectorSha256 = trpDigest('changed selector'); },
    (value) => { value.dependencies[0].sha256 = trpDigest('changed relevant source'); },
    (value) => { value.environment.hostId = 'other-laptop'; }
  ]) {
    const fixture = createTrpFixture();
    denied(evaluate(fixture, { observations: [change(fixture.observation, edit)] }));
  }
});

test('evidence that no longer matches the candidate is stale, re-runnable and never accepted as risk', () => {
  for (const edit of [
    (value) => { value.dependencies[0].sha256 = trpDigest('changed relevant source'); },
    (value) => { value.environment.hostId = 'other-laptop'; }
  ]) {
    const fixture = createTrpFixture();
    const result = evaluate(fixture, { observations: [change(fixture.observation, edit)] });
    denied(result);
    const stale = result.issues.find((entry) => entry.category === 'stale-evidence');
    assert.ok(stale && result.remainingBlockers.includes(stale.id), JSON.stringify(result.issues.map((entry) => entry.category)));
    assert.equal(stale.riskEligible, false);
    assert.equal(stale.repairRoute, 'rerun-validation');
    assert.ok(!result.issues.some((entry) => entry.category === 'provenance'), 'stale evidence is not tampering');
    assert.equal(result.operationReadiness, 'needs-execution');
    assert.ok(result.supportedNextActions.includes('rerun-validation'));
  }
});

test('feature source and unrelated documents outside declared dependencies permit carry-forward', () => {
  const fixture = createTrpFixture();
  const observation = change(fixture.observation, (value) => { value.sourceRevision = 'new-doc-commit'; value.sourceManifestSha256 = trpDigest('different whole-tree'); });
  const result = evaluate(fixture, { observations: [observation], candidateDependencies: [...fixture.dependencies, { id: 'docs:unrelated', sha256: trpDigest('edited') }] });
  assert.equal(result.gateDecision, 'allow-with-risk');
});

test('repaired failures pass without retaining a risk disposition', () => {
  const fixture = createTrpFixture();
  const result = evaluate(fixture, { observations: [passing(fixture.observation)] });
  assert.equal(result.gateDecision, 'allow');
  assert.equal(result.dispositions[0].disposition, 'satisfied');
  assert.deepEqual(result.decisionRefs, []);
});

test('missing expected cases and extra skips never become reduced known failures', () => {
  const fixture = createTrpFixture();
  assert.throws(() => change(fixture.observation, (value) => { value.cases.pop(); value.counts.discovered -= 1; value.counts.passed -= 1; }), /every expected test/u);
  const skipped = change(fixture.observation, (value) => { value.cases.find((entry) => entry.outcome === 'passed').outcome = 'skipped'; value.counts.passed = 0; value.counts.skipped = 1; });
  denied(evaluate(fixture, { observations: [skipped] }));
});

test('untrusted labels, booleans, missing verifier, bad bindings and pending receipts cannot authorize', () => {
  const fixture = createTrpFixture();
  for (const verifyAuthority of [undefined, () => true, () => ({ actor: 'human-owner', authorized: true }),
    (record, context) => ({ ...fixture.input.verifyAuthority(record, context), recordSha256: trpDigest('unrelated') }),
    (record, context) => ({ ...fixture.input.verifyAuthority(record, context), durable: false })]) {
    denied(evaluate(fixture, { verifyAuthority }));
  }
  denied(evaluate(fixture, { verifyEvidence: () => true }));
});

test('decision revocation and expiry block future transitions but preserve historical verification', () => {
  const fixture = createTrpFixture();
  const verifyAuthority = (record, context) => ({ ...fixture.input.verifyAuthority(record, context),
    revokedAt: record.kind === 'phase-risk-decision' ? '2026-10-03T00:00:00Z' : null });
  assert.equal(evaluate(fixture, { mode: 'historical', verifyAuthority }).gateDecision, 'allow-with-risk');
  denied(evaluate(fixture, { at: '2026-10-04T00:00:00Z', verifyAuthority }));
  denied(evaluate(fixture, { at: '2026-10-21T00:00:00Z' }));
  assert.equal(evaluate(fixture, { mode: 'historical', at: fixture.at }).gateDecision, 'allow-with-risk');
});

test('decision transition, phase, repository, epoch, expiry bounds and revocation remain independent', () => {
  for (const edit of [
    (value) => { value.transitions = ['submit']; },
    (value) => { value.applicability.phaseIds = ['release']; },
    (value) => { value.subject.repositoryId = 'other-repository'; },
    (value) => { value.subject.validationEpoch += 1; },
    (value) => { value.expiresAt = '2027-01-01T00:00:00Z'; }
  ]) {
    const fixture = createTrpFixture();
    denied(evaluate(fixture, { decisions: [change(fixture.decision, edit)] }));
  }
});

test('decision carry-forward cannot substitute a baseline captured for another phase', () => {
  const fixture = createTrpFixture();
  const subject = { ...fixture.subject, phaseId: 'release', generation: 2 };
  const selection = change(fixture.selection, (value) => { value.subject = subject; });
  const observation = change(fixture.observation, (value) => { value.subject = subject; value.selectionSha256 = selection.recordSha256; });
  denied(evaluate(fixture, { subject, selection, observations: [observation] }));
  const decision = change(fixture.decision, (value) => { value.applicability.carryForward = false; });
  denied(evaluate(fixture, { subject, selection, observations: [observation], decisions: [decision] }));
});

test('integrity blockers remain blocked alongside a valid accepted risk', () => {
  const fixture = createTrpFixture();
  for (const category of ['provenance', 'identity', 'protected-path', 'source-safety']) {
    const result = evaluate(fixture, { integrityIssues: [{ category, obligationId: 'source', message: 'Independent integrity condition requires repair' }] });
    denied(result);
    assert.equal(result.operationReadiness, 'blocked');
    assert.equal(result.dispositions[0].disposition, 'accepted-known-failures');
  }
});

test('a critical obligation cannot be waived by an enabled exception', () => {
  const fixture = createTrpFixture();
  const agreement = change(fixture.agreement, (value) => { value.repositories[0].mandatoryObligations[0].nonWaivable = true; });
  const selection = change(fixture.selection, (value) => { value.agreementSha256 = agreement.recordSha256; });
  const observation = change(fixture.observation, (value) => { value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256; });
  const decision = change(fixture.decision, (value) => { value.agreementSha256 = agreement.recordSha256; });
  const result = evaluate(fixture, { agreement, selection, observations: [observation], decisions: [decision] });
  denied(result);
  assert.equal(result.issues[0].category, 'non-waivable');
});

test('legacy Stories and absent fields never imply consent', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { agreement: null }));
  denied(evaluate(fixture, { policy: { ...fixture.policy, enabled: false } }));
  denied(evaluate(fixture, { decisions: [] }));
  const policy = { ...fixture.policy }; delete policy.enabledRiskCategories;
  denied(evaluate(fixture, { policy }));
});

test('silent full-suite expansion, empty selection and stale confirmation are blocked', () => {
  const fixture = createTrpFixture();
  for (const edit of [
    (value) => { value.effectiveMode = 'all-configured'; },
    (value) => { value.expansion = 'module'; value.fullSuiteEquivalent = true; },
    (value) => { value.inventoryTestIds = [...value.selectedTestIds]; },
    (value) => { value.selectedTestIds = []; }
  ]) {
    const selection = change(fixture.selection, edit);
    denied(evaluate(fixture, withSelection(fixture, selection)));
  }
  const selection = change(fixture.selection, (value) => { value.expansion = 'module'; value.confirmationSha256 = trpDigest('exact-selection-plan'); });
  assert.equal(evaluate(fixture, withSelection(fixture, selection)).gateDecision, 'allow-with-risk');
  const verifyAuthority = (record, context) => record.kind === 'test-selection-manifest' ? { ...fixture.input.verifyAuthority(record, context), recordSha256: fixture.selection.recordSha256 } : fixture.input.verifyAuthority(record, context);
  denied(evaluate(fixture, { ...withSelection(fixture, selection), verifyAuthority }));
});

test('old report and nonzero process cannot create a passing observation', () => {
  const fixture = createTrpFixture();
  for (const edit of [
    (value) => { value.reportStatus = 'stale'; },
    (value) => { value.reportStatus = 'missing'; },
    (value) => { value.processExitCode = 1; }
  ]) denied(evaluate(fixture, { observations: [change(passing(fixture.observation), edit)] }));
});

test('missing current observation and missing evidence provenance have different routes', () => {
  const fixture = createTrpFixture();
  assert.equal(evaluate(fixture, { observations: [] }).operationReadiness, 'needs-execution');
  assert.equal(evaluate(fixture, { verifyEvidence: undefined }).operationReadiness, 'blocked');
});

test('duplicate current observations and stale receipts fail closed', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { observations: [fixture.observation, fixture.observation] }));
  denied(evaluate(fixture, { at: '2026-10-04T10:00:00Z' }));
  const reused = change(fixture.observation, (value) => { value.executionOrigin = 'reused'; });
  assert.equal(evaluate(fixture, { observations: [reused] }).gateDecision, 'allow-with-risk');
  denied(evaluate(fixture, { observations: [reused], policy: { ...fixture.policy, allowEvidenceReuse: false } }));
});

test('a new host cannot claim another host execution as local evidence', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { candidateEnvironment: { ...fixture.environment, hostId: 'host-b' } }));
});

test('pending publication has exact resume action and never reports transition success', () => {
  const result = evaluate(createTrpFixture(), { publicationPending: true });
  assert.equal(result.operationReadiness, 'publication-pending');
  assert.equal(result.gateDecision, 'block');
  assert.deepEqual(result.supportedNextActions, ['resume-exact-publication']);
});

test('non-test workflows do not acquire test obligations', () => {
  const fixture = createTrpFixture();
  const agreement = change(fixture.agreement, (value) => {
    value.repositories[0].codeBearing = false; value.repositories[0].mandatoryObligations = [];
    value.repositories[0].baselineDisposition = 'not-applicable'; value.repositories[0].execution.mode = 'not-applicable';
  });
  const result = evaluate(fixture, { agreement, observations: [], decisions: [], baselines: [], selection: null });
  assert.equal(result.gateDecision, 'allow');
  assert.deepEqual(result.requiredObligations, []);
});

test('enabled unavailable validation is a separate exact decision and remains unavailable', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['validation-unavailable'] };
  const observation = change(fixture.observation, (value) => {
    value.observedOutcome = 'unavailable'; value.processExitCode = null; value.reportStatus = 'missing'; value.reportSha256s = [];
    value.cases.forEach((entry) => { entry.outcome = 'not-run'; entry.causeSha256 = null; });
    value.counts = { discovered: 2, passed: 0, failed: 0, skipped: 0, notRun: 2 };
  });
  const preview = evaluate(fixture, { policy, observations: [observation], decisions: [] });
  assert.equal(preview.operationReadiness, 'needs-decision');
  const decision = change(fixture.decision, (value) => { value.category = 'validation-unavailable'; value.issueId = preview.issues[0].id; value.anchorObservationDigest = observation.recordSha256; });
  const result = evaluate(fixture, { policy, observations: [observation], decisions: [decision] });
  assert.equal(result.gateDecision, 'allow-with-risk');
  assert.equal(result.dispositions[0].observedOutcome, 'unavailable');
  assert.equal(result.dispositions[0].disposition, 'accepted-risk');
  denied(evaluate(fixture, { observations: [observation], decisions: [decision] }));
  denied(evaluate(fixture, { policy, observations: [observation], decisions: [decision], integrityIssues: [{ category: 'provenance', obligationId: 'report', message: 'Old XML is falsely claimed as current' }] }));
});

test('authenticated unavailable attempts disclose unknown inventory without inventing coverage', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['validation-unavailable'] };
  const selection = change(fixture.selection, value => {
    value.selectedTestIds = []; value.inventoryTestIds = []; value.selectedSuites = ['unit-tests'];
    value.uncoveredAreas = ['testcase-inventory-unknown']; value.impactComplete = false;
  });
  const observation = change(fixture.observation, value => {
    value.selectionSha256 = selection.recordSha256; value.observedOutcome = 'unavailable';
    value.processExitCode = null; value.reportStatus = 'missing'; value.reportSha256s = [];
    value.identityCompleteness = 'incomplete'; value.expectedTestIds = []; value.cases = [];
    value.counts = { discovered: 0, passed: 0, failed: 0, skipped: 0, notRun: 0 };
  });
  const input = { policy, selection, observations: [observation], decisions: [] };
  const preview = evaluate(fixture, input);
  assert.equal(preview.operationReadiness, 'needs-decision');
  assert.deepEqual(preview.issues.map(issue => issue.category), ['validation-unavailable']);
  const decision = change(fixture.decision, value => {
    value.category = 'validation-unavailable'; value.issueId = preview.issues[0].id;
    value.anchorObservationDigest = observation.recordSha256;
    value.applicability.carryForward = false; value.applicability.allowedTestIds = [];
    value.applicability.acceptedFailures = []; value.applicability.baselineSha256 = null;
  });
  const accepted = evaluate(fixture, { ...input, decisions: [decision] });
  assert.equal(accepted.gateDecision, 'allow-with-risk');
  assert.equal(accepted.dispositions[0].observedOutcome, 'unavailable');
  assert.equal(accepted.normalApprovalRequired, true);
  denied(evaluate(fixture, { ...input, decisions: [decision], verifyEvidence: () => null }));
  denied(evaluate(fixture, { ...input, decisions: [decision], candidateDependencies: [] }));
  denied(evaluate(fixture, { ...input, decisions: [decision], candidateEnvironment: { ...fixture.environment, hostId: 'other-host' } }));
  denied(evaluate(fixture, { ...input, policy: fixture.policy, decisions: [decision] }));
  for (const mutate of [
    value => { value.observedOutcome = 'inconclusive'; },
    value => { value.observedOutcome = 'passed'; value.processExitCode = 0; },
    value => { value.observedOutcome = 'failed'; value.processExitCode = 1; },
    value => { value.processExitCode = 1; },
    value => { value.reportStatus = 'stale'; },
    value => { value.reportSha256s = [fixture.hash('unrelated-old-report')]; }
  ]) denied(evaluate(fixture, { ...input, observations: [change(observation, mutate)], decisions: [decision] }));
  const nextAttempt = change(observation, value => { value.id = 'another-run'; });
  denied(evaluate(fixture, { ...input, observations: [nextAttempt], decisions: [decision] }));
});

test('agreement authorship stays separate from a verified delegated approving principal', () => {
  const fixture = createTrpFixture();
  const original = fixture.input.verifyAuthority;
  const result = evaluate(fixture, { verifyAuthority: (record, context) => ({ ...original(record, context),
    principal: record.kind === 'story-test-recovery-agreement' ? 'delegated-reviewer' : record.issuer.principal }) });
  assert.equal(result.gateDecision, 'allow-with-risk');
  denied(evaluate(fixture, { verifyAuthority: (record, context) => ({ ...original(record, context),
    principal: record.kind === 'phase-risk-decision' ? 'different-reviewer' : record.issuer.principal }) }));
  denied(evaluate(fixture, { verifyAuthority: (record, context) => ({ ...original(record, context),
    policyAuthoritySha256: record.kind === 'story-test-recovery-agreement' ? fixture.hash('wrong-policy') : fixture.policy.authoritySha256 }) }));
});

test('new-failure and document categories require their own reviewed issue and enabled policy', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['new-test-failure'] };
  const observation = change(fixture.observation, (value) => { value.cases.find((entry) => entry.id === 'test:A').causeSha256 = fixture.hash('new failure cause'); });
  const preview = evaluate(fixture, { policy, observations: [observation], decisions: [] });
  const decision = change(fixture.decision, (value) => { value.category = 'new-test-failure'; value.issueId = preview.issues[0].id; value.anchorObservationDigest = observation.recordSha256; });
  assert.equal(evaluate(fixture, { policy, observations: [observation], decisions: [decision] }).dispositions[0].disposition, 'accepted-risk');
  denied(evaluate(fixture, { observations: [observation], decisions: [decision] }));
});

test('exact known failure remains eligible for review before a decision exists', () => {
  const result = evaluate(createTrpFixture(), { decisions: [] });
  assert.equal(result.operationReadiness, 'needs-decision');
  assert.equal(result.issues[0].category, 'known-test-failure');
  assert.equal(result.issues[0].riskEligible, true);
});

test('candidate host, nonempty dependency closure, and exact test inventory cannot be omitted', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { candidateEnvironment: null }));
  denied(evaluate(fixture, { candidateDependencies: [] }));
  const selection = change(fixture.selection, (value) => { value.selectedTestIds = []; value.selectedSuites = ['module-suite']; value.inventoryTestIds = []; });
  denied(evaluate(fixture, withSelection(fixture, selection)));
});

test('nonessential document risk is explicitly reviewed across non-test phases', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['nonessential-document'] };
  const agreement = change(fixture.agreement, (value) => { value.repositories[0].mandatoryObligations[0].kind = 'document'; });
  const observation = change(fixture.observation, (value) => { value.agreementSha256 = agreement.recordSha256; });
  const preview = evaluate(fixture, { policy, agreement, selection: null, observations: [observation], decisions: [] });
  assert.equal(preview.issues[0].category, 'nonessential-document');
  const decision = change(fixture.decision, (value) => {
    value.agreementSha256 = agreement.recordSha256; value.category = 'nonessential-document';
    value.issueId = preview.issues[0].id; value.anchorObservationDigest = observation.recordSha256;
  });
  const result = evaluate(fixture, { policy, agreement, selection: null, observations: [observation], decisions: [decision] });
  assert.equal(result.gateDecision, 'allow-with-risk');
  assert.equal(result.dispositions[0].observedOutcome, 'failed');
});

test('known-failure exclusions need a distinct reviewed coverage decision and never count as passes', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['known-test-failure', 'reduced-coverage'] };
  const agreement = change(fixture.agreement, (value) => { value.repositories[0].execution.knownFailureHandling = 'reviewed-exclusion'; });
  const selectionDraft = change(fixture.selection, (value) => {
    value.agreementSha256 = agreement.recordSha256; value.selectedTestIds = ['test:B'];
    value.exclusions = [{ testId: 'test:A', baselineSha256: fixture.baseline.recordSha256, decisionSha256: fixture.hash('pending-review') }];
  });
  const observationFor = (selection) => change(fixture.observation, (value) => {
    value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256;
    value.observedOutcome = 'passed'; value.processExitCode = 0; value.expectedTestIds = ['test:B'];
    value.cases = value.cases.filter((entry) => entry.id === 'test:B');
    value.counts = { discovered: 1, passed: 1, failed: 0, skipped: 0, notRun: 0 };
  });
  const preview = evaluate(fixture, { policy, agreement, selection: selectionDraft, observations: [observationFor(selectionDraft)], decisions: [] });
  assert.equal(preview.operationReadiness, 'needs-decision');
  const decision = change(fixture.decision, (value) => {
    value.agreementSha256 = agreement.recordSha256; value.category = 'reduced-coverage'; value.issueId = preview.issues[0].id;
    value.applicability.excludedTestIds = ['test:A']; value.applicability.allowedTestIds = ['test:B'];
  });
  const selection = change(selectionDraft, (value) => { value.exclusions[0].decisionSha256 = decision.recordSha256; });
  const observation = observationFor(selection);
  const result = evaluate(fixture, { policy, agreement, selection, observations: [observation], decisions: [decision] });
  assert.equal(result.gateDecision, 'allow-with-risk');
  assert.equal(result.dispositions[0].disposition, 'accepted-risk');
  assert.equal(observation.counts.passed, 1);
  assert.equal(observation.cases.some((entry) => entry.id === 'test:A'), false);
  denied(evaluate(fixture, { policy, agreement, selection, observations: [observation], decisions: [fixture.decision] }));
});

test('silently omitted known-failure sentinels cannot produce a pass', () => {
  const fixture = createTrpFixture();
  const selection = change(fixture.selection, (value) => { value.selectedTestIds = ['test:B']; });
  const observation = change(passing(fixture.observation), (value) => {
    value.selectionSha256 = selection.recordSha256; value.expectedTestIds = ['test:B']; value.cases = value.cases.filter((entry) => entry.id === 'test:B');
    value.counts = { discovered: 1, passed: 1, failed: 0, skipped: 0, notRun: 0 };
  });
  const result = evaluate(fixture, { selection, observations: [observation] });
  denied(result);
  assert.match(result.issues[0].message, /sentinels/u);
});

test('missing or process-inconsistent baseline evidence cannot bless current results', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { baselines: [] }));
  const invalid = change(fixture.baseline, (value) => { value.processExitCode = 0; value.observedOutcome = 'passed'; });
  const agreement = change(fixture.agreement, (value) => { value.repositories[0].baselineRefs = [invalid.recordSha256]; });
  const selection = change(fixture.selection, (value) => { value.agreementSha256 = agreement.recordSha256; });
  const observation = change(passing(fixture.observation), (value) => { value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256; });
  const result = evaluate(fixture, { agreement, selection, observations: [observation], baselines: [invalid], decisions: [] });
  denied(result);
  assert.equal(result.issues[0].category, 'provenance');
});

test('generated schema files exactly match pure runtime contracts', async () => {
  const names = { 'story-test-recovery-agreement': 'agreement', 'test-baseline-manifest': 'baseline', 'test-selection-manifest': 'selection',
    'phase-validation-observation': 'observation', 'phase-risk-decision': 'decision', 'phase-risk-revocation': 'revocation', 'phase-gate-evaluation': 'evaluation',
    'story-test-policy-amendment': 'amendment', 'phase-repair-receipt': 'repair', 'trp-authority-receipt': 'authority-receipt' };
  for (const [kind, schema] of Object.entries(TRP_SCHEMAS)) {
    assert.deepEqual(JSON.parse(await readFile(new URL(`../schemas/trp-${names[kind]}.schema.json`, import.meta.url), 'utf8')), schema);
  }
  const policySchema = JSON.parse(await readFile(new URL('../schemas/trp-policy.schema.json', import.meta.url), 'utf8'));
  const { $schema, $id, ...runtime } = policySchema;
  assert.deepEqual(runtime, TRP_POLICY_SCHEMA);
});

test('all enabled risk categories remain unable to waive a critical obligation', () => {
  for (const category of ['known-test-failure', 'new-test-failure', 'reduced-coverage', 'validation-unavailable', 'nonessential-document']) {
    const fixture = createTrpFixture();
    const policy = { ...fixture.policy, enabledRiskCategories: [category] };
    const agreement = change(fixture.agreement, value => {
      value.repositories[0].mandatoryObligations[0].nonWaivable = true;
      if (category === 'nonessential-document') value.repositories[0].mandatoryObligations[0].kind = 'document';
    });
    const selection = change(fixture.selection, value => { value.agreementSha256 = agreement.recordSha256; });
    const observation = change(fixture.observation, value => {
      value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256;
      if (category === 'new-test-failure') value.cases[0].causeSha256 = fixture.hash('new cause');
      if (category === 'validation-unavailable') {
        value.observedOutcome = 'unavailable'; value.processExitCode = null; value.reportStatus = 'missing'; value.reportSha256s = [];
        value.cases.forEach(entry => { entry.outcome = 'not-run'; });
        value.counts = { discovered: 2, passed: 0, failed: 0, skipped: 0, notRun: 2 };
      }
      if (category === 'reduced-coverage') {
        value.cases.find(entry => entry.outcome === 'passed').outcome = 'skipped'; value.counts.passed = 0; value.counts.skipped = 1;
      }
    });
    const preview = evaluate(fixture, { policy, agreement, selection, observations: [observation], decisions: [] });
    const decisions = preview.issues.map((issue, index) => change(fixture.decision, value => {
      value.id = `critical-attempt-${index}`; value.agreementSha256 = agreement.recordSha256; value.category = category;
      value.issueId = issue.id;
      if (category !== 'known-test-failure') value.anchorObservationDigest = observation.recordSha256;
    }));
    const result = evaluate(fixture, { policy, agreement, selection, observations: [observation], decisions });
    denied(result);
    assert.ok(result.issues.every(issue => issue.category === 'non-waivable' && !issue.riskEligible));
    assert.deepEqual(result.decisionRefs, []);
    assert.equal(result.dispositions[0].disposition, 'integrity-blocked');
  }
});

test('future observations and current evidence verified in the future cannot qualify a gate', () => {
  const fixture = createTrpFixture();
  const future = change(fixture.observation, value => {
    value.createdAt = '2026-10-02T13:02:00Z'; value.startedAt = '2026-10-02T13:00:00Z'; value.completedAt = '2026-10-02T13:01:00Z';
  });
  denied(evaluate(fixture, { observations: [future] }));
  const verifyEvidence = record => ({ ...fixture.input.verifyEvidence(record), verifiedAt: '2026-10-02T13:00:00Z' });
  denied(evaluate(fixture, { verifyEvidence }));
  assert.equal(evaluate(fixture, { mode: 'historical', verifyEvidence }).gateDecision, 'allow-with-risk',
    'rechecking authentic historical bytes later must not erase an originally valid transition');
  for (const mode of ['current', 'historical']) denied(evaluate(fixture, { mode,
    verifyEvidence: record => ({ ...fixture.input.verifyEvidence(record), verifiedAt: '2026-10-02T08:00:00Z' }) }));
});

test('authorization cannot predate the reviewed record and expiry/revocation boundaries are exact', () => {
  const fixture = createTrpFixture();
  denied(evaluate(fixture, { verifyAuthority: (record, context) => ({ ...fixture.input.verifyAuthority(record, context),
    issuedAt: '2026-10-02T09:00:00Z' }) }));
  const verifyAuthority = (record, context) => ({ ...fixture.input.verifyAuthority(record, context),
    revokedAt: record.kind === 'phase-risk-decision' ? fixture.at : null });
  denied(evaluate(fixture, { verifyAuthority }));
  assert.equal(evaluate(fixture, { verifyAuthority, mode: 'historical', at: '2026-10-02T11:00:00Z' }).gateDecision, 'allow-with-risk');
  const decision = change(fixture.decision, value => { value.expiresAt = fixture.at; });
  denied(evaluate(fixture, { decisions: [decision] }));
  assert.equal(evaluate(fixture, { decisions: [decision], mode: 'historical', at: '2026-10-02T11:00:00Z' }).gateDecision, 'allow-with-risk');
});

test('carry-forward cannot discard relevant dependency bindings or authorize an earlier generation of the same phase', () => {
  const fixture = createTrpFixture();
  for (const dependencies of [[], fixture.dependencies.slice(0, 1)]) {
    const decision = change(fixture.decision, value => { value.applicability.dependencies = dependencies; });
    denied(evaluate(fixture, { decisions: [decision] }));
  }
  const decision = change(fixture.decision, value => { value.subject.generation += 1; });
  denied(evaluate(fixture, { decisions: [decision] }));
});

test('a baseline for another obligation cannot authorize these otherwise identical failed tests', () => {
  const fixture = createTrpFixture();
  const baseline = change(fixture.baseline, value => { value.obligationId = 'different-test-obligation'; });
  const agreement = change(fixture.agreement, value => { value.repositories[0].baselineRefs = [baseline.recordSha256]; });
  const selection = change(fixture.selection, value => { value.agreementSha256 = agreement.recordSha256; });
  const observation = change(fixture.observation, value => { value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256; });
  const decision = change(fixture.decision, value => {
    value.agreementSha256 = agreement.recordSha256; value.anchorObservationDigest = baseline.recordSha256;
    value.applicability.baselineSha256 = baseline.recordSha256;
  });
  denied(evaluate(fixture, { agreement, selection, observations: [observation], baselines: [baseline], decisions: [decision] }));
});

test('selected testcase identity must belong to the authenticated declared inventory', () => {
  const fixture = createTrpFixture();
  const selection = change(fixture.selection, value => { value.inventoryTestIds = ['test:A', 'test:C']; });
  const result = evaluate(fixture, withSelection(fixture, selection));
  denied(result);
  assert.ok(result.issues.some(issue => /absent from the verified inventory/u.test(issue.message)));
});

test('a known failure decision cannot legitimize a missing or contradictory execution result', () => {
  const fixture = createTrpFixture();
  for (const processExitCode of [null, 0]) {
    const observation = change(fixture.observation, value => { value.processExitCode = processExitCode; });
    const result = evaluate(fixture, { observations: [observation] });
    denied(result);
    assert.equal(result.dispositions[0].disposition, 'integrity-blocked');
  }
});

test('a new failure decision cannot silently cover testcases that never ran', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['new-test-failure'] };
  const observation = change(fixture.observation, value => {
    value.cases.find(entry => entry.outcome === 'passed').outcome = 'not-run'; value.counts.passed = 0; value.counts.notRun = 1;
  });
  const preview = evaluate(fixture, { policy, observations: [observation], decisions: [] });
  const failure = preview.issues.find(issue => issue.category === 'new-test-failure');
  const decision = change(fixture.decision, value => {
    value.category = 'new-test-failure'; value.issueId = failure.id; value.anchorObservationDigest = observation.recordSha256;
  });
  const result = evaluate(fixture, { policy, observations: [observation], decisions: [decision] });
  denied(result);
  assert.ok(result.issues.some(issue => issue.category === 'reduced-coverage' && result.remainingBlockers.includes(issue.id)));
});

test('an exact new-failure decision does not carry to a new observation merely because the cause is unchanged', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['new-test-failure'] };
  const observation = change(fixture.observation, value => { value.cases[0].causeSha256 = fixture.hash('new cause'); });
  const preview = evaluate(fixture, { policy, observations: [observation], decisions: [] });
  const decision = change(fixture.decision, value => {
    value.category = 'new-test-failure'; value.issueId = preview.issues[0].id; value.anchorObservationDigest = observation.recordSha256;
  });
  assert.equal(evaluate(fixture, { policy, observations: [observation], decisions: [decision] }).gateDecision, 'allow-with-risk');
  const later = change(observation, value => { value.id = 'another-authenticated-run'; });
  denied(evaluate(fixture, { policy, observations: [later], decisions: [decision] }));
});

test('reviewed known-failure exclusion cannot name a testcase absent from its baseline', () => {
  const fixture = createTrpFixture();
  const policy = { ...fixture.policy, enabledRiskCategories: ['known-test-failure', 'reduced-coverage'] };
  const agreement = change(fixture.agreement, value => { value.repositories[0].execution.knownFailureHandling = 'reviewed-exclusion'; });
  const selectionDraft = change(fixture.selection, value => {
    value.agreementSha256 = agreement.recordSha256; value.confirmationSha256 = fixture.hash('full-inventory-review');
    value.exclusions = [{ testId: 'test:C', baselineSha256: fixture.baseline.recordSha256, decisionSha256: fixture.hash('pending') }];
  });
  const observationFor = selection => change(fixture.observation, value => {
    value.agreementSha256 = agreement.recordSha256; value.selectionSha256 = selection.recordSha256;
  });
  const preview = evaluate(fixture, { policy, agreement, selection: selectionDraft, observations: [observationFor(selectionDraft)], decisions: [] });
  const coverage = preview.issues.find(issue => issue.category === 'reduced-coverage');
  assert.ok(coverage);
  const decision = change(fixture.decision, value => {
    value.agreementSha256 = agreement.recordSha256; value.category = 'reduced-coverage'; value.issueId = coverage.id;
    value.applicability.excludedTestIds = ['test:C'];
  });
  const known = change(fixture.decision, value => { value.agreementSha256 = agreement.recordSha256; });
  const selection = change(selectionDraft, value => { value.exclusions[0].decisionSha256 = decision.recordSha256; });
  const result = evaluate(fixture, { policy, agreement, selection, observations: [observationFor(selection)], decisions: [known, decision] });
  denied(result);
  assert.ok(result.issues.some(issue => issue.category === 'reduced-coverage' && result.remainingBlockers.includes(issue.id)));
});
