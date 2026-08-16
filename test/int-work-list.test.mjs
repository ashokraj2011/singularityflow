import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workList, workListResult } from '../src/gateway/planners/work-list.mjs';
import { WORK_GROUP_ORDER, lastMaterialEvent, workRecords } from '../src/gateway/work-records.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const OTHER = { login: 'dev-2', email: 'dev-2@example.com', name: 'Dev Two' };

const story = (id, phases, { currentPhase, history = [], title = id }) => ({
  workItem: { id, title, workType: 'feature', branch: `wi/${id}` },
  phaseOrder: Object.keys(phases),
  currentPhase,
  phases,
  history
});

/**
 * A repository of work items and nothing else.
 *
 * The subject index scans the working tree, so a fixture is a directory of `workflow.json` files —
 * no Git, no network, no clock. Every grouping rule below is therefore exercised against the real
 * index rather than a stand-in for it.
 */
async function fixture(stories) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-work-'));
  for (const [id, workflow] of Object.entries(stories)) {
    const directory = path.join(root, 'singularity', 'work-items', id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
  }
  return root;
}

test('work is grouped by whether it is yours to move', async () => {
  const root = await fixture({
    'WRK-1': story('WRK-1', { design: { status: 'in_progress', generation: 1 } }, {
      currentPhase: 'design',
      history: [{ event: 'work_started', phase: 'design', actor: ACTOR, at: '2026-08-01T10:00:00.000Z' }]
    }),
    'WRK-2': story('WRK-2', { design: { status: 'awaiting_approval', generation: 1, approvalPolicy: { minimum: 1 } } }, {
      currentPhase: 'design',
      history: [{ event: 'phase_submitted', phase: 'design', actor: OTHER, at: '2026-08-02T10:00:00.000Z' }]
    }),
    'WRK-3': story('WRK-3', { design: { status: 'awaiting_approval', generation: 2, approvalPolicy: { minimum: 1 } } }, {
      currentPhase: 'design',
      history: [{ event: 'phase_submitted', phase: 'design', actor: ACTOR, at: '2026-08-03T10:00:00.000Z' }]
    })
  });

  const records = await workRecords(root, { actor: ACTOR });
  const groupOf = (id) => records.items.find((item) => item.id === id).group;
  assert.equal(groupOf('WRK-1'), 'active');
  // Someone else submitted it, so it is a review waiting on this reader.
  assert.equal(groupOf('WRK-2'), 'waiting-on-you');
  // This reader submitted it, so it is waiting on somebody who is not them.
  assert.equal(groupOf('WRK-3'), 'waiting-on-others');
  assert.deepEqual(records.groupOrder, [...WORK_GROUP_ORDER]);
});

test('a pending publication outranks every other grouping', async () => {
  const root = await fixture({
    'WRK-1': story('WRK-1', { design: { status: 'awaiting_approval', generation: 1 } }, { currentPhase: 'design' })
  });
  const records = await workRecords(root, { actor: ACTOR, pendingPublications: new Set(['WRK-1']) });
  assert.equal(records.items[0].group, 'recovery-required');
  assert.equal(records.items[0].whyVisible, 'publication.pending');
  assert.ok(records.items[0].blockers.includes('publication-pending'));
  assert.equal(records.items[0].nextAction.operation, 'work.continue');
});

test('completed work is out of the way unless it is asked for', async () => {
  const done = { design: { status: 'approved', generation: 1 } };
  const root = await fixture({ 'WRK-9': story('WRK-9', done, { currentPhase: 'design' }) });

  assert.equal((await workRecords(root, { actor: ACTOR })).items.length, 0);
  const included = await workRecords(root, { actor: ACTOR, includeCompleted: true });
  assert.equal(included.items[0].group, 'recently-completed');
});

test('ordering is newest material event first, and stable when they tie', async () => {
  const at = '2026-08-05T10:00:00.000Z';
  const root = await fixture({
    'WRK-B': story('WRK-B', { design: { status: 'in_progress' } }, {
      currentPhase: 'design', history: [{ event: 'work_started', actor: ACTOR, at }]
    }),
    'WRK-A': story('WRK-A', { design: { status: 'in_progress' } }, {
      currentPhase: 'design', history: [{ event: 'work_started', actor: ACTOR, at }]
    }),
    'WRK-C': story('WRK-C', { design: { status: 'in_progress' } }, {
      currentPhase: 'design', history: [{ event: 'work_started', actor: ACTOR, at: '2026-08-06T10:00:00.000Z' }]
    })
  });
  const first = await workRecords(root, { actor: ACTOR });
  const second = await workRecords(root, { actor: ACTOR });
  assert.deepEqual(first.items.map((item) => item.id), ['WRK-C', 'WRK-A', 'WRK-B']);
  assert.deepEqual(first.items.map((item) => item.id), second.items.map((item) => item.id));
});

test('the last material event ignores bookkeeping', () => {
  const workflow = {
    history: [
      { event: 'phase_submitted', phase: 'design', at: '2026-08-01T00:00:00.000Z', actor: ACTOR },
      { event: 'projection_rebuilt', at: '2026-08-09T00:00:00.000Z' },
      { event: 'index_refreshed', at: '2026-08-10T00:00:00.000Z' }
    ]
  };
  assert.equal(lastMaterialEvent(workflow).event, 'phase_submitted');
  assert.equal(lastMaterialEvent({ history: [] }), null);
});

test('every item explains why it is visible and what to do about it', async () => {
  const root = await fixture({
    'WRK-1': story('WRK-1', {
      design: { status: 'awaiting_approval', generation: 3, label: 'Design', approvalPolicy: { minimum: 2 }, approvals: [{ decision: 'approved' }] }
    }, { currentPhase: 'design', title: 'Address validation' })
  });
  const item = (await workRecords(root, { actor: ACTOR })).items[0];
  assert.equal(item.title, 'Address validation');
  assert.equal(item.phase, 'design');
  assert.equal(item.generation, 3);
  assert.equal(item.whyVisible, 'approval.awaiting-a-reviewer');
  assert.ok(item.blockers.includes('approvals-outstanding'));
  assert.equal(item.nextAction.operation, 'review.packet');
});

test('work records carry canonical and selectable branch identity for shared home state', async () => {
  const root = await fixture({ 'WRK-890': story('WRK-890', {
    intake: { status: 'in_progress', generation: 1 }
  }, { currentPhase: 'intake' }) });
  const item = (await workRecords(root, { actor: ACTOR, repositoryId: 'calc' })).items[0];
  assert.equal(item.repositoryId, 'calc');
  assert.equal(item.branch, 'wi/WRK-890');
  assert.ok(item.branches.includes('wi/WRK-890'));
});

test('the planner discloses that it read one repository', async () => {
  const root = await fixture({
    'WRK-1': story('WRK-1', { design: { status: 'in_progress' } }, { currentPhase: 'design' })
  });
  const result = await workList({ root, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.equal(result.kind, 'read');
  assert.equal(result.operation.id, 'work.list');
  assert.equal(result.data.repositoryScope, root);
  assert.ok(result.warnings.some((entry) => entry.code === 'work.single-repository-scope'));
  assert.equal(result.next[0].executable, false, 'a row rendered ten minutes ago cannot stand in for resolution');
});

test('a group filter narrows the list without hiding the shape of the rest', async () => {
  const records = {
    items: [
      { id: 'A', group: 'active', title: 'A', nextAction: { operation: 'work.continue', reasonCode: 'work.resume-phase' } },
      { id: 'B', group: 'waiting-on-you', title: 'B', nextAction: { operation: 'review.packet', reasonCode: 'approval.open-the-packet' } }
    ],
    groups: { active: [{ id: 'A' }], 'waiting-on-you': [{ id: 'B' }] },
    groupOrder: [...WORK_GROUP_ORDER]
  };
  const filtered = workListResult(records, { group: 'active', repositoryScope: '/tmp/repo' });
  assert.equal(filtered.data.items.length, 1);
  assert.equal(filtered.outcome.slots.group, 'active');
  // The other groups are still described, so the reader knows what the filter is hiding.
  assert.deepEqual(Object.keys(filtered.data.groups), [...WORK_GROUP_ORDER]);
});

test('an empty repository is an answer, not a dead end', async () => {
  const root = await fixture({});
  const result = await workList({ root, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.equal(result.data.items.length, 0);
  assert.equal(result.restState, 'informational');
});
