/**
 * The Repository Brief page: one tab per view, the phase's views first, every statement with
 * buttons to its sources, and the model's statements told apart from the evidence shown in their place.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { BRIEF_TABS, repositoryBriefBody } = await import(path.join(root, 'apps', 'vscode', 'src', 'views', 'repository-brief-page.ts'));

const brief = {
  repository: 'orders', commit: '0123456789abcdef', phase: 'intake',
  order: ['overview', 'rules', 'questions', 'contracts', 'flows', 'impact', 'risks'],
  mode: 'model', model: 'copilot', createdAt: '2026-10-09T12:00:00.000Z', cached: true, reason: null,
  views: {
    overview: [{ text: 'Orders takes customer orders.', cites: ['E1'], sources: [], origin: 'model' }],
    rules: [
      { text: 'Conflict: the README promises `422`, the code returns 400 <script>.', cites: ['E2', 'E9'], origin: 'model',
        sources: [{ path: 'README.md', line: 12, label: 'README.md › Error responses' }, { path: 'src/Orders.java', line: 40, label: 'src/Orders.java:40' }] }
    ],
    contracts: [{ text: 'POST /orders handled by OrderController.place', cites: ['E3'], origin: 'template', sources: [{ path: 'src/OrderController.java', line: 21, label: 'src/OrderController.java:21' }] }],
    flows: [], impact: [], risks: [],
    questions: [{ text: 'Which status is right?', cites: ['E2'], origin: 'model', sources: [] }]
  },
  rejected: 2, rejections: [{ view: 'rules', text: 'Orders over 99999 are refused.', reason: 'names what its evidence does not contain: 99999' }],
  evidence: { count: 40, documents: ['README.md'], documentStatements: 6 },
  documented: [{ text: 'An order needs at least one line.', path: 'README.md', line: 7, heading: 'Business rules' }],
  notKnown: ['no runtime or incident data']
};

test('every view has a tab, in the phase order, with the phase views highlighted', () => {
  const html = repositoryBriefBody(brief, { tab: 'rules', phase: 'intake', loading: null, error: null });
  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(tabs, ['overview', 'rules', 'questions', 'contracts', 'flows', 'impact', 'risks', 'sources']);
  assert.deepEqual([...tabs].sort(), [...BRIEF_TABS].sort());
  assert.match(html, /data-tab="rules" aria-selected="true" class="active phase"/u);
  assert.match(html, /data-tab="risks" aria-selected="false" class=""/u, 'risks is not among the first five for intake');
  assert.match(html, /Written by copilot/u);
  assert.match(html, /2 were dropped/u);
  assert.match(html, /<span class="badge">biz\.rules<\/span>/u);
});

test('statements are escaped, show conflicts and code, and link to each source', () => {
  const html = repositoryBriefBody(brief, { tab: 'rules', phase: 'all', loading: null, error: null });
  assert.match(html, /<span class="badge conflict">Conflict<\/span> the README promises <code>422<\/code>, the code returns 400 &lt;script&gt;\./u);
  assert.doesNotMatch(html, /<script>\./u);
  assert.match(html, /data-open-file="README\.md" data-open-line="12"/u);
  assert.match(html, /data-open-file="src\/Orders\.java" data-open-line="40"/u);
  const contracts = repositoryBriefBody(brief, { tab: 'contracts', phase: 'all', loading: null, error: null });
  assert.match(contracts, /from the evidence/u, 'a view the model left empty is marked');
});

test('the sources tab lists documents, docs statements and what the checks dropped; loading and errors are shown', () => {
  const html = repositoryBriefBody(brief, { tab: 'sources', phase: 'all', loading: null, error: null });
  assert.match(html, /Documents read/u);
  assert.match(html, /An order needs at least one line\./u);
  assert.match(html, /2 model statements were dropped by the checks/u);
  assert.match(html, /names what its evidence does not contain: 99999/u);
  const busy = repositoryBriefBody(null, { tab: 'overview', phase: 'all', loading: 'generate', error: 'The model is off.' });
  assert.match(busy, /Writing the brief with the model/u);
  assert.match(busy, /role="alert">The model is off\./u);
  assert.match(busy, /data-message="generate" disabled/u);
});

test('a brief read from another branch says so, and the branch picker lists the branches', () => {
  const other = {
    ...brief, branch: 'origin/migration', branches: ['origin/migration', 'test'],
    source: { ref: 'origin/migration', commit: '0123456789abcdef', checkedOut: 'test', chosen: 'has-code' },
    evidence: { ...brief.evidence, codeFiles: 13 }
  };
  const html = repositoryBriefBody(other, { tab: 'overview', phase: 'all', ref: null, loading: null, error: null });
  assert.match(html, /The checked-out branch <strong>test<\/strong> has no code, so this brief reads <strong>origin\/migration<\/strong> at <code>0123456789ab<\/code> straight from Git\./u);
  assert.match(html, /orders · origin\/migration at/u);
  assert.match(html, /<select id="brief-ref" data-message="ref"><option value="" selected>Checked out \(test\)<\/option><option value="origin\/migration">origin\/migration<\/option><option value="test">test<\/option><\/select>/u);
  const picked = repositoryBriefBody(other, { tab: 'overview', phase: 'all', ref: 'test', loading: null, error: null });
  assert.match(picked, /<option value="test" selected>/u);
  const empty = repositoryBriefBody({ ...other, source: { ...other.source, ref: 'test', chosen: 'requested' }, branch: 'test', evidence: { ...brief.evidence, codeFiles: 0 } },
    { tab: 'overview', phase: 'all', ref: 'test', loading: null, error: null });
  assert.match(empty, /No code at <strong>test<\/strong> <code>0123456789ab<\/code>\. Pick a branch that has code above\./u);
});

test('the Repository Knowledge command opens the brief panel through the lazy bundle', async () => {
  const extension = await readFile(path.join(root, 'apps', 'vscode', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.openRepositoryKnowledge': async \(\) => \{\s*await reconcileActiveWorkspaceSelection\(\);\s*const \{ RepositoryBriefPanel \} = lazyPanels\(\);/u);
  const lazy = await readFile(path.join(root, 'apps', 'vscode', 'src', 'lazy-panels-runtime.ts'), 'utf8');
  assert.match(lazy, /export \{ RepositoryBriefPanel \} from '\.\/views\/repository-brief\.ts';/u);
  const panel = await readFile(path.join(root, 'apps', 'vscode', 'src', 'views', 'repository-brief.ts'), 'utf8');
  assert.match(panel, /registerMessageRouter\('singularityFlow\.repositoryBrief'/u, 'messages go through the closed router');
});
