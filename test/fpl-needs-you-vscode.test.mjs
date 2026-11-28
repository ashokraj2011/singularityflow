// FPL M1 in VS Code (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.3, REQ-012 to REQ-018, REQ-037, A5, A7): the Needs-you tab, its
// one card page and the badge, built from the engine's JSON; the places are the sidebar's default since M5.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  needsYouBadge, needsYouCardFrom, needsYouCardHtml, needsYouListFrom, needsYouPlaceBody
} from '../apps/vscode/src/views/needs-you-page.ts';

const item = (key, group, extra = {}) => ({ key, kind: 'step-approval', group, question: `Approve ${key}?`, why: 'You are in Reviewers, which approves Plan.',
  repository: { id: 'shop-api', name: 'shop-api' }, story: { id: 'TASK-11', title: 'Add CSV export', kind: 'task-feature', task: true },
  step: { id: 'plan', label: 'Plan', version: 1 }, recommended: null, recommendation: 'SFlow checks it when you open the card.',
  choices: [{ id: 'approve', label: 'Approve Plan', command: 'singularity-flow approve plan --work-id TASK-11 --fetch', copilotCommand: '/sf-approve plan --work-id TASK-11' },
    { id: 'return', label: 'Send it back with a note', command: 'singularity-flow reject plan --work-id TASK-11 --fetch --to plan --reason <reason>', copilotCommand: '/sf-reject plan --work-id TASK-11' }],
  route: { checkout: null, clone: '/work/shop-api', here: false, checksOut: true, words: 'Approving checks out TASK-11 in shop-api.',
    elsewhere: { commands: ['singularity-flow session open TASK-11 --workspace shop --repository shop-api'], copilotCommand: '/sf-session TASK-11' } }, ...extra });
const result = (items) => ({ schemaVersion: 1, resultType: 'sflow-needs-you', items, shown: Math.min(items.length, 50), more: Math.max(0, items.length - 50),
  lines: ['shop-web could not be read (offline); showing 10:31.'], counts: { badgeTooltip: '2 things need you' },
  checked: { at: '2026-11-26T10:42:00Z', words: 'Checked 10:42 · 3 repositories' }, workspace: { id: 'shop', name: 'shop' } });

test('A7: the badge counts Holds work and Reviews, never Later, and reads "Needs you: 2 waiting"', () => {
  const list = needsYouListFrom(result([item('a', 'holds-work'), item('b', 'reviews', { kind: 'review' }), item('c', 'later', { kind: 'decision' })]));
  assert.equal(list.counts.badge, 2);
  assert.deepEqual(needsYouBadge(list), { value: 2, tooltip: '2 things need you' });
  assert.equal(list.counts.badgeLabel, 'Needs you: 2 waiting');
  assert.equal(needsYouBadge(needsYouListFrom(result([item('c', 'later')]))), undefined, 'no badge for Later alone');
  const tabs = needsYouPlaceBody(list);
  assert.match(tabs, /role="tablist"/);
  assert.match(tabs, /role="tab"[^>]*aria-selected="true"[^>]*data-tab="needs-you"/);
  assert.match(tabs, /aria-label="Needs you: 2 waiting"/, 'a screen reader reads the count');
  // Advanced is the last row under the place, never a tab [REQ-032].
  assert.doesNotMatch(tabs, /data-tab="advanced"/u);
  assert.match(tabs, /<p class="places-advanced"><button type="button" class="places-link" data-places="advanced">Advanced: today's Navigator, with every other SFlow screen<\/button><\/p>$/u);
});

test('REQ-012: one row per item in the engine\'s order, its question, Story, repository and advice; the first 50 and "Show N more"', () => {
  const many = Array.from({ length: 53 }, (_, index) => item(`k${String(index).padStart(2, '0')}`, 'holds-work'));
  const list = needsYouListFrom(result(many));
  const html = needsYouPlaceBody(list);
  assert.equal((html.match(/class="needs-you-row"/g) ?? []).length, 50);
  assert.match(html, /Show 3 more/);
  assert.match(html, /Checked 10:42 · 3 repositories/);
  assert.match(html, /shop-web could not be read \(offline\); showing 10:31\./);
  assert.match(html, /Add CSV export · TASK-11 · shop-api/);
  assert.equal((needsYouPlaceBody(list, { all: true }).match(/class="needs-you-row"/g) ?? []).length, 53);
  const unsure = needsYouPlaceBody(needsYouListFrom(result([item('u', 'holds-work', { couldNotTell: true })])));
  assert.match(unsure, /SFlow could not tell whether this one is yours/);
  // Untrusted output: a row with a key the engine never makes is dropped, never rendered.
  assert.equal(needsYouListFrom(result([item('bad key <script>', 'holds-work')])).items.length, 0);
});

test('REQ-013, REQ-037: the card asks one question as its first heading, recommended choice first, and announces the result', () => {
  const card = needsYouCardFrom({ resultType: 'sflow-needs-you-card', key: 'a', item: item('a', 'holds-work'), next: { key: 'b', question: 'Approve b?' },
    card: { question: 'Approve Plan?', asked: 'Approve Plan? Add CSV export (TASK-11, task-feature) in shop-api.', why: 'You are in Reviewers, which approves Plan.',
      about: { title: 'What needs your eyes', lines: ['A requirement has no test yet.'] }, checked: ['3 of 4 test runs passed'],
      recommendation: { choice: 'return', words: 'SFlow does not recommend it yet: a decision holds it.' },
      choices: item('a', 'holds-work').choices, place: { checksOut: true, words: 'Approving checks out TASK-11 in shop-api.' } } });
  const html = needsYouCardHtml(card);
  assert.match(html, /<h1 id="card-question" tabindex="-1">Approve Plan\?<\/h1>/);
  assert.ok(html.indexOf('data-choice="return"') < html.indexOf('data-choice="approve"'), 'the recommended choice comes first');
  assert.match(html, /What SFlow checked/);
  assert.match(html, /Approving checks out TASK-11 in shop-api\./);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /Next:/, 'it never moves on by itself');
  const after = needsYouCardHtml(card, { result: 'Approve Plan: recorded.' });
  assert.match(after, /Approve Plan: recorded\./);
  assert.match(after, /data-open="b">Next: Approve b\?/);
  // Words a person reads: no step ID shown as a word, no digest.
  assert.doesNotMatch(html, /[0-9a-f]{40}|sha256:|\bgeneration\b|\bphase\b/u);
});

test('the places are the default since M5 and lazy; the sidebar gains a badge and a tab strip only while they are on', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  const setting = manifest.contributes.configuration.properties['singularityFlow.navigation.layout'];
  assert.equal(setting.default, 'places', 'M5 switched the default to places');
  assert.deepEqual(setting.enum, ['places', 'classic']);
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /const syncPlaces = \(on = sidebarLayout\(vscode\.workspace\.getConfiguration\('singularityFlow'\)\) === 'places'\): void => \{/);
  assert.match(extension, /new \(lazyPanels\(\)\.NeedsYouPlace\)\(/, 'loaded from the lazy panels, never at activation');
  // Every choice runs today's path with a client bound to the item's repository and Story [REQ-014].
  assert.match(extension, /bind: \(where\) => client\.forkForRepository\(where\)/);
  assert.match(extension, /approve: \(bound, request\) => approveWithReceipt\(bound, request, output\)/);
  assert.match(extension, /decide: \(bound, workId\) => lazyPanels\(\)\.reviewDecisions\(bound, \{ workId \}, refreshAfterKnownMutation\)/);
  const lazy = await readFile(new URL('../apps/vscode/src/lazy-panels-runtime.ts', import.meta.url), 'utf8');
  assert.match(lazy, /export \{ NeedsYouPlace, NeedsYouCardPanel \} from '\.\/views\/needs-you\.ts';/);
  const sidebar = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /if \(this\.places \|\| this\.view\.badge\) this\.view\.badge = this\.places\?\.badge\(\);/);
  // Advanced is today's Navigator: sidebarBody's own output, under "← The four places".
  assert.match(sidebar, /this\.paint\(row \? `\$\{row\}\$\{body\}` : body/);
  const place = await readFile(new URL('../apps/vscode/src/views/needs-you.ts', import.meta.url), 'utf8');
  // A5: the item leaves the list and the badge drops at once; a task's chat goes on only from its own window (continueTaskInChat checks).
  assert.match(place, /acted\(key: string\): void \{\n {4}this\.removed\.add\(key\);/);
  assert.match(place, /await this\.host\.continueTask\(workId, item\.step\.id\);/);
  // The 5-minute read waits for the background governor and only while VS Code has focus [REQ-016].
  assert.match(place, /if \(!vscode\.window\.state\.focused\) return;\n {6}void this\.host\.waitUntilIdle\(\)\.then\(\(\) => this\.read\(\{\}\)\);/);
});
