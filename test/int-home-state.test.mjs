import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { deriveHomeState } from '../src/gateway/home-work-projection.mjs';
import { homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';

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
    current: { repositoryId: 'calc', branch: 'WRK-890', repositoryScoped: false }
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
  assert.match(skill, /After a selected flow completes, run `singularity-flow home`/);
});
