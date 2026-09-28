/** XPL2 relationships: declared mappings never become causes or coverage by transitivity. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { XPL2_RELATIONSHIPS } from '../src/comprehension/xpl2/vocabulary.mjs';
import { createXpl2Fixture, xpl2InputFor } from './helpers/xpl2-fixture.mjs';

test('XPL2-AC-033 Test association is not cause or coverage', async (t) => {
  const fixture = await createXpl2Fixture(t);
  // The tagged test source is itself part of the change, so an exact path identity exists too.
  await mkdir(path.join(fixture.root, 'test'), { recursive: true });
  await writeFile(path.join(fixture.root, 'test/export-range.test.ts'), 'test("ORD:AC-001 range", () => {});\n');
  const associations = [
    { clauseId: 'ORD:AC-001', path: 'src/export/service.ts' },
    { clauseId: 'ORD:AC-002', path: 'src/export/filters.ts' }
  ];
  const first = await xpl2InputFor(fixture.root, fixture.base, { associations });
  const workflow = structuredClone(fixture.workflow);
  workflow.phases.implementation.deliveryEvidence.changeSet.digest = first.manifest.changeSetSha256;
  const { input } = await xpl2InputFor(fixture.root, fixture.base, {
    associations, workflow, clauseSources: fixture.clauseSources, replay: fixture.replay
  });
  const view = explainXpl2Subject(input, { subject: 'change' });
  const kind = (id) => view.nodes.find((node) => node.id === id)?.kind;
  const tests = view.nodes.filter((node) => node.kind === 'test');
  assert.ok(tests.length >= 2);

  // A test reaches a clause only by its declared tag, and a file only when that file is the test
  // source itself; never another file, and never a change unit.
  for (const edge of view.relationships.filter((entry) => kind(entry.from) === 'test' || kind(entry.to) === 'test')) {
    assert.ok(['test-source-tags-clause', 'test-source-in-change'].includes(edge.type), `${edge.type} touches a test`);
    if (edge.type === 'test-source-in-change') {
      const test_ = view.nodes.find((node) => node.id === edge.from);
      const file = view.inventory.files.find((entry) => entry.fileId === edge.to);
      assert.equal(file.path, test_.label, 'exact path identity only');
      assert.equal(edge.scope, 'exact-path');
    }
    assert.notEqual(kind(edge.to), 'unit');
  }
  assert.ok(view.relationships.some((edge) => edge.type === 'test-source-in-change'), 'the fixture exercises the exact-path case');
  // The declared vocabulary says what each relationship does not imply, and nothing implements a hunk.
  assert.match(XPL2_RELATIONSHIPS['test-source-tags-clause'].notImplied, /ran, passed or covers the changed code/u);
  for (const edge of view.relationships) {
    assert.ok(Object.hasOwn(XPL2_RELATIONSHIPS, edge.type), edge.type);
    if (edge.type !== 'file-contains-unit') assert.notEqual(kind(edge.to), 'unit', `${edge.type} is not unit-scoped`);
  }
  assert.equal(view.inventory.counts.causeBoundUnits, 0);
  assert.ok(view.inventory.units.every((unit) => unit.explanationStatus !== 'explained'));
  // Every tagged clause still reports its region-level scope, not hunk scope, in words.
  const regionStatements = view.statements.filter((entry) => entry.kind === 'region-association');
  assert.ok(regionStatements.length >= 2);
  for (const entry of regionStatements) assert.match(entry.text, /its hunks are not individually linked/u);
});
