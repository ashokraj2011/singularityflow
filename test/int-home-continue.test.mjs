import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOME_CHOICES, MAX_HOME_CHOICES, homeOverview } from '../src/gateway/planners/home-overview.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { workContinue } from '../src/gateway/planners/work-continue.mjs';
import { workReadiness } from '../src/gateway/planners/work-readiness.mjs';
import { checklistSummary, primaryAction, validateSflowResult } from '../src/gateway/result.mjs';

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

// ---------------------------------------------------------------------------
// The shell contract, as the planners that feed it actually produce it.

test('a readiness refusal renders as gates, not as a red error', async () => {
  // [UXH:REQ-062] [UXH:AC-003]. The card in the reference screen is this result: a header count, a
  // row per gate, and a fix action on the rows that have one.
  const root = await fixture({
    'WRK-1': story('WRK-1', {
      design: { status: 'in_progress', generation: 1, requiredArtifact: { path: 'design.md' } }
    }, { currentPhase: 'design' })
  });
  const result = await workReadiness({ root, arguments: { workId: 'WRK-1' }, context: { actor: ACTOR } });
  const summary = checklistSummary(result);

  // Met gates are present, so the count reads "N of M" rather than "N problems".
  assert.ok(summary.met > 0, 'a checklist built only from failures cannot show a satisfied gate');
  assert.equal(summary.total, summary.met + summary.unmet + summary.unknown);

  const missing = result.checklist.find((row) => row.id === 'required-artifact-missing');
  assert.equal(missing.state, 'unmet');
  // The fix button on the row resolves through the same next action as everything else.
  assert.equal(missing.action, 'fix:required-artifact-missing');
  assert.ok(result.next.some((action) => action.id === missing.action));

  // The four inputs this planner cannot evaluate are rows, not omissions: an unevaluated gate and a
  // passing gate look identical on a screen that only lists problems.
  const unknown = result.checklist.filter((row) => row.state === 'unknown');
  assert.equal(unknown.length, 4);
  assert.ok(unknown.every((row) => row.source === 'unavailable' && row.evidence === null));
});

test('a gate only a human can clear is a row without a button', async () => {
  // [INT:CON-180] read through the checklist: "waiting for a reviewer" is a true statement about
  // the world, and giving it a fix button is an invitation to go and clear it.
  const root = await fixture({
    'WRK-2': story('WRK-2', {
      design: { status: 'awaiting_approval', generation: 1, approvalPolicy: { minimum: 2 }, approvals: [{ decision: 'approved' }] }
    }, { currentPhase: 'design' })
  });
  const result = await workReadiness({ root, arguments: { workId: 'WRK-2' }, context: { actor: ACTOR } });
  const row = result.checklist.find((entry) => entry.id === 'approvals-outstanding');
  assert.equal(row.state, 'unmet');
  assert.equal(row.action, null);
  assert.equal(result.next.length, 0);
});

test('every planner refusal states what it preserved', async () => {
  // [DHR:REQ-061]. Being told only that something is blocked is what sends a reader to check their
  // branch by hand.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  for (const planner of [workContinue, workReadiness]) {
    const result = await planner({ root, arguments: { workId: 'WRK-404' }, context: { actor: ACTOR } });
    assert.equal(result.outcome.status, 'refused');
    assert.ok(result.preserved.length, `${planner.name} refused without saying what survived`);
    assert.equal(result.preserved[0].scope, 'all');
  }
});

test('the home leads with exactly one filled action, and the menu below it does not compete', async () => {
  // [UXH:REQ-023] [UXH:REQ-064] with [DHR:REQ-031]: one legal next action and a goal menu are
  // different things, and the screen has to be able to show both without them arguing.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await homeOverview({ root, context: { actor: ACTOR, workspace: { id: 'w1', name: 'Payments' } } });
  validateSflowResult(result);
  assert.ok(result.next.length > 1, 'the menu is still a menu');
  assert.equal(result.next.filter((action) => action.emphasis === 'primary').length, 1);
  assert.equal(primaryAction(result).id, result.next[0].id);
  assert.equal(primaryAction(result).id, 'home:work.continue', 'active work leads [INT:REQ-023]');
  assert.ok(result.next.slice(1).every((action) => action.emphasis === 'secondary'));
});

test('the home menu order is a total order, not a stable-sort accident', async () => {
  // The obvious comparator returns -1 whenever the left item is work.continue, which also claims it
  // sorts before itself and leaves every other pair "equal". True today; unspecified; load-bearing.
  const root = await fixture({ 'WRK-1': inProgress('WRK-1') });
  const result = await homeOverview({ root, context: { actor: ACTOR, workspace: { id: 'w1', name: 'Payments' } } });
  const ids = result.next.map((action) => action.id);
  const expected = [
    'home:work.continue', 'home:work.list', 'home:work.start.intake',
    'home:workspace.switch', 'home:impact.quick', 'home:repository.explore'
  ];
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, ids.length);
});

test('every home choice names an operation the registry has', () => {
  /**
   * `[DHR:CON-004]`: a goal must not be advertised when its operation is unreachable. A menu entry
   * whose id resolves to nothing is exactly that, and the failure is silent — the choice renders,
   * the click resolves to no candidate, and the reader concludes the product is broken.
   *
   * This replaces a `goal` field that carried the same intent and was read nowhere. It had drifted
   * on two of seven entries, which cost nothing only because nothing consumed it.
   */
  const registered = new Set(gatewayRegistry().operations.map((entry) => entry.id));
  const missing = HOME_CHOICES.filter((choice) => !registered.has(choice.id)).map((choice) => choice.id);
  assert.deepEqual(missing, [], `home choices with no operation: ${missing.join(', ')}`);
});

test('a home choice carries an id and a label, and nothing that goes unread', () => {
  for (const choice of HOME_CHOICES) {
    assert.deepEqual(Object.keys(choice).sort(), ['id', 'label']);
  }
});
