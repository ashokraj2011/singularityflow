import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HOME_CHOICES, MAX_HOME_CHOICES, homeOverview, homeOverviewResult } from '../src/gateway/planners/home-overview.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { workContinue } from '../src/gateway/planners/work-continue.mjs';
import { workReadiness } from '../src/gateway/planners/work-readiness.mjs';
import { checklistSummary, plannerNavigationTarget, primaryAction, validateSflowResult } from '../src/gateway/result.mjs';
import { localPendingPublicationPath } from '../src/publication-pending.mjs';
import { run } from '../src/util.mjs';
import { codeOnly } from './source-text.mjs';

const ACTOR = { login: 'dev-1', email: 'dev-1@example.com', name: 'Dev One' };
const OTHER = { login: 'dev-2', email: 'dev-2@example.com', name: 'Dev Two' };
const APPROVAL_AUTHORITIES = {
  developers: {
    label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
    members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }]
  }
};

async function fixture(stories) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-home-'));
  for (const [id, workflow] of Object.entries(stories)) {
    const directory = path.join(root, 'singularity', 'work-items', id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'workflow.json'), JSON.stringify(workflow));
  }
  return root;
}

const story = (id, phases, { currentPhase, history = [], title = id, resolution = null }) => ({
  workItem: { id, title, workType: 'feature', branch: `wi/${id}` },
  phaseOrder: Object.keys(phases),
  currentPhase,
  phases,
  history,
  ...(resolution ? { resolution } : {})
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

test('the Home command renders one gateway projection', async () => {
  const source = codeOnly(await readFile(new URL('../src/commands/home.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /developerHome|developer-home\.mjs/);
  assert.match(source, /kernel\.resolve\(\{ utterance: 'home'/);
  assert.match(source, /kernel\.read\(\{ resolutionId/);
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

test('with no workspace Home offers only rootless setup and recovery paths', async () => {
  // `[INT:REQ-024]` `[WRP:REQ-150]`: work choices come out entirely and are replaced by actions
  // that are valid before any repository or Story exists.
  const result = await homeOverview({});
  validateSflowResult(result);
  assert.deepEqual(result.data.choiceSet, [
    'repository.open.guide', 'workspace.prepare.guide',
    'workspace.doctor.guide', 'workspace.explore.guide'
  ]);
  assert.equal(result.data.counts, null);
  assert.equal(result.why[0].code, 'home.no-workspace-selected');
});

test('the cross-workspace briefing is declared unavailable when the registry cannot answer', () => {
  const active = { id: 'WRK-1', kind: 'story', phase: 'design', group: 'active', blockers: [], nextAction: null };
  const result = homeOverviewResult({
    workspace: { id: 'w', name: 'W' },
    records: { groups: { active: [active], 'waiting-on-you': [] }, items: [active] },
    otherWorkspaces: null
  });
  assert.equal(result.data.briefingAvailable, false);
  assert.ok(result.warnings.some((entry) => entry.code === 'home.briefing-unavailable'));
});

test('decisions are counted on the menu and never recorded from it', async () => {
  // `[INT:CON-024]`.
  const root = await fixture({
    'WRK-2': story('WRK-2', { design: {
      status: 'awaiting_approval', generation: 1,
      approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: false }
    } }, {
      currentPhase: 'design',
      history: [{ event: 'phase_submitted', phase: 'design', actor: OTHER, at: '2026-08-02T10:00:00.000Z' }],
      resolution: { approvalAuthorities: APPROVAL_AUTHORITIES }
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

test('the briefing leads only when there is something you could not have known', () => {
  /**
   * `[DHR:REQ-070]` rule 3 beats rule 4, and the opposite reads as more helpful. Someone with an
   * active Story and their own uncommitted edits is offered "continue" first, because they know
   * what they changed — they changed it. The briefing is promoted for the case where local work
   * has not been compared against the plan, which is a fact they cannot have from memory.
   */
  const active = { id: 'WRK-1', kind: 'story', phase: 'implement', group: 'active', blockers: [], nextAction: null };
  const records = { groups: { active: [active], 'waiting-on-you': [] }, items: [active] };
  const workspace = { id: 'w', name: 'W' };

  const clean = homeOverviewResult({ workspace, records, localChanges: { dirty: false, files: 0 } });
  assert.equal(clean.next[0].id, 'home:work.continue');

  const dirty = homeOverviewResult({
    workspace, records, localChanges: { dirty: true, files: 3, worktreeHash: 'a'.repeat(64) }
  });
  assert.equal(dirty.next[0].id, 'home:work.continue', 'the active Story still leads');
  assert.equal(dirty.next[1].id, 'home:work.return', 'and the briefing is second, not buried');
  assert.ok(dirty.why.some((entry) => entry.code === 'home.local-work-unreconciled'));
});

test('an unread worktree does not promote the briefing', () => {
  // Null is not clean. Promoting on an unread tree would act on a fact nobody established.
  const active = { id: 'WRK-1', kind: 'story', phase: 'implement', group: 'active', blockers: [], nextAction: null };
  const result = homeOverviewResult({
    workspace: { id: 'w', name: 'W' },
    records: { groups: { active: [active], 'waiting-on-you': [] }, items: [active] },
    localChanges: null
  });
  assert.ok(!result.why.some((entry) => entry.code === 'home.local-work-unreconciled'));
});

test('the ordering is a total order whichever way the menu is shuffled', () => {
  /**
   * The property the old comparator lacked. Sorting a reversed input must give the same answer as
   * sorting the original, which a comparator returning -1 for one id and 0 for everything else
   * cannot guarantee — it only held because V8's sort happens to be stable.
   */
  const active = { id: 'WRK-1', kind: 'story', phase: 'implement', group: 'active', blockers: [], nextAction: null };
  const args = {
    workspace: { id: 'w', name: 'W' },
    records: { groups: { active: [active], 'waiting-on-you': [] }, items: [active] },
    localChanges: { dirty: true, files: 1, worktreeHash: 'b'.repeat(64) }
  };
  const once = homeOverviewResult(args).next.map((action) => action.id);
  const twice = homeOverviewResult(args).next.map((action) => action.id);
  assert.deepEqual(once, twice);
  assert.equal(new Set(once).size, once.length, 'no duplicates survive the sort');
});

test('an interrupted publication outranks the active Story', () => {
  /**
   * `[DHR:REQ-070]` rule 1, which had no implementation. The `recovery-required` group existed from
   * the day the work records were written and the home never mentioned it, so a reader with a
   * half-finished publication saw the ordinary home — and this is the one state where doing
   * something else first can lose work.
   */
  const mk = (id, group) => ({ id, kind: 'story', phase: 'implement', group, blockers: [], nextAction: null, rail: [] });
  const groups = {
    'recovery-required': [mk('W-9', 'recovery-required')], 'waiting-on-you': [],
    active: [mk('W-1', 'active')], 'waiting-on-others': [], 'recently-completed': []
  };
  const result = homeOverviewResult({
    workspace: { id: 'w', name: 'W' }, records: { groups, items: Object.values(groups).flat() }
  });
  const codes = result.why.map((entry) => entry.code);
  assert.ok(codes.includes('home.recovery-required'));
  assert.ok(!codes.includes('home.active-work-leads'), 'recovery replaces the ordinary reason, it does not sit beside it');
  assert.equal(result.why[0].reference, 'W-9');
  // Same button, different reason: both are continued by `work.continue` `[DHR:REQ-070]`.
  assert.equal(result.next[0].id, 'home:work.continue');
  assert.deepEqual(plannerNavigationTarget(result.next[0]), {
    operationId: 'work.continue', arguments: { workId: 'W-9', workKind: 'story' }
  });
  assert.equal(result.next[0].reasonCode, 'home.recovery-required');
});

test('production Home discovers an interrupted publication without caller injection', async (t) => {
  const root = await fixture({ 'WRK-9': inProgress('WRK-9', 'Recover me') });
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Home Test'], { cwd: root });
  run('git', ['config', 'user.email', 'home@example.test'], { cwd: root });
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const marker = localPendingPublicationPath(root, 'story', 'WRK-9');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ schemaVersion: 2, subject: { kind: 'story', id: 'WRK-9' } }));

  const result = await homeOverview({
    root,
    context: { actor: ACTOR, workspace: { id: 'w', name: 'W' } }
  });
  assert.equal(result.why[0].code, 'home.recovery-required');
  assert.equal(result.next[0].slots.work, 'WRK-9');
});

test('an unreadable publication marker is visible recovery state and offers diagnostics only', async (t) => {
  const root = await fixture({ 'WRK-10': inProgress('WRK-10', 'Repair marker') });
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Home Test'], { cwd: root });
  run('git', ['config', 'user.email', 'home@example.test'], { cwd: root });
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  const marker = localPendingPublicationPath(root, 'story', 'WRK-10');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, '{not json');

  const home = await homeOverview({
    root, context: { actor: ACTOR, workspace: { id: 'w', name: 'W' } }
  });
  assert.equal(home.why[0].code, 'home.recovery-required');
  const continued = await workContinue({
    root, arguments: { workId: 'WRK-10', workKind: 'story' }, context: { actor: ACTOR }
  });
  assert.ok(continued.why.some((entry) => entry.code === 'work.blocked.publication-marker-unreadable'));
  assert.deepEqual(continued.next, []);
  assert.equal(continued.restState, 'blocked');
});

test('a single-workspace Home does not warn about a briefing that has no other workspace to read', () => {
  const empty = {
    'recovery-required': [], 'waiting-on-you': [], active: [],
    'waiting-on-others': [], 'recently-completed': []
  };
  const result = homeOverviewResult({
    workspace: { id: 'w', name: 'W' }, records: { groups: empty, items: [] }, otherWorkspaces: 0
  });
  assert.ok(!result.warnings.some((entry) => entry.code === 'home.briefing-unavailable'));
});

test('a decision waiting on you is named, not folded into the count', () => {
  const mk = (id, group) => ({ id, kind: 'story', phase: 'implement', group, blockers: [], nextAction: null, rail: [] });
  const groups = {
    'recovery-required': [], 'waiting-on-you': [mk('W-2', 'waiting-on-you')],
    active: [], 'waiting-on-others': [], 'recently-completed': []
  };
  const result = homeOverviewResult({
    workspace: { id: 'w', name: 'W' }, records: { groups, items: Object.values(groups).flat() }
  });
  const decision = result.why.find((entry) => entry.code === 'home.needs-your-decision');
  assert.ok(decision, '"somebody is blocked on you" is a different obligation from "you have work"');
  assert.equal(decision.slots.count, '1');
});

test('nothing waiting is stated, because a silent menu reads as a failed load', () => {
  const empty = {
    'recovery-required': [], 'waiting-on-you': [], active: [], 'waiting-on-others': [], 'recently-completed': []
  };
  const result = homeOverviewResult({ workspace: { id: 'w', name: 'Rule-engine' }, records: { groups: empty, items: [] } });
  const rest = result.why.find((entry) => entry.code === 'home.nothing-waiting');
  assert.ok(rest);
  assert.equal(rest.slots.workspace, 'Rule-engine');

  // And it is not claimed when there is something.
  const busy = { ...empty, active: [{ id: 'W-1', kind: 'story', phase: 'x', group: 'active', blockers: [], nextAction: null, rail: [] }] };
  assert.ok(!homeOverviewResult({ workspace: { id: 'w', name: 'W' }, records: { groups: busy, items: busy.active } })
    .why.some((entry) => entry.code === 'home.nothing-waiting'));
});
