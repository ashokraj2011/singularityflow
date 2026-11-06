/**
 * The decisions table on both hosts: what the approved plan settled is on it, by its entry, and is
 * never a question. With nothing open there is no form to fill in and no page to close.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionsTable, runDecisions } from '../plugin/extensions/decisions/decisions.mjs';
import { adjudicationHtml } from '../apps/vscode/src/views/adjudication-page.ts';

const STRAY = 'test-results/.last-run.json';
const REASON = 'Test-only: gives the suite a local storage stand-in; no product behaviour changes.';
const settled = [
  { id: 'CF-21034d278357', paths: ['package.json'], clauseIds: [], decision: null,
    settledBy: { kind: 'supporting', phase: 'planning', generation: 1, class: 'build-configuration', text: 'add the browser test dependency and its script.' } },
  { id: 'CF-d481d2555b77', paths: ['src/test/setup.js'], clauseIds: [], decision: null,
    settledBy: { kind: 'amendment', id: 'PAM-001', clause: 'BIN:REQ-001', class: null, text: REASON } }
];

test('the decisions table on both hosts says it is settled, by which entry, and asks nothing about it', async () => {
  const list = { status: 'open', workId: 'BIN-1', phase: 'convergence', repositoryPath: '/repo', open: 1, digest: 'sha256:abc', settled,
    items: [{ id: 'CF-b707f55e9cd0', kind: 'unclaimed-changed-path', paths: [STRAY], clauseIds: [], detail: null, plan: null, acceptAll: true, decision: null }],
    decidedBy: { groups: ['reviewers'], labels: ['Reviewers'], allowed: true, words: 'You may decide these (Reviewers).' },
    dispositions: [{ id: 'accepted-deviation', label: 'Accept as is' }, { id: 'rework', label: 'Send back to fix' }] };

  const table = decisionsTable(list);
  assert.match(table, /1 of 1 still need a decision\. 2 settled by the plan, not asked\./u);
  assert.match(table, /\| package\.json \| Supporting file: add the browser test dependency and its script\. \| Settled by the plan \|/u);
  assert.match(table, /\| src\/test\/setup\.js \| PAM-001 under BIN:REQ-001: Test-only/u);

  const html = adjudicationHtml(list);
  assert.match(html, /Settled by the plan/u);
  assert.match(html, /these 2 changed files/u);
  assert.match(html, /PAM-001 under BIN:REQ-001: Test-only/u);
  assert.match(html, /data-open="package\.json"/u, 'a settled file cannot be opened from the table');
  // A settled row can be overruled, so it has a row of its own, and only the open one is a question.
  assert.equal((html.match(/data-item="[^"]*" data-accept-all/gu) ?? []).length, 1, 'a settled path became a question on the page');
  assert.equal((html.match(/data-settled=/gu) ?? []).length, 2);
  assert.match(html, /Accept all 1 changed file with one reason/u, 'Accept all reached a settled path');

  // Copilot CLI: the forms reach only the file nobody answered.
  const asked = [];
  const result = await runDecisions({ read: async () => list, show: async () => {}, ask: async (form) => { asked.push(form); return { action: 'cancel' }; }, record: async () => ({}) });
  assert.equal(result.status, 'cancelled');
  assert.match(asked[0].message, /1 of 1/u);

  // An entry that does not settle its file says why the person is still asked, in the same words on both hosts.
  const stillAsked = { ...list, items: [{ ...list.items[0], plan: { kind: 'supporting', text: 'lock the dependency.', askedBecause: 'the file was deleted, which the entry does not record' } }] };
  assert.match(decisionsTable(stillAsked), /Supporting file: lock the dependency\. · Still asked: the file was deleted, which the entry does not record\./u);
  assert.match(adjudicationHtml(stillAsked), /Supporting file: lock the dependency\. · Still asked: the file was deleted, which the entry does not record\./u);

  // Nothing open is not a question in a chat: no form. A person who opens it themselves may overrule (copilot-cli-decisions).
  const none = { ...list, items: [], open: 0 };
  const shown = [];
  const quiet = await runDecisions({ askedInChat: true, read: async () => none, show: async (text) => { shown.push(text); }, ask: async () => assert.fail('asked with nothing open'), record: async () => assert.fail('recorded with nothing open') });
  assert.equal(quiet.status, 'nothing-open');
  assert.match(shown[0], /2 settled by the plan, not asked\./u);
  const closed = adjudicationHtml(none);
  assert.match(closed, /Nothing here needs a decision\./u);
  assert.match(closed, /data-review/u, 'a settled row can still be overruled here, with nothing chosen');
  assert.doesNotMatch(closed, /<option [^>]*selected/u);
  assert.match(closed, /PAM-001 under BIN:REQ-001/u);
});

test('a person who overruled the plan on a settled path sees their answer on the row', () => {
  const list = { status: 'open', workId: 'BIN-1', phase: 'convergence', repositoryPath: '/repo', open: 0, items: [],
    settled: [{ ...settled[0], decision: { disposition: 'rework', reason: 'Not this script.', clauseIds: [], actor: 'reviewer', at: '2026-11-06T06:25:01.660Z' } }],
    decidedBy: { groups: ['reviewers'], labels: ['Reviewers'], allowed: true, words: 'You may decide these (Reviewers).' },
    dispositions: [{ id: 'rework', label: 'Send back to fix' }] };
  assert.match(decisionsTable(list), /\| package\.json \| Supporting file: add the browser test dependency and its script\. \| Send back to fix \|/u);
  assert.match(adjudicationHtml(list), /Send back to fix/u);
});

test('text from the repository on a settled row cannot become markup', () => {
  const list = { status: 'open', workId: 'BIN-1', phase: 'convergence', repositoryPath: '/repo', open: 0, items: [],
    settled: [{ ...settled[0], paths: ['<img src=x onerror=alert(1)>.js'], settledBy: { kind: 'supporting', text: '<script>alert(1)</script>' } }] };
  const html = adjudicationHtml(list);
  assert.doesNotMatch(html, /<img|<script/u);
});

test('a changed answer shows what it replaced and whose it was, on both hosts', () => {
  const decision = { disposition: 'rework', reason: 'It breaks the retry.', clauseIds: [], actor: 'reviewer-two', at: '2026-11-06T09:00:00.000Z',
    replaced: [{ disposition: 'accepted-deviation', reason: 'Fine as it is.', actor: 'reviewer-one', at: '2026-11-05T08:00:00.000Z' }] };
  const list = { status: 'open', workId: 'BIN-1', phase: 'convergence', repositoryPath: '/repo', open: 0, digest: 'sha256:abc', settled: [],
    items: [{ id: 'CF-b707f55e9cd0', kind: 'unclaimed-changed-path', paths: [STRAY], clauseIds: [], detail: null, plan: null, acceptAll: true, decision }],
    decidedBy: { groups: ['reviewers'], labels: ['Reviewers'], allowed: true, words: 'You may decide these (Reviewers).' },
    dispositions: [{ id: 'accepted-deviation', label: 'Accept as is' }, { id: 'rework', label: 'Send back to fix' }] };
  assert.match(decisionsTable(list), /Send back to fix, changed from Accept as is by reviewer-one \|/u);
  assert.match(adjudicationHtml(list), /Changed from Accept as is by reviewer-one on 2026-11-05: Fine as it is\./u);
  const unchanged = { ...list, items: [{ ...list.items[0], decision: { ...decision, replaced: [] } }] };
  assert.doesNotMatch(decisionsTable(unchanged), /changed from/u);
  assert.doesNotMatch(adjudicationHtml(unchanged), /Changed from/u);
});
