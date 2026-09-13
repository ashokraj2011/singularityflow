import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deduplicateTkrUsage, evaluateTkrBenchmark, normalizeTkrBenchmarkProfile,
  normalizeTkrProviderUsageAccounting
} from '../src/token-reduction-evaluation.mjs';
import { recordSha256 } from '../src/records.mjs';

const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;

function declaredCohort(scenarios = 10, trials = 3) {
  return Array.from({ length: scenarios }, (_, scenarioIndex) => ({
    scenarioId: `story-${scenarioIndex + 1}`,
    trials: Array.from({ length: trials }, (_, trialIndex) => trialIndex + 1)
  }));
}

function usageAccounting(overrides = {}) {
  const core = {
    kind: 'tkr/provider-usage-accounting',
    version: 1,
    mappingId: 'fixture-provider-v1',
    overlap: 'exclusive-requests',
    inputTokens: 'total-including-cached',
    cachedInputTokens: 'subset-of-input',
    outputTokens: 'reported-total',
    providerCost: 'reported-total',
    ...overrides
  };
  return { ...core, contractSha256: `sha256:${recordSha256(core)}` };
}

function profile(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'tkr/benchmark-profile',
    profileId: 'paired-release',
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    repositoryVectorSha256: digest('1'),
    taskDefinitionSha256: digest('2'),
    verificationDefinitionSha256: digest('3'),
    workflowPolicySha256: digest('4'),
    baselineComposerSha256: digest('5'),
    treatmentComposerSha256: digest('6'),
    adapterId: 'fake-controlled',
    adapterVersion: '1',
    provider: 'fixture',
    model: 'fixture-model',
    settingsSha256: digest('7'),
    tokenizerSha256: digest('8'),
    toolDefinitionsSha256: digest('9'),
    cacheCondition: 'declared-cold',
    usageAccounting: usageAccounting(),
    declaredCohort: declaredCohort(),
    ...overrides
  };
}

function observation({ scenario = 1, trial = 1, strategy = 'baseline', tokens = 100,
  request = `${strategy}-${scenario}-${trial}`, ...overrides } = {}) {
  return {
    scenarioId: `story-${scenario}`,
    trial,
    strategy,
    storyId: `WRK-${scenario}`,
    phase: 'implementation',
    operationId: `op-${request}`,
    attemptId: `attempt-${request}`,
    providerRequestId: `provider-${request}`,
    usageId: `usage-${request}`,
    usageKind: 'request',
    parentUsageId: null,
    includedUsageIds: [],
    snapshotIndex: 1,
    terminal: true,
    status: 'completed',
    inputTokens: tokens,
    outputTokens: 20,
    cachedInputTokens: 0,
    providerCost: 1,
    coverageComplete: true,
    requiredCoveragePassed: true,
    protectedContentPreserved: true,
    staleDispatchPrevented: true,
    authorizedContinuation: true,
    firstPassPassed: true,
    finalAccepted: true,
    repairCount: 0,
    latencyMs: 10,
    ...overrides
  };
}

test('TKR benchmark profile is closed and refuses hidden exclusion of failures', () => {
  assert.equal(normalizeTkrBenchmarkProfile(profile()).minimumScenarios, 10);
  assert.throws(() => normalizeTkrBenchmarkProfile(profile({ declaredCohort: [] })),
    (error) => error.code === 'TKR_COVERAGE_UNPROVEN');
  assert.throws(() => normalizeTkrBenchmarkProfile(profile({ surprise: true })),
    (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED');
  assert.throws(() => normalizeTkrBenchmarkProfile(profile({ includeFailedAttempts: false })),
    (error) => error.code === 'TKR_COVERAGE_UNPROVEN');
  assert.equal(normalizeTkrProviderUsageAccounting(usageAccounting()).overlap,
    'exclusive-requests');
  assert.throws(() => normalizeTkrProviderUsageAccounting({
    ...usageAccounting(), mappingId: 'tampered-without-rehash'
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
    && /content-integrity/.test(error.message));
  assert.throws(() => normalizeTkrProviderUsageAccounting({
    ...usageAccounting(), mappingId: ' fixture-provider-v1 '
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
    && /leading or trailing whitespace/.test(error.message));
  assert.throws(() => normalizeTkrProviderUsageAccounting({
    ...usageAccounting(), overlap: ' exclusive-requests '
  }), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
    && /leading or trailing whitespace/.test(error.message));
  assert.throws(() => normalizeTkrProviderUsageAccounting(usageAccounting({
    inputTokens: 'total-excluding-cached', cachedInputTokens: 'subset-of-input'
  })), (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
    && /contradictory/.test(error.message));
});

test('cumulative provider snapshots count once and terminal usage wins', () => {
  const first = observation({ terminal: false, snapshotIndex: 1, tokens: 40,
    providerRequestId: null });
  const terminal = { ...first, providerRequestId: 'provider-late', terminal: true,
    snapshotIndex: 2, inputTokens: 100 };
  const selected = deduplicateTkrUsage([terminal, first]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].inputTokens, 100);
  assert.equal(selected[0].terminal, true);
  assert.equal(selected[0].providerRequestId, 'provider-late');
  assert.throws(() => deduplicateTkrUsage([
    terminal,
    { ...terminal, scenarioId: 'story-other', snapshotIndex: 3 }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN');
});

test('usage snapshots refuse ambiguous identity and non-cumulative accounting', () => {
  const first = observation({ terminal: false, snapshotIndex: 1, tokens: 100,
    providerRequestId: null });
  assert.throws(() => deduplicateTkrUsage([
    first, { ...first, terminal: true, snapshotIndex: 2, inputTokens: 90 }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /decreases cumulative inputTokens/.test(error.message));

  const terminal = { ...first, terminal: true, snapshotIndex: 2,
    providerRequestId: 'provider-one' };
  assert.throws(() => deduplicateTkrUsage([
    terminal, { ...terminal, snapshotIndex: 3, providerRequestId: 'provider-two' }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /changed provider request identity/.test(error.message));
  assert.throws(() => deduplicateTkrUsage([
    terminal, { ...terminal, inputTokens: 101 }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /conflicting cumulative snapshots/.test(error.message));

  const anotherAttempt = observation({ request: 'another-attempt',
    providerRequestId: 'provider-one' });
  assert.throws(() => deduplicateTkrUsage([terminal, anotherAttempt]),
    (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && /maps to multiple attempts/.test(error.message));

  assert.throws(() => deduplicateTkrUsage([
    { ...first, firstPassPassed: false },
    { ...terminal, firstPassPassed: true }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
      && /changes observed firstPassPassed/u.test(error.message));
});

test('observation counters and state flags reject lossy coercion while absent legacy defaults remain explicit', () => {
  const legacy = observation();
  delete legacy.snapshotIndex;
  delete legacy.terminal;
  const [normalized] = deduplicateTkrUsage([legacy]);
  assert.equal(normalized.snapshotIndex, 0);
  assert.equal(normalized.terminal, false);

  for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'repairCount']) {
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => deduplicateTkrUsage([observation({ [field]: value })]),
        (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
          && error.message.includes(`${field} must be a non-negative safe integer`));
    }
  }
  for (const snapshotIndex of [-1, 1.5, null, undefined]) {
    assert.throws(() => deduplicateTkrUsage([observation({ snapshotIndex })]),
      (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && /snapshotIndex must be a non-negative safe integer/u.test(error.message));
  }
  for (const terminal of [null, 0, 'false']) {
    assert.throws(() => deduplicateTkrUsage([observation({ terminal })]),
      (error) => error.code === 'TKR_CONTRACT_UNSUPPORTED'
        && /terminal must be boolean/u.test(error.message));
  }

  const [measured] = deduplicateTkrUsage([observation({
    providerCost: 0.125, latencyMs: 0.5
  })]);
  assert.equal(measured.providerCost, 0.125);
  assert.equal(measured.latencyMs, 0.5);
});

test('independent retry attempts remain separate usage even under one operation', () => {
  const first = observation({ request: 'retry-one', operationId: 'shared-operation',
    attemptId: 'attempt-one', providerRequestId: 'provider-one', tokens: 60 });
  const retry = observation({ request: 'retry-two', operationId: 'shared-operation',
    attemptId: 'attempt-two', providerRequestId: 'provider-two', tokens: 40 });
  const selected = deduplicateTkrUsage([retry, first]);
  assert.equal(selected.length, 2);
  assert.equal(selected.reduce((total, entry) => total + entry.inputTokens, 0), 100);
});

test('complete paired cohort computes a candidate result but cannot authorize a savings claim', () => {
  const observations = [];
  for (let scenario = 1; scenario <= 10; scenario += 1) {
    for (let trial = 1; trial <= 3; trial += 1) {
      observations.push(observation({ scenario, trial, strategy: 'baseline', tokens: 100 }));
      observations.push(observation({ scenario, trial, strategy: 'treatment', tokens: 60 }));
    }
  }
  const result = evaluateTkrBenchmark(profile(), observations);
  assert.equal(result.accounting.reductionPercent, 40);
  assert.equal(result.coverage.cohortComplete, true);
  assert.equal(result.measurementEligible, true);
  assert.equal(result.diagnosticTargetAndQualityHeld, true);
  assert.equal(result.benchmarkEligible, false);
  assert.equal(result.candidateClaimEligible, false);
  assert.equal(result.claimBoundary, 'code-local-diagnostic-only');
  assert.equal(result.claimAllowed, false);
  assert.match(result.reasons.join(' '), /durable empirical release qualification/u);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.accounting));
  assert.ok(Object.isFrozen(result.accounting.providerUsageMapping));
  assert.throws(() => {
    result.accounting.providerUsageMapping.overlap = 'tampered';
  }, TypeError);

  const regressed = observations.map((entry, index) => index === 1
    ? { ...entry, firstPassPassed: false, finalAccepted: false }
    : entry);
  const failed = evaluateTkrBenchmark(profile(), regressed);
  assert.equal(failed.targetMet, true);
  assert.equal(failed.qualityHeld, false);
  assert.equal(failed.candidateClaimEligible, false);
  assert.equal(failed.claimAllowed, false);
});

test('unknown usage and repairs remain visible instead of becoming a complete-Story saving', () => {
  const observations = [
    observation({ strategy: 'baseline', tokens: 100 }),
    observation({ strategy: 'treatment', tokens: null, coverageComplete: false,
      status: 'failed', firstPassPassed: null, finalAccepted: false, repairCount: 1 })
  ];
  const result = evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), observations);
  assert.equal(result.accounting.treatmentInputTokens, null);
  assert.equal(result.accounting.reductionPercent, null);
  assert.equal(result.benchmarkEligible, false);
  assert.equal(result.claimAllowed, false);
  assert.match(result.reasons.join(' '), /coverage is incomplete/);
  assert.equal(result.outcomes.completeStoryObserved.status.failed, 1);
  assert.equal(result.outcomes.completeStoryObserved.repairCount, 1);
  assert.equal(result.outcomes.completeStoryObserved.unknownInputTokenRequests, 1);
  assert.equal(result.outcomes.completeStoryObserved.firstPassUnknownRequests, 1);
});

test('an unmatched declared run is visible but never mixed into primary cohort totals', () => {
  const observations = [
    observation({ scenario: 1, strategy: 'baseline', tokens: 100 }),
    observation({ scenario: 1, strategy: 'treatment', tokens: 60 }),
    observation({ scenario: 2, strategy: 'baseline', tokens: 900 })
  ];
  const result = evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(2, 1),
    minimumScenarios: 2,
    minimumPairedTrialsPerScenario: 1
  }), observations);
  assert.equal(result.coverage.pairingComplete, false);
  assert.equal(result.matchedRequests, 2);
  assert.equal(result.unmatchedRequests, 1);
  assert.equal(result.accounting.baselineInputTokens, 100);
  assert.equal(result.accounting.treatmentInputTokens, 60);
  assert.equal(result.accounting.reductionPercent, null);
  assert.equal(result.accounting.matchedSubsetReductionPercent, 40);
  assert.deepEqual(result.accounting.completeStoryObserved.inputTokens, {
    baseline: 1000, treatment: 60
  });
  assert.deepEqual(result.accounting.unmatchedObserved.inputTokens, {
    baseline: 900, treatment: null
  });
  assert.deepEqual(result.pairing.gaps, [{
    scenarioId: 'story-2', trial: 1,
    presentStrategies: ['baseline'], missingStrategies: ['treatment']
  }]);
  assert.equal(result.targetMet, false);
  assert.equal(result.claimAllowed, false);
});

test('runs outside the preregistered cohort are refused instead of excluded after inspection', () => {
  assert.throws(() => evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), [
    observation({ scenario: 1, strategy: 'baseline' }),
    observation({ scenario: 1, strategy: 'treatment' }),
    observation({ scenario: 2, strategy: 'baseline' })
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && error.details.unexpectedRuns[0].scenarioId === 'story-2');
});

test('additional treatment retrieval and repair are included in complete-Story totals', () => {
  const result = evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), [
    observation({ strategy: 'baseline', tokens: 100 }),
    observation({ strategy: 'treatment', tokens: 60, request: 'treatment-initial',
      status: 'failed', firstPassPassed: false, finalAccepted: true }),
    observation({ strategy: 'treatment', tokens: 50, request: 'treatment-repair',
      firstPassPassed: false, finalAccepted: true, repairCount: 1 })
  ]);
  assert.equal(result.accounting.baselineInputTokens, 100);
  assert.equal(result.accounting.treatmentInputTokens, 110);
  assert.ok(Math.abs(result.accounting.reductionPercent + 10) < 1e-9);
  assert.equal(result.quality.treatment.firstPassPercent, 0);
  assert.equal(result.quality.treatment.finalAcceptancePercent, 100);
  assert.equal(result.outcomes.matchedCohort.status.failed, 1);
  assert.equal(result.outcomes.matchedCohort.repairCount, 1);
  assert.equal(result.targetMet, false);
  assert.equal(result.claimAllowed, false);
});

test('quality rates give each paired run one vote regardless of request count', () => {
  const observations = [
    observation({ scenario: 1, strategy: 'baseline' }),
    observation({ scenario: 2, strategy: 'baseline' }),
    observation({ scenario: 2, strategy: 'treatment', firstPassPassed: false,
      finalAccepted: false })
  ];
  for (let request = 1; request <= 20; request += 1) {
    observations.push(observation({
      scenario: 1, strategy: 'treatment', tokens: 3, request: `many-${request}`
    }));
  }
  const result = evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(2, 1),
    minimumScenarios: 2,
    minimumPairedTrialsPerScenario: 1
  }), observations);
  assert.equal(result.quality.weighting, 'one-vote-per-declared-scenario-trial-run');
  assert.equal(result.quality.treatment.runs, 2);
  assert.equal(result.quality.treatment.firstPassPercent, 50);
  assert.equal(result.quality.treatment.finalAcceptancePercent, 50);
  assert.equal(result.qualityHeld, false);
});

test('explicit parent aggregates account once while retaining child observations', () => {
  const accounting = usageAccounting({ overlap: 'explicit-parent-aggregate' });
  const result = evaluateTkrBenchmark(profile({
    usageAccounting: accounting,
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), [
    observation({ strategy: 'baseline', request: 'baseline-parent', tokens: 100,
      usageId: 'baseline-parent', usageKind: 'aggregate',
      includedUsageIds: ['baseline-child'] }),
    observation({ strategy: 'baseline', request: 'baseline-child', tokens: 100,
      usageId: 'baseline-child', parentUsageId: 'baseline-parent' }),
    observation({ strategy: 'treatment', request: 'treatment-only', tokens: 50,
      usageId: 'treatment-only' })
  ]);
  assert.equal(result.observedRequests, 3);
  assert.equal(result.accountedRequests, 2);
  assert.equal(result.aggregateRequests, 1);
  assert.equal(result.aggregateCoveredRequests, 1);
  assert.equal(result.accounting.baselineInputTokens, 100);
  assert.equal(result.accounting.treatmentInputTokens, 50);
  assert.equal(result.accounting.reductionPercent, 50);
  assert.equal(result.accounting.overlapGraph.maximumDepth, 2);
  assert.equal(result.measurementEligible, true);
  assert.equal(result.diagnosticTargetAndQualityHeld, true);
  assert.equal(result.candidateClaimEligible, false);
  assert.equal(result.claimAllowed, false);
});

test('independent requests remain additive under an explicit aggregate-capable mapping', () => {
  const result = evaluateTkrBenchmark(profile({
    usageAccounting: usageAccounting({ overlap: 'explicit-parent-aggregate' }),
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), [
    observation({ strategy: 'baseline', request: 'baseline-a', tokens: 50 }),
    observation({ strategy: 'baseline', request: 'baseline-b', tokens: 50 }),
    observation({ strategy: 'treatment', request: 'treatment-a', tokens: 30 }),
    observation({ strategy: 'treatment', request: 'treatment-b', tokens: 30 })
  ]);
  assert.equal(result.accountedRequests, 4);
  assert.equal(result.accounting.baselineInputTokens, 100);
  assert.equal(result.accounting.treatmentInputTokens, 60);
  assert.equal(result.accounting.reductionPercent, 40);
  assert.equal(result.measurementEligible, true);
  assert.equal(result.diagnosticTargetAndQualityHeld, true);
  assert.equal(result.candidateClaimEligible, false);
  assert.equal(result.claimAllowed, false);
});

test('aggregate linkage refuses missing, ambiguous, cyclic, and snapshot-changing graphs', () => {
  const aggregateProfile = profile({
    usageAccounting: usageAccounting({ overlap: 'explicit-parent-aggregate' }),
    declaredCohort: declaredCohort(1, 1),
    minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  });
  assert.throws(() => evaluateTkrBenchmark(aggregateProfile, [
    observation({ request: 'parent', usageId: 'parent', usageKind: 'aggregate',
      includedUsageIds: ['missing'] })
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN' && /missing child/.test(error.message));

  assert.throws(() => evaluateTkrBenchmark(aggregateProfile, [
    observation({ request: 'parent-a', usageId: 'parent-a', usageKind: 'aggregate',
      includedUsageIds: ['child'] }),
    observation({ request: 'parent-b', usageId: 'parent-b', usageKind: 'aggregate',
      includedUsageIds: ['child'] }),
    observation({ request: 'child', usageId: 'child', parentUsageId: 'parent-a' })
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /multiple aggregates/.test(error.message));

  assert.throws(() => evaluateTkrBenchmark(aggregateProfile, [
    observation({ request: 'a', usageId: 'a', usageKind: 'aggregate',
      parentUsageId: 'b', includedUsageIds: ['b'] }),
    observation({ request: 'b', usageId: 'b', usageKind: 'aggregate',
      parentUsageId: 'a', includedUsageIds: ['a'] })
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN' && /cycle/.test(error.message));

  const first = observation({
    terminal: false, snapshotIndex: 1, usageKind: 'aggregate',
    includedUsageIds: ['first-child']
  });
  assert.throws(() => deduplicateTkrUsage([
    first, { ...first, snapshotIndex: 2, includedUsageIds: ['changed-child'] }
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /aggregate membership/.test(error.message));

  assert.throws(() => evaluateTkrBenchmark(profile({
    declaredCohort: declaredCohort(1, 1), minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  }), [
    observation({ request: 'aggregate', usageKind: 'aggregate',
      includedUsageIds: ['child'] }),
    observation({ request: 'child', parentUsageId: 'usage-aggregate' })
  ]), (error) => error.code === 'TKR_COVERAGE_UNPROVEN'
    && /declares exclusive/.test(error.message));
});

test('unknown or excluding-cached provider semantics cannot fabricate input totals', () => {
  const cohort = {
    declaredCohort: declaredCohort(1, 1), minimumScenarios: 1,
    minimumPairedTrialsPerScenario: 1
  };
  const unknown = evaluateTkrBenchmark(profile({
    ...cohort,
    usageAccounting: usageAccounting({
      inputTokens: 'unknown', cachedInputTokens: 'unknown'
    })
  }), [
    observation({ strategy: 'baseline', tokens: 100 }),
    observation({ strategy: 'treatment', tokens: 50 })
  ]);
  assert.equal(unknown.accounting.reductionPercent, null);
  assert.equal(unknown.benchmarkEligible, false);
  assert.equal(unknown.claimAllowed, false);

  const excluding = evaluateTkrBenchmark(profile({
    ...cohort,
    usageAccounting: usageAccounting({
      inputTokens: 'total-excluding-cached', cachedInputTokens: 'additional-to-input'
    })
  }), [
    observation({ strategy: 'baseline', tokens: 80, cachedInputTokens: 20 }),
    observation({ strategy: 'treatment', tokens: 40, cachedInputTokens: 10 })
  ]);
  assert.equal(excluding.accounting.baselineInputTokens, 100);
  assert.equal(excluding.accounting.treatmentInputTokens, 50);
  assert.equal(excluding.accounting.reductionPercent, 50);
});
