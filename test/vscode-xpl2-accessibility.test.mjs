/** Change Explorer accessibility: full-fidelity table and keyboard, themes and narrow layouts. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPLORER_SCRIPT, EXPLORER_STYLE } from '../apps/vscode/src/views/change-explorer.ts';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { XPL2_RELATIONSHIPS } from '../src/comprehension/xpl2/vocabulary.mjs';
import { createXpl2Fixture } from './helpers/xpl2-fixture.mjs';
import { attribute, mapBlock, nodeButtons, relationshipRows, renderExplorer, shown } from './helpers/xpl2-html.mjs';

async function prototypeView(t) {
  const fixture = await createXpl2Fixture(t);
  const view = explainXpl2Subject(fixture.input, { subject: 'change' });
  return { view, html: renderExplorer(view, { patch: fixture.diff.patch, patchFiles: fixture.diff.files, timeline: fixture.replay.events }) };
}

test('XPL2-AC-051 Full-fidelity table and keyboard reach every relationship and source', async (t) => {
  const { view, html } = await prototypeView(t);
  const label = (id) => view.nodes.find((node) => node.id === id)?.label ?? id;
  const drawn = view.relationships.filter((edge) => edge.type !== 'file-contains-unit' && edge.from !== edge.to);

  // Every drawn relationship is also a sentence for assistive technology and a table row.
  const spoken = html.slice(html.indexOf('<ul class="xpl-sr-edges"'), html.indexOf('</ul>', html.indexOf('<ul class="xpl-sr-edges"')));
  for (const edge of drawn) {
    assert.ok(spoken.includes(`<li>${shown(`${label(edge.from)} → ${label(edge.to)}: ${XPL2_RELATIONSHIPS[edge.type].means}`)} (${shown(edge.scope)})</li>`), edge.id);
  }
  assert.equal(relationshipRows(html).length, view.relationships.length);
  assert.match(html, /<th scope="col">Does not imply<\/th>/u);

  // Every map item is a native button with a spoken description, including clustered members.
  const buttons = nodeButtons(mapBlock(html));
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    const tag = html.slice(html.indexOf(`id="${button.domId}"`) - 200, html.indexOf(`id="${button.domId}"`) + 600);
    assert.match(tag, /aria-label="[^"]{12,}"/u, `${button.node} has a description`);
  }
  // The map, table and timeline are one ARIA tab set with arrow-key movement.
  for (const view_ of ['map', 'relationships', 'timeline']) {
    assert.match(html, new RegExp(`role="tab" id="xpl-view-${view_}" aria-controls="xpl-panel-${view_}"`, 'u'));
    assert.match(html, new RegExp(`id="xpl-panel-${view_}" role="tabpanel" aria-labelledby="xpl-view-${view_}"`, 'u'));
  }
  assert.match(html, /role="tablist" aria-label="Map views"/u);
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) assert.ok(EXPLORER_SCRIPT.includes(`'${key}'`), key);
  assert.match(EXPLORER_SCRIPT, /target\.focus\(\)/u);
  assert.match(EXPLORER_SCRIPT, /tab\.tabIndex = active \? 0 : -1;/u);
  // Search has a real label; the diff is a captioned table whose +/− marks are text, not colour.
  assert.match(html, /<label class="xpl-search-label" for="xpl-search">Find a changed file<\/label>/u);
  assert.match(html, /<caption class="xpl-sr">Before and after lines of H-\d{3}; removed and added lines are marked with minus and plus signs\.<\/caption>/u);
  assert.match(html, /<span class="xpl-mark" aria-hidden="true">−<\/span>/u);
  assert.match(html, /<span class="xpl-mark" aria-hidden="true">\+<\/span>/u);

  // Every source or read observation any fact cites is reachable from the inspector.
  const cited = new Set([...view.statements, ...view.relationships, ...view.nodes].flatMap((entry) => entry.cites));
  const listed = html.slice(html.indexOf('All admitted sources'));
  for (const id of cited) assert.ok(listed.includes(`<code>${id}</code>`), `${id} is listed with its properties`);
  assert.match(html, new RegExp(`All admitted sources \\(${view.sources.length + view.observations.length}\\)`, 'u'));
  assert.equal(JSON.parse(attribute(html, 'data-units')).length, view.inventory.units.length);
});

test('XPL2-AC-052 Themes and narrow layouts keep readable labels, focus and equivalent controls', async (t) => {
  // Colours come only from the editor theme, so light, dark and high-contrast themes all apply.
  const declarations = [...EXPLORER_STYLE.matchAll(/(color|background|border(?:-[a-z]+)?|stroke|fill|outline)\s*:\s*([^;}]+)/gu)];
  assert.ok(declarations.length > 20);
  for (const [, property, value] of declarations) {
    assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(red|green|blue|black|white|gr[ae]y|orange|yellow|purple)\b/iu,
      `${property}: ${value.trim()} uses a literal colour`);
  }
  assert.ok((EXPLORER_STYLE.match(/var\(--vscode-/gu) ?? []).length > 30);
  // Focus and selection use the theme's focus border.
  assert.match(EXPLORER_STYLE, /\.xpl-node\.xpl-selected[^{]*\{ outline:2px solid var\(--vscode-focusBorder\)/u);
  // Narrow widths collapse to one column; the drawn edges go away but the table and list remain.
  assert.match(EXPLORER_STYLE, /@media \(max-width: 1100px\)/u);
  assert.match(EXPLORER_STYLE, /@media \(max-width: 760px\) \{ \.xpl-layout \{ grid-template-columns: 1fr; \} \.xpl-map \{ grid-template-columns: 1fr; \} \.xpl-edges, \.xpl-edge-labels \{ display:none; \} \}/u);
  assert.doesNotMatch(EXPLORER_STYLE, /\.xpl-(sr-edges|table)[^{]*\{[^}]*display:\s*none/u);
  assert.match(EXPLORER_STYLE, /@media \(prefers-reduced-motion: reduce\)/u);

  // Status is carried by words, not colour or line style alone.
  const { html } = await prototypeView(t);
  assert.match(html, /<strong>Reason not recorded<\/strong>/u);
  assert.match(html, /<span class="xpl-eyebrow">Observation gap<\/span>/u);
  for (const words of ['Recorded region association', 'Declared tag (@clause in code, @ac in tests)', 'Clause cites clause',
    'Exact path identity', 'Observation gap', 'No test-to-hunk coverage is inferred.']) {
    assert.ok(html.includes(words), `legend explains ${words}`);
  }
  // Equivalent controls: every action is a button, and diff stepping has named controls.
  assert.match(html, /aria-label="Previous change unit"/u);
  assert.match(html, /aria-label="Next change unit"/u);
  assert.match(html, /<select id="xpl-audience" aria-label="Audience ordering">/u);
});
