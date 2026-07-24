import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assignLocalStoryIds, nextLocalEpicId, reserveLocalEpicBranch } from '../src/local-identity.mjs';
import { listInitiatives } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

function policy(publish = 'off') {
  return {
    initiativeRoot: 'singularity/initiatives',
    git: { remote: 'origin', publish },
    identity: {
      authority: 'local',
      local: {
        epicPrefix: 'SF-E',
        storyPrefix: 'SF-S',
        pad: 3,
        scopeStoriesByEpic: true
      }
    }
  };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-identity-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Planner'], { cwd: root });
  run('git', ['config', 'user.email', 'planner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Local IDs\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initial'], { cwd: root });
  return root;
}

test('local Epic allocation scans governed directories and branches', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'singularity/initiatives/SF-E-002'), { recursive: true });
  run('git', ['branch', 'SF-E-004'], { cwd: root });
  const next = await nextLocalEpicId(root, policy());
  assert.equal(next.id, 'SF-E-005');
});

test('local Story IDs retain plan IDs and are scoped by reserved Epic', () => {
  const portfolio = policy();
  const initiative = {
    initiative: { id: 'SF-E-007' },
    resolution: { identity: portfolio.identity }
  };
  const breakdown = {
    epics: [{
      id: 'PLAN-EPIC-001',
      stories: [
        { id: 'STORY-001', planId: 'STORY-001' },
        { id: 'STORY-002', planId: 'STORY-002' }
      ]
    }]
  };
  const assigned = assignLocalStoryIds(breakdown, initiative, portfolio);
  assert.deepEqual(assigned.stories.map((story) => story.workId), ['SF-S-007-001', 'SF-S-007-002']);
  assert.deepEqual(assigned.stories.map((story) => story.planId), ['STORY-001', 'STORY-002']);
  assert.ok(assigned.stories.every((story) => story.idAuthority === 'local'));
});

test('local Epic reservation is a committed branch allocation', async () => {
  const root = await repository();
  const result = await reserveLocalEpicBranch(root, policy(), {
    base: 'main',
    actor: { name: 'Planner', email: 'planner@example.com' }
  });
  assert.equal(result.id, 'SF-E-001');
  assert.equal(result.pushed, false);
  assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), 'SF-E-001');
  assert.match(run('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: root }).stdout, /identity-reservations\/SF-E-001\.json/);
});

test('Epic home discovers committed initiative state from remote branches', async () => {
  const root = await repository();
  const remoteRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-origin-'));
  const remote = path.join(remoteRoot, 'origin.git');
  run('git', ['init', '--bare', remote], { cwd: remoteRoot });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: root });
  run('git', ['switch', '-c', 'SF-E-001'], { cwd: root });
  const directory = path.join(root, 'singularity/initiatives/SF-E-001');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'state.json'), JSON.stringify({
    initiative: {
      id: 'SF-E-001',
      branch: 'SF-E-001',
      title: 'Remote business Epic',
      profile: 'epic-planning',
      profileLabel: 'Epic planning',
      createdAt: '2026-07-24T00:00:00.000Z'
    },
    lineage: { idAuthority: 'local', primaryId: 'SF-E-001', aliases: [] },
    phaseOrder: ['epic-intake', 'epic-requirements'],
    phases: {
      'epic-intake': { id: 'epic-intake', label: 'Epic intake', status: 'approved' },
      'epic-requirements': { id: 'epic-requirements', label: 'Requirements', status: 'awaiting_approval', submittedAt: '2026-07-24T01:00:00.000Z' }
    },
    currentPhase: 'epic-requirements',
    status: 'in_progress',
    history: [{ at: '2026-07-24T01:00:00.000Z', actor: 'owner@example.com', event: 'initiative_phase_published' }]
  }));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Add remote Epic'], { cwd: root });
  run('git', ['push', '-u', 'origin', 'SF-E-001'], { cwd: root });
  run('git', ['switch', 'main'], { cwd: root });
  const items = await listInitiatives(root, policy('required'));
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'SF-E-001');
  assert.equal(items[0].currentPhaseLabel, 'Requirements');
  assert.equal(items[0].currentPhaseStatus, 'awaiting_approval');
  assert.equal(items[0].percentage, 50);
  assert.equal(items[0].source, 'origin/SF-E-001');
});
