import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOME_CHOICES, MAX_HOME_CHOICES, homeOverview } from '../src/gateway/planners/home-overview.mjs';
import { workContinue } from '../src/gateway/planners/work-continue.mjs';
import { workReadiness } from '../src/gateway/planners/work-readiness.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const OTHER = { login: 'dev-2', email: 'dev-2@example.com', name: 'Dev Two' };

async function fixture(stories) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-home-'));
  for (const [id, workflow] of Object.entries(stories)) {
    const directory = path.join(root, 'singularity', 'work-items', id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
  }
  return root;
}

const story = (id, phases, { currentPhase, history = [], title = id }) => ({
  workItem: { id, title, workType: 'feature', branch: `wi/${id}` },
  phaseOrder: Object.keys(phases),
  currentPhase,
  phases,
  history
});

const inProgress = (id, title = id) => story(id, { design: { status: 'in_progress', generation: 1, label: 'Design' } }, {
  currentPhase: 'design', title, history: [{ event: 'work_started', phase: 'design', actor: ACTOR, at: '2026-08-01T10:00:00.000Z' }]
});

test('the home menu is at most six choices, all from the stable set', async () => {
  const root = await fixture({ 'WRK-1': inProgress('WRK-1', 'Address validation') });
  const result = await homeOverview({ root, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.ok(result.next.length <= MAX_HOME_CHOICES);
  const known = new Set(HOME_CHOICES.map((entry) => `home:${entry.id}`));
  for (const entry of result.next) assert.ok(known.has(entry.handle), `${entry.handle} is not a stable choice`);
  // `[INT:IFC-001]`: a menu item resolves a goal; it never acts.
  assert.equal(result.next.every((entry) => entry.executable === false), true);
  for (const entry of result.next) assert.ok(entry.fallback.command, 'every item needs a fallback command');
});

test('an active Story leads the menu and names what continuing means', async () => {
  // `[INT:REQ-023]`.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1', 'Address validation') });
  const result = await homeOverview({ root, context: { actor: ACTOR } });
  assert.equal(result.next[0].handle, 'home:work.continue');
  assert.equal(result.next[0].slots.work, 'WRK-1');
  assert.equal(result.next[0].slots.phase, 'design');
  assert.ok(result.next[0].slots.nextAction);
  assert.equal(result.why[0].code, 'home.active-work-leads');
});

test('with no workspace the menu does not pretend work exists', async () => {
  // `[INT:REQ-024]`: the work choices come out entirely rather than rendering empty.
  const result = await homeOverview({});
  validateSflowResult(result);
  assert.deepEqual(result.data.choiceSet, ['workspace.switch', 'help.explain']);
  assert.equal(result.data.counts, null);
  assert.equal(result.why[0].code, 'home.no-workspace-selected');
});

test('the cross-workspace briefing is declared unavailable, not silently absent', async () => {
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await homeOverview({ root, context: { actor: ACTOR } });
  assert.equal(result.data.briefingAvailable, false);
  assert.ok(result.warnings.some((entry) => entry.code === 'home.briefing-unavailable'));
});

test('decisions are counted on the menu and never recorded from it', async () => {
  // `[INT:CON-024]`.
  const root = await fixture({
    'WRK-2': story('WRK-2', { design: { status: 'awaiting_approval', generation: 1, approvalPolicy: { minimum: 1 } } }, {
      currentPhase: 'design',
      history: [{ event: 'phase_submitted', phase: 'design', actor: OTHER, at: '2026-08-02T10:00:00.000Z' }]
    })
  });
  const result = await homeOverview({ root, context: { actor: ACTOR } });
  assert.equal(result.data.needsYourDecision, 1);
  assert.equal(result.next.every((entry) => entry.executable === false), true);
});

test('continue reconstructs from records and returns legal actions without proposing one', async () => {
  // `[INT:REQ-063]` `[INT:CON-062]`.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1', 'Address validation') });
  const result = await workContinue({ root, arguments: { workId: 'WRK-1' }, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.equal(result.kind, 'read');
  assert.equal(result.data.work.id, 'WRK-1');
  assert.equal(result.why[0].code, 'work.reconstructed-from-records');
  assert.ok(result.data.legalActions.length);
  assert.equal(result.next.every((entry) => entry.executable === false), true);
});

test('local development is preserved, disclosed, and bound to the bytes it was seen at', async () => {
  // `[INT:CON-063]`.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await workContinue({
    root,
    arguments: { workId: 'WRK-1' },
    context: { actor: ACTOR, localChanges: { dirty: true, files: 3, worktreeHash: 'sha256:worktree' } }
  });
  const warning = result.warnings.find((entry) => entry.code === 'work.local-changes-present');
  assert.ok(warning);
  assert.equal(warning.reference, 'sha256:worktree', 'a disclosure with no revision cannot be checked');
  assert.equal(warning.slots.files, '3');
  assert.equal(result.data.localChanges.dirty, true);
});

test('continuing something this repository does not have is a refusal with a way out', async () => {
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await workContinue({ root, arguments: { workId: 'WRK-404' }, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.equal(result.kind, 'refusal');
  assert.equal(result.why[0].code, 'work.not-in-this-repository');
  assert.ok(result.next.length);
});

test('readiness reports blockers and the smallest legal step for each', async () => {
  // `[INT:IFC-081]`.
  const root = await fixture({
    'WRK-1': story('WRK-1', {
      design: { status: 'in_progress', generation: 1, requiredArtifact: { path: 'design.md' } }
    }, { currentPhase: 'design' })
  });
  const result = await workReadiness({ root, arguments: { workId: 'WRK-1' }, context: { actor: ACTOR } });
  validateSflowResult(result);
  assert.equal(result.data.ready, false);
  assert.ok(result.data.blockers.some((entry) => entry.blocker === 'required-artifact-missing'));
  assert.equal(result.next[0].reasonCode, 'readiness.produce-the-artifact');
});

test('readiness never recommends approval, and never counts a human decision as a step', async () => {
  // `[INT:CON-180]`.
  const root = await fixture({
    'WRK-2': story('WRK-2', {
      design: { status: 'awaiting_approval', generation: 1, approvalPolicy: { minimum: 2 }, approvals: [{ decision: 'approved' }] }
    }, { currentPhase: 'design' })
  });
  const result = await workReadiness({ root, arguments: { workId: 'WRK-2' }, context: { actor: ACTOR } });
  assert.equal(result.data.recommendation, null);
  const outstanding = result.data.blockers.find((entry) => entry.blocker === 'approvals-outstanding');
  assert.equal(outstanding.action, null, 'waiting for a reviewer is not a task the reader can complete');
  assert.equal(result.next.length, 0);
  assert.equal(result.restState, 'informational');
});

test('readiness says which of its inputs it did not read', async () => {
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await workReadiness({ root, arguments: { workId: 'WRK-1' }, context: { actor: ACTOR } });
  const partial = result.warnings.find((entry) => entry.code === 'readiness.partial-inputs');
  assert.ok(partial, 'an answer that omits four of nine inputs reads as "you are ready"');
  assert.match(partial.slots.missing, /tests/);
});

test('these planners refuse without a root rather than reading the working directory', async () => {
  for (const planner of [workContinue, workReadiness]) {
    await assert.rejects(() => planner({ arguments: { workId: 'WRK-1' } }), (error) => /requires the repository root/.test(error.message));
  }
});
