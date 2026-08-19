import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { deriveHomeState } from '../src/gateway/home-work-projection.mjs';
import { developerNext } from '../src/gateway/planners/developer-next.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { recommendationNarration } from '../src/commands/recommend.mjs';

const emptyGroups = () => ({
  'recovery-required': [], 'waiting-on-you': [], active: [],
  'waiting-on-others': [], 'recently-completed': []
});

function recordsFor(item) {
  const groups = emptyGroups();
  groups[item.group].push(item);
  return { items: [item], groups };
}

const started = {
  id: 'WRK-890', title: 'Calculator work', group: 'active', repositoryId: 'calc',
  branch: 'wi/WRK-890', branches: ['wi/WRK-890', 'WRK-890'], phase: 'intake',
  phaseLabel: 'Intake', status: 'in_progress', rail: [],
  nextAction: { operation: 'work.continue' }
};

test('every surface recognizes a started Story through any registered branch', () => {
  const records = recordsFor(started);
  const state = deriveHomeState(records, { repositoryId: 'calc', branch: 'WRK-890' });
  assert.equal(state.currentWork?.id, 'WRK-890');
  assert.equal(state.activeWork?.id, 'WRK-890');
  assert.equal(state.activeCount, 1);
  assert.equal(state.visibleCount, 1);

  const result = homeOverviewResult({
    workspace: { id: 'calc-app', name: 'calc-app' }, records,
    actor: { name: 'Ada Lovelace', email: 'ada@example.test' },
    current: { repositoryId: 'calc', branch: 'WRK-890', repositoryScoped: false }
  });
  assert.deepEqual(result.data.personalization, {
    schemaVersion: 1, source: 'git-identity', displayName: 'Ada Lovelace', replyName: 'Ada'
  });
  assert.equal(result.data.activeWork?.id, 'WRK-890');
  assert.equal(result.next[0].id, 'home:work.continue');
  assert.equal(result.next[0].slots.work, 'WRK-890');
  assert.equal(result.next[0].fallback.skill, '/sf-resume WRK-890');
});

test('visible work on another branch is not advertised as current', () => {
  const records = recordsFor(started);
  const state = deriveHomeState(records, { repositoryId: 'calc', branch: 'main' });
  assert.equal(state.currentWork, null);
  assert.equal(state.activeCount, 1, 'the work remains visible in the workspace');

  const result = homeOverviewResult({
    workspace: { id: 'calc-app', name: 'calc-app' }, records,
    current: { repositoryId: 'calc', branch: 'main', repositoryScoped: false }
  });
  assert.equal(result.data.activeWork, null);
  assert.equal(result.next[0].id, 'home:work.list');
  assert.ok(!result.next.some((entry) => entry.id === 'home:work.continue'));
});

test('a bound Story awaiting this actor\'s decision remains current and keeps repository context', async () => {
  const waiting = {
    ...started,
    id: 'WRK-19',
    title: 'Convert to SQL Server',
    branch: 'WRK-19',
    branches: ['WRK-19'],
    phase: 'release',
    phaseLabel: 'Release',
    status: 'awaiting_approval',
    group: 'waiting-on-you',
    repositoryId: 'rulecompiler',
    nextAction: { operation: 'review.packet' }
  };
  const records = recordsFor(waiting);
  const repository = {
    id: 'rulecompiler', path: '/workspace/repos/rulecompiler', branch: 'WRK-19',
    head: '56097b70adee193f8200369caa9553be57ca96d9', resolvedFrom: 'active-workspace'
  };
  const context = {
    workspace: { id: 'local--rule-comiler', name: 'rule-comiler' },
    repository,
    repositoryId: repository.id,
    storyId: 'WRK-19',
    branch: 'WRK-19',
    records,
    localChanges: { dirty: false, files: 0, paths: [] }
  };

  const home = homeOverviewResult({
    workspace: context.workspace,
    repository,
    records,
    current: context,
    localChanges: context.localChanges,
    otherWorkspaces: 3
  });
  assert.equal(home.data.activeWork, null, 'approval grouping remains mechanically distinct');
  assert.equal(home.data.currentWork?.id, 'WRK-19');
  assert.equal(home.data.currentWork?.group, 'waiting-on-you');
  assert.equal(home.data.attentionWork?.id, 'WRK-19');
  assert.deepEqual(home.data.repository, repository);
  assert.equal(home.next[0].id, 'home:review:story:WRK-19');
  assert.equal(home.next[0].slots.work, 'WRK-19');
  assert.equal(home.next[0].fallback.skill, '/sf-approve WRK-19');
  assert.equal(home.next[0].fallback.command, 'singularity-flow approvals WRK-19');

  const recommended = await developerNext({ root: process.cwd(), context });
  assert.equal(recommended.data.guidance.workId, 'WRK-19');
  assert.equal(recommended.data.currentWork?.id, 'WRK-19');
  assert.notEqual(recommended.next[0].fallback?.skill, '/sf-session');

  const narrated = recommendationNarration(recommended);
  assert.equal(narrated.data.home.repository.id, 'rulecompiler');
  assert.equal(narrated.data.home.currentWork.id, 'WRK-19');
  assert.equal(narrated.data.home.attentionWork.id, 'WRK-19');
});

test('an empty home leads to intake and every route names its Copilot skill', () => {
  const records = { items: [], groups: emptyGroups() };
  const result = homeOverviewResult({
    workspace: { id: 'calc-app', name: 'calc-app' }, records,
    current: { repositoryId: 'calc', branch: 'main', repositoryScoped: false }
  });
  assert.equal(result.next[0].id, 'home:work.start.intake');
  assert.equal(result.next[0].fallback.skill, '/sf-start <WORK-ID>');
  assert.ok(result.next.every((entry) => entry.fallback?.skill?.startsWith('/sf-')));
});

test('the Copilot home skill explicitly routes every home goal and refreshes afterwards', async () => {
  const skill = await readFile(new URL('../plugin/skills/sflow-home/SKILL.md', import.meta.url), 'utf8');
  for (const goal of [
    'home:work.continue', 'home:work.list', 'home:work.return', 'home:work.start.intake',
    'home:workspace.switch', 'home:impact.quick', 'home:repository.explore', 'home:help.explain'
  ]) assert.match(skill, new RegExp(goal.replaceAll('.', '\\.')));
  assert.match(skill, /ask_user/);
  assert.match(skill, /singularity-flow home --json --request "\$ARGUMENTS"/);
  for (const intent of ['orient', 'continue', 'start', 'inspect', 'act', 'recover']) {
    assert.match(skill, new RegExp(`\\b${intent}\\b`));
  }
  for (const heading of ['I found', 'Next', 'I need from you', 'This will change']) {
    assert.match(skill, new RegExp(`\\*\\*${heading}\\*\\*`));
  }
  assert.match(skill, /automatic invocation is not mutation consent/);
  assert.match(skill, /data\.home\.personalization\.replyName/);
  assert.match(skill, /data\.home\.repository/);
  assert.match(skill, /data\.home\.currentWork/);
  assert.match(skill, /never say the repository is unresolved/i);
  assert.match(skill, /Do not derive a name from email, login/);
  assert.match(skill, /After a selected flow completes, run `singularity-flow home`/);
});
