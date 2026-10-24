/**
 * XPL2 M4: exact links from implementation bindings, joined to captured units by content.
 *
 * The bindings are produced by their real owner (`implementationBindings`) over a real disposable
 * Git change, and admitted through `readStoryBindingSources`. A binding joins a unit only when the
 * capture holds the very file change the receipt delivered; nothing is joined by display ID, and a
 * region association is never upgraded to a hunk link.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { implementationBindings } from '../src/implementation-bindings.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { readStoryBindingSources } from '../src/comprehension/xpl2/record-sources.mjs';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { createXpl2Fixture, xpl2InputFor } from './helpers/xpl2-fixture.mjs';

const REQUIRED = [
  { clauseId: 'ORD:AC-001', expectedPaths: ['src/export/service.ts'] },
  { clauseId: 'ORD:AC-002', expectedPaths: ['src/export/service.ts', 'src/export/filters.ts'] }
];

/** Deliver the fixture's current change: the owner binds each clause to its planned paths' hunks. */
async function delivered(fixture, { required = REQUIRED, approve = true } = {}) {
  const changeSet = await buildRepositoryChangeSet(fixture.root, {
    baseCommit: fixture.base, subject: { workId: 'ORD-418', phase: 'implementation', generation: 2 }
  });
  const bound = await implementationBindings(fixture.root, { changeSet, required, tags: [] });
  const workflow = structuredClone(fixture.workflow);
  const phase = workflow.phases.implementation;
  phase.deliveryEvidence = {
    ...phase.deliveryEvidence, generation: 2, changeSet,
    implementationBindings: { bindings: bound.bindings, bindingsSha256: bound.bindingsSha256 }
  };
  phase.approvals = approve ? [{
    decision: 'approved', phase: 'implementation', generation: 2, at: '2026-10-02T10:00:00.000Z',
    implementationBindings: {
      bindingsSha256: bound.bindingsSha256,
      decisions: [
        { clauseId: 'ORD:AC-001', decision: 'accepted' },
        { clauseId: 'ORD:AC-002', decision: 'accepted-with-exception', reason: 'The filter change is covered by the export suite.' }
      ]
    }
  }] : [];
  return { workflow, bound };
}

async function viewOf(fixture, workflow, query = { subject: 'change' }) {
  const bindingSources = await readStoryBindingSources(workflow);
  const input = { ...fixture.input, workflow, bindingSources };
  return { view: explainXpl2Subject(input, query), bindingSources };
}

const edgesOf = (view, type) => view.relationships.filter((edge) => edge.type === type);

test('XPL2-AC-034 one hunk with two exact bindings shows both, counts the unit once and keeps each scope', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const { workflow } = await delivered(fixture);
  const { view } = await viewOf(fixture, workflow);
  const exact = edgesOf(view, 'binding-covers-unit');
  const serviceUnits = view.inventory.units.filter((unit) => unit.path === 'src/export/service.ts').map((unit) => unit.nodeId);
  assert.equal(serviceUnits.length, 2, 'two separate hunks in the service file');
  for (const unit of serviceUnits) {
    assert.deepEqual(exact.filter((edge) => edge.to === unit).map((edge) => edge.from).sort(), ['clause:ORD:AC-001', 'clause:ORD:AC-002']);
  }
  assert.equal(view.inventory.counts.causeBoundUnits, 3, 'two service hunks and the filter hunk, each counted once');
  assert.equal(view.inventory.counts.exactLinks, 5);
  assert.equal(view.inventory.counts.changeUnits, view.inventory.units.length, 'totals never double count');
  for (const edge of exact) {
    assert.equal(edge.granularity, 'exact-interval');
    assert.equal(edge.scope, 'implementation generation 2 receipt');
  }
  const statements = view.statements.filter((entry) => entry.kind === 'exact-cause');
  assert.equal(statements.length, 5);
  assert.match(statements.find((entry) => entry.arguments.clauseId === 'ORD:AC-001').text,
    /^H-\d{3} holds changed lines \(after line \d+\) that the implementation code-delivery receipt \(generation 2\) binds to ORD:AC-001, as delivered hunks of its planned path src\/export\/service\.ts\. The phase approval accepted this binding\. A binding maps changed lines to a clause; it does not show that the code meets it\.$/u);
  assert.ok(statements.filter((entry) => entry.arguments.clauseId === 'ORD:AC-002').every((entry) => entry.arguments.decision === 'accepted-with-exception'));
  // Bound units are no longer "reason not recorded"; the unbound ones still are.
  const missing = view.statements.filter((entry) => entry.kind === 'cause-not-recorded').map((entry) => entry.about);
  for (const edge of exact) assert.ok(!missing.includes(edge.to), `${edge.to} is bound`);
  assert.ok(missing.some((about) => view.inventory.units.find((unit) => unit.nodeId === about)?.path === 'src/export/format.ts'));
  // The approval's decisions are their own records about the binding set.
  const decisions = view.statements.filter((entry) => entry.kind === 'binding-decision').map((entry) => entry.text);
  assert.ok(decisions.some((text) => /binding of ORD:AC-002 is accepted with an exception \(exception: “The filter change is covered by the export suite\.”\); it is a decision about the binding/u.test(text)));
  assert.equal(edgesOf(view, 'decision-covers-binding').length, 2);
  // Nothing calls the code correct.
  assert.doesNotMatch(view.statements.map((entry) => entry.text).join('\n'), /\b(?:proven|proved|satisfied|implements the clause)\b/iu);
});

test('XPL2-AC-032 a region association stays region-only while exact bindings stay exact', async (t) => {
  const fixture = await createXpl2Fixture(t);
  // format.ts has a recorded region association in the fixture's cause graph, and its planned
  // obligation is bound here with no hunks at all (a whole-region binding).
  const { workflow, bound } = await delivered(fixture, { required: [...REQUIRED, { clauseId: 'ORD:AC-003', expectedPaths: ['src/export/format.ts'] }] });
  const format = bound.bindings.find((entry) => entry.clauseId === 'ORD:AC-003');
  format.regions = format.regions.map((region) => ({ ...region, hunks: [] }));
  workflow.phases.implementation.deliveryEvidence.implementationBindings = {
    bindings: bound.bindings, bindingsSha256: (await import('../src/implementation-bindings.mjs')).bindingsDigest(bound.bindings)
  };
  const { view } = await viewOf(fixture, workflow);
  const formatFile = view.inventory.files.find((file) => file.path === 'src/export/format.ts');
  const formatUnits = new Set(view.inventory.units.filter((unit) => unit.fileId === formatFile.fileId).map((unit) => unit.nodeId));
  assert.equal(edgesOf(view, 'binding-covers-unit').filter((edge) => formatUnits.has(edge.to)).length, 0, 'no hunk link for format.ts');
  const region = edgesOf(view, 'region-associated-with-clause').filter((edge) => edge.to === formatFile.fileId);
  assert.deepEqual(region.map((edge) => edge.qualifier).sort(), ['implementation-binding', 'implements']);
  for (const unit of formatUnits) {
    assert.ok(view.statements.some((entry) => entry.kind === 'cause-not-recorded' && entry.about === unit
      && entry.limitations.includes('region-only-association')), 'child hunks keep no exact cause');
  }
});

test('XPL2-AC-035 a binding from another change cannot reach the new unit with the same display ID', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const { workflow } = await delivered(fixture);
  const before = (await viewOf(fixture, workflow)).view;
  // The person edits the bound file after delivery: same path, same H- display IDs, other bytes.
  const file = path.join(fixture.root, 'src/export/service.ts');
  const lines = (await readFile(file, 'utf8')).split('\n');
  lines[4] = '  const step5 = range.start + 1;';
  await writeFile(file, lines.join('\n'));
  const { input } = await xpl2InputFor(fixture.root, fixture.base, {
    workflow, clauseSources: fixture.clauseSources, replay: fixture.replay,
    associations: [{ clauseId: 'ORD:AC-003', path: 'src/export/format.ts' }]
  });
  const bindingSources = await readStoryBindingSources(workflow);
  const after = explainXpl2Subject({ ...input, bindingSources }, { subject: 'change' });
  const ids = (view) => view.inventory.units.filter((unit) => unit.path === 'src/export/service.ts').map((unit) => unit.unitId);
  assert.deepEqual(ids(after), ids(before), 'the display IDs are the same');
  const serviceUnits = new Set(after.inventory.units.filter((unit) => unit.path === 'src/export/service.ts').map((unit) => unit.nodeId));
  assert.equal(edgesOf(after, 'binding-covers-unit').filter((edge) => serviceUnits.has(edge.to)).length, 0);
  const stale = after.statements.filter((entry) => entry.kind === 'binding-not-joined' && entry.arguments.path === 'src/export/service.ts');
  assert.equal(stale.length, 2, 'both clauses bound to the service file are reported, not joined');
  for (const entry of stale) assert.match(entry.text, /but they are not joined to this capture\. The source describes a different subject, revision or scope\./u);
  assert.ok(after.attention.some((entry) => entry.reason === 'source-scope-mismatch'));
  // The untouched filter file still joins: staleness is per file change, never global.
  assert.ok(edgesOf(after, 'binding-covers-unit').some((edge) => after.inventory.units.find((unit) => unit.nodeId === edge.to)?.path === 'src/export/filters.ts'));
});

test('a tampered binding set or change set contributes nothing; an unmatched approval decides nothing', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const { workflow } = await delivered(fixture);
  const forged = structuredClone(workflow);
  forged.phases.implementation.deliveryEvidence.implementationBindings.bindings[0].clauseId = 'ORD:AC-999';
  const tampered = (await viewOf(fixture, forged)).view;
  assert.equal(edgesOf(tampered, 'binding-covers-unit').length, 0);
  assert.ok(tampered.observations.some((entry) => entry.id === 'OBS-BINDINGS-01' && entry.reason === 'integrity-failed'));
  assert.ok(!tampered.nodes.some((node) => node.label === 'ORD:AC-999'));
  const movedSet = structuredClone(workflow);
  movedSet.phases.implementation.deliveryEvidence.changeSet.entries[0].newContent = { kind: 'regular-file', sha256: `sha256:${'0'.repeat(64)}`, bytes: 1 };
  assert.equal(edgesOf((await viewOf(fixture, movedSet)).view, 'binding-covers-unit').length, 0);
  const other = structuredClone(workflow);
  other.phases.implementation.approvals[0].implementationBindings.bindingsSha256 = `sha256:${'1'.repeat(64)}`;
  const undecided = (await viewOf(fixture, other)).view;
  assert.ok(undecided.statements.filter((entry) => entry.kind === 'exact-cause').every((entry) => /No approval has decided this binding yet\./u.test(entry.text)));
  assert.equal(edgesOf(undecided, 'decision-covers-binding').length, 0);
});

test('a bound changed line names its binding and never an author; impact stays a named unavailability', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const { workflow } = await delivered(fixture);
  const { view } = await viewOf(fixture, workflow, { subject: 'line', path: 'src/export/service.ts', line: 5 });
  const line = view.derived.find((entry) => entry.kind === 'line-binding');
  assert.match(line.text, /^After-side line 5 of src\/export\/service\.ts is one of the changed lines in H-\d{3} that the implementation code-delivery receipt \(generation 2\) binds to ORD:AC-001, ORD:AC-002\. A binding maps lines to a clause; it does not say who or what wrote them\.$/u);
  const context = (await viewOf(fixture, workflow, { subject: 'line', path: 'src/export/service.ts', line: 3 })).view;
  assert.ok(!context.derived.some((entry) => entry.kind === 'line-binding'), 'an unchanged context line inside the unit is not a bound line');
  const change = (await viewOf(fixture, workflow)).view;
  assert.equal(change.availability.impact, 'unavailable');
  assert.equal(change.observations.find((entry) => entry.id === 'OBS-IMPACT').reason, 'adapter-unavailable');
  assert.equal(change.availability.cause, 'partial');
});
