import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { SharedWorkflowDraftController } from '../apps/vscode/src/views/workflow-drafts-model.ts';
import { sharedWorkflowDraftsHtml, SHARED_WORKFLOW_DRAFTS_SCRIPT } from '../apps/vscode/src/views/workflow-drafts-page.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const roots = ['/approved/one', '/approved/two'];
const selectors = `${roots[0]}#STORY-1=refs/heads/story-1\n${roots[1]}#STORY-2=refs/heads/story-2`;
const report = (cursor = 0, override = {}) => ({
  format: 'sflow-cross-repository-story-skill-inventory/v1',
  subject: { skillId: 'review-skill', packageSha256: null }, sourceSha256: digest,
  source: { repositoryOrder: 'explicit-request-order', repositories: roots.map((requestedRoot) => ({ requestedRoot })) },
  permissionEffect: 'none', readScope: { kind: 'explicit-local-repository-story-ref-windows',
    network: 'not-contacted', authenticatedPrincipal: 'not-established' },
  coverage: { observedRevisions: 2, matchingRevisions: 1, otherRepositories: 'not-searched',
    earlierCommitsBeyondWindows: 'not-searched', providerPrincipalAndRevocation: 'not-established',
    executionUsage: 'not-assessed' },
  page: { cursor, limit: 32, total: 33, returned: cursor ? 1 : 32, nextCursor: cursor ? null : 32,
    complete: Boolean(cursor) },
  observations: [{ repositoryIndex: 0, workId: 'STORY-1', commit: 'b'.repeat(40), status: 'verified-matching-pin' }],
  references: Array.from({ length: cursor ? 1 : 32 }, (_, index) => ({ repositoryIndex: cursor ? 1 : 0,
    workId: cursor ? 'STORY-2' : 'STORY-1', phaseId: `phase-${index}`, packageSha256: digest })),
  ...override
});

function fixture(responder = (cursor) => report(cursor)) {
  const calls = []; const controller = new SharedWorkflowDraftController('/opened/explicit-repository',
    async (argv, root) => {
      calls.push({ argv, root });
      const cursor = argv.includes('--cursor') ? Number(argv[argv.indexOf('--cursor') + 1]) : 0;
      const usage = responder(cursor);
      return { result: { resultType: 'workflow-author', status: 'read',
        operation: { id: 'workflow.author.where-used', modelPolicy: 'never', classification: 'read' },
        data: { usage } }, error: null };
    }, async () => { throw new Error('Read-only usage must never create an input file.'); },
    { changed: () => {}, confirmDiscard: async () => false, copyReview: async () => {} });
  return { controller, calls };
}

test('selected cross-repository usage is a bounded explicit read, independent of shared draft state', async () => {
  const f = fixture();
  await f.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill',
    usageSelectors: selectors, usageHistoryDepth: 2 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].root, '/opened/explicit-repository');
  assert.deepEqual(f.calls[0].argv, ['workflow', 'author', 'where-used', 'review-skill',
    '--repository-story-refs', selectors.replace(/\n/gu, ','), '--history-depth', '2', '--limit', '32', '--json']);
  assert.equal(f.controller.view.usage.report.page.total, 33);
  assert.equal(f.controller.view.usage.error, null);
  assert.equal(f.controller.view.durability, 'shared');
  assert.equal(f.controller.view.editor, null);
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /Where is this skill used/u);
  assert.match(html, /Other repositories: not-searched/u);
  assert.match(html, /data-draft-action="usage-next"/u);
  assert.doesNotMatch(html, /Ready to run/u);
});

test('the next page reuses the exact selected roots and source digest; stale responses disappear', async () => {
  const f = fixture();
  await f.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill', usageSelectors: selectors, usageHistoryDepth: 1 });
  await f.controller.receive({ type: 'usage-next' });
  assert.deepEqual(f.calls[1].argv.slice(-5), ['--cursor', '32', '--expected-source', digest, '--json']);
  assert.equal(f.controller.view.usage.report.page.nextCursor, null);

  const stale = fixture((cursor) => report(cursor, cursor ? { sourceSha256: `sha256:${'b'.repeat(64)}` } : {}));
  await stale.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill', usageSelectors: selectors, usageHistoryDepth: 1 });
  await stale.controller.receive({ type: 'usage-next' });
  assert.equal(stale.controller.view.usage.report, null);
  assert.match(stale.controller.view.usage.error, /did not match the exact selected/u);
  assert.match(sharedWorkflowDraftsHtml(stale.controller.view), /No partial or stale inventory is displayed/u);
});

test('unsafe or implied-discovery selectors refuse before the CLI; host messages cannot choose authority', async () => {
  const f = fixture();
  for (const value of ['https://provider.invalid/org/repo#A=refs/heads/main',
    '/approved/one#A=refs/heads/*', '/approved/one#A=refs/heads/main\n'.repeat(9),
    '/a#A=refs/heads/main\n/b#A=refs/heads/main\n/c#A=refs/heads/main\n/d#A=refs/heads/main\n/e#A=refs/heads/main']) {
    await f.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill', usageSelectors: value, usageHistoryDepth: 1 });
    assert.equal(f.controller.view.usage.report, null);
    assert.ok(f.controller.view.usage.error);
    assert.equal(f.controller.view.usage.selectors, value, 'a bounded rejected selector remains available to correct');
  }
  assert.equal(f.calls.length, 0);
  await f.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill', usageSelectors: selectors,
    usageHistoryDepth: 1, repository: '/different/authority' });
  assert.equal(f.calls.length, 0);
  assert.match(f.controller.view.error, /unsupported fields/u);
});

test('grouped SKP impact and host limitations are escaped and cannot become execution controls', () => {
  const f = fixture();
  f.controller.view.editor = { inputText: JSON.stringify({ payload: { schema: 'sflow-workflow-request@2',
    changes: [{ profile: 'wca-shared-skill-contract-group-review/v1', kind: 'phase', operation: 'edit', id: 'one',
      expectedDefinitionSha256: digest }, { profile: 'wca-shared-skill-contract-group-review/v1', kind: 'phase',
      operation: 'edit', id: 'two', expectedDefinitionSha256: digest }] }, assets: [] }),
    record: { draftId: 'WFD-ABC123', displayName: 'Group', revision: 1, lifecycleEpoch: 1,
      revisionSha256: digest }, authority: '/approved/config.git', head: 'c'.repeat(40),
    name: 'Group', savedName: 'Group', savedText: '{}', binding: 'bound', readOnlyReason: null };
  f.controller.view.stage = 3;
  f.controller.view.preview = { planSha256: digest,
    readiness: { authoring: 'review-required', host: 'discovery-unverified', execution: 'not-run',
      publication: 'not-proposed', activation: 'inactive', behavior: 'not-evaluated' },
    coverage: { hostEnforcement: 'unavailable' }, skillFinalization: { status: 'requires-exact-terminal-consent' },
    sharedObjectChanges: { profile: 'wca-shared-skill-contract-group-review/v1', status: 'ready-for-impact-review',
      replacements: [{ kind: 'phase', id: '<unsafe>', expectedDefinitionSha256: digest }],
      impact: { selectedSkillPhaseIds: ['one', 'two'], consumers: [], affectedWorkflows: [], excluded: ['host-qualification'],
        otherRepositories: 'not-inventoried', retainedStories: 'not-inventoried' } } };
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /One grouped artifact-only review/u);
  assert.match(html, /Skill contract review is a configuration proposal only/u);
  assert.match(html, /Complete phase replacements use advanced JSON|Grouped artifact-only contract review selects/u);
  assert.match(html, /&lt;unsafe&gt;/u);
  assert.doesNotMatch(html, /<unsafe>|data-draft-action="(?:activate|approve|execute)"/u);
  assert.match(SHARED_WORKFLOW_DRAFTS_SCRIPT, /usage-query/u);
  assert.match(SHARED_WORKFLOW_DRAFTS_SCRIPT, /usage-next/u);
});

test('webview sends only bounded explicit usage values, even when an unrelated editor buffer is invalid', () => {
  const posted = []; const handlers = {};
  const fields = { 'usage-skill-id': { value: 'review-skill' }, 'usage-selectors': { value: selectors },
    'usage-depth': { value: '2' }, 'draft-binding': { value: 'draft-bound' }, 'draft-name': { value: 'Name' },
    'draft-input': { value: 'x'.repeat(5 * 1024 * 1024 + 1) },
    'draft-input-error': { textContent: '', hidden: true } };
  class Element { closest() { return this; } }
  class HTMLButtonElement extends Element {
    constructor(action) { super(); this.dataset = { draftAction: action }; this.disabled = false; }
  }
  runInNewContext(SHARED_WORKFLOW_DRAFTS_SCRIPT, {
    window: { __sfVscode: { postMessage: (message) => posted.push(message) }, addEventListener: () => {} },
    document: { getElementById: (id) => fields[id], addEventListener: (type, listener) => { handlers[type] = listener; } },
    Element, HTMLButtonElement, TextEncoder
  });
  handlers.click({ target: new HTMLButtonElement('usage-query') });
  assert.equal(posted.length, 1);
  assert.deepEqual(Object.keys(posted[0]).sort(), ['type', 'usageHistoryDepth', 'usageSelectors', 'usageSkillId']);
  assert.equal(posted[0].usageSelectors, selectors);
  handlers.click({ target: new HTMLButtonElement('usage-next') });
  assert.equal(posted[1].type, 'usage-next');
  fields['usage-selectors'].value = 'x'.repeat(8193);
  handlers.click({ target: new HTMLButtonElement('usage-query') });
  assert.equal(posted.length, 2);
});

test('usage observations and selectors are HTML-escaped, not rendered as markup or active links', async () => {
  const f = fixture((cursor) => report(cursor, { observations: [{ repositoryIndex: 0,
    workId: '<script>alert(1)</script>', commit: 'b'.repeat(40), status: 'verified-matching-pin' }] }));
  await f.controller.receive({ type: 'usage-query', usageSkillId: 'review-skill', usageSelectors: selectors, usageHistoryDepth: 1 });
  const html = sharedWorkflowDraftsHtml(f.controller.view);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u);
});
