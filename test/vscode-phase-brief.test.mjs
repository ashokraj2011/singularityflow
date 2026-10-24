/**
 * VS Code "What this phase sees" (World Model v5, M5): the Repository brief one Story phase's prompt
 * carries, as `wm brief --json` returns it, with how it was made and the way to have a model phrase it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { phaseBriefBody } from '../apps/vscode/src/views/phase-brief-page.ts';

const state = { workId: 'STORY-42', phase: 'design', phases: [{ id: 'intake', label: 'Intake' }, { id: 'design', label: 'Design' }], loading: null, error: null };
const text = [
  '# Repository brief: orders at 0123456789ab (for design, focused on this Story)',
  '',
  '## What exists',
  '- orders: 10 code files in java (10 files); 3 entry points. (commit 0123456789ab)',
  '',
  '## Contracts',
  '- POST /orders takes Order and returns it; refuses with 400 (3 checks); tested (OrderController.java:21)',
  '- Configuration orders.max-items = 20 (application.properties:1)',
  '',
  '## Rules that apply',
  '- OrderService.place: when `order.getLines().isEmpty()` → refuses "An order needs at least one line" (HTTP 400). Documented, enforced, tested. (OrderService.java:23; README.md › Business rules)',
  '',
  'Not known: no runtime or incident data.',
  'Read without a model from the committed source. Open the cited lines before relying on a detail.'
].join('\n');
const result = { status: 'ok', phase: 'design', bytes: 612, text, budget: 3072, profile: 'design', saved: false, phrasing: { by: 'template' }, records: ['C-1', 'C-2', 'R-1'], omitted: 2 };

test('the page shows the brief a phase receives, its size against the budget, and where each line comes from', () => {
  const html = phaseBriefBody(result, state);
  assert.match(html, /<h1>What this phase sees<\/h1><p class="meta">Design · Story STORY-42 · the Repository brief in its prompt<\/p>/u);
  assert.match(html, /<option value="design" selected>Design<\/option>/u);
  assert.match(html, /612 of 3,072 bytes · 3 records · 2 more not shown/u);
  assert.match(html, /<h2>Rules that apply<\/h2><ul class="brief-list"><li><p>OrderService\.place: when <code>order\.getLines\(\)\.isEmpty\(\)<\/code> → refuses &quot;An order needs at least one line&quot; \(HTTP 400\)\. Documented, enforced, tested\. <span class="brief-source">OrderService\.java:23; README\.md › Business rules<\/span>/u);
  assert.match(html, /refuses with 400 \(3 checks\); tested <span class="brief-source">OrderController\.java:21<\/span>/u, 'only the closing source is set apart');
  assert.match(html, /3 entry points\. <span class="brief-source">commit 0123456789ab<\/span>/u, 'the repository\'s counts cite the commit');
  assert.match(html, /<p class="meta brief-not-known">Not known: no runtime or incident data\.<\/p>/u);
  assert.match(html, /Read without a model from the committed source\.<\/strong> It is guidance/u);
  assert.match(html, /data-message="polish"[^>]*>Phrase with model<\/button>/u);
  assert.doesNotMatch(html, /data-message="polish"[^>]*disabled/u);
});

test('a phrased brief says who phrased it and lists what kept its fixed wording; a composed prompt is shown as it was composed', () => {
  const phrased = phaseBriefBody({ ...result, phrasing: { by: 'model', model: 'recorded', sentences: 1 },
    polish: { accepted: 1, applied: 1, rejected: [{ text: 'Refunds go through Stripe.', reason: 'names what its records do not contain: Stripe' }] }, note: null }, state);
  assert.match(phrased, /class="brief-mode model"><strong>Phrased by recorded from the records it cites/u);
  assert.match(phrased, /1 model sentence kept the fixed wording<\/summary>.*Refunds go through Stripe\..*names what its records do not contain: Stripe/su);
  const saved = phaseBriefBody({ ...result, saved: true, budget: null, records: [], omitted: null }, state);
  assert.match(saved, /already composed; this is the brief it was composed with/u);
  assert.match(saved, /data-message="polish"[^>]*disabled/u, 'a composed prompt is not phrased again');
  assert.match(saved, /<p class="meta">612 bytes<\/p>/u);
  const off = phaseBriefBody({ ...result, note: 'Model use is off, so the brief keeps its fixed wording.' }, { ...state, loading: null });
  assert.match(off, /<p class="callout" role="status">Model use is off, so the brief keeps its fixed wording\.<\/p>/u);
  assert.match(phaseBriefBody(null, { ...state, loading: 'polish' }), /Asking the model to phrase the brief/u);
  assert.match(phaseBriefBody({ ...result, status: 'none', text: '' }, state), /This phase receives no Repository brief/u);
});

test('the command is contributed, lazy, and opened from each phase of the Story lifecycle', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.showPhaseBrief' && entry.title === 'What This Phase Sees'));
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  const start = extension.indexOf("'singularityFlow.showPhaseBrief': async");
  const handler = extension.slice(start, extension.indexOf("'singularityFlow.explainCodeAtCursor'", start));
  assert.match(handler, /lazyPanels\(\)/u, 'the panel loads with the lazy panels, not at activation');
  assert.match(handler, /story-phase:\(\.\+\):brief/u);
  const runtime = await readFile(new URL('../apps/vscode/src/lazy-panels-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /export \{ PhaseBriefPanel \} from '\.\/views\/phase-brief\.ts';/u);
  const panel = await readFile(new URL('../apps/vscode/src/views/phase-brief.ts', import.meta.url), 'utf8');
  assert.match(panel, /\['wm', 'brief', '--phase', this\.state\.phase, '--work-id', this\.state\.workId, '--json'\]/u);
  assert.match(panel, /if \(polish\) args\.push\('--polish'\)/u);
});
