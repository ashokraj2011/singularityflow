import assert from 'node:assert/strict';
import test from 'node:test';

import { recordSha256 } from '../src/records.mjs';
import {
  assessTestBaselineCoverage, compareSelectedTestObservations, evaluateReadinessRepairAdmission,
  normalizeTestSelectionPath, planTestSelection, selectTestCommandFiles, testSelectorCapabilities
} from '../src/test-selection-policy.mjs';
import { projectReadinessTestIdentities } from '../src/initialization/runtime-readiness.mjs';

const hash = (value) => `sha256:${recordSha256(value)}`;
const semantics = hash('assertion-source');
const definition = (id, moduleRoot, extra = {}) => ({
  id, path: `${moduleRoot}/${id}.test.mjs`, moduleRoot, commandId: `${moduleRoot}-tests`,
  semanticsSha256: semantics, sourcePaths: [], ...extra
});
const command = (moduleRoot, extra = {}) => ({
  id: `${moduleRoot}-tests`, kind: 'test', argv: ['node', '--test', '--test-reporter=junit', 'test'],
  workingDirectory: moduleRoot, affectedRoots: [moduleRoot],
  result: { adapter: 'junit-xml', path: '.sflow/results/tests.xml', minimumDiscovered: 1 }, ...extra
});
function input(extra = {}) {
  return {
    agreement: { schemaVersion: 1, workId: 'story', agreementSha256: hash('policy'), repositories: [{
      repositoryId: 'repo', execution: { mode: 'changed-and-affected', moduleExpansion: 'confirm', fullSuiteExpansion: 'confirm' }
    }] }, repositoryId: 'repo', commands: [command('api'), command('web')],
    candidate: { baseCommit: 'a'.repeat(40), baseTree: 'b'.repeat(40), sourceManifestSha256: hash('source'),
      generation: 'generation-1', validationEpoch: 1, delta: [{ status: 'modified', path: 'api/a.test.mjs' }] },
    bindings: { dependencyManifestSha256: hash('dependencies'), environmentSha256: hash('environment'), runnerSha256: hash('runner'), adapterSha256: hash('adapter') },
    testInventory: [definition('a', 'api'), definition('regression', 'api'), definition('b', 'web')],
    inventoryComplete: true, ...extra
  };
}
function policy(value, fields) { Object.assign(value.agreement.repositories[0].execution, fields); return value; }

test('changed test preview uses literal supported selectors and never reports a pass', () => {
  const value = input(); const original = structuredClone(value);
  const plan = planTestSelection(value);
  assert.deepEqual(value, original, 'preview cannot mutate its inputs');
  assert.equal(plan.ready, true);
  assert.equal(plan.observedOutcome, 'not-run');
  assert.deepEqual(plan.commands[0].argv, ['node', '--test', '--test-reporter=junit', '--', './a.test.mjs']);
  assert.equal(plan.commands.length, 1);
  assert.deepEqual(plan.manifest.selectedTests.map((entry) => entry.id), ['a']);
  assert.ok(plan.manifest.selectedTests[0].reasons.includes('changed-test:api/a.test.mjs'));
  assert.equal(plan.manifest.baselineCoverage.status, 'unknown');
});

test('source and requirement mappings select regression tests and declared failure sentinels', () => {
  const value = input();
  value.candidate.delta = [{ path: 'api/service.mjs' }];
  value.testInventory[1].sourcePaths = ['api/service.mjs'];
  value.testInventory[2].requirementIds = ['AC-1'];
  value.impact = { requirementIds: ['AC-1'] };
  value.agreement.repositories[0].knownFailureSentinelIds = ['a'];
  const plan = planTestSelection(value);
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.manifest.selectedTests.map((entry) => entry.id), ['a', 'b', 'regression']);
  assert.equal(plan.manifest.expansions.length, 0);
  assert.equal(plan.manifest.fullSuiteEquivalent, true);
  assert.deepEqual(plan.requiredConfirmation, ['full-suite-expansion']);
  assert.equal(planTestSelection({ ...value, confirmation: plan.planDigest }).ready, true);
});

test('a file selector records every case in the selected file', () => {
  const value = input();
  value.testInventory.push(definition('another-case', 'api', { path: 'api/a.test.mjs' }));
  const plan = planTestSelection(value);
  assert.deepEqual(plan.manifest.selectedTests.map((entry) => entry.id), ['a', 'another-case']);
  assert.deepEqual(plan.commands[0].argv.slice(-2), ['--', './a.test.mjs']);
});

test('module fallback pauses for exact confirmation and changed candidates invalidate it', () => {
  const value = input(); value.candidate.delta = [{ path: 'api/service.mjs' }];
  const preview = planTestSelection(value);
  assert.equal(preview.ready, false);
  assert.deepEqual(preview.requiredConfirmation, ['module-expansion']);
  assert.equal(preview.manifest.fullSuiteEquivalent, false);
  assert.deepEqual(preview.manifest.selectedTests.map((entry) => entry.id), ['a', 'regression']);
  assert.equal(planTestSelection({ ...value, confirmation: preview.planDigest }).ready, true);
  const changed = structuredClone(value); changed.candidate.generation = 'generation-2';
  assert.ok(planTestSelection({ ...changed, confirmation: preview.planDigest }).blockers.some((entry) => entry.code === 'TEST_SELECTION_CONFIRMATION_STALE'));
  changed.candidate = value.candidate; changed.commands[0].argv.push('--no-warnings');
  assert.notEqual(planTestSelection(changed).planDigest, preview.planDigest);
});

test('a single module equivalent to all tests needs the separate full-suite consent', () => {
  const value = input({ commands: [command('api', { argv: ['npm', 'test'] })], testInventory: [definition('a', 'api')] });
  policy(value, { moduleExpansion: 'allow' });
  const preview = planTestSelection(value);
  assert.equal(preview.manifest.fullSuiteEquivalent, true);
  assert.equal(preview.manifest.effectiveMode, 'all');
  assert.match(preview.manifest.scopeLabel, /full configured suite/u);
  assert.deepEqual(preview.requiredConfirmation, ['full-suite-expansion']);
  assert.equal(preview.ready, false);
  assert.equal(planTestSelection({ ...value, confirmation: preview.planDigest }).ready, true);
  policy(value, { fullSuiteExpansion: 'deny' });
  assert.ok(planTestSelection(value).blockers.some((entry) => entry.code === 'TEST_EXPANSION_DENIED'));
});

test('precise test-only selection of the complete approved cohort exposes actionable full-suite consent', () => {
  const value = input({ commands: [command('api')], testInventory: [
    definition('a', 'api'), definition('same-file-case', 'api', { path: 'api/a.test.mjs' })
  ] });
  policy(value, { moduleExpansion: 'allow' });
  const original = structuredClone(value);
  const preview = planTestSelection(value);
  assert.deepEqual(value, original);
  assert.equal(preview.commands[0].selectionAdapter, 'node-test-files');
  assert.deepEqual(preview.commands[0].argv.slice(-2), ['--', './a.test.mjs']);
  assert.deepEqual(preview.manifest.expansions, []);
  assert.equal(preview.manifest.fullSuiteEquivalent, true);
  assert.equal(preview.manifest.effectiveMode, 'all');
  assert.match(preview.manifest.scopeLabel, /full configured suite/u);
  assert.deepEqual(preview.requiredConfirmation, ['full-suite-expansion']);
  assert.equal(preview.ready, false);
  assert.equal(preview.observedOutcome, 'not-run');
  assert.equal(preview.manifest.baselineCoverage.status, 'unknown', 'complete inventory is not baseline evidence');
  assert.ok(preview.blockers.some(entry => entry.code === 'TEST_SELECTION_CONFIRMATION_REQUIRED'));
  const confirmed = planTestSelection({ ...value, confirmation: preview.planDigest });
  assert.equal(confirmed.ready, true);
  assert.equal(confirmed.planDigest, preview.planDigest);
  const changed = structuredClone(value);
  changed.testInventory[0].semanticsSha256 = hash('changed-assertion-source');
  assert.ok(planTestSelection({ ...changed, confirmation: preview.planDigest }).blockers
    .some(entry => entry.code === 'TEST_SELECTION_CONFIRMATION_STALE'));
  policy(value, { fullSuiteExpansion: 'deny' });
  assert.ok(planTestSelection(value).blockers.some(entry => entry.code === 'TEST_EXPANSION_DENIED'));
});

test('partial and unqualified inventories cannot label precise selection as the full suite', () => {
  for (const inventoryComplete of [false, undefined, 'true']) {
    const value = input({ commands: [command('api')], testInventory: [definition('a', 'api')], inventoryComplete });
    const preview = planTestSelection(value);
    assert.equal(preview.manifest.fullSuiteEquivalent, false, String(inventoryComplete));
    assert.equal(preview.manifest.effectiveMode, 'changed-and-affected');
    assert.deepEqual(preview.requiredConfirmation, []);
  }
  const partial = planTestSelection(input());
  assert.equal(partial.manifest.inventoryComplete, true);
  assert.equal(partial.manifest.fullSuiteEquivalent, false, 'a verified but incompletely selected cohort is not the full suite');
  assert.deepEqual(partial.requiredConfirmation, []);
});

test('explicit all-configured scope does not require expansion confirmation for precise cohort coverage', () => {
  const value = policy(input({ commands: [command('api')], testInventory: [definition('a', 'api')] }),
    { mode: 'all-configured', fullSuiteExpansion: 'deny' });
  const preview = planTestSelection(value);
  assert.equal(preview.ready, true);
  assert.equal(preview.manifest.effectiveMode, 'all');
  assert.equal(preview.manifest.fullSuiteEquivalent, false);
  assert.deepEqual(preview.requiredConfirmation, []);
});

test('all configured mode selects every configured test command and exposes partial baseline', () => {
  const value = policy(input(), { mode: 'all' });
  const preview = planTestSelection(value);
  const baseline = { authenticated: true, identitiesComplete: true, bindings: preview.manifest.bindings,
    baselineSha256: hash('baseline'), tests: [{ ...value.testInventory[0], outcome: 'passed' }] };
  const plan = planTestSelection({ ...value, baseline });
  assert.equal(plan.commands.length, 2);
  assert.equal(plan.manifest.baselineCoverage.status, 'partial');
  assert.deepEqual(plan.manifest.baselineCoverage.unknownTestIds, ['b', 'regression']);
  assert.equal(plan.manifest.baselineCoverage.preexistingFailureClassificationComplete, false);
});

test('empty or unmapped affected cohort cannot be mistaken for passing validation', () => {
  const value = input(); value.candidate.delta = [];
  assert.ok(planTestSelection(value).blockers.some((entry) => entry.code === 'TEST_SELECTION_EMPTY'));
  value.candidate.delta = [{ path: 'outside/source.mjs' }];
  const plan = planTestSelection(value);
  assert.ok(plan.blockers.some((entry) => entry.code === 'TEST_IMPACT_UNCOVERED'));
  assert.equal(plan.ready, false);
  value.impact = { complete: false };
  assert.ok(planTestSelection(value).blockers.some((entry) => entry.code === 'TEST_IMPACT_INCOMPLETE'));
});

test('deleted and renamed paths retain both endpoints in visible impact scope', () => {
  const value = input();
  value.candidate.delta = [{ status: 'renamed', path: 'web/moved.mjs', oldPath: 'api/old.mjs' }, { status: 'deleted', path: 'api/removed.mjs' }];
  const plan = planTestSelection(value);
  assert.equal(plan.commands.length, 2);
  assert.equal(plan.manifest.fullSuiteEquivalent, true);
  assert.ok(plan.manifest.expansions[0].reasons.includes('affected-module:api/old.mjs'));
});

test('unsupported selectors cannot be inferred from a report adapter or package script', () => {
  assert.equal(testSelectorCapabilities(command('api', { argv: ['npm', 'test', '--', '--json'], result: { adapter: 'jest-json' } })).fileSelection, false);
  const value = input(); value.commands[0].argv.push('--test-name-pattern', 'filtered');
  const plan = planTestSelection(value);
  assert.equal(plan.commands[0].selectionAdapter, 'module-suite');
  assert.equal(plan.ready, false);
});

test('explicit Node preload hooks cannot claim a precise file-only cohort', () => {
  for (const option of ['--import', '--require', '-r', '--loader']) {
    const value = input(); value.commands[0].argv.push(option, './test-bootstrap.mjs');
    const plan = planTestSelection(value);
    assert.equal(plan.commands[0].selectionAdapter, 'module-suite', option);
    assert.deepEqual(plan.requiredConfirmation, ['module-expansion'], option);
    assert.equal(plan.ready, false, option);
  }
});

test('pytest precise selection stays unavailable across native and virtualenv launchers', () => {
  const python = command('api', { argv: ['.venv\\Scripts\\python.exe', '-B', '-m', 'pytest', '-p', 'no:cacheprovider', '--junitxml=report.xml', 'tests'] });
  assert.equal(selectTestCommandFiles(python, ['api\\test service.py']), null);
  const mac = command('api', { argv: ['./.venv/bin/python', '-m', 'pytest', '-q'] });
  for (const argv of [mac.argv, ['pytest', '-q'], ['py.test'], ['py', '-3', '-m', 'pytest']]) {
    const capability = testSelectorCapabilities(command('api', { argv }));
    assert.equal(capability.fileSelection, false);
    assert.equal(capability.reason, 'pytest-collection-inputs-unbound');
  }
});

test('Jest direct selectors preserve reporter contracts and replace old selectors', () => {
  const jest = command('api', { argv: ['jest.cmd', '--json', '--outputFile', 'report.json', 'tests'] });
  assert.deepEqual(selectTestCommandFiles(jest, ['api/a.test.mjs']).argv,
    ['jest.cmd', '--json', '--outputFile', 'report.json', '--runTestsByPath', '--', './a.test.mjs']);
});

test('Windows separators normalize, case remains exact, and drive/UNC/escape paths reject', () => {
  assert.equal(normalizeTestSelectionPath('.\\api\\a.test.mjs'), 'api/a.test.mjs');
  assert.notEqual(normalizeTestSelectionPath('Api/a.test.mjs'), normalizeTestSelectionPath('api/a.test.mjs'));
  for (const candidate of ['C:\\repo\\test.py', 'C:relative.py', '\\\\host\\share\\test.py', '../test.py', 'api/../test.py', '/tmp/test.py', 'a\0b']) {
    assert.throws(() => normalizeTestSelectionPath(candidate), { code: 'TEST_SELECTION_INVALID' });
  }
  assert.throws(() => selectTestCommandFiles(command('api'), ['api/[a].test.mjs']), { code: 'TEST_SELECTION_INVALID' });
  assert.throws(() => selectTestCommandFiles(command('api'), ['web/a.test.mjs']), { code: 'TEST_SELECTION_INVALID' });
});

test('missing legacy scope and unknown authority-like expansion fields never infer consent', () => {
  const value = input(); delete value.agreement.repositories[0].execution.mode;
  assert.throws(() => planTestSelection(value), { code: 'TEST_SELECTION_INVALID' });
  policy(value, { mode: 'changed-and-affected', moduleExpansion: true });
  assert.throws(() => planTestSelection(value), { code: 'TEST_SELECTION_INVALID' });
});

test('known-failure exclusions are visible unexecuted outcomes and unavailable case support blocks', () => {
  const value = input(); value.agreement.repositories[0].exclusions = [{ testId: 'a', decisionRef: 'risk-1' }];
  const plan = planTestSelection(value);
  assert.equal(plan.manifest.exclusions[0].outcome, 'not-run-known-failure');
  assert.ok(plan.blockers.some((entry) => entry.code === 'TEST_EXCLUSION_UNSUPPORTED'));
});

test('a non-test workflow has no added execution obligation', () => {
  const plan = planTestSelection({ ...input(), applicable: false });
  assert.equal(plan.ready, true); assert.equal(plan.commands.length, 0);
  assert.equal(plan.manifest.effectiveMode, 'not-applicable');
  assert.equal(plan.observedOutcome, 'not-applicable');
});

test('baseline coverage requires exact immutable base, host, command and assertion bindings', () => {
  const value = input(); const preview = planTestSelection(value);
  const baseline = { authenticated: true, identitiesComplete: true, baselineSha256: hash('baseline'),
    bindings: preview.manifest.bindings, tests: [{ ...value.testInventory[0], outcome: 'failed' }] };
  const args = { baseline, bindings: preview.manifest.bindings, selectedTests: value.testInventory.slice(0, 1), inventoryComplete: true };
  assert.equal(assessTestBaselineCoverage(args).status, 'complete');
  for (const key of ['baseCommit', 'baseTree', 'sourceManifestSha256', 'dependencyManifestSha256', 'environmentSha256', 'runnerSha256', 'adapterSha256', 'commandInventorySha256']) {
    const result = assessTestBaselineCoverage({ ...args, bindings: { ...args.bindings, [key]: hash('different') } });
    assert.equal(result.status, 'unknown', key);
    assert.equal(result.preexistingFailureClassificationComplete, false, key);
  }
  assert.equal(assessTestBaselineCoverage({ ...args, baseline: { ...baseline, identitiesComplete: false } }).status, 'unknown');
  assert.equal(assessTestBaselineCoverage({ ...args, baseline: { ...baseline, authenticated: false } }).status, 'unknown');
  assert.equal(assessTestBaselineCoverage({ ...args, selectedTests: [{ ...args.selectedTests[0], semanticsSha256: hash('changed') }] }).status, 'unknown');
});

test('baseline identity incompleteness stays unknown even when selected failure names exist', () => {
  const value = input(); const plan = planTestSelection(value);
  const result = assessTestBaselineCoverage({
    baseline: { authenticated: true, identitiesComplete: true, bindings: plan.manifest.bindings, tests: [] },
    bindings: plan.manifest.bindings, inventoryComplete: false, selectedCommandIds: ['api-tests']
  });
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.unknownCommandIds, ['api-tests']);
  assert.equal(result.extensionBaseCommit, value.candidate.baseCommit);
});

test('failure matching distinguishes missing cases, new skips, changed assertions, and new failures', () => {
  const tests = ['a', 'b'].map((id) => ({ id, semanticsSha256: semantics }));
  const baseline = [{ ...tests[0], outcome: 'failed' }, { ...tests[1], outcome: 'passed' }];
  const repaired = compareSelectedTestObservations({ expectedTests: tests, baselineTests: baseline, currentTests: tests.map((entry) => ({ ...entry, outcome: 'passed' })) });
  assert.equal(repaired.comparable, true); assert.deepEqual(repaired.repairedTestIds, ['a']);
  const swapped = compareSelectedTestObservations({ expectedTests: tests, baselineTests: baseline, currentTests: [{ ...tests[0], outcome: 'passed' }, { ...tests[1], outcome: 'failed' }] });
  assert.deepEqual(swapped.newFailureIds, ['b']);
  for (const [currentTests, code] of [
    [[baseline[0]], 'TEST_EXPECTED_MISSING'],
    [[baseline[0], { ...baseline[1], outcome: 'skipped' }], 'TEST_NEW_SKIP'],
    [[{ ...baseline[0], semanticsSha256: hash('changed-assertions') }, baseline[1]], 'TEST_SEMANTICS_CHANGED_OR_UNKNOWN'],
    [[...baseline, baseline[0]], 'TEST_IDENTITY_AMBIGUOUS']
  ]) assert.ok(compareSelectedTestObservations({ expectedTests: tests, baselineTests: baseline, currentTests }).issues.some((entry) => entry.code === code));
});

function repairRepository(repositoryId = 'repo') {
  return { repositoryId, baselineDisposition: 'fix', agreementSha256: hash('policy'), originalBaseCommit: 'a'.repeat(40),
    baselineIssueIds: ['issue-A'], baseline: { authenticated: true, outcome: 'failed', identitiesComplete: true,
      baselineSha256: hash(`baseline-${repositoryId}`), tests: [{ id: 'A', semanticsSha256: semantics, outcome: 'failed' }] } };
}

test('failing baseline admits a test/document-only repair and blocks feature coding', () => {
  const result = evaluateReadinessRepairAdmission({ repositories: [repairRepository()] });
  assert.equal(result.mayRecordStory, true); assert.equal(result.mayStartFeature, false);
  assert.equal(result.purpose, 'readiness-repair');
  assert.equal(result.obligations[0].sourceEditRequired, false);
  assert.equal(result.obligations[0].featureAcceptanceTagsRequired, false);
  assert.deepEqual(result.obligations[0].issueIds, ['issue-A']);
});

test('repair checkpoint keeps original baseline and explicitly establishes feature base', () => {
  const repository = repairRepository();
  const checkpoint = { repositoryId: 'repo', authenticated: true, committed: true, commit: 'c'.repeat(40),
    originalBaselineSha256: repository.baseline.baselineSha256, originalBaseCommit: repository.originalBaseCommit,
    outcome: 'passed', processExitCode: 0, identitiesComplete: true, baselineSha256: hash('repaired'),
    tests: repository.baseline.tests.map((entry) => ({ ...entry, outcome: 'passed' })) };
  const result = evaluateReadinessRepairAdmission({ repositories: [repository], repairCheckpoints: [checkpoint] });
  assert.equal(result.mayStartFeature, true);
  assert.equal(result.featureBases[0].originalBaselineSha256, repository.baseline.baselineSha256);
  assert.equal(result.featureBases[0].featureBaseCommit, checkpoint.commit);
  for (const mutation of [{ processExitCode: 1 }, { committed: false }, { tests: [] }, { tests: [{ ...checkpoint.tests[0], outcome: 'skipped' }] }]) {
    assert.equal(evaluateReadinessRepairAdmission({ repositories: [repository], repairCheckpoints: [{ ...checkpoint, ...mutation }] }).mayStartFeature, false);
  }
});

test('a decision for one repository does not unblock another repository fix obligation', () => {
  const repositories = [repairRepository('repo'), repairRepository('other')];
  const authorization = { repositoryId: 'repo', verified: true, durable: true, agreementSha256: hash('policy'),
    baselineSha256: repositories[0].baseline.baselineSha256, permittedTransition: 'feature-coding' };
  const result = evaluateReadinessRepairAdmission({ repositories, dispositionAuthorizations: [authorization] });
  assert.equal(result.mayStartFeature, false);
  assert.deepEqual(result.blockers.map((entry) => entry.repositoryId), ['other']);
  assert.equal(evaluateReadinessRepairAdmission({ repositories: [repositories[0]], dispositionAuthorizations: [{ ...authorization, durable: false }] }).mayStartFeature, false);
});

test('unknown and missing baseline dispositions cannot become accepted known failures', () => {
  const repository = repairRepository(); repository.baseline = null;
  assert.equal(evaluateReadinessRepairAdmission({ repositories: [repository] }).mayStartFeature, false);
  repository.baselineDisposition = 'accept-known-failures';
  assert.ok(evaluateReadinessRepairAdmission({ repositories: [repository] }).blockers.some((entry) => entry.code === 'TEST_BASELINE_AUTHORIZATION_REQUIRED'));
  delete repository.baselineDisposition;
  assert.ok(evaluateReadinessRepairAdmission({ repositories: [repository] }).blockers.some((entry) => entry.code === 'TEST_BASELINE_DISPOSITION_REQUIRED'));
});

const occurrence = (name, outcome = 'passed') => ({ suite: 'Suite', className: 'Suite', name, fullName: null,
  ancestorTitles: [], identityStatus: 'observed-name-only', outcome });

test('readiness observations retain passing, failing and skipped identities without claiming source binding', () => {
  const result = projectReadinessTestIdentities('unit', 'junit-xml', [occurrence('pass'), occurrence('fail', 'failed'), occurrence('skip', 'skipped')], { discovered: 3, passed: 1, failed: 1, skipped: 1 });
  assert.equal(result.testIdentitiesComplete, true);
  assert.equal(result.semanticsBound, false);
  assert.equal(result.testCases.length, 3);
  assert.match(result.testCases[0].id, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(result.testCases[1].outcome, 'failed');
});

test('readiness identities disclose truncated, altered, ambiguous and count-only evidence', () => {
  const counts = { discovered: 2, passed: 2, failed: 0, skipped: 0 };
  for (const entries of [[occurrence('same'), occurrence('same')], [occurrence('a\nb'), occurrence('other')], []]) {
    assert.equal(projectReadinessTestIdentities('unit', 'junit-xml', entries, counts).testIdentitiesComplete, false);
  }
  const result = projectReadinessTestIdentities('unit', 'junit-xml', [occurrence('one'), occurrence('two')], counts, { maxCases: 1 });
  assert.equal(result.testCasesTruncated, true);
  assert.equal(result.testIdentitiesComplete, false);
  assert.equal(result.testCases.length, 1);
});
