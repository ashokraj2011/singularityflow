/** XPL2 M1 engine acceptance cases over a real disposable Git change. */
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildCodeExplanation } from '../src/comprehension/code-explanation.mjs';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { renderTemplate, XPL2_TEMPLATE_IDS } from '../src/comprehension/xpl2/templates.mjs';
import { XPL2_REASON_CODES, xpl2Reason } from '../src/comprehension/xpl2/reasons.mjs';
import { XPL2_RELATIONSHIPS } from '../src/comprehension/xpl2/vocabulary.mjs';
import { recordSha256 } from '../src/records.mjs';
import { createXpl2Fixture } from './helpers/xpl2-fixture.mjs';

const change = (input, extra = {}) => explainXpl2Subject(input, { subject: 'change', ...extra });
const citable = (model) => new Set([...model.sources.map((entry) => entry.id), ...model.observations.map((entry) => entry.id)]);

test('XPL2-AC-001 every statement and edge cites an admitted source; absence cites a read observation', async (t) => {
  const fixture = await createXpl2Fixture(t, { withGraph: false });
  const model = change(fixture.input);
  const ids = citable(model);
  for (const entry of [...model.statements, ...model.derived]) {
    assert.ok(entry.cites.length > 0, `${entry.id} is uncited`);
    for (const citation of entry.cites) assert.ok(ids.has(citation), `${entry.id} cites unknown ${citation}`);
    assert.equal(entry.authority, 'none');
  }
  for (const edge of model.relationships) for (const citation of edge.cites) assert.ok(ids.has(citation));
  const missing = model.statements.filter((entry) => entry.kind === 'cause-not-recorded');
  assert.ok(missing.length > 0);
  for (const entry of missing) assert.deepEqual(entry.cites, ['OBS-CAUSE']);
  // An unavailable source never carries an invented record hash.
  for (const source of model.sources) {
    if (['not-recorded', 'unavailable', 'inaccessible', 'disabled'].includes(source.properties.availability)) {
      assert.equal(source.digest, null);
    }
  }
  for (const observation of model.observations) assert.match(observation.observationSha256, /^sha256:[a-f0-9]{64}$/u);
});

test('XPL2-AC-002 multi-hunk, binary, untracked and mode changes are each counted exactly once', async (t) => {
  const fixture = await createXpl2Fixture(t);
  await writeFile(path.join(fixture.root, 'notes-untracked.md'), 'draft\n');
  await chmod(path.join(fixture.root, 'src/index.ts'), 0o755);
  const { buildRepositoryChangeSet } = await import('../src/repository-change-set.mjs');
  const { buildChangeRegionManifest } = await import('../src/comprehension/contracts.mjs');
  const { buildComprehensionDiffPreview } = await import('../src/comprehension/diff-preview.mjs');
  const changeSet = await buildRepositoryChangeSet(fixture.root, { baseCommit: fixture.base, subject: { kind: 'comprehension-observation' } });
  const manifest = buildChangeRegionManifest(changeSet);
  const diff = buildComprehensionDiffPreview(fixture.root, changeSet);
  const codeExplanation = buildCodeExplanation({ manifest, diff });
  const model = change({ ...fixture.input, manifest, codeExplanation, evidence: null, workflow: null });
  const { counts, units, files } = model.inventory;
  assert.equal(counts.changeUnits, units.length);
  assert.equal(counts.textHunks + counts.opaqueUnits, counts.changeUnits);
  assert.equal(counts.files, files.length);
  assert.equal(counts.regions, manifest.regions.length);
  assert.equal(new Set(units.map((unit) => unit.explanationUnitSha256)).size, units.length);
  assert.equal(files.find((file) => file.path === 'src/export/service.ts').hunks, 2);
  assert.ok(units.some((unit) => unit.path === 'notes-untracked.md' && unit.unitKind === 'untracked-region-opaque'));
  assert.ok(units.some((unit) => unit.path === 'assets/export-badge.png' && !unit.hunk));
  // Multiple associations to one region never duplicate a unit in the totals.
  const associated = change(fixture.input);
  assert.equal(associated.inventory.counts.changeUnits, associated.inventory.units.length);
  assert.equal(associated.inventory.counts.causeBoundUnits, 0);
});

test('XPL2-AC-003 an unavailable or empty gap set never becomes a mergeable state', async (t) => {
  const fixture = await createXpl2Fixture(t);
  for (const proof of [null, { proofSubjectSha256: null, proofSummarySha256: null, gaps: [] }]) {
    const model = explainXpl2Subject(fixture.input, { subject: 'gap' }, { proof });
    const texts = [...model.statements, ...model.derived].map((entry) => entry.text).join('\n');
    assert.match(texts, /cannot report that no blockers exist/u);
    assert.doesNotMatch(texts, /\b(?:mergeable|safe to merge|no blockers\.)/iu);
    assert.equal(model.availability.admission, 'unavailable');
  }
  const reported = explainXpl2Subject(fixture.input, { subject: 'gap' }, {
    proof: { proofSubjectSha256: null, proofSummarySha256: null, gaps: [{ code: 'PFC_WITNESS_MISSING', subject: 'ORD:AC-003' }] }
  });
  assert.ok(reported.derived.some((entry) => entry.kind === 'gap-observed' && /PFC_WITNESS_MISSING/u.test(entry.text)
    && entry.limitations.includes('evaluation-unavailable')));
});

test('XPL2-AC-004 result, assurance and applicability stay separate and nothing becomes proven', async (t) => {
  const current = await createXpl2Fixture(t);
  const model = change(current.input);
  const results = model.statements.filter((entry) => entry.kind === 'test-result');
  assert.equal(results.length, 2);
  for (const entry of results) assert.match(entry.text, /authenticated Candidate execution is unavailable/u);
  assert.doesNotMatch(model.statements.map((entry) => entry.text).join('\n'), /\b(?:proven|proved|satisfied|verified correct)\b/iu);
  const stale = await createXpl2Fixture(t, { deliveryCurrent: false });
  const staleModel = change(stale.input);
  assert.equal(staleModel.sources.find((entry) => entry.id === 'SRC-DELIVERY').properties.applicability, 'stale');
  assert.ok(staleModel.statements.filter((entry) => entry.cites.includes('SRC-DELIVERY') && entry.kind !== 'source-state')
    .every((entry) => entry.limitations.includes('source-scope-mismatch')));
  const failing = await createXpl2Fixture(t);
  failing.input.evidence = { ...failing.input.evidence, testExecutions: [{ ...failing.input.evidence.testExecutions[0], status: 'failed' }] };
  const failed = change(failing.input);
  assert.ok(failed.attention.some((entry) => entry.category === 'blocker' && entry.reason === 'owner-reported-failure'));
});

test('XPL2-AC-005 audiences reorder and fold the same authorized statement set', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const views = ['reviewer', 'auditor', 'developer'].map((audience) => change(fixture.input, { audience }));
  assert.equal(new Set(views.map((view) => view.explanationSetSha256)).size, 1);
  assert.equal(new Set(views.map((view) => view.explanationSha256)).size, 1);
  for (const view of views) {
    const plan = view.presentation.audiences[view.presentation.audience];
    assert.deepEqual([...plan.order].sort(), view.statements.map((entry) => entry.id).sort());
    for (const folded of plan.folded) assert.ok(plan.order.includes(folded), 'folded statements stay reachable');
  }
  const orders = views.map((view) => view.presentation.audiences[view.presentation.audience].order.join(','));
  assert.equal(new Set(orders).size, 3);
});

test('XPL2-AC-006 identical inputs give identical identities; a different evidence cut differs', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const first = change(fixture.input);
  const second = change(structuredClone(fixture.input));
  assert.equal(first.explanationSetSha256, second.explanationSetSha256);
  assert.equal(first.explanationSha256, second.explanationSha256);
  const withoutStory = change({ ...fixture.input, evidence: null, workflow: null, clauseSources: null, replay: null });
  assert.notEqual(withoutStory.explanationSetSha256, first.explanationSetSha256);
  // Machine-local checkout paths never enter the semantic identity.
  const moved = change({ ...fixture.input, context: { ...fixture.input.context, repository: '/elsewhere/checkout' } });
  assert.equal(moved.explanationSetSha256, first.explanationSetSha256);
  assert.doesNotMatch(JSON.stringify(first.snapshot), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('XPL2-AC-007 a corrupt optional source contributes nothing while inventory stays readable', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const tampered = { ...fixture.graph, nodes: fixture.graph.nodes.map((node) => node.type === 'cause' ? { ...node, causeId: 'ORD:AC-999' } : node) };
  const codeExplanation = buildCodeExplanation({ manifest: fixture.manifest, diff: fixture.diff, graph: tampered, evidence: fixture.evidence });
  const model = change({ ...fixture.input, codeExplanation });
  assert.equal(model.inventory.counts.changeUnits, fixture.codeExplanation.whyEachChange.length);
  assert.equal(model.relationships.filter((edge) => edge.type === 'region-associated-with-clause').length, 0);
  assert.ok(!model.nodes.some((node) => node.label === 'ORD:AC-999'));
  const invalidClauses = {
    status: 'available', reason: null,
    artifacts: [{ ...fixture.clauseSources.artifacts[0], status: 'invalid', reason: 'integrity-failed', clauses: [] }]
  };
  const invalid = change({ ...fixture.input, clauseSources: invalidClauses });
  assert.equal(invalid.sources.find((entry) => entry.id === 'SRC-SPEC-01').properties.integrity, 'failed');
  assert.ok(!invalid.statements.some((entry) => entry.kind === 'clause-declared'));
});

test('XPL2-AC-014 impact without a compatible producer is a named unavailability', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change(fixture.input);
  assert.equal(model.availability.impact, 'unavailable');
  assert.equal(model.observations.find((entry) => entry.id === 'OBS-IMPACT').reason, 'adapter-unavailable');
  assert.ok(model.statements.some((entry) => entry.cites.includes('OBS-IMPACT')));
});

test('XPL2-AC-019 a working-tree observation is never labelled a retained Candidate', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change(fixture.input);
  assert.equal(model.snapshot.truth, 'working-tree-observation');
  assert.equal(model.snapshot.retainedCandidate, false);
  assert.equal(model.snapshot.candidateBinding, 'repository-change-set-compatibility');
});

test('XPL2-AC-023 bounded delivery keeps totals and states the omission', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const bounded = explainXpl2Subject(fixture.input, { subject: 'change' }, { maximumUnits: 2 });
  const full = change(fixture.input);
  assert.equal(bounded.delivery.complete, false);
  assert.equal(bounded.delivery.reason, 'bounded-delivery');
  assert.equal(bounded.delivery.totalUnits, full.inventory.units.length);
  assert.equal(bounded.inventory.units.length, 2);
  assert.deepEqual(bounded.inventory.counts, full.inventory.counts);
  assert.equal(bounded.explanationSetSha256, full.explanationSetSha256);
  assert.notEqual(bounded.explanationSha256, full.explanationSha256);
});

test('XPL2-AC-028 a self-hashed record renders as recorded, never as an authenticated fact', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change(fixture.input);
  const delivery = model.sources.find((entry) => entry.id === 'SRC-DELIVERY');
  assert.equal(delivery.properties.integrity, 'self-hashed');
  assert.equal(delivery.properties.origin, 'recorded-local');
  assert.ok(!model.sources.some((entry) => /authenticated/u.test(entry.properties.origin)));
  for (const entry of model.statements.filter((item) => item.kind === 'test-tag')) {
    assert.match(entry.text, /declares a test tag .* not coverage or a result/u);
  }
});

test('XPL2-AC-029 no clock enters the statements or identities', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const realNow = Date.now;
  let first;
  try {
    Date.now = () => 0;
    first = change(fixture.input);
    Date.now = () => 9e12;
  } finally { Date.now = realNow; }
  const later = change(fixture.input);
  assert.equal(first.explanationSha256, later.explanationSha256);
  assert.doesNotMatch(JSON.stringify(first.statements), /\b(?:ago|minutes|hours|yesterday)\b/iu);
});

test('XPL2-AC-030 an inaccessible specification reveals neither content nor digest', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change({
    ...fixture.input,
    clauseSources: { status: 'available', reason: null, artifacts: [{ path: 'secret/spec.md', phase: 'specification', status: 'inaccessible', reason: 'source-inaccessible', digest: null, clauses: [] }] }
  });
  const observation = model.observations.find((entry) => entry.id === 'OBS-SPEC-01');
  assert.equal(observation.reason, 'source-inaccessible');
  assert.doesNotMatch(JSON.stringify(observation), /secret\/spec\.md/u);
  assert.ok(!model.sources.some((entry) => entry.recordId === 'secret/spec.md'));
});

test('XPL2-AC-031 conflicting admitted declarations stay a conflict with both references', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const second = {
    ...fixture.clauseSources.artifacts[0], path: 'singularity/work-items/ORD-418/amended-specification.md', digest: `sha256:${'f'.repeat(64)}`,
    clauses: [{ id: 'ORD:AC-003', type: 'AC', line: 3, body: 'Format timestamps in UTC.', bodySha256: `sha256:${'9'.repeat(64)}` }]
  };
  const model = change({ ...fixture.input, clauseSources: { ...fixture.clauseSources, artifacts: [fixture.clauseSources.artifacts[0], second] } });
  const node = model.nodes.find((entry) => entry.label === 'ORD:AC-003');
  assert.equal(node.status, 'conflicting-declarations');
  const declarations = model.statements.filter((entry) => entry.kind === 'clause-declared' && entry.about === node.id);
  assert.equal(declarations.length, 2);
  assert.deepEqual(new Set(declarations.flatMap((entry) => entry.cites)), new Set(['SRC-SPEC-01', 'SRC-SPEC-02']));
  assert.ok(model.attention.some((entry) => entry.reason === 'conflicting-sources' && entry.about === node.id));
});

test('XPL2-AC-036 a declared clause outside the changed paths is still inspectable by exact id', async (t) => {
  const fixture = await createXpl2Fixture(t, { withGraph: false });
  const extra = { id: 'ORD:AC-010', type: 'AC', line: 30, body: 'Keep the header row stable.', bodySha256: `sha256:${'5'.repeat(64)}` };
  const input = { ...fixture.input, clauseSources: { ...fixture.clauseSources, artifacts: [{ ...fixture.clauseSources.artifacts[0], clauses: [...fixture.clauseSources.artifacts[0].clauses, extra] }] } };
  const view = explainXpl2Subject(input, { subject: 'clause', id: 'ORD:AC-010' });
  assert.equal(view.subject.status, 'available');
  assert.ok(view.statements.some((entry) => entry.kind === 'clause-declared' && /header row/u.test(entry.text)));
  const missing = explainXpl2Subject(input, { subject: 'clause', id: 'ORD:AC-01' });
  assert.equal(missing.subject.reason, 'subject-not-found');
});

test('XPL2-AC-037 a passing test result never renders as clause satisfaction', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'clause', id: 'ORD:AC-001' });
  const kinds = new Set(view.statements.map((entry) => entry.kind));
  assert.ok(kinds.has('clause-declared'));
  assert.ok(!kinds.has('test-result'), 'a command result is not joined to a clause');
  assert.ok(view.relationships.every((edge) => edge.type !== 'test-command-reported-result'));
});

test('XPL2-AC-038 next actions are inspection only and never claim closure', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change(fixture.input);
  for (const action of model.next) {
    assert.equal(action.kind, 'inspect');
    assert.match(action.label, /changes nothing/u);
  }
});

test('XPL2-AC-061 v1 code explanations are unchanged and unregistered vocabulary is refused', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const again = buildCodeExplanation({ context: fixture.input.context, manifest: fixture.manifest, diff: fixture.diff, graph: fixture.graph, evidence: fixture.evidence });
  assert.equal(again.kind, 'comprehension-code-explanation');
  assert.equal(again.schemaVersion, 1);
  assert.equal(again.explanationSha256, fixture.codeExplanation.explanationSha256);
  const { explanationSha256, ...core } = again;
  assert.equal(`sha256:${recordSha256(core)}`, explanationSha256);
  assert.throws(() => xpl2Reason('future-reason'), /Unregistered XPL2 reason/u);
  assert.throws(() => renderTemplate('xpl2.future@9', {}), /Unregistered XPL2 template/u);
  assert.throws(() => renderTemplate('xpl2.hunk@1', { unitId: 'H-001' }), /not a valid/u);
  assert.ok(XPL2_TEMPLATE_IDS.length >= 20 && XPL2_REASON_CODES.includes('region-only-association'));
  assert.ok(Object.values(XPL2_RELATIONSHIPS).every((entry) => entry.means && entry.notImplied));
});

test('XPL2-AC-032 a region association highlights region membership only; hunks keep no exact cause', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = change(fixture.input);
  const regionEdges = model.relationships.filter((edge) => edge.type === 'region-associated-with-clause');
  assert.equal(regionEdges.length, 3);
  for (const edge of regionEdges) {
    assert.equal(edge.granularity, 'region-only');
    assert.ok(model.nodes.find((node) => node.id === edge.to).kind === 'file');
  }
  assert.equal(model.inventory.counts.causeBoundUnits, 0);
  assert.ok(model.inventory.units.filter((unit) => unit.hunk).every((unit) => unit.explanationStatus === 'unexplained'));
});
