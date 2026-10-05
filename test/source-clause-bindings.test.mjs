import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateCodeDeliveryPreflight, plannedSourceClauseBindings, verifyCodeDeliveryReceipt
} from '../src/delivery-evidence.mjs';
import { phaseDraftCheck } from '../src/phase-draft-check.mjs';
import { phasePrepublish } from '../src/phase-prepublish.mjs';
import { canonicalJson } from '../src/records.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';
import { beginCodeGeneration } from '../src/generation-boundary.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(claims, { clauses = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-clause-bindings-'));
  const workId = 'BIND-1';
  const relative = `singularity/work-items/${workId}/context/claims/planning-gen1-planned.json`;
  const record = {
    schemaVersion: 2, kind: 'planned', workId, phase: 'planning', generation: 1,
    recordedAt: '2026-09-29T00:00:00.000Z', claims
  };
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, relative), canonicalJson(record));
  // The specification index that defines every planned clause, as approving the plan's
  // specification step writes it; publication judges clause and criterion tags against it.
  const index = `singularity/work-items/${workId}/context/spec-indexes/planning-gen1.json`;
  await mkdir(path.dirname(path.join(root, index)), { recursive: true });
  await writeFile(path.join(root, index), canonicalJson({
    schemaVersion: 1, kind: 'specification-index', workId, phase: 'planning', generation: 1,
    clauses: [...new Set([...Object.keys(claims), ...clauses])].sort().map((id) => ({
      id, type: id.split(':').at(-1).split('-')[0], body: `${id} is approved.`,
      bodySha256: createHash('sha256').update(`${id} is approved.`).digest('hex'), source: { path: 'plan.md', line: 1 }
    }))
  }));
  const planning = {
    id: 'planning', generation: 1, claimMaps: { planned: {
      path: relative, generation: 1,
      sha256: createHash('sha256').update(canonicalJson(record)).digest('hex')
    } }
  };
  const phase = { id: 'implementation', sourceBoundary: 'unrestricted' };
  const workflow = {
    workItem: { id: workId }, phaseOrder: ['planning', 'implementation'],
    phases: { planning, implementation: phase },
    resolution: {
      codeDelivery: { traceability: { sourceBindings: 'enforce' } },
      plannedClaims: { mode: 'required', owners: { implementation: 'planning' } },
      spec: { mode: 'enforce', coverage: 'enforce', acceptance: 'presence' }
    }
  };
  const config = { workItemRoot: 'singularity/work-items' };
  return { root, config, workflow, phase, relative };
}

const planned = (expectedPaths, tests = ['tests/payment.test.js'], testDisposition = 'applicable') => ({
  expectedPaths, tests: testDisposition === 'not-applicable' ? [] : tests,
  testDisposition, testReason: testDisposition === 'not-applicable' ? 'No executable behavior is asserted by this clause.' : null,
  deviation: null
});

test('source-bound clauses require an exact qualified comment in a planned changed source path', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const source = path.join(item.root, 'src', 'payment.js');
  await writeFile(source, 'export const payment = true; // @clause:BIND-1:REQ-001\n');
  let result = await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']);
  assert.deepEqual(result.bindings, [], 'an inline string/code occurrence is not a source-comment witness');
  assert.deepEqual(result.missing.map((entry) => entry.clauseId), ['BIND-1:REQ-001']);

  await writeFile(source, '// @clause:REQ-001\nexport const payment = true;\n');
  result = await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']);
  assert.equal(result.missing.length, 1, 'bare IDs cannot satisfy a qualified governed clause');

  await writeFile(source, '// @clause:BIND-1:REQ-001\nexport const payment = true;\n');
  result = await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.bindings, [{
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: 1, tag: 'clause'
  }]);
  assert.deepEqual(result.required, [{ clauseId: 'BIND-1:REQ-001', expectedPaths: ['src/payment.js'] }]);
});

test('unplanned paths cannot satisfy a source-bound clause', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await writeFile(path.join(item.root, 'src', 'payment.js'), 'export const payment = true;\n');
  await writeFile(path.join(item.root, 'src', 'other.js'), '// @clause:BIND-1:REQ-001\n');
  const result = await plannedSourceClauseBindings(
    item.root, item.config, item.workflow, item.phase, ['src/payment.js', 'src/other.js']
  );
  assert.equal(result.missing.length, 1);
  assert.deepEqual(result.bindings, []);
});

test('an exact planned product-source deletion has an explicit non-comment binding', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const result = await plannedSourceClauseBindings(
    item.root, item.config, item.workflow, item.phase, ['src/payment.js'],
    { deletedSourcePaths: ['src/payment.js'] }
  );
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.bindings, [{
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: null, tag: 'deletion'
  }]);
  const unproven = await plannedSourceClauseBindings(
    item.root, item.config, item.workflow, item.phase, ['src/payment.js']
  );
  assert.equal(unproven.missing.length, 1, 'absence alone is not a reviewed deletion witness');
});

test('a source too large for immutable replay is refused before publication', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const source = path.join(item.root, 'src/payment.js');
  await writeFile(source, '// @clause:BIND-1:REQ-001\n');
  await truncate(source, 16 * 1024 * 1024);
  await assert.rejects(
    plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']),
    (error) => error.code === 'CODE_DELIVERY_SOURCE_BINDING_TOO_LARGE'
      && error.details?.path === 'src/payment.js'
  );
  await writeFile(source, '// @clause:BIND-1:REQ-001\nexport const payment = true;\n');
  const repaired = await plannedSourceClauseBindings(
    item.root, item.config, item.workflow, item.phase, ['src/payment.js']
  );
  assert.deepEqual(repaired.missing, []);
});

test('test-only and reviewed not-applicable claims have no source-comment duty', async (t) => {
  const item = await fixture({
    'BIND-1:AC-001': planned([]),
    'BIND-1:CON-001': planned(['src/payment.js'], [], 'not-applicable')
  });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const result = await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']);
  assert.deepEqual(result.required, []);
  assert.deepEqual(result.missing, []);
  item.phase.sourceBoundary = 'test-automation';
  const testOnly = await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, ['src/payment.js']);
  assert.equal(testOnly.mode, 'off');
});

test('legacy pinned and planned-claims opt-out code phases retain their existing behavior', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  delete item.workflow.resolution.codeDelivery.traceability.sourceBindings;
  assert.equal((await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, [])).mode,
    'off', 'a historical pinned Story with no source-binding field is not silently upgraded');
  item.workflow.resolution.codeDelivery.traceability.sourceBindings = 'off';
  assert.equal((await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, [])).mode, 'off');
  item.workflow.resolution.codeDelivery.traceability.sourceBindings = 'enforce';
  item.workflow.resolution.plannedClaims.mode = 'opt-out';
  assert.equal((await plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, [])).mode, 'off');
});

test('the source gate reads only the exact approved planning pointer', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.workflow.phases.planning.claimMaps.planned.sha256 = 'f'.repeat(64);
  await assert.rejects(
    plannedSourceClauseBindings(item.root, item.config, item.workflow, item.phase, []),
    (error) => error.code === 'SPECIFICATION_CLAIM_MAP_BINDING_STALE'
  );
});

/**
 * A committed planning baseline with the code step's generation open on the Story branch.
 * `files` adds or replaces baseline sources, such as code an earlier Story delivered.
 */
async function openCodeGeneration(item, files = {}) {
  const { root, phase, workflow, config } = item;
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Source Binding Test');
  git(root, 'config', 'user.email', 'source-binding@example.invalid');
  await writeFile(path.join(root, 'src/payment.js'), 'export const payment = false;\n');
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'approved planning baseline');
  git(root, 'switch', '-c', 'BIND-1');
  Object.assign(phase, {
    generation: 0, status: 'in_progress', writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }
  });
  Object.assign(workflow, {
    currentPhase: phase.id,
    lineage: { canonicalBranch: 'BIND-1', requiredChecks: [] }, history: []
  });
  Object.assign(workflow.workItem, { workType: 'feature', branch: 'BIND-1' });
  Object.assign(workflow.resolution, {
    configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
    capability: { policy: { protectedPaths: [] } }
  });
  config.governance = { requireAcceptanceCriteriaTags: false };
  config.workTypes = { feature: {} };
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory: path.join(root, 'singularity/work-items/BIND-1'),
    itemRelative: 'singularity/work-items/BIND-1'
  });
  await beginCodeGeneration(root, config, workflow, phase, { agent: 'developer' });
  await mkdir(path.join(root, 'tests'), { recursive: true });
}

/** What phase draft-check reads before the code delivery: an open intent and a finished summary. */
async function readyForDraftCheck(item) {
  const { root, phase } = item;
  phase.generationPolicy = {
    task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent']
  };
  phase.requiredArtifact = {
    path: 'artifacts/implementation/implementation-summary.md',
    kind: 'implementation-summary', minimumBytes: 20,
    validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] }
  };
  const itemDirectory = path.join(root, 'singularity/work-items/BIND-1');
  await mkdir(path.join(itemDirectory, 'artifacts/implementation'), { recursive: true });
  await writeFile(path.join(itemDirectory, phase.requiredArtifact.path),
    '# Implementation\n\nThe approved payment rule is implemented and covered by tests.\n');
}

const draftCheck = (item) => phaseDraftCheck(item.root, item.config, item.workflow, item.phase, {
  session: { workId: 'BIND-1', phaseId: item.phase.id, agent: 'developer' }
});

test('the existing repair loop surfaces missing and unattached acceptance tags with exact planned test paths', async (t) => {
  const item = await fixture({
    'BIND-1:REQ-001': planned(['src/payment.js']),
    'BIND-1:AC-001': planned([])
  });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.phase.qualityCommands = [{ id: 'node-tests', kind: 'test', argv: ['node', '--test'],
    affectedRoots: ['.'], workingDirectory: '.', modelPolicy: 'never',
    result: { adapter: 'node-tap', path: '.sflow/results/node-tests.tap', minimumDiscovered: 1 } }];
  await openCodeGeneration(item);
  await readyForDraftCheck(item);
  item.config.governance.requireAcceptanceCriteriaTags = true;
  await writeFile(path.join(item.root, 'src/payment.js'),
    '// @clause:BIND-1:REQ-001 marks an accepted payment as paid\nexport const payment = true;\n');
  const testPath = path.join(item.root, 'tests/payment.test.js');
  const body = 'import test from "node:test";\nimport assert from "node:assert/strict";\n'
    + 'import { payment } from "../src/payment.js";\ntest("pays", () => { assert.equal(payment, true); });\n';
  await writeFile(testPath, body);
  await assert.rejects(evaluateCodeDeliveryPreflight(item.root, item.config, item.workflow, item.phase), (error) => {
    assert.equal(error.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED', error.message);
    assert.equal(error.details.traceabilityRepair.actions.some((action) => action.kind === 'acceptance-tag'), true);
    return true;
  });
  const missing = await draftCheck(item);
  assert.equal(missing.status, 'correction-required');
  assert.equal(missing.commands.publish, null);
  assert.equal(missing.correction.sameTurn, true);
  const action = missing.traceabilityRepair.actions.find((entry) => entry.kind === 'acceptance-tag');
  assert.equal(action.clauseId, 'BIND-1:AC-001');
  assert.equal(action.sameTurn, true);
  assert.equal(action.requiresSemanticVerification, true);
  assert.deepEqual(action.paths.map((entry) => entry.path), ['tests/payment.test.js']);
  assert.ok(missing.findings.some((finding) => finding.code === 'code.delivery.acceptance-tag-missing'
    && finding.fingerprint === action.fingerprint));
  assert.equal(await readFile(testPath, 'utf8'), body, 'draft-check must not apply its own suggestions');

  await writeFile(testPath, `// @ac:BIND-1:AC-001\n\n${body}`);
  const unattached = await draftCheck(item);
  assert.equal(unattached.status, 'correction-required');
  assert.ok(unattached.findings.some((finding) => finding.code === 'code.delivery.acceptance-tag-unattached'));
  assert.notEqual(unattached.draftFingerprint, missing.draftFingerprint);
  await writeFile(testPath, body.replace('test("pays"', '// @ac:BIND-1:AC-001\ntest("pays"'));
  const repaired = await draftCheck(item);
  assert.equal(repaired.status, 'ready');
  assert.equal(repaired.traceabilityRepair, null, 'static repair readiness is not a passing execution receipt');
});

test('a custom test-only code phase repairs @ac without enabling product-source tagging', async (t) => {
  const item = await fixture({ 'BIND-1:AC-001': planned([]) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.phase.id = 'custom-tests';
  item.workflow.phaseOrder = ['planning', 'custom-tests'];
  item.workflow.phases = { planning: item.workflow.phases.planning, 'custom-tests': item.phase };
  item.workflow.resolution.plannedClaims.owners = { 'custom-tests': 'planning' };
  item.phase.sourceBoundary = 'test-automation';
  await openCodeGeneration(item);
  await readyForDraftCheck(item);
  item.workflow.resolution.codeDelivery.traceability.sourceBindings = 'off';
  item.config.governance.requireAcceptanceCriteriaTags = true;
  await writeFile(path.join(item.root, 'tests/payment.test.js'), 'test("pays", () => {});\n');
  const missing = await draftCheck(item);
  assert.equal(missing.status, 'correction-required');
  assert.deepEqual(missing.traceabilityRepair.actions.map((entry) => entry.kind), ['acceptance-tag']);
  assert.equal(missing.correction.skill, '/sf-code');
  assert.equal(missing.traceabilityRepair.actions[0].sameTurn, true);
  assert.equal(missing.phase, 'custom-tests');
});

test('routine annotation repair never opens unowned or spent generations', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await openCodeGeneration(item);
  await readyForDraftCheck(item);
  await writeFile(path.join(item.root, 'src/payment.js'), 'export const payment = true;\n');
  await writeFile(path.join(item.root, 'tests/payment.test.js'), 'test("pays", () => {});\n');
  const unowned = await phaseDraftCheck(item.root, item.config, item.workflow, item.phase);
  assert.equal(unowned.correction.sameTurn, false);
  assert.equal(unowned.traceabilityRepair.status, 'owner-review');
  assert.ok(unowned.traceabilityRepair.actions.every((action) => !action.sameTurn));
  const receiptPath = path.join(item.root, item.phase.generationIntent.path);
  const receipt = await readFile(receiptPath, 'utf8');
  await writeFile(receiptPath, '{invalid receipt');
  const unverified = await draftCheck(item);
  assert.equal(unverified.status, 'correction-required');
  assert.equal(unverified.correction.sameTurn, false);
  assert.equal(unverified.correction.skill, '/sf-recover');
  assert.equal(unverified.traceabilityRepair, null);
  assert.ok(unverified.findings.some((finding) => finding.code === 'code.generation.intent-unverified'));
  await writeFile(receiptPath, receipt);
  item.phase.generationIntent.status = 'consumed';
  const spent = await draftCheck(item);
  assert.equal(spent.correction.sameTurn, false);
  assert.equal(spent.traceabilityRepair, null);
  assert.equal(item.phase.generationIntent.status, 'consumed');
});

test('prepublish shares the repair plan but withdraws annotation permission behind lifecycle and grounding gates', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await openCodeGeneration(item);
  await readyForDraftCheck(item);
  await writeFile(path.join(item.root, 'src/payment.js'), 'export const payment = true;\n');
  await writeFile(path.join(item.root, 'tests/payment.test.js'), 'test("pays", () => {});\n');
  const preview = () => phasePrepublish(item.root, item.config, item.workflow, item.phase, {
    session: { workId: 'BIND-1', phaseId: item.phase.id, agent: 'developer' }
  });
  const draft = await draftCheck(item);
  const result = await preview();
  assert.equal(result.status, 'correction-required');
  assert.equal(result.commands.publish, null);
  assert.equal(result.traceabilityRepair.fingerprint, draft.traceabilityRepair.fingerprint);
  assert.equal(result.traceabilityRepair.actions[0].fingerprint, draft.traceabilityRepair.actions[0].fingerprint);
  assert.equal(result.mutates, false);
  assert.equal(result.modelInvocations, 0);

  const pending = path.join(item.root, 'singularity/work-items/BIND-1/publication-pending.json');
  await writeFile(pending, '{unreadable publication');
  const blocked = await preview();
  assert.equal(blocked.correction.sameTurn, false);
  assert.equal(blocked.traceabilityRepair.sameTurn, false);
  assert.ok(blocked.traceabilityRepair.actions.every((action) => !action.sameTurn));
  assert.equal(await readFile(pending, 'utf8'), '{unreadable publication');
  await rm(pending);
  item.workflow.resolution.worldModelGrounding = 'enforce';
  const grounding = await preview();
  assert.equal(grounding.correction.sameTurn, false);
  assert.equal(grounding.traceabilityRepair.sameTurn, false);
  assert.ok(grounding.traceabilityRepair.actions.every((action) => !action.sameTurn));
});

test('code-delivery preflight refuses missing source tags before a generation is published', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await openCodeGeneration(item);
  const { phase, workflow, config } = item;
  await writeFile(path.join(item.root, 'tests/payment.test.js'), 'test("payment", () => {});\n');
  await writeFile(path.join(item.root, 'src/payment.js'), 'export const payment = true;\n');
  await assert.rejects(
    evaluateCodeDeliveryPreflight(item.root, config, workflow, phase),
    (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED'
      && error.details?.sourceBindingsMissing?.[0]?.clauseId === 'BIND-1:REQ-001'
      && /@clause:BIND-1:REQ-001/.test(error.message)
  );
  await readyForDraftCheck(item);
  const draft = await draftCheck(item);
  assert.equal(draft.status, 'correction-required');
  assert.equal(draft.findings.some((finding) =>
    finding.code === 'code.delivery.source-clause-tag-missing'
      && finding.value === 'BIND-1:REQ-001'), true);
  assert.equal(draft.traceabilityRepair.status, 'producer-repair');
  assert.equal(draft.traceabilityRepair.actions[0].kind, 'source-tag');
  assert.equal(draft.traceabilityRepair.actions[0].sameTurn, true);
  assert.equal(draft.traceabilityRepair.actions[0].regions[0].path, 'src/payment.js');
  assert.ok(draft.traceabilityRepair.actions[0].regions[0].hunks.length > 0);
  assert.equal(draft.traceabilityRepair.actions[0].regions[0].symbolAssurance, 'heuristic');
  assert.equal(draft.traceabilityRepair.plan.sha256, workflow.phases.planning.claimMaps.planned.sha256);
  const originalSummary = await readFile(path.join(item.root,
    'singularity/work-items/BIND-1/artifacts/implementation/implementation-summary.md'), 'utf8');
  await writeFile(path.join(item.root, 'README.md'), '# Separate work remains uncommitted\n');
  const unrelated = await draftCheck(item);
  assert.equal(unrelated.draftFingerprint, draft.draftFingerprint);
  assert.equal(unrelated.findings.find((finding) => finding.code === 'code.delivery.source-clause-tag-missing').fingerprint,
    draft.findings.find((finding) => finding.code === 'code.delivery.source-clause-tag-missing').fingerprint);
  // A bare tag associates the clause but explains nothing [E2G-011].
  await writeFile(path.join(item.root, 'src/payment.js'),
    '// @clause:BIND-1:REQ-001\nexport const payment = true;\n');
  await assert.rejects(
    evaluateCodeDeliveryPreflight(item.root, config, workflow, phase),
    (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED'
      && error.details?.explanationsMissing?.[0]?.clauseId === 'BIND-1:REQ-001'
      && /needs an explanation of how the change meets it, after its @clause tag in src\/payment.js:1/.test(error.message)
  );
  const unexplained = await draftCheck(item);
  assert.notEqual(unexplained.draftFingerprint, draft.draftFingerprint, 'a tag-only edit is real repair progress');
  assert.equal(unexplained.findings.some((finding) => finding.code === 'code.delivery.clause-explanation-missing'
    && finding.value === 'BIND-1:REQ-001' && finding.path === 'src/payment.js' && finding.line === 1), true);
  await writeFile(path.join(item.root, 'src/payment.js'),
    '// @clause:BIND-1:REQ-001 marks an accepted payment as paid\nexport const payment = true;\n');
  const evidence = await evaluateCodeDeliveryPreflight(item.root, config, workflow, phase);
  const repaired = await draftCheck(item);
  assert.equal(repaired.status, 'ready');
  assert.equal(repaired.traceabilityRepair, null);
  assert.equal(await readFile(path.join(item.root,
    'singularity/work-items/BIND-1/artifacts/implementation/implementation-summary.md'), 'utf8'), originalSummary);
  assert.equal(await readFile(path.join(item.root, 'README.md'), 'utf8'), '# Separate work remains uncommitted\n');
  assert.deepEqual(evidence.sourceBindings.missing, []);
  assert.deepEqual(evidence.implementationBindings.bindings.map((binding) => [binding.clauseId, binding.explanation]),
    [['BIND-1:REQ-001', { text: 'marks an accepted payment as paid', path: 'src/payment.js', line: 1 }]]);
  assert.deepEqual(evidence.sourceBindings.bindings, [{
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: 1, tag: 'clause'
  }]);
  await truncate(path.join(item.root, 'src/payment.js'), 16 * 1024 * 1024);
  const oversizedDraft = await draftCheck(item);
  assert.equal(oversizedDraft.status, 'correction-required');
  assert.equal(oversizedDraft.findings.some((finding) =>
    finding.code === 'code.delivery.source-binding-too-large'
      && finding.path === 'src/payment.js'), true);
});

test('a tag naming a criterion or clause the specification does not hold is refused before publication, at its line', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) }, { clauses: ['BIND-1:AC-001'] });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await openCodeGeneration(item);
  const { root, phase, workflow, config } = item;
  const source = (...lines) => writeFile(path.join(root, 'src/payment.js'),
    ['// @clause:BIND-1:REQ-001 marks an accepted payment as paid', ...lines, 'export const payment = true;', ''].join('\n'));
  const tests = (tag) => writeFile(path.join(root, 'tests/payment.test.js'), [
    '// @ac:BIND-1:AC-001', 'test("pays", () => {});', '',
    `// @ac:${tag}`, 'test("retries", () => {});', '',
    // Another Story's tag binds nothing here: this module's runner only counts tests.
    '// @ac:OTHER-2:AC-001', 'test("history", () => {});', ''
  ].join('\n'));
  await source();
  await tests('BIND-1:AC-007');
  await assert.rejects(evaluateCodeDeliveryPreflight(root, config, workflow, phase), (error) => {
    assert.equal(error.code, 'EVIDENCE_CRITERION_UNKNOWN');
    assert.deepEqual(error.details.findings.map((finding) => [finding.path, finding.line, finding.clauseId]),
      [['tests/payment.test.js', 4, 'BIND-1:AC-007']]);
    assert.deepEqual(error.details.paths, ['tests/payment.test.js']);
    assert.deepEqual(error.details.recoveryCommands, ['singularity-flow phase prepublish implementation --json']);
    assert.match(error.message, /tests name criteria the active specification does not hold: @ac:BIND-1:AC-007 at tests\/payment\.test\.js:4\n/);
    assert.match(error.message, /Correct each @ac tag to a criterion the specification holds, or remove it/);
    return true;
  });
  await readyForDraftCheck(item);
  const draft = await draftCheck(item);
  assert.equal(draft.status, 'correction-required');
  assert.equal(draft.commands.publish, null);
  const criterion = draft.findings.find((finding) => finding.code === 'code.delivery.criterion-tag-unknown');
  assert.deepEqual([criterion?.path, criterion?.line, criterion?.value], ['tests/payment.test.js', 4, 'BIND-1:AC-007']);
  assert.equal(criterion.message, '@ac:BIND-1:AC-007 at tests/payment.test.js:4 names a criterion the active specification does not hold.');

  // Its source twin, a clause the Story never approved, is shown at its line the same way.
  await tests('BIND-1:AC-001');
  await source('// @clause:BIND-1:REQ-009 retries a declined payment');
  const unapproved = (await draftCheck(item)).findings.find((finding) => finding.code === 'code.delivery.source-clause-tag-unapproved');
  assert.deepEqual([unapproved?.path, unapproved?.line, unapproved?.value], ['src/payment.js', 2, 'BIND-1:REQ-009']);

  await source();
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(evidence.acceptanceCriteria.tagged, ['BIND-1:AC-001', 'OTHER-2:AC-001']);
});

const unapprovedFindings = (error) => error.details.findings.map((finding) => [finding.sourcePath, finding.line, finding.clauseId]);

test('a source tag in a namespace the specification uses, not its Work ID, must name an approved clause', async (t) => {
  // Like test/spk-e2e.test.mjs's Story E2E-1, this Story names its clauses E2E:REQ-NNN.
  const item = await fixture({ 'E2E:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await openCodeGeneration(item);
  const { root, phase, workflow, config } = item;
  await writeFile(path.join(root, 'tests/payment.test.js'), 'test("payment", () => {});\n');
  const source = (...lines) => writeFile(path.join(root, 'src/payment.js'),
    ['// @clause:E2E:REQ-001 marks an accepted payment as paid', ...lines, 'export const payment = true;', ''].join('\n'));
  await source('// @clause:E2E:REQ-009 retries a declined payment');
  await assert.rejects(evaluateCodeDeliveryPreflight(root, config, workflow, phase), (error) => {
    assert.equal(error.code, 'EVIDENCE_CLAUSE_UNAPPROVED');
    assert.deepEqual(unapprovedFindings(error), [['src/payment.js', 2, 'E2E:REQ-009']]);
    assert.match(error.message, /this Story has not approved: E2E:REQ-009 at src\/payment\.js:2\. Correct the tag/);
    return true;
  });
  // A tag in another Story's Work ID binds nothing here and stays.
  await source('// @clause:OTHER-2:REQ-004 keeps the retry window another Story set');
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(evidence.sourceBindings.bindings.map((binding) => [binding.clauseId, binding.line]), [['E2E:REQ-001', 1]]);
});

test('in a namespace other Stories share, only a source tag this generation adds must name an approved clause', async (t) => {
  const item = await fixture({
    'ORDER:REQ-001': planned(['src/payment.js']), 'ORDER:REQ-002': planned(['src/history.js'])
  });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  // Every Story of the work type uses the configured namespace and numbers its own clauses, so code
  // an earlier Story delivered already carries ORDER tags this Story never defined.
  item.workflow.resolution.spec.namespace = 'ORDER';
  await openCodeGeneration(item, {
    'src/payment.js': '// @clause:ORDER:REQ-007 refuses a card past its expiry date\nexport const payment = false;\n',
    'src/history.js': '// @clause:ORDER:REQ-008 keeps every attempt in the history\nexport const history = [];\n'
  });
  const { root, phase, workflow, config } = item;
  await writeFile(path.join(root, 'tests/payment.test.js'), 'test("payment", () => {});\n');
  const write = (relative, ...lines) => writeFile(path.join(root, relative), [...lines, ''].join('\n'));
  const payment = '// @clause:ORDER:REQ-001 marks an accepted payment as paid';
  const expiry = '// @clause:ORDER:REQ-007 refuses a card past its expiry date';
  const history = '// @clause:ORDER:REQ-008 keeps every attempt in the history';
  await write('src/payment.js', payment, expiry, 'export const payment = true;');
  await write('src/history.js', '// @clause:ORDER:REQ-002 appends each attempt to the history', history, 'export const history = [];');
  assert.deepEqual((await evaluateCodeDeliveryPreflight(root, config, workflow, phase)).sourceBindings.missing, []);

  // A mistyped tag the generation adds is refused at its line; the earlier Story's tags stay.
  await write('src/payment.js', payment, expiry, '// @clause:ORDER:REQ-009 retries a declined payment', 'export const payment = true;');
  await assert.rejects(evaluateCodeDeliveryPreflight(root, config, workflow, phase), (error) => {
    assert.equal(error.code, 'EVIDENCE_CLAUSE_UNAPPROVED');
    assert.deepEqual(unapprovedFindings(error), [['src/payment.js', 3, 'ORDER:REQ-009']]);
    return true;
  });

  // An earlier Story's tag that moves with its code into another changed file is still carried.
  await write('src/payment.js', payment, expiry, history, 'export const payment = true;');
  await write('src/history.js', '// @clause:ORDER:REQ-002 appends each attempt to the history', 'export const history = [];');
  assert.deepEqual((await evaluateCodeDeliveryPreflight(root, config, workflow, phase)).sourceBindings.missing, []);
});

test('in a namespace other Stories share, only a test tag the generation adds must name a criterion the specification holds', async (t) => {
  const item = await fixture({ 'ORDER:REQ-001': planned(['src/payment.js']) }, { clauses: ['ORDER:AC-001'] });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.workflow.resolution.spec.namespace = 'ORDER';
  // An earlier Story's test, tagged with that Story's criterion in the namespace every Story uses.
  const earlier = ['// @ac:ORDER:AC-003', 'test("refuses an expired card", () => {});', ''];
  await openCodeGeneration(item, { 'tests/payment.test.js': earlier.join('\n') });
  const { root, phase, workflow, config } = item;
  await writeFile(path.join(root, 'src/payment.js'), '// @clause:ORDER:REQ-001 marks an accepted payment as paid\nexport const payment = true;\n');
  const tests = (...lines) => writeFile(path.join(root, 'tests/payment.test.js'),
    [...earlier, '// @ac:ORDER:AC-001', 'test("pays", () => {});', '', ...lines].join('\n'));
  await tests();
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(evidence.acceptanceCriteria.tagged, ['ORDER:AC-001', 'ORDER:AC-003']);

  await tests('// @ac:ORDER:AC-009', 'test("retries", () => {});', '');
  await assert.rejects(evaluateCodeDeliveryPreflight(root, config, workflow, phase), (error) => {
    assert.equal(error.code, 'EVIDENCE_CRITERION_UNKNOWN');
    assert.deepEqual(error.details.findings.map((finding) => [finding.path, finding.line, finding.clauseId]),
      [['tests/payment.test.js', 7, 'ORDER:AC-009']]);
    return true;
  });
});

test('in a namespace other Stories share, an earlier Story\'s source tag with the same ID does not bind this Story\'s clause', async (t) => {
  const item = await fixture({ 'ORDER:REQ-001': planned(['src/payment.js', 'src/refund.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  // Each Story numbers its own clauses, so the earlier Story's ORDER:REQ-001 is another clause.
  item.workflow.resolution.spec.namespace = 'ORDER';
  const earlier = '// @clause:ORDER:REQ-001 refuses a card past its expiry date';
  await openCodeGeneration(item, { 'src/payment.js': [earlier, 'export const payment = false;', ''].join('\n') });
  const { root, phase, workflow, config } = item;
  await writeFile(path.join(root, 'tests/payment.test.js'), 'test("payment", () => {});\n');
  const write = (relative, ...lines) => writeFile(path.join(root, relative), [...lines, ''].join('\n'));
  const refused = (where) => assert.rejects(evaluateCodeDeliveryPreflight(root, config, workflow, phase), (error) => {
    assert.equal(error.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED');
    assert.deepEqual(error.details.sourceBindingsMissing, [{
      clauseId: 'ORDER:REQ-001', expectedPaths: ['src/payment.js', 'src/refund.js'], otherStoryTags: [where]
    }]);
    assert.ok(error.message.includes(`@clause:ORDER:REQ-001 in src/payment.js or src/refund.js (the tag at ${where.path}:${where.line} is from before this Story, so it names an earlier Story's clause)`));
    return true;
  });
  // The Story changes its planned file but forgets its own tag.
  await write('src/payment.js', earlier, 'export const payment = true;');
  await refused({ path: 'src/payment.js', line: 1 });
  await readyForDraftCheck(item);
  const missing = (await draftCheck(item)).findings.find((finding) => finding.code === 'code.delivery.source-clause-tag-missing');
  assert.equal(missing?.message, 'Planned clause ORDER:REQ-001 needs @clause:ORDER:REQ-001 in an exact planned product source path: src/payment.js, src/refund.js'
    + ' (the tag at src/payment.js:1 is from before this Story, so it names an earlier Story\'s clause).');
  // A tag that moves with its code, here into a new file, is still the earlier Story's.
  await write('src/payment.js', 'export const payment = true;');
  await write('src/refund.js', earlier, 'export const refund = false;');
  await refused({ path: 'src/refund.js', line: 1 });
  // Its own tag binds, and the binding is explained in its own words, not the earlier Story's.
  await rm(path.join(root, 'src/refund.js'));
  await write('src/payment.js', earlier, '// @clause:ORDER:REQ-001 marks an accepted payment as paid', 'export const payment = true;');
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.deepEqual(evidence.sourceBindings.bindings.map((binding) => [binding.clauseId, binding.sourcePath, binding.line]),
    [['ORDER:REQ-001', 'src/payment.js', 2]]);
  assert.deepEqual(evidence.implementationBindings.bindings.map((binding) => binding.explanation),
    [{ text: 'marks an accepted payment as paid', path: 'src/payment.js', line: 2 }]);
});

test('in a namespace other Stories share, an earlier Story\'s test tag with the same ID neither satisfies nor witnesses this Story\'s criterion', async (t) => {
  const item = await fixture({ 'ORDER:REQ-001': planned(['src/payment.js']) }, { clauses: ['ORDER:AC-001'] });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.workflow.resolution.spec.namespace = 'ORDER';
  // An earlier Story's node:test test, read exactly, tagged with that Story's own AC-001.
  const header = ["import test from 'node:test';", ''];
  const earlier = ['// @ac:ORDER:AC-001', 'test("refuses an expired card", () => {});', ''];
  await openCodeGeneration(item, { 'tests/payment.test.js': [...header, ...earlier].join('\n') });
  const { root, phase, workflow, config } = item;
  config.governance.requireAcceptanceCriteriaTags = true;
  await writeFile(path.join(root, 'src/payment.js'), '// @clause:ORDER:REQ-001 marks an accepted payment as paid\nexport const payment = true;\n');
  // The Story adds its test above the earlier one.
  const tests = (...lines) => writeFile(path.join(root, 'tests/payment.test.js'), [...header, ...lines, '', ...earlier].join('\n'));
  const preflight = () => evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  // It forgets its tag.
  await tests('test("pays", () => {});');
  await assert.rejects(preflight(), (error) => {
    assert.equal(error.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED');
    assert.ok(error.message.includes('changed tests do not contain required traceability tags: @ac:ORDER:AC-001'
      + ' (the tag at tests/payment.test.js:5 is from before this Story, so it names an earlier Story\'s criterion)'));
    return true;
  });
  // Its tag sits on no test, and the earlier Story's tag on a test does not make up for it.
  await tests('// @ac:ORDER:AC-001', '', 'test("pays", () => {});');
  await assert.rejects(preflight(), (error) => {
    assert.match(error.message, /@ac:ORDER:AC-001 is not on a test: tests\/payment\.test\.js:3 /);
    return true;
  });
  // Its own tag makes its own test the only witness of its criterion.
  await tests('// @ac:ORDER:AC-001', 'test("pays", () => {});');
  let evidence = await preflight();
  assert.deepEqual(evidence.acceptanceCriteria.witnesses.map((witness) => [witness.clauseId, witness.testSource, witness.identity?.name]),
    [['ORDER:AC-001', 'tests/payment.test.js', 'pays']]);
  assert.deepEqual(evidence.acceptanceCriteria.unattachedTags, []);
  // So does its tag in a new test file, beside the earlier Story's test left as it was.
  await writeFile(path.join(root, 'tests/payment.test.js'), [...header, ...earlier].join('\n'));
  await writeFile(path.join(root, 'tests/pays.test.js'), [...header, '// @ac:ORDER:AC-001', 'test("pays", () => {});', ''].join('\n'));
  evidence = await preflight();
  assert.deepEqual(evidence.acceptanceCriteria.witnesses.map((witness) => [witness.clauseId, witness.testSource, witness.identity?.name]),
    [['ORDER:AC-001', 'tests/pays.test.js', 'pays']]);
  assert.deepEqual(evidence.acceptanceCriteria.bindings.map((binding) => [binding.clauseId, binding.testSource]),
    [['ORDER:AC-001', 'tests/pays.test.js']]);
});

test('in a namespace other Stories share, the Story\'s own tags still count in a rework generation', async (t) => {
  const item = await fixture({ 'ORDER:REQ-001': planned(['src/payment.js']) }, { clauses: ['ORDER:AC-001'] });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.workflow.resolution.spec.namespace = 'ORDER';
  const earlierSource = '// @clause:ORDER:REQ-001 refuses a card past its expiry date';
  const earlierTest = ["import test from 'node:test';", '', '// @ac:ORDER:AC-001', 'test("refuses an expired card", () => {});', ''];
  await openCodeGeneration(item, {
    'src/payment.js': [earlierSource, 'export const payment = false;', ''].join('\n'),
    'tests/payment.test.js': earlierTest.join('\n')
  });
  const { root, phase, workflow, config } = item;
  config.governance.requireAcceptanceCriteriaTags = true;
  const own = '// @clause:ORDER:REQ-001 marks an accepted payment as paid';
  const write = (relative, ...lines) => writeFile(path.join(root, relative), [...lines, ''].join('\n'));
  // Generation one delivers the Story's own tags, committed with it.
  await write('src/payment.js', earlierSource, own, 'export const payment = true;');
  await write('tests/payment.test.js', ...earlierTest, '// @ac:ORDER:AC-001', 'test("pays", () => {});');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'generation one');
  const first = git(root, 'rev-parse', 'HEAD');
  // A rework measures the next generation from generation one, and opens a new interval there.
  Object.assign(phase, { generation: 1, generationIntent: { status: 'open', id: 'intent-rework', baseline: { commit: first, previousGenerationCommit: first } } });
  await ensureWorkIntervalBaseline(root, config, workflow, {
    phaseId: phase.id, itemDirectory: path.join(root, 'singularity/work-items/BIND-1'), itemRelative: 'singularity/work-items/BIND-1'
  });
  assert.equal(workflow.workIntervals.current.sourceBaseCommit, first);
  // Generation two changes the code and the test beside the tags generation one added.
  await write('src/payment.js', earlierSource, own, 'export const payment = Boolean(true);');
  await write('tests/payment.test.js', ...earlierTest, '// @ac:ORDER:AC-001', 'test("pays", () => { /* retried */ });');
  const evidence = await evaluateCodeDeliveryPreflight(root, config, workflow, phase);
  assert.equal(evidence.baselineCommit, first);
  assert.deepEqual(evidence.sourceBindings.bindings.map((binding) => [binding.clauseId, binding.line]), [['ORDER:REQ-001', 2]]);
  assert.deepEqual(evidence.implementationBindings.bindings.map((binding) => binding.explanation?.text), ['marks an accepted payment as paid']);
  assert.deepEqual(evidence.acceptanceCriteria.witnesses.map((witness) => [witness.clauseId, witness.identity?.name]), [['ORDER:AC-001', 'pays']]);
});

test('a source tag in the Work ID is refused even where the baseline already carried it', async (t) => {
  const item = await fixture({ 'ORDER:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const { root, phase, workflow, config } = item;
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Source Binding Test');
  git(root, 'config', 'user.email', 'source-binding@example.invalid');
  // A rework generation's baseline: this Story's tag of a clause its revised specification
  // withdrew, beside an earlier Story's tag in the namespace both specifications use.
  const stale = '// @clause:BIND-1:REQ-003 caps retries at three attempts';
  const earlier = '// @clause:ORDER:REQ-007 refuses a card past its expiry date';
  await writeFile(path.join(root, 'src/payment.js'), [stale, earlier, 'export const payment = false;', ''].join('\n'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'previous generation');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  await writeFile(path.join(root, 'src/payment.js'),
    ['// @clause:ORDER:REQ-001 marks an accepted payment as paid', stale, earlier, 'export const payment = true;', ''].join('\n'));
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit });
  const bind = (options) => plannedSourceClauseBindings(root, config, workflow, phase, ['src/payment.js'], options);
  await assert.rejects(bind({ changeSet }), (error) => {
    assert.deepEqual(unapprovedFindings(error), [['src/payment.js', 2, 'BIND-1:REQ-003']]);
    return true;
  });
  // Without a change set no tag is known to be carried, so each one counts as the delivery's own.
  await assert.rejects(bind({}), (error) => {
    assert.deepEqual(unapprovedFindings(error), [['src/payment.js', 2, 'BIND-1:REQ-003'], ['src/payment.js', 3, 'ORDER:REQ-007']]);
    return true;
  });
});

test('committed receipt replay verifies exact comment witnesses and planned deletions', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  git(item.root, 'init', '-b', 'main');
  git(item.root, 'config', 'user.name', 'Source Binding Test');
  git(item.root, 'config', 'user.email', 'source-binding@example.invalid');
  await writeFile(path.join(item.root, 'src/payment.js'),
    '// @clause:BIND-1:REQ-001\nexport const payment = true;\n');
  git(item.root, 'add', '.');
  git(item.root, 'commit', '-m', 'bound source');
  const commit = git(item.root, 'rev-parse', 'HEAD');
  const minimalReceipt = (binding, deletedSourcePaths = []) => ({
    schemaVersion: 2, kind: 'code-delivery', status: 'ready',
    phase: 'implementation', generation: 1,
    tree: {
      generationCommit: commit,
      generationTree: git(item.root, 'rev-parse', `${commit}^{tree}`)
    },
    changeSet: { sourcePaths: ['src/payment.js'], deletedSourcePaths },
    traceability: {
      required: [], bound: [], bindings: [], missing: [], ambiguous: [],
      sourceRequired: [{ clauseId: 'BIND-1:REQ-001', expectedPaths: ['src/payment.js'] }],
      sourceBindings: [binding]
    },
    testExecutions: []
  });
  const comment = {
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: 1, tag: 'clause'
  };
  const accepted = await verifyCodeDeliveryReceipt(item.root, minimalReceipt(comment), {
    sourceBindingPolicy: 'enforce'
  });
  assert.equal(accepted.errors.some((message) => /source-clause|planned clause/.test(message)), false);
  const wrongLine = await verifyCodeDeliveryReceipt(item.root, minimalReceipt({ ...comment, line: 2 }), {
    sourceBindingPolicy: 'enforce'
  });
  assert.equal(wrongLine.errors.some((message) => /does not replay from the generation commit/.test(message)), true);

  await rm(path.join(item.root, 'src/payment.js'));
  git(item.root, 'add', '-u');
  git(item.root, 'commit', '-m', 'remove planned product source');
  const deletedCommit = git(item.root, 'rev-parse', 'HEAD');
  const deletion = minimalReceipt({
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: null, tag: 'deletion'
  }, ['src/payment.js']);
  deletion.tree.generationCommit = deletedCommit;
  deletion.tree.generationTree = git(item.root, 'rev-parse', `${deletedCommit}^{tree}`);
  const acceptedDeletion = await verifyCodeDeliveryReceipt(item.root, deletion, {
    sourceBindingPolicy: 'enforce'
  });
  assert.equal(acceptedDeletion.errors.some((message) => /source-clause|planned deletion|planned clause/.test(message)), false);
  deletion.changeSet.deletedSourcePaths = [];
  const unprovenDeletion = await verifyCodeDeliveryReceipt(item.root, deletion, {
    sourceBindingPolicy: 'enforce'
  });
  assert.equal(unprovenDeletion.errors.some((message) => /outside the reviewed delivery/.test(message)), true);
});
