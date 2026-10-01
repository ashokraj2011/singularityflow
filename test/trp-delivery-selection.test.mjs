import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeTrpDeliveryCommands, resolveTrpDeliverySelection, trpSelectionAuthorityContext, trpSelectionPublicPreview } from '../src/trp-delivery-selection.mjs';
import { sealTrpRecord, validateTrpRecord } from '../src/test-recovery-policy.mjs';
import { appendTrpRecord, trpAuthorityReview } from '../src/test-recovery-store.mjs';
import { canonicalJson } from '../src/records.mjs';
import { createTrpFixture } from './test-recovery-policy.fixture.mjs';
import { authorizeTrpRecord, TRP_TERMINAL_AVAILABLE } from './test-recovery-terminal.fixture.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-trp-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'test')); await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'test', 'changed.test.mjs'), "import test from 'node:test'; test('selected test executes', () => {});\n");
  await writeFile(path.join(root, 'test', 'other.test.mjs'), "import test from 'node:test'; test('unselected test must not execute', () => {});\n");
  await writeFile(path.join(root, 'src', 'service.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }));
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'TRP Tests']); git(root, ['config', 'user.email', 'trp@example.invalid']);
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  const baselineCommit = git(root, ['rev-parse', 'HEAD']);
  const core = createTrpFixture();
  const agreementPath = 'singularity/work-items/story-1/context/test-recovery/agreements/revision-1.json';
  await mkdir(path.dirname(path.join(root, agreementPath)), { recursive: true });
  await writeFile(path.join(root, agreementPath), JSON.stringify(core.agreement));
  const config = { workItemRoot: 'singularity/work-items', git: { publish: 'off' } };
  const workflow = { workItem: { id: 'story-1' }, resolution: { testRecovery: { enabled: true, riskAuthorities: ['reviewers'] },
    approvalAuthorities: { reviewers: { label: 'Reviewers', allowAnyGitIdentity: false, members: [{ email: 'trp@example.invalid' }] } } },
    testRecovery: { agreementPath, agreementSha256: core.agreement.recordSha256, validationEpoch: 1, selectionConfirmations: [] } };
  const phase = { id: 'code', generation: 0, qualityCommands: [] };
  const evidence = { baselineCommit, sourcePaths: [], testPaths: ['test/changed.test.mjs'], supportingTestPaths: [],
    changeSet: { entries: [{ status: 'modified', oldPath: 'test/changed.test.mjs', newPath: 'test/changed.test.mjs' }] } };
  const commands = [{ id: 'node-tests', kind: 'test', argv: ['node', '--test', '--test-reporter=tap', 'test'],
    workingDirectory: '.', affectedRoots: ['.'], modelPolicy: 'never', provenance: 'inferred',
    result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1, minimumPassed: 1 } }];
  const resolve = (options = {}) => resolveTrpDeliverySelection(root, config, workflow, phase, evidence, commands, options);
  return { root, core, config, workflow, phase, evidence, commands, resolve };
}

async function commitConfirmation(value, { fabricated = false } = {}) {
  const preview = (await value.resolve({ previewOnly: true })).preview;
  const planned = await value.resolve({ previewOnly: true, confirmation: preview.planDigest });
  const selection = sealTrpRecord({ ...planned.selection, issuer: { principal: 'trp@example.invalid', channel: 'terminal' } });
  const authority = trpSelectionAuthorityContext(value.workflow, value.phase, value.core.agreement);
  const review = trpAuthorityReview(selection, authority.policy);
  let receipt = sealTrpRecord({ ...value.core.envelope('trp-authority-receipt', 'receipt-1', selection.subject), issuer: selection.issuer,
    authorizedRecordSha256: selection.recordSha256, policyAuthoritySha256: authority.policy.authoritySha256,
    confirmationSha256: selection.confirmationSha256, capability: 'trp-scope-confirmation', transitions: [], issuedAt: selection.createdAt,
    authorizationRef: 'receipt-1', authorityGroup: 'reviewers', assurance: 'configured-local-review', reviewPlanSha256: review.plan.planHash,
    reviewActionId: review.action.actionId, actionAuthorizationId: 'authorization-1', questionId: 'question-1', answerReceipt: 'answer-1',
    actor: { name: 'TRP Tests', email: 'trp@example.invalid', login: null } });
  const workRoot = path.join(value.root, 'singularity/work-items/story-1');
  if (fabricated) {
    await appendTrpRecord(workRoot, selection);
    const authDir = path.join(workRoot, 'context/test-recovery/authorizations'); await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, 'receipt-1.json'), canonicalJson(receipt));
  } else receipt = await authorizeTrpRecord(value.root, workRoot, selection, authority);
  git(value.root, ['add', '.']); git(value.root, ['commit', '-qm', 'Published selection review receipt']);
  const ref = ({ kind, id, recordSha256 }) => ({ kind, id, recordSha256 });
  value.workflow.testRecovery.selectionConfirmations.push({ planDigest: preview.planDigest, phaseId: 'code', generation: 1, validationEpoch: 1,
    selection: ref(selection), authorityReceipt: ref(receipt) });
  return preview;
}

test('production preview is read-only and supported selectors execute only the selected test file', async (t) => {
  const value = await fixture(t);
  const result = await value.resolve({ previewOnly: true });
  assert.equal(result.preview.ready, true);
  assert.equal(result.preview.inventoryComplete, false);
  assert.equal(result.preview.inventoryAssurance, 'test-source-files-only');
  assert.deepEqual(result.selection.selectedTestIds, []);
  assert.deepEqual(result.selection.selectedSuites, ['node-tests']);
  assert.ok(result.selection.uncoveredAreas.includes('test-case-inventory-not-enumerated'));
  assert.equal(result.reference, null);
  await assert.rejects(stat(path.join(value.root, 'singularity/work-items/story-1/context/test-recovery/selections')), { code: 'ENOENT' });
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const output = execFileSync(process.execPath, result.commands[0].argv.slice(1), { cwd: value.root, env: environment, encoding: 'utf8' });
  assert.match(output, /selected test executes/u);
  assert.doesNotMatch(output, /unselected test must not execute/u);
});

test('unknown precise runner cannot execute the hidden full suite until exact stored confirmation', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const value = await fixture(t); value.commands[0].argv = ['npm', 'test'];
  await assert.rejects(value.resolve(), (failure) => failure.code === 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED'
    && failure.details.preview.manifest.fullSuiteEquivalent === true);
  const preview = (await value.resolve({ previewOnly: true })).preview;
  await commitConfirmation(value);
  const confirmed = await value.resolve({ persist: true });
  assert.equal(confirmed.preview.ready, true);
  assert.equal(confirmed.selection.expansion, 'full-suite');
  assert.equal(confirmed.selection.confirmationSha256, preview.planDigest);
  validateTrpRecord(JSON.parse(await readFile(path.join(value.root, confirmed.reference.path), 'utf8')));
  value.evidence.generation = 1; value.phase.generation = 1;
  assert.equal((await value.resolve()).preview.planDigest, preview.planDigest, 'publication of the same candidate does not change consent');
  await writeFile(path.join(value.root, 'test', 'changed.test.mjs'), "import test from 'node:test'; test('changed after consent', () => {});\n");
  await assert.rejects(value.resolve(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
});

test('ambient PYTEST_ADDOPTS cannot silently widen a claimed precise file selection', async (t) => {
  const previous = process.env.PYTEST_ADDOPTS;
  process.env.PYTEST_ADDOPTS = 'test';
  t.after(() => { if (previous === undefined) delete process.env.PYTEST_ADDOPTS; else process.env.PYTEST_ADDOPTS = previous; });
  const value = await fixture(t);
  // Pytest prepends PYTEST_ADDOPTS/config addopts even when an explicit -- file selector follows.
  // Until that collection input is bound, preserve the declared command and disclose expansion.
  value.commands[0].argv = ['pytest', '--junitxml=.sflow/results/pytest.xml', 'test'];
  value.commands[0].result = { adapter: 'junit-xml', path: '.sflow/results/pytest.xml', minimumDiscovered: 1, minimumPassed: 1 };
  const preview = (await value.resolve({ previewOnly: true })).preview;
  assert.equal(preview.ready, false);
  assert.equal(preview.manifest.fullSuiteEquivalent, true);
  assert.deepEqual(preview.requiredConfirmation, ['full-suite-expansion']);
  assert.deepEqual(preview.commands[0].argv, value.commands[0].argv);
  await assert.rejects(value.resolve({ persist: true }), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
});

test('inherited NODE_OPTIONS cannot preload tests outside a sealed Node or Jest cohort', async (t) => {
  const value = await fixture(t);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--import=data:text/javascript,import%20test%20from%20%22node%3Atest%22%3Btest%28%22ambient-extra%22%2C%28%29%3D%3E%7B%7D%29';
  t.after(() => { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; });
  for (const argv of [['node', '--test'], ['jest', '--json'], ['npm', 'test']]) {
    value.commands[0].argv = argv;
    await assert.rejects(value.resolve({ previewOnly: true }), { code: 'TRP_TEST_RUNNER_ENVIRONMENT_UNQUALIFIED' });
    await assert.rejects(value.resolve({ persist: true }), { code: 'TRP_TEST_RUNNER_ENVIRONMENT_UNQUALIFIED' });
  }
  await assert.rejects(stat(path.join(value.root, 'singularity/work-items/story-1/context/test-recovery/selections')), { code: 'ENOENT' });
});

test('changed source expands to the disclosed module and command changes invalidate confirmation', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const value = await fixture(t);
  value.evidence.sourcePaths.push('src/service.mjs');
  value.evidence.changeSet.entries.push({ status: 'modified', oldPath: 'src/service.mjs', newPath: 'src/service.mjs' });
  const preview = (await value.resolve({ previewOnly: true })).preview;
  assert.equal(preview.manifest.fullSuiteEquivalent, true);
  await commitConfirmation(value);
  assert.equal((await value.resolve()).preview.ready, true);
  value.commands[0].argv.push('--no-warnings');
  await assert.rejects(value.resolve(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
});

test('plain workflow confirmation fields and direct digest arguments are not human authority', async (t) => {
  const value = await fixture(t); value.commands[0].argv = ['npm', 'test'];
  const preview = (await value.resolve({ previewOnly: true })).preview;
  value.workflow.testRecovery.selectionConfirmations.push({ planDigest: preview.planDigest, phaseId: 'code', generation: 1, validationEpoch: 1 });
  await assert.rejects(value.resolve({ confirmation: preview.planDigest, persist: true }), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
  assert.equal((await value.resolve({ previewOnly: true, confirmation: preview.planDigest })).preview.ready, true);
  await assert.rejects(stat(path.join(value.root, 'singularity/work-items/story-1/context/test-recovery/selections')), { code: 'ENOENT' });
});

test('uncommitted tampering and authority removal invalidate durable scope confirmation', { skip: !TRP_TERMINAL_AVAILABLE }, async (t) => {
  const value = await fixture(t); value.commands[0].argv = ['npm', 'test'];
  await commitConfirmation(value);
  assert.equal((await value.resolve()).authorityVerified, true);
  value.workflow.resolution.approvalAuthorities.reviewers.members = [];
  await assert.rejects(value.resolve(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
  value.workflow.resolution.approvalAuthorities.reviewers.members = [{ email: 'trp@example.invalid' }];
  const saved = value.workflow.testRecovery.selectionConfirmations[0];
  saved.authorityReceipt.recordSha256 = value.core.hash('tampered');
  await assert.rejects(value.resolve(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
});

test('a fabricated authority receipt cannot authorize scope even when exact bytes are committed', async (t) => {
  const value = await fixture(t); value.commands[0].argv = ['npm', 'test'];
  await commitConfirmation(value, { fabricated: true });
  await assert.rejects(value.resolve(), { code: 'TRP_TEST_SELECTION_CONFIRMATION_REQUIRED' });
  assert.equal((await value.resolve({ previewOnly: true })).authorityVerified, false);
});

test('public previews redact secret argv without changing the bound execution arguments', async (t) => {
  const value = await fixture(t); value.commands[0].argv = ['npm', 'test', '--password', 'a-private-value'];
  const result = await value.resolve({ previewOnly: true });
  assert.equal(result.preview.commands[0].argv.at(-1), 'a-private-value');
  assert.doesNotMatch(JSON.stringify(trpSelectionPublicPreview(result.preview)), /a-private-value/u);
  assert.doesNotMatch(JSON.stringify(result.selection), /a-private-value/u);
  delete value.commands[0].id;
  await assert.rejects(value.resolve({ previewOnly: true }), { code: 'TRP_TEST_COMMAND_ID_REQUIRED' });
});

test('all configured mode preserves all supplied test contracts and ordinary non-test commands', async (t) => {
  const value = await fixture(t);
  const agreement = structuredClone(value.core.agreement);
  agreement.repositories[0].execution.mode = 'all-configured';
  const sealed = sealTrpRecord(agreement);
  value.workflow.testRecovery.agreementSha256 = sealed.recordSha256;
  await writeFile(path.join(value.root, value.workflow.testRecovery.agreementPath), JSON.stringify(sealed));
  value.commands.push({ ...value.commands[0], id: 'other-tests', argv: ['node', '--test', 'test/other.test.mjs'] });
  const lint = { id: 'lint', kind: 'quality', argv: ['node', '--check', 'src/service.mjs'] };
  value.commands.unshift(lint);
  const result = await value.resolve();
  assert.equal(result.commands.length, 3);
  assert.equal(result.commands[0], lint);
  assert.equal(result.selection.effectiveMode, 'all-configured');
  assert.equal(result.preview.manifest.baselineCoverage.status, 'unknown');
});

test('missing, tampered and cross-Story agreements block before command execution', async (t) => {
  const value = await fixture(t);
  value.workflow.testRecovery.agreementSha256 = value.core.hash('tampered');
  await assert.rejects(value.resolve(), { code: 'TRP_AGREEMENT_INVALID' });
  value.workflow.testRecovery.agreementPath = 'another-story/revision-1.json';
  await assert.rejects(value.resolve(), { code: 'TRP_AGREEMENT_INVALID' });
  delete value.workflow.testRecovery;
  await assert.rejects(value.resolve(), { code: 'TRP_AGREEMENT_REQUIRED' });
});

test('legacy workflows preserve original command identity without imposing a new policy', async (t) => {
  const value = await fixture(t); delete value.workflow.testRecovery; delete value.workflow.resolution.testRecovery;
  value.commands.unshift('npm test');
  value.phase.qualityCommands = [...value.commands];
  const result = await value.resolve();
  assert.equal(result.commands, value.commands);
  assert.equal(result.preview, null);
});

test('TRP rejects recognized legacy test runners outside the structured cohort before persistence', async (t) => {
  const value = await fixture(t);
  for (const legacy of ['npm test', ['node', '--test'], { id: 'legacy-pytest', argv: ['pytest'], modelPolicy: 'never' }]) {
    // Publication filters its input to structured tests, so the pinned phase must also be checked.
    value.phase.qualityCommands = [legacy, ...value.commands];
    await assert.rejects(value.resolve({ persist: true }), { code: 'TRP_TEST_COMMAND_CONTRACT_REQUIRED' });
    value.phase.qualityCommands = [];
    // Submission supplies all resolved commands, including any unclassified runner.
    await assert.rejects(resolveTrpDeliverySelection(value.root, value.config, value.workflow, value.phase,
      value.evidence, [legacy, ...value.commands], { persist: true }), { code: 'TRP_TEST_COMMAND_CONTRACT_REQUIRED' });
  }
  await assert.rejects(stat(path.join(value.root, 'singularity/work-items/story-1/context/test-recovery/selections')), { code: 'ENOENT' });
});

test('raw CLI and state-normalized contracts produce the same exact selection plan', async (t) => {
  const value = await fixture(t);
  value.phase.qualityCommands = structuredClone(value.commands);
  const raw = await value.resolve({ previewOnly: true });
  const normalized = normalizeTrpDeliveryCommands(value.workflow, value.phase, value.commands);
  const state = await resolveTrpDeliverySelection(value.root, value.config, value.workflow, value.phase,
    value.evidence, normalized, { previewOnly: true });
  assert.equal(raw.preview.planDigest, state.preview.planDigest);
  assert.equal(raw.commands[0].provenance, 'configured');
});

test('scope authority is pinned and cannot reduce the phase approval quorum', async (t) => {
  const value = await fixture(t); value.workflow.resolution.testRecovery.riskAuthorities = [];
  value.phase.approvalPolicy = { authorities: ['attacker'], minimum: 1 };
  value.workflow.resolution.phases = [{ id: 'code', approvalPolicy: { authorities: ['reviewers', 'security'],
    requiredAuthorities: ['security'], minimum: 1 } }];
  assert.deepEqual(trpSelectionAuthorityContext(value.workflow, value.phase, value.core.agreement).delegation.authorities, ['security']);
  value.workflow.resolution.phases[0].approvalPolicy.minimum = 2;
  assert.throws(() => trpSelectionAuthorityContext(value.workflow, value.phase, value.core.agreement), { code: 'TRP_AUTHORITY_REQUIRED' });
});

test('unknown local repository in a multi-repository agreement requires an explicit binding', async (t) => {
  const value = await fixture(t);
  const agreement = structuredClone(value.core.agreement);
  agreement.repositories.push({ ...agreement.repositories[0], repositoryId: 'other' });
  const sealed = sealTrpRecord(agreement);
  value.workflow.testRecovery.agreementSha256 = sealed.recordSha256;
  await writeFile(path.join(value.root, value.workflow.testRecovery.agreementPath), JSON.stringify(sealed));
  await assert.rejects(value.resolve(), { code: 'TRP_REPOSITORY_REQUIRED' });
  assert.equal((await value.resolve({ repositoryId: 'service' })).preview.ready, true);
});
