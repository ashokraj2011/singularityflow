import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInbox } from '../apps/vscode/src/views/inbox-model.ts';
import { storyCreatedDateHtml, workspaceStoriesHtml } from '../apps/vscode/src/views/workspace-stories-page.ts';

const createdAt = '2026-10-01T08:30:00.000Z';
const row = { repositoryId: 'app', repositoryPath: '/repo/app', id: 'STORY-1', title: 'A Story',
  branch: 'feature/story', status: 'in_progress', currentPhase: 'implementation', createdAt };

test('Story lists retain creation dates from local metadata and mapped remote catalogs', () => {
  const snapshot = { workItems: [{ id: row.id, title: row.title, createdAt, updatedAt: '2026-10-15T12:00:00Z' }],
    workflow: null, initiative: null, documents: [] };
  const local = buildInbox(snapshot, [], '/repo/app');
  assert.equal(local.stories[0].createdAt, createdAt);
  const remote = buildInbox(null, [{ ...row, repositoryPath: '', repositoryUrl: 'https://example.test/app.git' }]);
  assert.equal(remote.stories[0].createdAt, createdAt);
  const html = workspaceStoriesHtml(remote, '');
  assert.match(html, /<th>Created \(UTC\)<\/th>/);
  assert.match(html, /<time datetime="2026-10-01T08:30:00.000Z"[^>]*>1 Oct 2026<\/time>/);
  assert.equal(local.stories[0].createdAt, remote.stories[0].createdAt);
});

test('older snapshot projections use retained workflow or catalog creation, never update time', () => {
  const snapshot = { workItems: [{ id: row.id, updatedAt: '2026-10-15T12:00:00Z' }], workflow: null, initiative: null, documents: [] };
  assert.equal(buildInbox(snapshot, [row], '/repo/app').stories[0].createdAt, createdAt);
  assert.equal(buildInbox(snapshot, [], '/repo/app').stories[0].createdAt, null);
  snapshot.workflow = { workItem: { id: row.id, createdAt }, phases: {} };
  assert.equal(buildInbox(snapshot, [], '/repo/app').stories[0].createdAt, createdAt);
  snapshot.workflow.workItem.id = 'OTHER';
  assert.equal(buildInbox(snapshot, [], '/repo/app').stories[0].createdAt, null, 'another Story cannot supply the date');
});

test('missing, invalid and unsafe creation dates are displayed honestly and safely', () => {
  for (const value of [null, undefined, '', 'not-a-date', '<script>alert(1)</script>']) {
    assert.equal(storyCreatedDateHtml(value), '<span class="muted">Not recorded</span>');
  }
  assert.match(storyCreatedDateHtml('2026-10-01T00:30:00+05:30'), />30 Sept 2026<\/time>/, 'UTC date, with the exact instant in the tooltip');
});
