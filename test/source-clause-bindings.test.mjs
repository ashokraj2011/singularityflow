import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateCodeDeliveryPreflight, plannedSourceClauseBindings, verifyCodeDeliveryReceipt
} from '../src/delivery-evidence.mjs';
import { phaseDraftCheck } from '../src/phase-draft-check.mjs';
import { canonicalJson } from '../src/records.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(claims) {
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

test('code-delivery preflight refuses missing source tags before a generation is published', async (t) => {
  const item = await fixture({ 'BIND-1:REQ-001': planned(['src/payment.js']) });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  git(item.root, 'init', '-b', 'main');
  git(item.root, 'config', 'user.name', 'Source Binding Test');
  git(item.root, 'config', 'user.email', 'source-binding@example.invalid');
  await writeFile(path.join(item.root, 'src/payment.js'), 'export const payment = false;\n');
  git(item.root, 'add', '.');
  git(item.root, 'commit', '-m', 'approved planning baseline');
  git(item.root, 'switch', '-c', 'BIND-1');
  const { phase, workflow, config } = item;
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
  const itemDirectory = path.join(item.root, 'singularity/work-items/BIND-1');
  await ensureWorkIntervalBaseline(item.root, config, workflow, {
    phaseId: phase.id, itemDirectory, itemRelative: 'singularity/work-items/BIND-1'
  });
  await mkdir(path.join(item.root, 'tests'), { recursive: true });
  await writeFile(path.join(item.root, 'tests/payment.test.js'), 'test("payment", () => {});\n');
  await writeFile(path.join(item.root, 'src/payment.js'), 'export const payment = true;\n');
  await assert.rejects(
    evaluateCodeDeliveryPreflight(item.root, config, workflow, phase),
    (error) => error.code === 'CODE_DELIVERY_EVIDENCE_REQUIRED'
      && error.details?.sourceBindingsMissing?.[0]?.clauseId === 'BIND-1:REQ-001'
      && /@clause:BIND-1:REQ-001/.test(error.message)
  );
  phase.generationIntent = { status: 'open', id: 'intent-source-binding' };
  phase.generationPolicy = {
    task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent']
  };
  phase.requiredArtifact = {
    path: 'artifacts/implementation/implementation-summary.md',
    kind: 'implementation-summary', minimumBytes: 20,
    validation: { requiredHeadings: ['Implementation'], forbiddenPlaceholders: [] }
  };
  await mkdir(path.join(itemDirectory, 'artifacts/implementation'), { recursive: true });
  await writeFile(path.join(itemDirectory, phase.requiredArtifact.path),
    '# Implementation\n\nThe approved payment rule is implemented and covered by tests.\n');
  const draft = await phaseDraftCheck(item.root, config, workflow, phase, {
    session: { workId: 'BIND-1', phaseId: phase.id, agent: 'developer' }
  });
  assert.equal(draft.status, 'correction-required');
  assert.equal(draft.findings.some((finding) =>
    finding.code === 'code.delivery.source-clause-tag-missing'
      && finding.value === 'BIND-1:REQ-001'), true);
  await writeFile(path.join(item.root, 'src/payment.js'),
    '// @clause:BIND-1:REQ-001\nexport const payment = true;\n');
  const evidence = await evaluateCodeDeliveryPreflight(item.root, config, workflow, phase);
  assert.deepEqual(evidence.sourceBindings.missing, []);
  assert.deepEqual(evidence.sourceBindings.bindings, [{
    clauseId: 'BIND-1:REQ-001', sourcePath: 'src/payment.js', line: 1, tag: 'clause'
  }]);
  await truncate(path.join(item.root, 'src/payment.js'), 16 * 1024 * 1024);
  const oversizedDraft = await phaseDraftCheck(item.root, config, workflow, phase, {
    session: { workId: 'BIND-1', phaseId: phase.id, agent: 'developer' }
  });
  assert.equal(oversizedDraft.status, 'correction-required');
  assert.equal(oversizedDraft.findings.some((finding) =>
    finding.code === 'code.delivery.source-binding-too-large'
      && finding.path === 'src/payment.js'), true);
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
