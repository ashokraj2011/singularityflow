import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTestRecoveryPolicy, previewTestRecoveryIntake, testRecoveryChoices,
  confirmTestRecoveryIntake, applyTestRecoveryAdmission, initialTestRecoveryAgreement
} from '../src/test-recovery-intake.mjs';
import { validateTrpRecord } from '../src/test-recovery-policy.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

const base = 'a'.repeat(40);
function fixture(overrides = {}) {
  return {
    definition: { testRecovery: { enabled: true } }, workId: 'story-1', workType: 'custom',
    phaseDefinitions: [{ id: 'build', generationPolicy: { task: 'code' } }],
    repositories: [{ id: 'service', baseCommit: base }],
    repositoryReadiness: { repositories: { service: { sourceCommit: base, status: 'pass',
      receiptSha256: `sha256:${'b'.repeat(64)}`, scope: 'dependency-test',
      structuredTestContract: { commands: [{ id: 'unit', launcher: 'node', adapter: 'node-tap', workingDirectory: '.', reportPath: '.sflow/results/unit.tap' }] }
    } } }, ...overrides
  };
}

test('TRP is explicit opt-in and does not acquire tests for document-only workflows', () => {
  assert.equal(normalizeTestRecoveryPolicy(undefined), null);
  assert.equal(previewTestRecoveryIntake(fixture({ definition: {} })).enabled, false);
  assert.equal(previewTestRecoveryIntake(fixture({ phaseDefinitions: [{ id: 'write', generationPolicy: { task: 'document' } }] })).enabled, false);
  assert.equal(previewTestRecoveryIntake(fixture()).enabled, true);
});

test('configuration rejects unknown keys, risky coercions and unsupported production waiver/reuse activation', () => {
  for (const value of [true, { enabled: 'true' }, { enabled: true, typo: true },
    { enabled: true, maxRiskDays: 31 }, { enabled: true, maxDistinctAutomaticAttempts: 4 },
    { enabled: true, allowEvidenceReuse: 'true' }, { enabled: true, riskAuthorities: ['a', 'a'] }]) {
    assert.throws(() => normalizeTestRecoveryPolicy(value), { code: 'TRP_POLICY_INVALID' });
  }
  assert.throws(() => normalizeTestRecoveryPolicy({ enabled: true, allowEvidenceReuse: true }), { code: 'TRP_EVIDENCE_REUSE_UNAVAILABLE' });
  assert.throws(() => normalizeTestRecoveryPolicy({ enabled: true, enabledRiskCategories: ['known-test-failure'], riskAuthorities: ['owner'] }), { code: 'TRP_RISK_ADAPTER_UNAVAILABLE' });
});

test('legacy test commands cannot hide an unselected full run in any phase', () => {
  for (const command of ['npm test', { argv: ['node', '--test'] }]) {
    for (const task of ['code', 'document']) {
      const phaseDefinitions = [{ id: 'verify', generationPolicy: { task }, qualityCommands: [command] }];
      const preview = previewTestRecoveryIntake(fixture({ phaseDefinitions }));
      assert.equal(preview.enabled, true);
      assert.equal(preview.ready, false);
      assert.match(preview.blockers.join(' '), /structured test commands/u);
      if (task === 'document') assert.match(preview.blockers.join(' '), /outside code-delivery phases/u);
      const all = previewTestRecoveryIntake(fixture({ phaseDefinitions, choices: { executionMode: 'all-configured' } }));
      assert.equal(all.ready, false, 'structured evidence is still required for explicit all-tests mode');
    }
  }
});

test('display defaults do not constitute confirmation, and both independent choices are bound', () => {
  const preview = previewTestRecoveryIntake(fixture());
  assert.equal(preview.maturity, 'repair-selection-pilot');
  assert.throws(() => confirmTestRecoveryIntake(preview, preview.planDigest), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
  const options = { 'test-baseline-disposition': 'fix', 'test-execution-mode': 'changed-and-affected', 'test-baseline-scope': 'reuse' };
  assert.equal(confirmTestRecoveryIntake(preview, preview.planDigest, options), preview);
  const all = previewTestRecoveryIntake(fixture({ choices: testRecoveryChoices({ 'test-execution-mode': 'all-configured' }) }));
  assert.notEqual(all.planDigest, preview.planDigest);
  assert.throws(() => confirmTestRecoveryIntake(all, preview.planDigest, options), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
});

test('base, workflow, command contract and baseline evidence invalidate stale confirmation', () => {
  const preview = previewTestRecoveryIntake(fixture());
  const options = { 'test-baseline-disposition': 'fix', 'test-execution-mode': 'changed-and-affected', 'test-baseline-scope': 'reuse' };
  const edits = [input => input.repositories[0].baseCommit = 'c'.repeat(40),
    input => input.workType = 'different', input => input.phaseDefinitions[0].qualityCommands = ['node --test'],
    input => input.definition.approvalAuthorities = { owner: { members: [] } },
    input => input.repositoryReadiness.repositories.service.receiptSha256 = `sha256:${'d'.repeat(64)}`,
    input => input.repositoryReadiness.repositories.service.structuredTestContract.commands[0].adapter = 'junit-xml'];
  for (const edit of edits) {
    const input = fixture(); edit(input);
    assert.throws(() => confirmTestRecoveryIntake(previewTestRecoveryIntake(input), preview.planDigest, options), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
  }
});

test('missing/stale baseline is honestly unknown and cannot activate known-failure acceptance', () => {
  const input = fixture(); input.repositoryReadiness.repositories.service.sourceCommit = 'e'.repeat(40);
  const preview = previewTestRecoveryIntake(input);
  assert.equal(preview.repositories[0].baselineStatus, 'unknown');
  assert.equal(preview.route, 'readiness-repair');
  assert.equal(preview.repositories[0].tools.length, 0);
  assert.equal(preview.acceptKnownFailuresEligible, false);
  const known = previewTestRecoveryIntake(fixture({ choices: { baselineDisposition: 'accept-known-failures' } }));
  assert.equal(known.ready, false);
  assert.throws(() => confirmTestRecoveryIntake(known, known.planDigest, { 'test-baseline-disposition': 'accept-known-failures', 'test-execution-mode': 'changed-and-affected', 'test-baseline-scope': 'reuse' }), { code: 'TRP_INTAKE_CONFIRMATION_REQUIRED' });
});

test('baseline acquisition never runs from preview, missing exact bases block', () => {
  for (const baselineScope of ['targeted', 'all-configured']) {
    const preview = previewTestRecoveryIntake(fixture({ choices: { baselineScope } }));
    assert.equal(preview.ready, false);
    assert.deepEqual(preview.repositories[0].commands, []);
  }
  assert.equal(previewTestRecoveryIntake(fixture({ repositories: [] })).ready, false);
  assert.equal(previewTestRecoveryIntake(fixture({ repositories: [{ id: 'service', baseCommit: 'main' }] })).ready, false);
});

test('repair admission substitutes only readiness and leaves all independent security blockers', () => {
  const preview = previewTestRecoveryIntake(fixture());
  const readiness = { checks: [
    { status: 'block', code: 'STORY_REPOSITORY_READINESS_REQUIRED' },
    { status: 'block', code: 'REMOTE_AUTH_REQUIRED' },
    { status: 'pass', code: 'CONFIGURATION_VALID' }
  ] };
  const result = applyTestRecoveryAdmission(readiness, preview);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(check => check.code), ['REMOTE_AUTH_REQUIRED']);
  assert.deepEqual(result.warnings.map(check => check.code), ['TRP_READINESS_REPAIR_REQUIRED']);
  assert.equal(readiness.checks[0].status, 'block');
  assert.equal(applyTestRecoveryAdmission(readiness, null), readiness);
});

test('initial agreement is sealed, has no risk decisions, and records independent execution mode', () => {
  const agreement = initialTestRecoveryAgreement(previewTestRecoveryIntake(fixture({ choices: { executionMode: 'all-configured' } })), {
    workId: 'story-1', principal: 'owner@example.invalid', createdAt: '2026-10-02T12:00:00Z', phaseIds: ['build']
  });
  validateTrpRecord(agreement);
  assert.equal(agreement.repositories[0].baselineDisposition, 'fix');
  assert.equal(agreement.repositories[0].execution.mode, 'all-configured');
  assert.deepEqual(agreement.repositories[0].riskDecisionRefs, []);
  assert.equal(agreement.repositories[0].execution.fullSuiteExpansion, 'confirm');
});

test('legacy Stories cannot gain consent from new CLI flags', () => {
  assert.equal(confirmTestRecoveryIntake({ enabled: false }, null), null);
  assert.throws(() => confirmTestRecoveryIntake({ enabled: false }, 'digest', { 'test-policy-confirm': 'digest' }), { code: 'TRP_NOT_ENABLED' });
});

test('TRP CLI operations classify plans as read-only and confirmations/execution as mutation', () => {
  for (const action of ['show', 'plan']) {
    assert.equal(resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', action] }).classification, 'read');
  }
  assert.equal(resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', 'repair'] }).classification, 'read');
  for (const [action, options] of [['confirm', {}], ['repair', { run: true }]]) {
    assert.equal(resolveOperation({ requestedCommand: 'story', positionals: ['story', 'test-policy', action], options }).classification, 'mutation');
  }
});
