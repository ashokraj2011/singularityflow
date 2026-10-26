import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { compareStoryCreation, storyCreatorName } from '../src/story-presentation.mjs';
import { storyLedgerSummary } from '../src/story-publication-binding.mjs';
import { buildInbox } from '../apps/vscode/src/views/inbox-model.ts';
import { workspaceStoriesHtml, STORY_FILTER_SCRIPT } from '../apps/vscode/src/views/workspace-stories-page.ts';
import { discoverWorkspaceStoryRows } from '../apps/vscode/src/story-discovery.ts';
import { EMPTY_INTAKE_FORM, intakeHtml, INTAKE_SCRIPT } from '../apps/vscode/src/views/intake-form.ts';
import { repository, withMachineState } from './helpers/environment-files-fixture.mjs';
import { sessionListingSnapshot } from '../src/session-listing-cache.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { storiesByRepository } from '../apps/vscode/src/cli/snapshot.ts';
import { buildStories } from '../apps/vscode/src/views/stories-model.ts';

const rows = () => [
  { id: 'old', createdAt: '2026-10-01T00:00:00Z', createdBy: 'Builder One', status: 'in_progress' },
  { id: 'unknown', createdAt: null, status: 'in_progress' },
  { id: 'new', createdAt: '2026-10-03T00:00:00+02:00', createdBy: 'Builder Two', status: 'closed' },
  { id: 'bad', createdAt: 'invalid', status: 'in_progress' },
  { id: 'same-time', createdAt: '2026-10-02T22:00:00Z', status: 'cancelled' }
];

test('creation sorting uses instants, deterministic ties and unknown-last without mutating inputs', () => {
  const input = rows(), before = structuredClone(input);
  assert.deepEqual([...input].sort(compareStoryCreation).map(row => row.id), ['new', 'same-time', 'old', 'bad', 'unknown']);
  assert.deepEqual(input, before);
  assert.equal(storyCreatorName({ name: ' Builder ', email: 'other@example.test' }), 'Builder');
  assert.equal(storyCreatorName({ login: 'sample-user' }), 'sample-user');
  assert.equal(storyCreatorName({ email: 'builder@example.test' }), 'builder@example.test');
  for (const value of [null, undefined, '', {}, { name: 42 }]) assert.equal(storyCreatorName(value), null);
});

test('publication retains the original creator rather than the publisher', () => {
  const summary = storyLedgerSummary({ workItem: { id: 'story', title: 'Sample', createdAt: '2026-10-01T00:00:00Z', createdBy: { name: 'Original Builder' } } });
  assert.equal(summary.createdBy, 'Original Builder');
  assert.equal(summary.createdAt, '2026-10-01T00:00:00Z');
});

function inbox() {
  return buildInbox({ repository: { root: '/workspace/repo' }, initiative: null, workflow: null,
    documents: [], selectedWorkId: 'old', workItems: rows().map(row => ({ ...row, title: row.id, currentPhase: 'specification' })) }, [], '/workspace/repo');
}

test('workspace catalog, Inbox and Story table agree despite current/terminal flags', async () => {
  const model = inbox();
  assert.deepEqual(model.stories.map(row => row.workId), ['new', 'same-time', 'old', 'bad', 'unknown']);
  assert.equal(model.stories.find(row => row.workId === 'old').current, true);
  assert.equal(model.stories[0].createdBy, 'Builder Two');
  const html = workspaceStoriesHtml(model, '');
  assert.ok(html.indexOf('data-identity="new:') < html.indexOf('data-identity="old:'));
  for (const key of ['title', 'repository', 'created', 'creator', 'phase', 'status']) assert.ok(html.includes(`data-story-sort="${key}"`));
  assert.match(html, /aria-sort="descending"/);
  assert.match(html, /Builder Two/);
  assert.match(html, /Not recorded/);
  const result = await discoverWorkspaceStoryRows([{ id: 'repo', absolutePath: '/workspace/repo', state: 'ready' }], async () => ({ items: rows() }));
  assert.deepEqual(result.stories.map(row => row.id), ['new', 'same-time', 'old', 'bad', 'unknown']);
  assert.equal(result.stories[0].createdBy, 'Builder Two');
  const escaped = workspaceStoriesHtml({ ...model, stories: [{ ...model.stories[0], createdBy: '<img onerror="x">' }] }, '');
  assert.doesNotMatch(escaped, /<img/);
  assert.match(escaped, /&lt;img/);
});

function browser(saved = {}) {
  let state = saved;
  const listener = () => ({ events: {}, addEventListener(type, fn) { this.events[type] = fn; } });
  const search = { ...listener(), value: '' }, filter = { ...listener(), value: '' }, count = {}, empty = {};
  const detail = { ...listener(), dataset: { detailKey: 'repo:old' }, open: false };
  const rows = inbox().stories.map(row => ({ dataset: { identity: row.workId, title: row.title,
    repository: row.repositoryId, created: row.createdAt ?? '', creator: row.createdBy ?? '',
    phase: row.phase, status: row.status, search: `${row.workId} ${row.createdBy ?? ''}`.toLowerCase(),
    category: row.terminal ? 'completed' : 'active' }, hidden: false }));
  const body = { appendChild(row) { rows.splice(rows.indexOf(row), 1); rows.push(row); } };
  for (const row of rows) row.parentElement = body;
  const buttons = Object.fromEntries(['title', 'repository', 'created', 'creator', 'phase', 'status'].map(key => {
    const heading = { setAttribute(key, value) { this[key] = value; } }, indicator = {};
    return [key, { ...listener(), dataset: { storySort: key }, closest() { return heading; }, querySelector() { return indicator; }, heading }];
  }));
  const scope = { dataset: { storyTable: 'story' }, querySelectorAll: selector => document.querySelectorAll(selector) };
  const document = { getElementById(id) { return { 'story-search': search, 'story-status': filter, 'story-count': count, 'story-empty': empty }[id]; },
    querySelectorAll(selector) { return { '[data-story-table]': [scope], '[data-story-row]': rows, '[data-story-sort]': Object.values(buttons), '[data-detail-key]': [detail] }[selector] ?? []; }, addEventListener() {} };
  const vscode = { getState: () => state, setState(value) { state = value; }, postMessage() { assert.fail('Sorting must not call the host or attach a Story'); } };
  new Function('document', 'window', 'vscode', STORY_FILTER_SCRIPT)(document, { scrollTo() {}, addEventListener() {} }, vscode);
  return { rows, buttons, search, filter, count, detail, state: () => state, click(key) { buttons[key].events.click(); } };
}

test('shipping column sorter toggles, keeps missing dates last and persists through refresh with filters/details', () => {
  const view = browser({ storyDetails: { 'repo:old': true } });
  assert.deepEqual(view.rows.map(row => row.dataset.identity), ['new', 'same-time', 'old', 'bad', 'unknown']);
  assert.equal(view.detail.open, true);
  view.click('created');
  assert.deepEqual(view.rows.map(row => row.dataset.identity), ['old', 'new', 'same-time', 'bad', 'unknown']);
  assert.equal(view.buttons.created.heading['aria-sort'], 'ascending');
  view.click('creator');
  assert.deepEqual(view.rows.map(row => row.dataset.identity).slice(0, 2), ['old', 'new']);
  view.click('creator');
  assert.equal(view.rows[0].dataset.identity, 'new');
  view.search.value = 'builder two'; view.search.events.input();
  assert.equal(view.count.textContent, '1 Story');
  const restored = browser(view.state());
  assert.equal(restored.buttons.creator.heading['aria-sort'], 'descending');
  assert.equal(restored.rows[0].dataset.identity, 'new');
  assert.equal(restored.count.textContent, '1 Story');
  assert.equal(restored.detail.open, true);
  restored.click('status');
  assert.equal(restored.buttons.status.heading['aria-sort'], 'ascending');
  assert.equal(restored.count.textContent, '1 Story');
});

test('Initiative Story display sorts retained creation while dependency merge order stays intact', () => {
  const stories = ['older', 'newer'].map(id => ({ id, planId: id, workId: id, title: id, repository: 'repo', dependsOn: id === 'newer' ? [{ story: 'older', requiredPhase: 'release' }] : [] }));
  const initiative = { state: { initiative: { id: 'parent' }, childStories: {
    older: { createdAt: '2026-10-01T00:00:00Z', createdBy: { name: 'Builder One' } },
    newer: { createdAt: '2026-10-02T00:00:00Z', createdBy: { name: 'Builder Two' } }
  } }, breakdown: { stories } };
  assert.deepEqual(storiesByRepository(initiative)[0].stories.map(row => row.id), ['newer', 'older']);
  const view = buildStories({ initiative });
  assert.deepEqual(view.groups[0].stories.map(row => row.workId), ['newer', 'older']);
  assert.deepEqual(view.order, ['older', 'newer']);
  assert.equal(view.groups[0].stories[0].createdBy, 'Builder Two');
});


test('fresh and cached session rosters use creation order without extra Git or reader calls', async t => {
  const fixture = await repository(t);
  await withMachineState(fixture.env, async () => {
    const cwd = process.cwd(), preferences = process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES;
    process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES = path.join(fixture.base, 'preferences.json');
    process.chdir(fixture.root);
    try {
      let reads = 0;
      const inspect = () => sessionListingSnapshot(['session', 'candidates'], {}, async () => {
        reads++;
        return { discovered: { items: rows(), count: rows().length, fetched: false, unavailable: [], unavailableCount: 0 } };
      });
      const first = await inspect();
      const timer = commandTimer('session-order-cache', { commandClass: 'read' });
      const cached = await withCommandTiming(timer, inspect);
      assert.deepEqual(first.discovered.items.map(row => row.id), ['new', 'same-time', 'old', 'bad', 'unknown']);
      assert.deepEqual(cached.discovered.items, first.discovered.items);
      assert.equal(cached.discovered.listingSnapshot.source, 'cache');
      assert.equal(cached.discovered.items[0].createdBy, 'Builder Two');
      assert.equal(reads, 1);
      assert.equal(timer.finish().counters['git.spawns'] ?? 0, 0);
    } finally {
      process.chdir(cwd);
      if (preferences === undefined) delete process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES;
      else process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES = preferences;
    }
  });
});

test('intake existing-work tables expose creation and creator sorting and reinitialize after background patches', () => {
  const html = intakeHtml({ ...EMPTY_INTAKE_FORM, inFlight: rows().map(row => ({ ...row, shape: 'story', title: row.id, completed: row.status === 'closed' })) });
  for (const group of ['intake-active', 'intake-closed']) {
    assert.ok(html.includes(`data-story-table="${group}"`));
    assert.ok(html.includes(`id="${group}-sort-creator"`));
    assert.ok(html.includes(`id="${group}-sort-created"`));
  }
  assert.ok(html.indexOf('data-identity="same-time"') < html.indexOf('data-identity="old"'));
  assert.match(html, /Builder Two/);
  assert.match(INTAKE_SCRIPT, /changed.has\('inFlight'\)\) window.__sfSortStoryTables\?\.\(\)/);
});
