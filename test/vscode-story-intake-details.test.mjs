import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { storyIntakeBody } from '../apps/vscode/src/views/story-intake-page.ts';
import { sidebarBody } from '../apps/vscode/src/views/sidebar-page.ts';
import { buildLifecycleTree } from '../apps/vscode/src/views/tree-model.ts';

const workflow = (status = 'in_progress') => ({
  workItem: { id: 'STORY-42', title: 'Keep entered details', workType: 'team-custom',
    workTypeLabel: 'Team delivery', branch: 'STORY-42', baseBranch: 'release/next',
    baseCommit: '1234abc', baseRemote: 'origin', createdAt: '2026-10-06T10:00:00Z' },
  currentPhase: 'custom-code', phaseOrder: [], phases: {}, status,
  resolution: { capability: { id: 'payments', label: 'Payments' }, testExecutionMode: 'changed-only',
    referenceRepositories: [{ id: 'legacy', requestedBranch: 'release/reference', commit: '4321abc' }] }
});
const source = { title: 'Requested title', user: 'Operations', description: 'Original input\nSecond line',
  acceptanceCriteria: ['Accept A', 'Accept B'], scope: 'Small change', constraints: 'Offline',
  outOfScope: 'Other modules', customField: 'Retain custom intake', type: 'manual' };
const preview = (input = source) => ({ record: { id: 'SYS-SOURCE', path: 'singularity/work-items/STORY-42/source.json' },
  content: JSON.stringify(input, null, 2), verifiedSha256: 'a'.repeat(64) });
const readSource = file => readFile(new URL(`../apps/vscode/src/${file}`, import.meta.url), 'utf8');

test('intake page shows saved inputs, custom fields and recorded setup without redrafting', () => {
  const html = storyIntakeBody(workflow(), preview());
  for (const value of ['Requested title', 'Operations', 'Original input', 'Accept A', 'Accept B', 'Small change',
    'Other modules', 'Offline', 'Retain custom intake', 'Team delivery', 'release/next', '1234abc', 'Payments',
    'changed-only', 'release/reference', '4321abc']) assert.ok(html.includes(value), value);
  assert.match(html, /Read-only saved input/);
  assert.match(html, /Saved source record/);
  assert.match(html, /Read SHA-256/);
  assert.match(html, /Test policies can be amended after intake/);
});

test('current evidence is not claimed as original intake attachments', () => {
  const html = storyIntakeBody(workflow(), preview(), [
    { id: 'DOC-1', name: 'later-screenshot.png', type: 'file', availability: 'available' },
    { id: 'ART-1', name: 'Generated plan', type: 'generated-artifact' }
  ]);
  assert.match(html, /This catalog includes later uploads/);
  assert.match(html, /later-screenshot.png/);
  assert.doesNotMatch(html, /Generated plan/);
});

test('repository intake, references and document labels cannot inject HTML, actions or executable links', () => {
  const attack = '<img src=x onerror="execute()"><script>execute()</script>';
  const state = workflow();
  state.workItem.title = attack;
  state.resolution.referenceRepositories[0].id = attack;
  const html = storyIntakeBody(state, preview({ ...source, description: attack, url: 'javascript:execute()' }),
    [{ id: 'DOC-1', type: 'url', name: attack }]);
  assert.doesNotMatch(html, /<img|<script|onclick=|href=|data-action="execute/);
  assert.match(html, /&lt;img/);
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/gu)].map(match => match[1]), ['evidence', 'tests', 'refresh']);
});

test('missing setup is unknown, not a guessed workflow, test result or base', () => {
  const html = storyIntakeBody({ workItem: { id: 'MINIMAL' }, resolution: {} }, preview({}));
  assert.match(html, /Not recorded/);
  assert.match(html, /No reference repository was recorded/);
  assert.match(html, /No supporting evidence is reported/);
  assert.doesNotMatch(html, /changed-only|release\/next|Tests passed|spec-driven-standard/);
});

test('invalid and truncated source previews report limitations and preserve returned text', () => {
  for (const content of ['{broken', 'null', '[]', '42']) {
    const html = storyIntakeBody(workflow(), { ...preview(), content });
    assert.match(html, /could not be interpreted as a JSON object/);
    assert.ok(html.includes(content));
  }
  const truncated = storyIntakeBody(workflow(), { ...preview(), content: '{"description":"Partial', truncated: true });
  assert.match(truncated, /not all intake details are available/);
  assert.match(truncated, /Saved source record \(truncated\)/);
  for (const result of [{}, { ...preview(), record: { id: 'SYS-WORKFLOW' } },
    { ...preview(), binary: true }, { ...preview(), content: null }]) {
    assert.throws(() => storyIntakeBody(workflow(), result), /selected Story source document/);
  }
});

test('current Story has a direct Navigator intake action; Initiative and unknown contexts do not', () => {
  const view = kind => ({ navigation: { workspace: null, next: null, ...(kind ? { subject: { kind, id: 'S', phase: 'custom-code' } } : {}) },
    freshness: null, loading: false, pending: null, active: null, favorites: [] });
  assert.match(sidebarBody(view('Story')), /data-action="story-intake">View intake details/);
  for (const kind of ['Initiative', null]) assert.doesNotMatch(sidebarBody(view(kind)), /data-action="story-intake"/);
});

test('active, completed and cancelled selected Stories keep their saved intake action', () => {
  const flatten = nodes => nodes.flatMap(node => [node, ...flatten(node.children ?? [])]);
  for (const status of ['in_progress', 'closed', 'cancelled']) {
    const entries = flatten(buildLifecycleTree({ workflow: workflow(status), documents: [] }));
    const actions = entries.filter(node => node.runCommand === 'singularityFlow.openStoryIntake');
    assert.equal(actions.length, 1, status);
    assert.equal(actions[0].label, 'View intake details');
  }
});

test('menu, shortcuts and palette dispatch the exact read-only selected-Story source read', async () => {
  const extension = await readSource('extension.ts');
  const block = extension.slice(extension.indexOf("'singularityFlow.openStoryIntake': async"),
    extension.indexOf("'singularityFlow.runAction': runNode"));
  assert.match(block, /\['documents', 'view', 'SYS-SOURCE', '--work-id', workId, '--json'\]/);
  assert.equal((block.match(/client\.run</gu) ?? []).length, 1);
  assert.match(block, /repositoryEpoch\.isCurrent\(scope\)/);
  assert.match(block, /workItem\.id === workId/);
  assert.match(block, /request === storyIntakeRequest/);
  assert.match(block, /store\.onDidChange\(\(\) => \{ if \(!stillCurrent\(\)\) panel\.dispose\(\)/);
  assert.match(block, /selection\.dispose\(\)/);
  assert.doesNotMatch(block, /--fetch|readFile|absolutePath|sendText|\['start'|\['test'|\['approve'/);
  const registrations = extension.slice(extension.indexOf('const REPOSITORY_COMMANDS'), extension.indexOf('];', extension.indexOf('const REPOSITORY_COMMANDS')));
  assert.match(registrations, /'singularityFlow\.openStoryIntake'/);
  const sidebar = await readSource('views/sidebar.ts');
  assert.match(sidebar, /'story-intake': 'singularityFlow\.openStoryIntake'/);
  assert.match(sidebar, /'work-tools':[^\n]+'story-intake'/);
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some(entry => entry.command === 'singularityFlow.openStoryIntake'));
});

test('intake webview accepts fixed actions, uses nonce styles and supports footer navigation', async () => {
  const panel = await readSource('views/story-intake-details.ts');
  assert.match(panel, /localResourceRoots: \[\]/);
  assert.match(panel, /contentSecurityPolicy\(panel\.webview, token\)/);
  assert.match(panel, /<style nonce="\$\{token\}">/);
  assert.match(panel, /navigationTarget\(raw\)/);
  assert.match(panel, /registerMessageRouter/);
  assert.doesNotMatch(panel, /executeCommand|fetch\(|nav: false|readFile/);
  assert.ok(panel.indexOf('storyIntakeBody(workflow') < panel.indexOf('createWebviewPanel'));
});
