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

test('main task destinations have a fixed order and contributed commands', async () => {
  assert.deepEqual(PRIMARY_NAVIGATION.map(item => item.label), ['My Work', 'Start new work', 'Stories', 'Reviews', 'Workspaces', 'Configuration']);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  for (const item of PRIMARY_NAVIGATION) assert.ok(manifest.contributes.commands.some(command => command.command === item.command));
  const html = sidebarBody(view());
  assert.equal((html.match(/aria-current=/g) ?? []).length, 0);
  assert.match(html, /data-action="configuration-center"/);
  assert.doesNotMatch(html, /Open Configuration Center|More actions/);
});

test('configuration approvals directly open the workflow proposal queue, not only capability proposals', async () => {
  // Reached from Reviews, a pin or the palette; Reviews is the one place decisions wait.
  assert.equal(PRIMARY_NAVIGATION.find(item => item.id === 'configuration-approvals'), undefined);
  const sidebarSource = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  assert.match(sidebarSource, /'configuration-approvals': 'singularityFlow\.openConfigurationApprovals'/);
  const source = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(source, /'singularityFlow\.openConfigurationApprovals': async \(\) =>\s*vscode\.commands\.executeCommand\('singularityFlow\.openWorkflowStudio', \{ view: 'changes' \}\)/);
  const commands = source.slice(source.indexOf('const REPOSITORY_COMMANDS = ['), source.indexOf('];', source.indexOf('const REPOSITORY_COMMANDS = [')));
  assert.match(commands, /'singularityFlow\.openConfigurationApprovals'/);
  const reviews = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  assert.match(reviews, /'workflow-proposals': 'singularityFlow\.openConfigurationApprovals'/);
  assert.match(reviews, /data-review-route="workflow-proposals"/);
  assert.match(reviews, /data-review-route="proposals"/);
});

test('Story Analytics, Artifacts and the Code Explainer are Work tools, even before a Story is selected', async () => {
  const sidebarSource = await readFile(new URL('../apps/vscode/src/views/sidebar.ts', import.meta.url), 'utf8');
  const tools = sidebarSource.match(/'work-tools': \{ title: 'Work tools', ids: \[([^\]]*)\] \}/)[1];
  for (const id of ['story-analytics', 'artifacts', 'understand-changes']) assert.match(tools, new RegExp(`'${id}'`));
  assert.match(sidebarSource, /'story-analytics': 'singularityFlow\.openDashboard'/);
  const html = sidebarBody(view({ active: 'my-work' }));
  const nav = html.match(/<nav aria-label="Singularity Flow">([\s\S]*?)<\/nav>/)[1];
  assert.match(nav, /data-action="my-work" aria-current="page"/);
  assert.equal((nav.match(/aria-current=/g) ?? []).length, 1);
  assert.doesNotMatch(nav, /data-action="story-analytics"|data-action="artifacts"|data-action="code-explainer"/);
});

test('the sidebar shows one next step and the current phase by its label', () => {
  const entries = [{ id: 'w', path: '/work/w', name: 'W', active: 'yes', repositoryState: 'ready' }];
  const story = { repository: { root: '/work/w' }, definition: { phases: { design: { label: 'Design' } } },
    workflow: { workItem: { id: 'S-1' }, currentPhase: 'design' } };
  const navigation = deriveSidebarNavigation(entries, story);
  assert.deepEqual(navigation.subject, { id: 'S-1', kind: 'Story', phase: 'Design' });
  assert.deepEqual(navigation.next, { label: 'Continue S-1', description: 'Story · Design', actionId: 'my-work' });
  const html = sidebarBody(view({ navigation }));
  assert.match(html, /<button type="button" class="next-step" data-action="my-work" data-focus-key="next-step">\s*<span class="next-label">Continue S-1<\/span><span class="next-detail">Story · Design<\/span><\/button>/);
  assert.match(html, /Phase: <span>Design<\/span>/);
  assert.doesNotMatch(html, /Phase not reported/);

  const initiative = { repository: { root: '/work/w' }, initiative: { state: {
    initiative: { id: 'SF-E-1' }, currentPhase: 'epic-publish', phases: { 'epic-publish': { label: 'Publish Stories' } } } } };
  assert.equal(deriveSidebarNavigation(entries, initiative).subject.phase, 'Publish Stories');
  const idle = deriveSidebarNavigation(entries, { repository: { root: '/work/w' } });
  assert.equal(idle.next.actionId, 'work-start');
  assert.match(sidebarBody(view({ navigation: idle })), /class="next-step" data-action="work-start"/);
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
  assert.equal(sidebarDestination('singularityFlow.artifacts'), 'artifacts');
  assert.equal(sidebarDestination('singularityFlow.dashboard'), 'story-analytics');
  assert.equal(sidebarDestination('mainThreadWebview-singularityFlow.dashboard'), 'story-analytics');
  assert.equal(sidebarDestination('singularityFlow.codeExplainer'), 'code-explainer');
  assert.equal(sidebarDestination('mainThreadWebview-singularityFlow.reviews'), 'reviews');
  assert.equal(sidebarDestination('singularityFlow.result', true), 'my-work');
  assert.equal(sidebarDestination('singularityFlow.result', false), null);
  assert.equal(sidebarDestination(null), null);
  assert.equal(sidebarDestination('another-extension'), null);
  assert.doesNotMatch(SIDEBAR_SCRIPT, /lastOpened|markLastOpened/);
  assert.match(SIDEBAR_SCRIPT, /active-destination/);
  assert.match(SIDEBAR_SCRIPT, /postMessage\(\{type:'navigation-ready'\}\)/,
    'a recreated webview requests the actual selected destination after its script is listening');
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
