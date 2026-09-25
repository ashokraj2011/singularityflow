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
  store.changed();
  pending[1].resolve();
  await tick();
  assert.match(panel.webview.html, /STORY-7/);
  assert.match(panel.webview.html, /Open checkout/);
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
  assert.match(panel.webview.html, /data-story="STORY-11" data-repository-path="" disabled aria-disabled="true"/);
  assert.match(panel.webview.html, /Materialize repository to open/);
  assert.ok(panel.webview.html.indexOf('data-story="STORY-8"')
    < panel.webview.html.indexOf('data-story="STORY-9"'),
  'active Stories precede terminal ones');
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-8', repositoryPath: '/repo/b' } }) } });
  assert.deepEqual(attached, [{ type: 'attach-story', workId: 'STORY-8', repositoryPath: '/repo/b' }]);
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-8', repositoryPath: '/repo/unknown' } }) } });
  assert.equal(attached.length, 1, 'a forged repository route cannot attach a Story');
  click({ target: { closest: () => ({ hasAttribute: () => false,
    dataset: { story: 'STORY-11', repositoryPath: '' } }) } });
  assert.equal(attached.length, 1, 'a remote-only Story cannot be attached through a forged message');

  const tree = buildInboxTree(store.current.snapshot, null, catalog, '/repo/a');
  const model = buildInbox(store.current.snapshot, catalog, '/repo/a');
  assert.deepEqual(model.workItems.map((item) => item.workId),
    ['STORY-7'], 'other repositories provide Story navigation, not invented artifact catalogs');
  assert.equal(model.stories.length, 7);
  assert.equal(model.activeStories.length, 5);
  assert.equal(buildInbox(null, catalog, '/repo/a').stories.filter((story) => !story.attachable).length, 2,
    'remote-only Stories remain visible before a local repository snapshot exists');
  const stories = tree.find((node) => node.id === 'inbox:active-stories').children;
  assert.equal(stories.length, 7);
  assert.match(stories.find((node) => node.label === 'STORY-7').description, /current-delivery/);
  assert.equal(stories.find((node) => node.description.startsWith('payments')).openPath, '/repo/b');
  for (const remoteOnly of stories.filter((node) => node.label === 'STORY-11')) {
    assert.equal(remoteOnly.runCommand, undefined);
    assert.equal(remoteOnly.command, undefined);
    assert.equal(remoteOnly.openPath, undefined);
    assert.match(remoteOnly.description, /materialize to open/);
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
