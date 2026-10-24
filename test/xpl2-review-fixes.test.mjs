/**
 * Regressions from the work-xpl2 review: each case failed before its fix.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { compareXpl2Views, renderExplorerComparisonNote } from '../apps/vscode/src/views/change-explorer.ts';
import { implementationBindings } from '../src/implementation-bindings.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { readStoryBindingSources } from '../src/comprehension/xpl2/clause-sources.mjs';
import { deliveredContent, sameDeliveredContent } from '../src/comprehension/xpl2/change-subject.mjs';
import { validateXpl2Narration, xpl2NarrationInput } from '../src/comprehension/xpl2/narration.mjs';
import { explainXpl2Subject, xpl2LineHistoryRequest } from '../src/comprehension/xpl2/subjects.mjs';
import { cliJson, createChangeRepository, createXpl2Fixture, git, isolatedHome, xpl2InputFor } from './helpers/xpl2-fixture.mjs';

const GENERATION = { subject: 'generation', phase: 'implementation', generation: 2 };
const texts = (model) => [...model.statements, ...model.derived].map((entry) => entry.text).join('\n');

test('review 1: an added file is bound with its real line count and joins its unit exactly', async (t) => {
  const fixture = await createXpl2Fixture(t);
  await writeFile(path.join(fixture.root, 'src/export/added.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  git(fixture.root, 'add', 'src/export/added.ts');
  const changeSet = await buildRepositoryChangeSet(fixture.root, { baseCommit: fixture.base, subject: { workId: 'ORD-418', phase: 'implementation', generation: 2 } });
  const bound = await implementationBindings(fixture.root, { changeSet, required: [{ clauseId: 'ORD:AC-003', expectedPaths: ['src/export/added.ts'] }], tags: [] });
  assert.deepEqual(bound.bindings[0].regions[0].hunks, [{ beforeStart: 0, beforeLines: 0, afterStart: 1, afterLines: 3 }], 'three lines, not four');
  const workflow = structuredClone(fixture.workflow);
  workflow.phases.implementation.deliveryEvidence = { ...workflow.phases.implementation.deliveryEvidence, generation: 2, changeSet,
    implementationBindings: { bindings: bound.bindings, bindingsSha256: bound.bindingsSha256 } };
  const { input } = await xpl2InputFor(fixture.root, fixture.base, { workflow, clauseSources: fixture.clauseSources, replay: fixture.replay });
  const view = explainXpl2Subject({ ...input, bindingSources: await readStoryBindingSources(workflow) }, { subject: 'change' });
  const unit = view.inventory.units.find((entry) => entry.path === 'src/export/added.ts');
  assert.ok(unit.hunk, 'the staged added file is a text hunk');
  assert.ok(view.relationships.some((edge) => edge.type === 'binding-covers-unit' && edge.to === unit.nodeId));
  // A receipt recorded before the count was fixed (one line too many) still names the whole added file.
  const legacy = structuredClone(bound.bindings);
  legacy[0].regions[0].hunks[0].afterLines = 4;
  const { bindingsDigest } = await import('../src/implementation-bindings.mjs');
  workflow.phases.implementation.deliveryEvidence.implementationBindings = { bindings: legacy, bindingsSha256: bindingsDigest(legacy) };
  const older = explainXpl2Subject({ ...input, bindingSources: await readStoryBindingSources(workflow) }, { subject: 'change' });
  assert.ok(older.relationships.some((edge) => edge.type === 'binding-covers-unit' && edge.to === unit.nodeId));
});

test('review 2: --subject line outside a Story asks history at the resolved baseline commit', async (t) => {
  const baseline = `${Array.from({ length: 30 }, (_, index) => `const v${index + 1} = ${index + 1};`).join('\n')}\n`;
  const repository = await createChangeRepository(t, { baseline: { 'app.js': baseline }, change: { 'app.js': baseline.replace('const v3 = 3;', 'const v3 = 30;') } });
  const home = await isolatedHome(t);
  const result = cliJson(repository.root, home, ['explain', '--subject', 'line', '--path', 'app.js', '--line', '20', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const derived = result.json.data.explanation.derived;
  assert.ok(derived.some((entry) => entry.kind === 'line-commit'), JSON.stringify(derived.map((entry) => entry.text)));
});

test('review 3: a deleted or renamed-away file says so instead of blaming an unchanged line', async (t) => {
  const old = `${Array.from({ length: 10 }, (_, index) => `const o${index + 1} = ${index + 1};`).join('\n')}\n`;
  const repository = await createChangeRepository(t, {
    baseline: { 'src/old.js': old, 'src/moved.js': old.replaceAll('const o', 'const m') },
    change: { 'src/old.js': null },
    apply: async (root) => { git(root, 'mv', 'src/moved.js', 'src/renamed.js'); }
  });
  const { input, diff } = await xpl2InputFor(repository.root, repository.base);
  const request = (pathName, side = 'after') => xpl2LineHistoryRequest({ codeExplanation: input.codeExplanation, diff, context: input.context },
    { subject: 'line', path: pathName, line: 5, side });
  assert.deepEqual(request('src/old.js'), { kind: 'file-gone', change: 'deleted', path: 'src/old.js', newPath: null });
  assert.deepEqual(request('src/moved.js'), { kind: 'file-gone', change: 'renamed', path: 'src/moved.js', newPath: 'src/renamed.js' });
  assert.equal(request('src/old.js', 'before').kind, 'baseline');
  const deleted = explainXpl2Subject(input, { subject: 'line', path: 'src/old.js', line: 5 }, { lineHistory: { request: request('src/old.js'), result: null } });
  assert.match(texts(deleted), /src\/old\.js is deleted in this captured change, so it has no after-side line 5; ask about the before side\./u);
  assert.doesNotMatch(texts(deleted), /outside the changed units|not inside any change unit/u);
  const renamed = explainXpl2Subject(input, { subject: 'line', path: 'src/moved.js', line: 5 }, { lineHistory: { request: request('src/moved.js'), result: null } });
  assert.match(texts(renamed), /src\/moved\.js is renamed to src\/renamed\.js in this captured change; ask about after-side line 5 of src\/renamed\.js\./u);
});

test('review 4: every attention item is shown in the tour and every statement is shown or counted', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const executions = Array.from({ length: 30 }, (_, index) => ({
    commandId: `suite-${String(index + 1).padStart(2, '0')}`, status: index < 15 ? 'failed' : 'passed', receiptSha256: `sha256:${'2'.repeat(64)}`, affectedRoots: ['src/export']
  }));
  const view = explainXpl2Subject({ ...fixture.input, evidence: { ...fixture.input.evidence, testExecutions: executions } }, { subject: 'change' });
  const tour = view.presentation.tour;
  const shown = tour.flatMap((step) => step.statements);
  for (const entry of view.attention) assert.ok(shown.includes(entry.statement), `attention ${entry.statement} is shown`);
  const counted = shown.length + tour.reduce((sum, step) => sum + step.omitted, 0) + (tour.at(-1).unlisted ?? 0);
  assert.equal(counted, view.statements.length + view.derived.length, 'each statement is shown once or counted once');
  assert.equal(new Set(shown).size, shown.length);
  // A kind that used to belong to no step is now shown (here as an attention item), never dropped.
  const kindOf = (id) => view.statements.find((entry) => entry.id === id)?.kind;
  assert.ok(shown.some((id) => kindOf(id) === 'clause-untagged'));
  assert.equal(tour.find((entry) => entry.step === 'checks').omitted, 3, 'fifteen passed runs: twelve shown in checks, three counted; the fifteen failed ones are all shown as attention');
});

test('review 5: commentary with any link, markup or wrapped secret is withheld', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const input = xpl2NarrationInput(explainXpl2Subject(fixture.input, { subject: 'change' }));
  const id = input.statements[0].id;
  for (const text of ['see https://example.test/run', 'visit www.example.test now', 'write to mailto:someone@example.test',
    'run `rm` first', '# Heading', 'this is **bold**', 'a &gt b', 'see ftp://example.test/x', 'quoted "QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA" token',
    'wrapped (Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZg) value', '> quoted line', '- [x] task']) {
    const result = validateXpl2Narration(JSON.stringify({ sections: [], commentary: { text, citations: [id] } }), input, { commentary: true });
    assert.equal(result.commentary.status, 'withheld', text);
  }
  const plain = validateXpl2Narration(JSON.stringify({ sections: [], commentary: { text: 'The service file changes twice, at the range limits.', citations: [id] } }), input, { commentary: true });
  assert.equal(plain.commentary.status, 'shown');
});

test('review 7: an unreadable or empty attempt store is reported, never read as no attempts', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const unreadable = explainXpl2Subject(fixture.input, GENERATION, { generationSources: {
    invocations: null, prompts: null, attempts: { status: 'inaccessible', records: [], omitted: 0 }
  } });
  assert.ok(unreadable.observations.some((entry) => entry.id === 'OBS-GENERATION-ATTEMPTS' && entry.reason === 'source-inaccessible'));
  assert.match(texts(unreadable), /The test attempt record on this machine could not be read, so nothing is known about its records for this generation\./u);
  const empty = explainXpl2Subject(fixture.input, GENERATION, { generationSources: {
    invocations: null, prompts: null, attempts: { status: 'available', records: [], omitted: 0 }
  } });
  assert.match(texts(empty), /The test attempt record on this machine is readable: 0 records for this generation\./u);
});

test('review 8: editing one hunk of a file reports one changed unit, and an older view is not compared', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const before = await xpl2InputFor(fixture.root, fixture.base);
  const older = explainXpl2Subject({ ...before.input, diff: before.diff }, { subject: 'change' });
  const file = path.join(fixture.root, 'src/export/service.ts');
  await writeFile(file, (await readFile(file, 'utf8')).replace('range.end;', 'range.end + 1;'));
  const after = await xpl2InputFor(fixture.root, fixture.base);
  const newer = explainXpl2Subject({ ...after.input, diff: after.diff }, { subject: 'change' });
  const comparison = compareXpl2Views(older, newer);
  assert.equal(comparison.units.addedCount, 1, 'only the edited hunk is new');
  assert.equal(comparison.units.removedCount, 1);
  assert.equal(comparison.units.kept, older.inventory.units.length - 1);
  const stripped = structuredClone(older);
  for (const unit of stripped.inventory.units) delete unit.unitContentSha256;
  const notComparable = compareXpl2Views(stripped, newer);
  assert.equal(notComparable.units, null);
  assert.match(renderExplorerComparisonNote(notComparable), /cannot be compared unit by unit/u);
});

test('review 9: a re-pointed submodule or other content-less change is not the delivered change', () => {
  const entry = (newObject) => ({ status: 'modified', oldPath: 'vendor/lib', newPath: 'vendor/lib', oldMode: '160000', newMode: '160000',
    oldObject: 'a'.repeat(40), newObject, newContent: { kind: 'non-regular', sha256: null, bytes: 0 } });
  const region = { operation: 'modified', location: { pathBefore: 'vendor/lib', pathAfter: 'vendor/lib', modeBefore: '160000', modeAfter: '160000',
    gitObjectBefore: 'a'.repeat(40), gitObjectAfter: 'c'.repeat(40), contentAfterSha256: null } };
  assert.equal(sameDeliveredContent(deliveredContent(entry('b'.repeat(40))), region), false);
  assert.equal(sameDeliveredContent(deliveredContent(entry('c'.repeat(40))), region), true);
  assert.equal(sameDeliveredContent(deliveredContent(entry(null)), { ...region, location: { ...region.location, gitObjectAfter: null } }), false,
    'two unknown after sides are not the same change');
});

test('review 10: malformed generation records are reported, truncated listings say so, and narration counts toward the bound', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, GENERATION, { generationSources: {
    invocations: { status: 'available', omitted: 0, records: [
      { id: 'inv-ok', status: 'completed', requestedModel: '', startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:01:00.000Z', observationIntegrity: 'machine-local-mac' },
      { id: '', status: 'completed' }
    ] },
    prompts: { status: 'available', enabled: true, retentionDays: 30, integrity: 'verified', omitted: 0, truncated: true, records: [{ id: 'p1', recordedAt: '', source: 'wm-compose', redactions: 0, invocationId: null }] },
    attempts: { status: 'available', omitted: 0, records: [{ attemptId: '_bad', commandId: '', purpose: '', status: '', tests: null }] }
  } });
  assert.match(texts(view), /requested model not recorded/u);
  assert.match(texts(view), /1 record in the model invocation records could not be read and contributes nothing\./u);
  assert.match(texts(view), /1 record in the test attempt records could not be read and contributes nothing\./u);
  const prompts = view.sources.find((source) => source.id === 'SRC-PROMPTS');
  assert.equal(prompts.coverage.complete, false);
  assert.ok(view.derived.find((entry) => entry.kind === 'capture-state' && entry.arguments.capture === 'prompt-log').limitations.includes('partial-inventory'));
  const home = await isolatedHome(t);
  const narrated = cliJson(fixture.root, home, ['explain', '--subject', 'change', '--narrate', '--json']);
  const { wire, explanation, narration } = narrated.json.data;
  assert.equal(wire.explanationBytes, Buffer.byteLength(JSON.stringify(explanation), 'utf8'));
  assert.equal(wire.narrationBytes, Buffer.byteLength(JSON.stringify(narration), 'utf8'));
  assert.equal(wire.bytes, wire.explanationBytes + wire.narrationBytes);
});

test('review 6: the VS Code display parser treats --commentary as a flag, like the engine', async () => {
  const { DISPLAY_BOOLEAN_OPTIONS } = await import('../apps/vscode/src/cli/runner.ts');
  assert.ok(DISPLAY_BOOLEAN_OPTIONS.has('commentary'));
});
