import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PRIMARY_NAVIGATION, sidebarBody, SIDEBAR_STYLE, SIDEBAR_SCRIPT } from '../apps/vscode/src/views/sidebar-page.ts';
import { sidebarDestination } from '../apps/vscode/src/views/sidebar-destination.ts';
import { deriveSidebarNavigation } from '../apps/vscode/src/views/sidebar-navigation-model.ts';
import { workspaceStoriesHtml, storyCategory } from '../apps/vscode/src/views/workspace-stories-page.ts';
import { buildInbox } from '../apps/vscode/src/views/inbox-model.ts';

const view = overrides => ({ navigation: { workspace: null, next: null }, freshness: null,
  loading: false, pending: null, active: null, favorites: [], ...overrides });

test('five task destinations have a fixed order and contributed commands', async () => {
  assert.deepEqual(PRIMARY_NAVIGATION.map(item => item.label), ['My Work', 'Stories', 'Reviews', 'Workspaces', 'Configuration']);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  for (const item of PRIMARY_NAVIGATION) assert.ok(manifest.contributes.commands.some(command => command.command === item.command));
  const html = sidebarBody(view());
  assert.equal((html.match(/aria-current=/g) ?? []).length, 0);
  assert.match(html, /data-action="configuration-center"/);
  assert.doesNotMatch(html, /Open Configuration Center|More actions/);
});

test('sidebar has no hover commands, tooltips, automatic help or unsafe markup', () => {
  const html = sidebarBody(view({ navigation: { workspace: { name: '<script>bad</script>', repository: 'repo' }, next: null } }));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|title=|role="tooltip"|singularity-flow|sf-help|help-copy/);
  assert.doesNotMatch(SIDEBAR_SCRIPT, /mouseover|mouseenter|focusin.*postMessage|executeCommand|fetch\(/);
  assert.match(SIDEBAR_STYLE, /scale\(1\.015\)/);
  assert.match(SIDEBAR_STYLE, /prefers-reduced-motion:reduce[^}]+transform:none!important/);
  assert.match(SIDEBAR_STYLE, /:focus-visible/);
  assert.doesNotMatch(SIDEBAR_STYLE, /@keyframes/);
});

test('only confirmed pending approvals get a badge, and loading is not green or empty', () => {
  assert.doesNotMatch(sidebarBody(view({ pending: null })), /class="badge"/);
  assert.match(sidebarBody(view({ pending: 3 })), /3 pending phase approvals/);
  const loading = sidebarBody(view({ loading: true }));
  assert.match(loading, /Reading workspace state/);
  assert.doesNotMatch(loading, /Nothing is waiting|ready|brand-status/);
});

test('selection follows real editor destinations, including clearing a previous selection', () => {
  assert.equal(sidebarDestination('singularityFlow.workspaceStories'), 'stories');
  assert.equal(sidebarDestination('mainThreadWebview-singularityFlow.reviews'), 'reviews');
  assert.equal(sidebarDestination('singularityFlow.result', true), 'my-work');
  assert.equal(sidebarDestination('singularityFlow.result', false), null);
  assert.equal(sidebarDestination(null), null);
  assert.equal(sidebarDestination('another-extension'), null);
  assert.doesNotMatch(SIDEBAR_SCRIPT, /lastOpened|markLastOpened/);
  assert.match(SIDEBAR_SCRIPT, /active-destination/);
});

test('context refuses a previous workspace snapshot and handles Windows path casing', () => {
  const entries = [{ id: 'next', path: 'C:\\work\\next', name: 'Next', active: 'yes', repositoryState: 'ready' }];
  const snapshot = { repository: { root: 'C:\\work\\previous\\repo' }, workflow: { workItem: { id: 'OLD' }, currentPhase: 'testing' } };
  assert.equal(deriveSidebarNavigation(entries, snapshot).subject, undefined);
  assert.equal(deriveSidebarNavigation(entries, snapshot).next, null);
  snapshot.repository.root = 'c:/WORK/next/repos/current';
  assert.equal(deriveSidebarNavigation(entries, snapshot).subject.id, 'OLD');
  snapshot.repository.root = 'c:/work/next-other/repo';
  assert.equal(deriveSidebarNavigation(entries, snapshot).subject, undefined);
});

test('reuse of an explicitly registered external lead clone is supported', () => {
  const entries = [{ id: 'w', path: '/work/w', leadRepositoryPath: '/existing/repo', name: 'W', active: 'yes' }];
  const snapshot = { repository: { root: '/existing/repo' }, workflow: { workItem: { id: 'S' }, currentPhase: 'design' } };
  assert.equal(deriveSidebarNavigation(entries, snapshot).subject.id, 'S');
});

test('an externally reused non-lead clone needs the matching host-verified workspace binding', () => {
  const entries = [{ id: 'w', path: '/work/w', name: 'W', active: 'yes' }];
  const snapshot = { repository: { root: '/existing/member' }, workflow: { workItem: { id: 'S' }, currentPhase: 'design' } };
  const verifiedContext = { workspaceId: 'w', root: '/existing/member' };
  assert.equal(deriveSidebarNavigation(entries, snapshot, { verifiedContext }).subject.id, 'S');
  assert.equal(deriveSidebarNavigation(entries, snapshot, { verifiedContext: { ...verifiedContext, workspaceId: 'old' } }).subject, undefined);
});

test('workspace Story details are read-only and remote progress is never fabricated', () => {
  const inbox = buildInbox(null, [{ id: 'A', title: '<unsafe>', repositoryId: 'delivery', repositoryPath: '',
    repositoryUrl: 'https://git.example.test/team/repo.git', status: 'in_progress', currentPhase: 'custom-phase', branch: 'A' }]);
  const html = workspaceStoriesHtml(inbox, '<button data-refresh-stories>Refresh</button>');
  assert.match(html, /&lt;unsafe&gt;/);
  assert.match(html, /custom-phase/);
  assert.match(html, /Phase totals not reported/);
  assert.match(html, /<summary>View details<\/summary>/);
  assert.match(html, /data-story="A"[^>]+>Switch to Story/);
  assert.doesNotMatch(html, /100%|singularity-flow|onclick=/);
});

test('Story status filters distinguish completed, cancelled and active work', () => {
  for (const status of ['closed', 'complete', 'completed', 'merged']) assert.equal(storyCategory({ status }), 'completed');
  for (const status of ['invalid', 'cancelled']) assert.equal(storyCategory({ status }), 'cancelled');
  assert.equal(storyCategory({ status: 'in progress' }), 'active');
});

test('favorite IDs, focus and scroll survive redraw without positional node keys', () => {
  const html = sidebarBody(view({ favorites: [{ id: 'journal', label: 'Local Journal', icon: 'book' }] }));
  assert.match(html, /data-action="favorite:journal"/);
  assert.match(html, /data-remove-favorite="journal"/);
  assert.match(SIDEBAR_SCRIPT, /preventScroll:true/);
  assert.match(SIDEBAR_SCRIPT, /state.scroll/);
  assert.match(SIDEBAR_SCRIPT, /state.focus=null/);
});
