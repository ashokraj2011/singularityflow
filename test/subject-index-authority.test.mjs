import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildRepositorySubjectIndexFromRefs, resolveContext
} from '../src/repository-subject-index.mjs';
import { resolveGovernedWork } from '../src/commands/goal.mjs';
import { run } from '../src/util.mjs';

function story(id, status) {
  return {
    schemaVersion: 2,
    workItem: { id, title: id, branch: id, workType: 'chore' },
    status,
    currentPhase: status === 'complete' ? null : 'intake',
    phaseOrder: ['intake'],
    phases: { intake: { id: 'intake', status: status === 'complete' ? 'approved' : 'in_progress', generation: 1 } },
    lineage: { canonicalBranch: id, childBranches: [], requiredChecks: [] },
    history: []
  };
}

function initiative(id, status) {
  return {
    schemaVersion: 1,
    initiative: { id, title: id, branch: id, profile: 'portfolio' },
    status,
    currentPhase: status === 'complete' ? null : 'discovery',
    phaseOrder: ['discovery'],
    phases: { discovery: { id: 'discovery', status: status === 'complete' ? 'approved' : 'in_progress' } },
    lineage: { branches: [] }
  };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-subject-authority-'));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Subject Authority'], { cwd: root });
  run('git', ['config', 'user.email', 'subject@example.invalid'], { cwd: root });
  await mkdir(path.join(root, 'singularity/work-items/AAA'), { recursive: true });
  await mkdir(path.join(root, 'singularity/work-items/STORY-1'), { recursive: true });
  await mkdir(path.join(root, 'singularity/work-items/ZZZ'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\nworkItemRoot: singularity/work-items\n');
  await writeFile(path.join(root, 'singularity/work-items/AAA/workflow.json'), `${JSON.stringify(story('STORY-1', 'complete'))}\n`);
  await writeFile(path.join(root, 'singularity/work-items/STORY-1/workflow.json'), `${JSON.stringify(story('STORY-1', 'active'))}\n`);
  await writeFile(path.join(root, 'singularity/work-items/ZZZ/workflow.json'), `${JSON.stringify(story('STORY-1', 'complete'))}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'state'], { cwd: root });
  return root;
}

test('ref subject authority is canonical-path bound regardless of tree order', async () => {
  const root = await repository();
  const index = await buildRepositorySubjectIndexFromRefs(root, {
    definition: { workItemRoot: 'singularity/work-items' },
    refs: [{ branch: 'STORY-1', ref: 'main' }]
  });
  const selected = index.list('story').find((entry) => entry.id === 'STORY-1');
  assert.equal(selected.state.status, 'active');
  assert.equal(selected.location.directory, 'STORY-1');
  assert.equal(selected.location.path, 'singularity/work-items/STORY-1/workflow.json');
  assert.deepEqual(index.unreadable.map((entry) => entry.code), [
    'SUBJECT_STATE_NONCANONICAL', 'SUBJECT_STATE_NONCANONICAL'
  ]);
  assert.equal(index.conflicts.length, 2);
  assert.equal(index.conflicts.every((entry) => entry.code === 'SUBJECT_STATE_DUPLICATE'), true);

  const resolved = resolveContext(index, { reference: 'STORY-1', kind: 'story' });
  assert.equal(resolved.state.status, 'active');
  assert.equal(resolved.location.path, 'singularity/work-items/STORY-1/workflow.json');
});

test('noncanonical ref state can never satisfy a governed Goal oracle', async () => {
  const root = await repository();
  const context = {
    workspace: {
      id: 'workspace', name: 'Workspace', path: path.dirname(root),
      repositories: {
        app: { id: 'app', path: 'unused', adoption: { mode: 'existing-clone', canonicalPath: root } }
      }
    },
    selected: { repositoryId: 'app' }
  };
  const observed = await resolveGovernedWork(context, {
    reference: 'STORY-1', kind: 'story', repositoryId: 'app', required: false
  });
  assert.equal(observed.availability, 'unavailable');
  assert.equal(observed.terminal, false);
  assert.equal(observed.status, 'unknown');
  assert.ok(observed.diagnostics.some((entry) => entry.code === 'SUBJECT_STATE_NONCANONICAL'));
});

test('the same canonical subject on distinct legitimate refs is not a duplicate', async () => {
  const root = await repository();
  run('git', ['branch', 'review'], { cwd: root });
  const index = await buildRepositorySubjectIndexFromRefs(root, {
    definition: { workItemRoot: 'singularity/work-items' },
    refs: [{ branch: 'main', ref: 'main' }, { branch: 'review', ref: 'review' }]
  });
  assert.equal(index.list('story').length, 1);
  assert.equal(index.list('story')[0].locations.length, 2);
  assert.equal(index.conflicts.length, 4,
    'only the two noncanonical claims on each ref are conflicts; the canonical refs are legitimate');
});

test('custom Story and Initiative roots retain canonical directory authority', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'governed/stories/CUSTOM-1'), { recursive: true });
  await mkdir(path.join(root, 'governed/initiatives/EPIC-1'), { recursive: true });
  await mkdir(path.join(root, 'governed/initiatives/SHADOW'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'version: 2\nworkItemRoot: governed/stories\n');
  await writeFile(path.join(root, 'singularity/portfolio.yml'), 'version: 1\ninitiativeRoot: governed/initiatives\n');
  await writeFile(path.join(root, 'governed/stories/CUSTOM-1/workflow.json'), `${JSON.stringify(story('CUSTOM-1', 'active'))}\n`);
  await writeFile(path.join(root, 'governed/initiatives/EPIC-1/state.json'), `${JSON.stringify(initiative('EPIC-1', 'active'))}\n`);
  await writeFile(path.join(root, 'governed/initiatives/SHADOW/state.json'), `${JSON.stringify(initiative('EPIC-1', 'complete'))}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'custom roots'], { cwd: root });

  const index = await buildRepositorySubjectIndexFromRefs(root, { refs: ['main'] });
  assert.equal(index.list('story').find((entry) => entry.id === 'CUSTOM-1').location.path,
    'governed/stories/CUSTOM-1/workflow.json');
  const epic = index.list('initiative').find((entry) => entry.id === 'EPIC-1');
  assert.equal(epic.state.status, 'active');
  assert.equal(epic.location.path, 'governed/initiatives/EPIC-1/state.json');
  assert.ok(index.unreadable.some((entry) => entry.code === 'SUBJECT_STATE_NONCANONICAL'
    && entry.path === 'governed/initiatives/SHADOW/state.json'));
});

test('branch-selected resolution preserves the canonical path on that branch', async () => {
  const root = await repository();
  run('git', ['switch', '-qc', 'review'], { cwd: root });
  const canonicalPath = path.join(root, 'singularity/work-items/STORY-1/workflow.json');
  const canonical = story('STORY-1', 'active');
  canonical.lineage.childBranches = [{ name: 'review' }];
  await writeFile(canonicalPath, `${JSON.stringify(canonical)}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'review branch state'], { cwd: root });
  run('git', ['switch', '-q', 'main'], { cwd: root });

  const index = await buildRepositorySubjectIndexFromRefs(root, {
    refs: [{ branch: 'main', ref: 'main' }, { branch: 'review', ref: 'review' }]
  });
  const resolved = resolveContext(index, { reference: 'review', kind: 'story' });
  assert.equal(resolved.selectedBranch, 'review');
  assert.equal(resolved.location.ref, 'review');
  assert.equal(resolved.location.path, 'singularity/work-items/STORY-1/workflow.json');
});

test('bad JSON and unknown schema remain explicit unreadable ref evidence', async () => {
  const root = await repository();
  await mkdir(path.join(root, 'singularity/work-items/BAD'), { recursive: true });
  await mkdir(path.join(root, 'singularity/work-items/FUTURE'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/BAD/workflow.json'), '{not json}\n');
  await writeFile(path.join(root, 'singularity/work-items/FUTURE/workflow.json'), `${JSON.stringify({
    ...story('FUTURE', 'active'), schemaVersion: 999
  })}\n`);
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'invalid state'], { cwd: root });

  const index = await buildRepositorySubjectIndexFromRefs(root, { refs: ['main'] });
  const bad = index.unreadable.filter((entry) => /\/(BAD|FUTURE)\//.test(entry.path ?? ''));
  assert.equal(bad.length, 2);
  assert.equal(bad.every((entry) => entry.code === 'SUBJECT_STATE_UNREADABLE'), true);
  assert.equal(bad.every((entry) => entry.ref === 'main' && entry.commit), true);

  const context = {
    workspace: {
      id: 'workspace', name: 'Workspace', path: path.dirname(root),
      repositories: {
        app: { id: 'app', path: 'unused', adoption: { mode: 'existing-clone', canonicalPath: root } }
      }
    },
    selected: { repositoryId: 'app' }
  };
  const unavailable = await resolveGovernedWork(context, {
    reference: 'BAD', kind: 'story', repositoryId: 'app', required: false
  });
  assert.equal(unavailable.availability, 'unavailable');
  assert.equal(unavailable.terminal, false);
  assert.ok(unavailable.diagnostics.some((entry) => entry.claimedId === 'BAD'));
});
