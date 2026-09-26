import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  approvePhase, beginPhaseGeneration, pendingPublicationPath, preparePhaseInputs,
  publishGeneration, submitPhase
} from '../src/state.mjs';

async function fixture(t, {
  pinnedKind = 'skill', currentKind = 'skill', status = 'in_progress'
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q', '-b', 'main'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(init.status, 0, init.stderr);
  const phase = {
    id: 'review', kind: currentKind, status, generation: status === 'awaiting_approval' ? 1 : 0,
    approvals: [], approvalPolicy: { mode: 'required' }
  };
  const workflow = {
    workItem: { id: 'SKP-STATE-1', workType: 'test', branch: 'main' },
    status: 'in_progress', currentPhase: phase.id, phaseOrder: [phase.id],
    phases: { [phase.id]: phase },
    resolution: {
      sequenceGates: { default: 'hard' },
      phases: [{ id: phase.id, kind: pinnedKind }]
    }
  };
  const config = { workItemRoot: 'singularity/work-items' };
  return { root, config, workflow, phase };
}

async function assertNoMutationOnHostRefusal(value, attempt) {
  const before = structuredClone(value.workflow);
  const filesBefore = await readdir(value.root);
  const storyPath = path.join(value.root, value.config.workItemRoot, value.workflow.workItem.id);
  const marker = pendingPublicationPath(value.root, value.config, value.workflow.workItem.id);
  assert.equal(existsSync(storyPath), false);
  assert.equal(existsSync(marker), false);
  await assert.rejects(attempt, { code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE' });
  assert.deepEqual(value.workflow, before, 'host refusal must not mutate in-memory lifecycle state');
  assert.deepEqual(await readdir(value.root), filesBefore,
    'host refusal must not create a Story file or a local publication marker');
  assert.equal(existsSync(storyPath), false);
  assert.equal(existsSync(marker), false);
}

test('pinned skill phase refuses prepare, publication and submission before host delivery', async (t) => {
  const value = await fixture(t);
  await assertNoMutationOnHostRefusal(value, () => preparePhaseInputs(
    value.root, value.config, value.workflow, 'review'
  ));
  await assertNoMutationOnHostRefusal(value, () => publishGeneration(
    value.root, value.config, value.workflow, { phaseId: 'review' }
  ));
  await assertNoMutationOnHostRefusal(value, () => submitPhase(
    value.root, value.config, value.workflow, { phaseId: 'review' }
  ));
});

test('pinned skill phase refuses code-generation entry before creating an intent', async (t) => {
  const value = await fixture(t);
  await assertNoMutationOnHostRefusal(value, () => beginPhaseGeneration(
    value.root, value.config, value.workflow, { phaseId: 'review' }
  ));
});

test('submitted skill phase refuses approval before a decision or phase advance', async (t) => {
  const value = await fixture(t, { status: 'awaiting_approval' });
  await assertNoMutationOnHostRefusal(value, () => approvePhase(
    value.root, value.config, value.workflow, { phaseId: 'review' }
  ));
});

test('accepted skill kind cannot be downgraded in mutable Story phase to bypass host gate', async (t) => {
  const value = await fixture(t, { pinnedKind: 'skill', currentKind: 'template' });
  await assertNoMutationOnHostRefusal(value, () => preparePhaseInputs(
    value.root, value.config, value.workflow, 'review'
  ));
});

test('skill phase added to mutable Story state cannot bypass the host gate either', async (t) => {
  const value = await fixture(t, { pinnedKind: 'template', currentKind: 'skill' });
  await assertNoMutationOnHostRefusal(value, () => preparePhaseInputs(
    value.root, value.config, value.workflow, 'review'
  ));
});

test('ordinary template phase retains its existing code-generation classification', async (t) => {
  const value = await fixture(t, { pinnedKind: 'template', currentKind: 'template' });
  await assert.rejects(
    () => beginPhaseGeneration(value.root, value.config, value.workflow, { phaseId: 'review' }),
    { code: 'GENERATION_INTENT_NOT_APPLICABLE' }
  );
});
