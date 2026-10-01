import { sealTrpRecord, trpDigest, trpEnvironmentDigest } from '../src/test-recovery-policy.mjs';

// Test-only simulated trusted verifiers. Production callers must authenticate the
// receipt against pinned policy and durable governed storage before returning it.
export function createTrpFixture() {
  const hash = (value) => trpDigest(value);
  const at = '2026-10-02T12:00:00Z';
  const subject = { workId: 'story-1', repositoryId: 'service', phaseId: 'code', generation: 1, validationEpoch: 1 };
  const policy = { enabled: true, authoritySha256: hash('policy'), enabledRiskCategories: ['known-test-failure'], maxRiskDays: 30,
    allowEvidenceReuse: true, maxEvidenceAgeSeconds: 86400, requiredApproval: true };
  const envelope = (kind, recordId, recordSubject = subject) => ({ schemaVersion: 1, kind, id: recordId, subject: recordSubject,
    createdAt: '2026-10-02T10:00:00Z', issuer: { principal: 'human-owner', channel: 'governed-review' },
    provenance: { authorityRef: 'authority-1', evidenceRefs: [] } });
  const environment = { hostId: 'host-a', platform: 'darwin', arch: 'arm64', runtimeSha256: hash('node'), dependencySha256: hash('lock'),
    runnerSha256: hash('runner'), adapterSha256: hash('adapter'), configurationSha256: hash('env'), externalDependenciesSha256: hash('none') };
  const dependencies = [{ id: 'test:A', sha256: hash('test-A') }, { id: 'source:legacy-module', sha256: hash('legacy-module') }];
  const agreementDraft = { ...envelope('story-test-recovery-agreement', 'agreement-1', { workId: subject.workId }), revision: 1, parentRevision: null,
    policyAuthoritySha256: policy.authoritySha256, confirmedPlanSha256: hash('start-plan'), repair: { maxDistinctAutomaticAttempts: 3 },
    repositories: [{ repositoryId: 'service', required: true, codeBearing: true, baselineDisposition: 'accept-known-failures', baselineScope: 'targeted',
      baselineRefs: [], riskDecisionRefs: [], execution: { mode: 'changed-and-affected', moduleExpansion: 'confirm', fullSuiteExpansion: 'confirm', knownFailureHandling: 'observe' },
      mandatoryObligations: [{ id: 'unit-tests', kind: 'test', nonWaivable: false, transitions: ['prepare', 'generation-admission', 'draft-check', 'prepublish', 'publish', 'submit', 'approve', 'replay'] }] }] };
  const baseline = sealTrpRecord({ ...envelope('test-baseline-manifest', 'baseline-a'), obligationId: 'unit-tests',
    agreementSha256: null, selectionSha256: hash('baseline-selection'), sourceRevision: 'base-commit', sourceManifestSha256: hash('base-manifest'),
    commandInventorySha256: hash('commands'), commandSha256: hash(['node', '--test']), selectorSha256: hash('selector'), dependencies, environment,
    startedAt: '2026-10-02T09:00:00Z', completedAt: '2026-10-02T09:01:00Z', processExitCode: 1, reportStatus: 'current', reportSha256s: [hash('baseline-report')],
    expectedTestIds: ['test:A', 'test:B'], cases: [{ id: 'test:A', outcome: 'failed', semanticsSha256: hash('semantics-A'), causeSha256: hash('cause-A') },
      { id: 'test:B', outcome: 'passed', semanticsSha256: hash('semantics-B'), causeSha256: null }], counts: { discovered: 2, passed: 1, failed: 1, skipped: 0, notRun: 0 },
    identityCompleteness: 'complete', observedOutcome: 'failed', diagnostics: [], executionOrigin: 'executed', preFeatureBase: 'base-commit', inventoryTestIds: ['test:A', 'test:B'], inventoryComplete: true });
  agreementDraft.repositories[0].baselineRefs = [baseline.recordSha256];
  const agreement = sealTrpRecord(agreementDraft);
  const selection = sealTrpRecord({ ...envelope('test-selection-manifest', 'selection-1'), agreementSha256: agreement.recordSha256,
    requestedMode: 'changed-and-affected', effectiveMode: 'changed-and-affected', candidateDeltaSha256: hash('candidate-delta'),
    commandInventorySha256: baseline.commandInventorySha256, commandSha256: baseline.commandSha256, selectorSha256: baseline.selectorSha256,
    selectedTestIds: ['test:A', 'test:B'], selectedSuites: [], inventoryTestIds: ['test:A', 'test:B', 'test:C'], reasons: [{ target: 'test:A', reason: 'known-failure-sentinel' }, { target: 'test:B', reason: 'affected-module' }],
    expansion: 'none', fullSuiteEquivalent: false, confirmationSha256: null, exclusions: [], uncoveredAreas: [], impactComplete: true });
  const { preFeatureBase, inventoryTestIds, inventoryComplete, recordSha256, ...baselineObservation } = baseline;
  const observation = sealTrpRecord({ ...baselineObservation, ...envelope('phase-validation-observation', 'run-1'), agreementSha256: agreement.recordSha256,
    selectionSha256: selection.recordSha256, sourceRevision: 'feature-commit', sourceManifestSha256: hash('feature-manifest'), reportSha256s: [hash('current-report')] });
  const decision = sealTrpRecord({ ...envelope('phase-risk-decision', 'decision-1'), agreementSha256: agreement.recordSha256,
    policyAuthoritySha256: policy.authoritySha256, issueId: 'baseline-test-A', category: 'known-test-failure', severity: 'noncritical',
    anchorObservationDigest: baseline.recordSha256, obligationId: 'unit-tests', transitions: ['prepare', 'generation-admission', 'draft-check', 'prepublish', 'publish', 'submit', 'approve', 'replay'],
    authorityRef: 'authority-1', authorizationRef: 'human-receipt-1', confirmationSha256: hash('reviewed-risk-plan'), reason: 'Existing failure A is bounded to the unchanged legacy module.',
    expiresAt: '2026-10-20T10:00:00Z', followUpOwner: 'team-maintainer', remediationRef: 'repair-issue-1', applicability: {
      carryForward: true, phaseIds: ['code', 'test', 'release'], dependencies, environmentSha256: trpEnvironmentDigest(environment), baselineSha256: baseline.recordSha256,
      acceptedFailures: [{ testId: 'test:A', semanticsSha256: hash('semantics-A'), causeSha256: hash('cause-A') }], allowedTestIds: ['test:A', 'test:B'],
      excludedTestIds: [], maxFailed: 1, commandSha256: baseline.commandSha256, selectorSha256: baseline.selectorSha256, maxObservationAgeSeconds: 86400 } });
  const verifyAuthority = (record, context) => ({ recordSha256: record.recordSha256, principal: record.issuer.principal,
    policyAuthoritySha256: policy.authoritySha256, confirmationSha256: record.confirmationSha256 ?? record.confirmedPlanSha256,
    capability: context.capability, transitions: record.transitions ?? [], issuedAt: record.createdAt, revokedAt: null, durable: true,
    authorizationRef: record.authorizationRef ?? 'agreement-receipt-1' });
  const verifyEvidence = (record) => ({ recordSha256: record.recordSha256, authenticated: true, reportsAvailable: true, verifiedAt: at });
  return { hash, envelope, at, subject, policy, agreement, selection, baseline, observation, decision, environment, dependencies,
    input: { policy, agreement, subject, operation: 'publish', mode: 'current', at, observations: [observation], baselines: [baseline], decisions: [decision], selection,
      candidateDependencies: dependencies, candidateEnvironment: environment, verifyAuthority, verifyEvidence } };
}
