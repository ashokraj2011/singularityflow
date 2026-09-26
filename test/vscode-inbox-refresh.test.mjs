import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { runInNewContext } from 'node:vm';

let webviewMessage = () => {};
let panel;
globalThis.__sfInboxTestVscode = {
  ViewColumn: { Active: 1 },
  Uri: { joinPath: () => ({}) },
  window: {
    createWebviewPanel: () => {
      panel = {
        webview: {
          html: '', cspSource: 'vscode-resource:',
          onDidReceiveMessage(listener) { webviewMessage = listener; return { dispose() {} }; }
        },
        onDidDispose() { return { dispose() {} }; },
        reveal() {},
        dispose() {}
      };
      return panel;
    }
  }
};

const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  export const ViewColumn = globalThis.__sfInboxTestVscode.ViewColumn;
  export const Uri = globalThis.__sfInboxTestVscode.Uri;
  export const window = globalThis.__sfInboxTestVscode.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const { InboxPanel } = await import('../apps/vscode/src/views/inbox.ts');
const { buildInbox, buildInboxTree } = await import('../apps/vscode/src/views/inbox-model.ts');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function linkedCheckoutFixture() {
  const checkoutPath = '/worktrees/STORY-7';
  const repositoryPath = '/workspace/repos/delivery';
  return {
    checkoutPath,
    repositoryPath,
    binding: { checkoutPath, repositoryPath, repositoryId: 'delivery' },
    snapshot: {
      repository: { root: checkoutPath },
      initiative: null, workflow: null, selectedWorkId: 'STORY-7', documents: [],
      workItems: [{ id: 'STORY-7', title: 'Local review progress',
        status: 'awaiting_approval', currentPhase: 'security_review', branch: 'sflow/story/STORY-7' }]
    },
    catalog: [{ repositoryId: 'delivery', repositoryPath,
      repositoryUrl: 'https://example.test/delivery.git', id: 'STORY-7',
      title: 'Older remote progress', status: 'in_progress', currentPhase: 'intake',
      branch: 'sflow/story/STORY-7' }]
  };
}

test('a verified repository binding joins linked-checkout Stories to their canonical mapped repository', () => {
  const { snapshot, catalog, checkoutPath, repositoryPath, binding } = linkedCheckoutFixture();
  const inbox = buildInbox(snapshot, catalog, checkoutPath, binding);
  assert.equal(inbox.stories.length, 1,
    'the snapshot and canonical catalog entry describe one Story in one verified repository');
  const [story] = inbox.stories;
  assert.equal(story.workId, 'STORY-7');
  assert.equal(story.repositoryId, 'delivery');
  assert.equal(story.repositoryPath, repositoryPath,
    'the merged card retains the mapped path used by the attachment drift guard');
  assert.equal(story.current, true);
  assert.equal(story.title, 'Local review progress');
  assert.equal(story.phase, 'security review', 'the local snapshot supplies current phase progress');
  assert.equal(story.status, 'awaiting approval', 'the local snapshot supplies current lifecycle status');

  const tree = buildInboxTree(snapshot, null, catalog, checkoutPath, null, binding);
  const stories = tree.find((node) => node.id === 'inbox:active-stories').children;
  assert.equal(stories.length, 1, 'the sidebar uses the same verified repository binding');
  assert.equal(stories[0].storyRepositoryId, 'delivery');
  assert.match(stories[0].description, /delivery.*security review.*current/);
});

test('the same Story ID in different mapped repositories remains distinct even with an identical remote URL', () => {
  const { snapshot, catalog, checkoutPath, binding } = linkedCheckoutFixture();
  const secondRepository = {
    ...catalog[0], repositoryId: 'accounts', repositoryPath: '/workspace/repos/accounts',
    title: 'Independent repository Story', currentPhase: 'design'
  };
  const inbox = buildInbox(snapshot, [...catalog, secondRepository], checkoutPath, binding);
  assert.equal(inbox.stories.length, 2,
    'a remote URL or Story ID does not prove that two local repositories share identity');
  assert.deepEqual(inbox.stories.map((story) => ({
    repositoryId: story.repositoryId, repositoryPath: story.repositoryPath, current: story.current
  })), [
    { repositoryId: 'delivery', repositoryPath: '/workspace/repos/delivery', current: true },
    { repositoryId: 'accounts', repositoryPath: '/workspace/repos/accounts', current: false }
  ]);
  assert.equal(inbox.stories[1].title, 'Independent repository Story');
  assert.equal(inbox.stories[1].phase, 'design');
});

test('an unknown linked-checkout repository is not inferred from a matching Story ID', () => {
  const { snapshot, catalog, checkoutPath } = linkedCheckoutFixture();
  const inbox = buildInbox(snapshot, catalog, checkoutPath);
  assert.equal(inbox.stories.length, 2,
    'different checkout paths remain separate until the caller provides verified repository identity');
  assert.equal(inbox.stories.filter((story) => story.current).length, 1);
  assert.equal(inbox.stories.find((story) => story.current).repositoryPath, checkoutPath);
  assert.equal(inbox.stories.find((story) => story.repositoryId === 'delivery').current, false);
});

test('a repository binding for a different checkout cannot merge the current snapshot', () => {
  const { snapshot, catalog, checkoutPath, binding } = linkedCheckoutFixture();
  const wrongCheckout = { ...binding, checkoutPath: '/worktrees/another-checkout' };
  assert.deepEqual(buildInbox(snapshot, catalog, checkoutPath, wrongCheckout),
    buildInbox(snapshot, catalog, checkoutPath),
    'a retained binding from another checkout is ignored');
  assert.deepEqual(buildInboxTree(snapshot, null, catalog, checkoutPath, null, wrongCheckout),
    buildInboxTree(snapshot, null, catalog, checkoutPath),
    'the sidebar also ignores a binding from another checkout');
});

test('a verified binding cannot join a snapshot retained from another repository', () => {
  const { snapshot, catalog, checkoutPath, binding } = linkedCheckoutFixture();
  const stale = { ...snapshot, repository: { root: '/another/repository' } };
  assert.deepEqual(buildInbox(stale, catalog, checkoutPath, binding), buildInbox(stale, catalog, checkoutPath));
});

test('same-ID remote-only Stories keep their explicit mapped repository identities', () => {
  const { catalog } = linkedCheckoutFixture();
  const first = { ...catalog[0], repositoryPath: '' };
  const second = { ...first, repositoryId: 'independent-mapping', title: 'A separate selected mapping' };
  const stories = buildInbox(null, [first, second, { ...first }]).stories;
  assert.equal(stories.length, 2, 'no Git identity is inferred from a shared remote URL');
  assert.deepEqual(stories.map((story) => story.repositoryId), ['delivery', 'independent-mapping']);
});

test('Inbox refresh discovers Stories from an empty workspace and supports a failed fetch retry', async () => {
  const store = {
    current: { snapshot: null },
    onDidChange(listener) { this.changed = listener; return { dispose() {} }; }
  };
  const pending = [];
  const attached = [];
  let catalog = [];
  let catalogIssue = null;
  const inbox = InboxPanel.show({ extensionUri: {} }, store, (message) => {
    if (message.type === 'attach-story') { attached.push(message); return; }
    assert.deepEqual(message, { type: 'refresh-stories' });
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  }, () => catalog, () => '/repo/a', () => catalogIssue);

  const initialPage = panel.webview.html;
  store.changed(store.current, { kind: 'loading', revisionChanged: false, changedSlices: [] });
  assert.equal(panel.webview.html, initialPage,
    'a loading-only store event must not rebuild the Inbox webview');
  store.changed(store.current, { kind: 'snapshot', revisionChanged: true, changedSlices: ['lifecycle'] });
  assert.notEqual(panel.webview.html, initialPage,
    'the Inbox still renders a changed snapshot');

  assert.match(panel.webview.html, /data-refresh-stories/,
    'refresh must remain available when the local snapshot has no Story');
  const script = [...panel.webview.html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)]
    .map((match) => match[1]).find((body) => body.includes('data-refresh-stories'));
  assert.ok(script, 'the Inbox click handler must be installed in the webview');
  let click;
  runInNewContext(script, {
    window: { __sfVscode: { postMessage: (message) => webviewMessage(message) } },
    document: { addEventListener: (type, listener) => { if (type === 'click') click = listener; } }
  });
  const refreshButton = { hasAttribute: (name) => name === 'data-refresh-stories', dataset: {} };
  const clickRefresh = () => click({ target: { closest: () => refreshButton } });
  clickRefresh();
  assert.match(panel.webview.html, /Checking for Stories…/);
  clickRefresh();
  await tick();
  assert.equal(pending.length, 1, 'overlapping clicks must not launch another remote fetch');

  pending[0].reject(new Error('<remote unavailable>'));
  await tick();
  assert.match(panel.webview.html, /Retry Story refresh/);
  assert.match(panel.webview.html, /&lt;remote unavailable&gt;/,
    'the remote error is shown inline and escaped');

  clickRefresh();
  await tick();
  assert.equal(pending.length, 2);
  store.current.snapshot = {
    initiative: null, workflow: null, selectedWorkId: null,
    documents: [{ id: 'DESIGN', type: 'artifact', label: 'Design', kind: 'markdown',
      path: 'singularity/work-items/STORY-7/artifacts/design/design.md', phase: 'design',
      status: 'published', generation: 1, sha256: 'a'.repeat(64) }],
    workItems: [{ id: 'STORY-7', title: 'Half done on another laptop', status: 'in_progress', currentPhase: 'design' }]
  };
  store.changed(store.current, { kind: 'snapshot', revisionChanged: true, changedSlices: ['lifecycle'] });
  pending[1].resolve();
  await tick();
  assert.match(panel.webview.html, /STORY-7/);
  assert.match(panel.webview.html, /Open &amp; continue|Open & continue/);
  assert.doesNotMatch(panel.webview.html, /remote unavailable/);
  assert.doesNotMatch(panel.webview.html, /Checking for Stories…/);
  catalog = [
    { repositoryId: 'current-delivery', repositoryPath: '/repo/a', id: 'STORY-7', title: 'Fetched copy',
      status: 'in_progress', currentPhase: 'intake', branch: 'sflow/story/STORY-7' },
    { repositoryId: 'payments', repositoryPath: '/repo/b', id: 'STORY-8', title: 'Cross-repository Story',
      status: 'in_progress', currentPhase: 'implementation', branch: 'sflow/story/STORY-8' },
    { repositoryId: 'payments', repositoryPath: '/repo/b', id: 'STORY-8', title: 'Duplicate discovery',
      status: 'in_progress', currentPhase: 'implementation', branch: 'sflow/story/STORY-8' },
    { repositoryId: 'accounts', repositoryPath: '/repo/c', id: 'STORY-8', title: 'Same ID in another repository',
      status: 'in_progress', currentPhase: 'design', branch: 'sflow/story/STORY-8' },
    { repositoryId: 'payments', repositoryPath: '/repo/b', id: 'STORY-9', title: 'Finished on another laptop',
      status: 'completed', currentPhase: null, branch: 'sflow/story/STORY-9' },
    { repositoryId: 'shipping', repositoryPath: '', repositoryUrl: 'https://example.test/shipping.git',
      id: 'STORY-11', title: 'Remote-only shipping Story', status: 'in_progress',
      currentPhase: 'design', branch: 'sflow/story/STORY-11' },
    { repositoryId: 'analytics', repositoryPath: '', repositoryUrl: 'https://example.test/analytics.git',
      id: 'STORY-11', title: 'Remote-only analytics Story', status: 'in_progress',
      currentPhase: 'implementation', branch: 'sflow/story/STORY-11' }
  ];
  store.current.snapshot.workItems.push({
    id: 'STORY-10', title: 'Cancelled locally', status: 'cancelled', currentPhase: null
  });
  InboxPanel.refreshCurrent();
  assert.equal([...panel.webview.html.matchAll(/data-story="STORY-8"/g)].length, 2,
    'one repository+Story identity is shown once, while the same ID in another repository remains distinct');
  assert.match(panel.webview.html, /payments/);
  assert.match(panel.webview.html, /accounts/);
  assert.match(panel.webview.html, /Workspace Stories/);
  assert.match(panel.webview.html, /STORY-9[\s\S]*?completed/);
  assert.match(panel.webview.html, /STORY-10[\s\S]*?cancelled/);
  assert.equal([...panel.webview.html.matchAll(/data-story="STORY-11"/g)].length, 2);
  assert.match(panel.webview.html, /data-story="STORY-11" data-repository-id="shipping"/);
  assert.match(panel.webview.html, /Materialize &amp; continue|Materialize & continue/);
  assert.ok(panel.webview.html.indexOf('data-story="STORY-8"')
    < panel.webview.html.indexOf('data-story="STORY-9"'),
  'active Stories precede terminal ones');
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-8', repositoryId: 'payments' } }) } });
  assert.deepEqual(attached, [{ type: 'attach-story', workId: 'STORY-8', repositoryId: 'payments' }]);
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-8', repositoryId: 'unknown' } }) } });
  assert.equal(attached.length, 1, 'a forged repository route cannot attach a Story');
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-11', repositoryId: 'shipping' } }) } });
  assert.deepEqual(attached[1], { type: 'attach-story', workId: 'STORY-11', repositoryId: 'shipping' },
    'a known remote-only Story routes through its mapped repository identity');
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-11', repositoryId: 'unknown' } }) } });
  assert.equal(attached.length, 2, 'a forged remote-only repository identity cannot attach');

  const tree = buildInboxTree(store.current.snapshot, null, catalog, '/repo/a');
  const model = buildInbox(store.current.snapshot, catalog, '/repo/a');
  assert.deepEqual(model.workItems.map((item) => item.workId),
    ['STORY-7'], 'other repositories provide Story navigation, not invented artifact catalogs');
  assert.equal(model.stories.length, 7);
  assert.equal(model.activeStories.length, 5);
  assert.equal(buildInbox(null, catalog, '/repo/a').stories.filter((story) => !story.materialized).length, 2,
    'remote-only Stories remain visible before a local repository snapshot exists');
  const stories = tree.find((node) => node.id === 'inbox:active-stories').children;
  assert.equal(stories.length, 7);
  assert.match(stories.find((node) => node.label === 'STORY-7').description, /current-delivery/);
  assert.equal(stories.find((node) => node.description.startsWith('payments')).openPath, '/repo/b');
  for (const remoteOnly of stories.filter((node) => node.label === 'STORY-11')) {
    assert.equal(remoteOnly.runCommand, 'singularityFlow.runAction');
    assert.deepEqual(remoteOnly.command, ['session', 'attach', 'STORY-11']);
    assert.equal(remoteOnly.openPath, undefined);
    assert.match(remoteOnly.description, /materialize and open/);
    assert.match(remoteOnly.storyRepositoryId, /shipping|analytics/);
  }
  assert.equal(tree.find((node) => node.id === 'inbox:refresh-stories')?.runCommand,
    'singularityFlow.refresh', 'the sidebar Inbox refresh uses the same remote discovery command');
  assert.equal(buildInboxTree(null, new Error('offline')).find((node) => node.id === 'inbox:refresh-stories')?.runCommand,
    'singularityFlow.refresh', 'a failed sidebar load still offers a retry');

  clickRefresh();
  await tick();
  pending[2].reject(new Error('temporary fetch failure'));
  await tick();
  assert.match(panel.webview.html, /temporary fetch failure/);
  InboxPanel.refreshCurrent();
  assert.doesNotMatch(panel.webview.html, /temporary fetch failure/,
    'a later successful automatic catalog refresh clears a previous explicit error');

  catalogIssue = '<background discovery failed for payments>';
  InboxPanel.refreshCurrent();
  assert.match(panel.webview.html, /Story list may be incomplete/);
  assert.match(panel.webview.html, /&lt;background discovery failed for payments&gt;/);
  assert.match(panel.webview.html, /Retry Story refresh/);
  const warningTree = buildInboxTree(store.current.snapshot, null, catalog, '/repo/a', catalogIssue);
  assert.equal(warningTree[0].id, 'inbox:story-discovery-issue');
  assert.match(warningTree[0].tooltip, /background discovery failed/);
  assert.equal(warningTree.at(-1).runCommand, 'singularityFlow.refresh');

  catalog = [];
  store.current.snapshot = null;
  InboxPanel.refreshCurrent();
  assert.match(panel.webview.html, /No Stories are confirmed yet/);
  assert.doesNotMatch(panel.webview.html, /Nothing governed is checked out/);
  assert.deepEqual(buildInboxTree(null, null, [], '/repo/a', catalogIssue).map((node) => node.id),
    ['inbox:story-discovery-issue', 'inbox:refresh-stories']);
  catalogIssue = null;
  InboxPanel.refreshCurrent();
  assert.doesNotMatch(panel.webview.html, /Story list may be incomplete/);
  inbox.dispose();
});
