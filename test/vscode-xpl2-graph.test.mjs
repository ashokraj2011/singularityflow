/** Change Explorer map: linked selection, clustering and the first release without WEL or PE. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPLORER_ALSO_CHANGED_LIMIT, EXPLORER_COLUMN_LIMIT, EXPLORER_EDGE_LIMIT, EXPLORER_SCRIPT
} from '../apps/vscode/src/views/change-explorer.ts';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { XPL2_RELATIONSHIPS } from '../src/comprehension/xpl2/vocabulary.mjs';
import {
  comprehensionSlice, createChangeRepository, createXpl2Fixture, xpl2InputFor
} from './helpers/xpl2-fixture.mjs';
import {
  attribute, mapBlock, nodeButtons, pane, relationshipRows, renderExplorer, shown, withoutClusters
} from './helpers/xpl2-html.mjs';

const lines = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;

/** The relationships the map may draw: everything except file membership, exactly as computed. */
const drawable = (view) => view.relationships.filter((edge) => edge.type !== 'file-contains-unit' && edge.from !== edge.to);

function sentence(view, edge) {
  const label = (id) => view.nodes.find((node) => node.id === id)?.label ?? id;
  return shown(`${label(edge.from)} → ${label(edge.to)}: ${XPL2_RELATIONSHIPS[edge.type].means}`);
}

test('XPL2-AC-049 Linked selection highlights exactly the admitted relations and no phantom edge', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  const html = renderExplorer(view, { patch: fixture.diff.patch, patchFiles: fixture.diff.files });
  const edges = JSON.parse(attribute(html, 'data-edges'));
  const expected = drawable(view);

  // Every drawn edge is a computed relationship with the same endpoints, and nothing else is drawn.
  assert.deepEqual(edges.map((edge) => edge.id).sort(), expected.map((edge) => edge.id).sort());
  for (const edge of edges) {
    const source = expected.find((entry) => entry.id === edge.id);
    assert.equal(edge.fromNode, source.from);
    assert.equal(edge.toNode, source.to);
    assert.equal(edge.style, XPL2_RELATIONSHIPS[source.type].style, `${edge.id} keeps its recorded scope style`);
  }
  // Region associations stay region-scoped and test tags stay declared mappings on the page too.
  assert.ok(edges.some((edge) => edge.style === 'region'));
  assert.ok(edges.every((edge) => edge.style !== 'exact' || XPL2_RELATIONSHIPS[expected.find((entry) => entry.id === edge.id).type].style === 'exact'));

  // Endpoints exist exactly once on the map, so a highlight can never land on a phantom element.
  const map = mapBlock(html);
  const buttons = nodeButtons(map);
  for (const edge of edges) {
    assert.equal(buttons.filter((button) => button.domId === edge.from).length, 1, `${edge.from} is on the map once`);
    assert.equal(buttons.filter((button) => button.domId === edge.to).length, 1, `${edge.to} is on the map once`);
  }

  // Selecting any node relates exactly the endpoints of its admitted relationships (the page's own
  // rule, evaluated over the page's own edge list), and its inspector lists exactly those.
  const related = (nodeId) => new Set([nodeId, ...edges.flatMap((edge) => edge.fromNode === nodeId ? [edge.toNode]
    : edge.toNode === nodeId ? [edge.fromNode] : [])]);
  for (const node of view.nodes.filter((entry) => entry.kind !== 'unit')) {
    const admitted = new Set([node.id, ...expected.flatMap((edge) => edge.from === node.id ? [edge.to] : edge.to === node.id ? [edge.from] : [])]);
    assert.deepEqual([...related(node.id)].sort(), [...admitted].sort(), `${node.id} relates only to its admitted neighbours`);
    const detail = pane(html, node.id);
    assert.ok(detail, `${node.id} has an inspector pane`);
    for (const edge of expected) {
      const touches = edge.from === node.id || edge.to === node.id;
      assert.equal(detail.includes(sentence(view, edge)), touches,
        `${node.id} ${touches ? 'lists' : 'must not list'} ${edge.id} (${edge.type})`);
    }
  }

  // A file's inspector states what is recorded about each of its units, not only about the file.
  for (const file of view.inventory.files) {
    const detail = pane(html, file.fileId);
    for (const unit of view.inventory.units.filter((entry) => entry.fileId === file.fileId)) {
      for (const statement of view.statements.filter((entry) => entry.about === unit.nodeId)) {
        assert.ok(detail.includes(shown(statement.text)), `${file.path} pane states ${statement.id}`);
      }
    }
  }

  // A clause's selection reaches code only through its recorded region association, never by a
  // transitive test-to-clause-to-code join.
  const clause = view.nodes.find((node) => node.kind === 'clause' && node.label === 'ORD:AC-001');
  const reached = [...related(clause.id)].map((id) => view.nodes.find((node) => node.id === id));
  assert.ok(reached.some((node) => node?.kind === 'file'));
  assert.ok(reached.filter((node) => node?.kind === 'file').every((file) => expected.some((edge) =>
    edge.type === 'region-associated-with-clause' && edge.from === clause.id && edge.to === file.id)));

  // Every unit carries the file it belongs to, so "follow the selection" always has exact code.
  const units = JSON.parse(attribute(html, 'data-units'));
  for (const file of view.inventory.files) {
    assert.ok(units.some((unit) => unit.fileId === file.fileId), `${file.path} has a selectable unit`);
  }
  assert.deepEqual(Object.keys(units[0]).sort(), ['digest', 'fileId', 'nodeId', 'unitId']);

  // The Relationships table lists every relationship, including those the map never draws.
  const rows = relationshipRows(html);
  assert.equal(rows.length, view.relationships.length);
  assert.deepEqual(rows.map((row) => `${row.from}|${row.type}|${row.to}`).sort(),
    view.relationships.map((edge) => `${edge.from}|${edge.type}|${edge.to}`).sort());
});

test('XPL2-AC-024 Clustering preserves counts beyond the initial graph budget', async (t) => {
  const baseline = {};
  const change = {};
  for (let index = 0; index < 30; index += 1) {
    const file = `src/area-${String(index).padStart(2, '0')}.ts`;
    baseline[file] = lines(12, (line) => `export const value${line} = ${line};`);
    change[file] = lines(12, (line) => line === 6 ? `export const value6 = ${index * 100};` : `export const value${line} = ${line};`);
  }
  baseline['assets/logo.bin'] = Buffer.from([0, 1, 2, 3]);
  change['assets/logo.bin'] = Buffer.from([0, 1, 2, 4]);
  const { root, base } = await createChangeRepository(t, { baseline, change });
  const associations = Array.from({ length: 16 }, (_, index) => ({
    clauseId: `AREA:AC-${String(index + 1).padStart(3, '0')}`, path: `src/area-${String(index).padStart(2, '0')}.ts`
  }));
  const { diff, input } = await xpl2InputFor(root, base, { associations });
  const view = explainXpl2Subject(input, { subject: 'change' });
  const html = renderExplorer(view, { patch: diff.patch, patchFiles: diff.files });
  const map = mapBlock(html);
  const initial = nodeButtons(withoutClusters(map));
  const all = nodeButtons(map);

  const clauses = view.nodes.filter((node) => node.kind === 'clause');
  const linkedFiles = new Set(drawable(view).filter((edge) => edge.type === 'region-associated-with-clause').map((edge) => edge.to));
  const alsoChanged = view.inventory.files.filter((file) => !linkedFiles.has(file.fileId));
  assert.equal(clauses.length, 16);
  assert.equal(linkedFiles.size, 16);
  assert.equal(alsoChanged.length, 15, '14 unassociated text files plus the binary resource');

  // Labelled clusters with their exact member counts; nothing is dropped from the page.
  assert.match(map, new RegExp(`${16 - EXPLORER_COLUMN_LIMIT} more in intent — counted, not hidden`, 'u'));
  assert.match(map, new RegExp(`${16 - EXPLORER_COLUMN_LIMIT} more in changed code — counted, not hidden`, 'u'));
  assert.match(map, new RegExp(`Also changed \\(${alsoChanged.length}\\)`, 'u'));
  assert.match(map, new RegExp(`${alsoChanged.length - EXPLORER_ALSO_CHANGED_LIMIT} more also changed — counted, not hidden`, 'u'));
  assert.ok(initial.length <= 40, `the first view shows ${initial.length} nodes; the goal is at most forty`);
  const onMap = view.nodes.filter((node) => node.kind !== 'unit');
  for (const node of onMap) {
    assert.equal(all.filter((button) => button.node === node.id).length, 1, `${node.label} is on the map exactly once`);
  }
  assert.equal(all.length, onMap.length);
  assert.equal(Number(attribute(html, 'data-edge-limit')), EXPLORER_EDGE_LIMIT);
  // Clustered members are never drawn to or focused while their cluster is closed.
  assert.match(EXPLORER_SCRIPT, /const shown = \(element\) => element\.offsetParent !== null && !element\.closest\('details:not\(\[open\]\)'\);/u);
  assert.match(EXPLORER_SCRIPT, /if \(!from \|\| !to \|\| !shown\(from\) \|\| !shown\(to\)\) continue;/u);
  assert.match(EXPLORER_SCRIPT, /nodeElements\(\)\.filter\(shown\)/u);

  // Unexplained and opaque units remain in the authorized total everywhere counts are shown.
  const counts = view.inventory.counts;
  assert.equal(counts.files, 31);
  assert.equal(counts.changeUnits, view.inventory.units.length);
  assert.ok(counts.opaqueUnits >= 1);
  assert.match(html, new RegExp(`<strong>${counts.files}</strong><span>changed files</span>`, 'u'));
  assert.match(html, new RegExp(`<strong>${counts.opaqueUnits}</strong><span>opaque units</span>`, 'u'));
  assert.match(html, new RegExp(`${counts.changeUnits} of ${counts.changeUnits} change units accounted for`, 'u'));
  for (const file of view.inventory.files) {
    assert.ok(html.includes(`data-path="${shown(file.path.toLowerCase())}"`), `${file.path} stays in the inventory rail`);
  }
  assert.equal(relationshipRows(html).length, view.relationships.length, 'every relationship remains in the table');
});

test('XPL2-AC-050 First release without WEL, PE, AST cache or causes still supports inspection', async (t) => {
  const { root } = await createChangeRepository(t, {
    baseline: {
      'src/orders.ts': lines(30, (line) => `export const order${line} = ${line};`),
      'src/legacy.ts': lines(5, (line) => `export const legacy${line} = ${line};`),
      'assets/icon.bin': Buffer.from([0, 9, 8, 7])
    },
    change: {
      'src/orders.ts': lines(30, (line) => line === 12 ? 'export const order12 = 1200;' : `export const order${line} = ${line};`),
      'src/legacy.ts': null,
      'assets/icon.bin': Buffer.from([0, 9, 8, 6])
    }
  });
  // The exact slice the Comprehension Center leases; no Story, graph, WEL, PE or structure cache.
  const slice = await comprehensionSlice(root);
  const view = slice.explanationView;
  assert.ok(view, `the computed view is available (${slice.explanationViewUnavailableReason})`);
  assert.equal(view.subject.status, 'available');
  assert.equal(view.availability.wel, 'disabled');
  assert.equal(view.availability.pe, 'unavailable');
  assert.equal(view.availability.structure, 'unavailable');
  assert.equal(view.availability.cause, 'unavailable');
  assert.equal(view.inventory.counts.files, 3);

  const html = renderExplorer(view, { patch: slice.diff.patch, patchFiles: slice.diff.files, timeline: slice.replay?.events ?? null });
  // Inventory: every changed resource, with no intent invented for it.
  for (const file of view.inventory.files) assert.ok(html.includes(`<strong>${shown(file.path)}</strong>`), file.path);
  assert.match(html, /No clause is named by a tag in the changed files, a recorded association or a delivery record\./u);
  assert.match(html, /Also changed \(3\)/u);
  // Diff: the first text hunk has an exact before/after preview and the native diff action.
  const first = view.inventory.units.find((unit) => unit.hunk);
  const preview = html.slice(html.indexOf(`data-unit-pane="${first.unitId}"`));
  assert.match(preview.slice(0, preview.indexOf('</section>')), /<table class="xpl-diff">/u);
  assert.match(html, /data-message="explorer-open-diff"/u);
  // Sources: every admitted source and read observation is listed with its properties.
  assert.match(html, new RegExp(`All admitted sources \\(${view.sources.length + view.observations.length}\\)`, 'u'));
  assert.ok(view.observations.some((observation) => observation.id === 'OBS-CAUSE'));
  // Useful next inspection: attention items point at unexplained changes, none of them a blocker.
  assert.ok(view.attention.length > 0);
  assert.ok(view.attention.every((entry) => entry.category !== 'blocker'));
  assert.match(html, /data-next-attention/u);
  assert.match(html, /WEL off/u);
  assert.match(html, /No Story history is bound to this repository view/u);
});
