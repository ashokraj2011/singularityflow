// FPL M2 (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.2, REQ-004 to REQ-007, A8 to A10): Work's likely plan, `work list` across the
// workspace and the task page's read, `work status`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addableSteps, endedWhere, orderRows, planChips, planNote, rulesApplied, statusWords, storyEvents, storySteps, waitingItem, waitingOf, withWaiting, workRow
} from '../src/work-rows.mjs';
import { stepApprovalItem } from '../src/needs-you-items.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
const me = { name: 'Reviewer', email: 'reviewer@example.invalid' };
const GROUPS = {
  'quality-reviewers': { label: 'Quality reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.invalid' }] },
  'release-owners': { label: 'Release owners', members: [{ name: 'Owner', email: 'owner@example.invalid' }] }
};

/** A Story's record, as workflow.json holds it: one plan step, or a composed fix's three steps. */
function story(id, { status = 'in_progress', step = 'awaiting_approval', authorities = ['quality-reviewers'], createdBy = me, task = null,
  history = [], createdAt = new Date(Date.now() - 2 * DAY).toISOString(), submittedAt = new Date(Date.now() - DAY).toISOString() } = {}) {
  const phases = task
    ? Object.fromEntries(task.steps.map((entry, index) => [entry.id, { id: entry.id, label: entry.label, status: entry.status ?? (index === 0 ? step : 'not_started'),
      generation: 1, artifacts: [], checks: [], approvals: [], approvalPolicy: { minimum: 1, authorities, requiredAuthorities: [], allowSelfApproval: true },
      submittedAt, requiredArtifact: { path: `${entry.id}.md` } }]))
    : { plan: { id: 'plan', label: 'Plan', status: step, generation: 1, artifacts: [], checks: [], approvals: [],
      approvalPolicy: { minimum: 1, authorities, requiredAuthorities: [], allowSelfApproval: true }, submittedAt, requiredArtifact: { path: 'plan.md' } } };
  const order = Object.keys(phases);
  return {
    schemaVersion: 11,
    workItem: { id, title: `Story ${id}`, branch: `story/${id}`, workType: task ? `task-${task.kind}` : 'feature', createdAt, createdBy, baseBranch: 'main' },
    lineage: { canonicalBranch: `story/${id}` }, status, currentPhase: status === 'in_progress' ? order.find((key) => phases[key].status !== 'approved') ?? order[0] : null,
    phaseOrder: order, phases,
    resolution: { phases: order.map((key) => ({ id: key, label: phases[key].label })), approvalAuthorities: GROUPS, ...(task ? { composition: task.composition } : {}) },
    history: [{ at: createdAt, event: 'work_started', phase: order[0] }, ...history]
  };
}

const FIX = {
  kind: 'fix',
  steps: [{ id: 'intake', label: 'Intake', status: 'approved' }, { id: 'implementation', label: 'Code', status: 'approved' }, { id: 'verification', label: 'Tests' }],
  composition: { schemaVersion: 1, kind: 'fix', workType: 'task-fix', steps: [{ id: 'intake', intent: 'intake', label: 'Intake' },
    { id: 'implementation', intent: 'code', label: 'Code' }, { id: 'verification', intent: 'test', label: 'Tests' }],
  added: [{ intent: 'test', rule: 'always[0]', because: 'Every code change gets tests.' }], personApproves: ['code'],
  rules: [{ rule: 'always[0]', because: 'Every code change gets tests.' }] }
};

test('REQ-005: the plan as chips with `work status` steps, each state in words, and one status line', () => {
  const fix = story('TASK-12', { task: FIX, step: 'in_progress' });
  fix.phases.verification.status = 'in_progress';
  fix.currentPhase = 'verification';
  const steps = storySteps(fix, 'singularity/work-items');
  assert.deepEqual(steps.map((entry) => [entry.label, entry.status]), [['Intake', 'approved'], ['Code', 'approved'], ['Tests', 'in_progress']]);
  assert.equal(steps[2].document, 'singularity/work-items/TASK-12/verification.md');
  const chips = planChips(fix, steps);
  assert.deepEqual(chips.map((chip) => chip.words), ['Intake, done', 'Code, done', 'Tests, now'], 'state in words as well as colour [REQ-037]');
  assert.equal(chips[2].added, true, 'the team\'s rule added the tests');
  assert.equal(statusWords(fix, steps), 'TASK-12 is at Tests.', 'what runs now, in work status\'s words');

  const waiting = story('TASK-11', { authorities: ['release-owners'] });
  const waitingSteps = storySteps(waiting, 'singularity/work-items');
  assert.equal(statusWords(waiting, waitingSteps), 'Waiting for Release owners: approve Plan');
  assert.equal(planChips(waiting, waitingSteps)[0].words, 'Plan, now, waits for approval');
  const decided = { ...story('TASK-13', { step: 'approved' }), pendingDecision: { key: 'k', label: 'Ship now or wait', by: ['quality-reviewers', 'release-owners'] } };
  assert.equal(statusWords(decided, storySteps(decided, 'x')), 'Waiting for Quality reviewers or Release owners: ship now or wait');

  // A Story with an item in Needs you says "Waiting for you: …" and its chip waits for you [A9].
  const row = workRow(waiting, { repository: { id: 'shop-api', name: 'shop-api' }, folder: 'singularity/work-items', mine: 'started' });
  const held = withWaiting(row, { key: 'shop-api:TASK-11:approve:plan:1', question: 'Approve Plan?', step: { id: 'plan' } });
  assert.equal(held.statusLine, 'Waiting for you: Approve Plan?');
  assert.deepEqual(held.waiting, { key: 'shop-api:TASK-11:approve:plan:1', question: 'Approve Plan?' });
  assert.equal(held.chips[0].state, 'waits-for-you');
  assert.equal(held.chips[0].words, 'Plan, waits for you');
  assert.equal(withWaiting(row, null), row);
});

test('REQ-005: "Waiting for you" is current with the record the row was read from, never an item already decided', () => {
  const repository = { id: 'shop-api', name: 'shop-api' };
  const waiting = story('TASK-11');
  const row = { ...workRow(waiting, { repository, folder: 'singularity/work-items', mine: 'started' }), updatedAt: '2026-11-26T10:00:00.000Z' };
  // The record's own item, computed as Needs you computes it, from the same record.
  const live = [waitingOf(stepApprovalItem(waiting, { repository, actor: me }))];
  assert.deepEqual(live.map((item) => [item.key, item.question]), [['shop-api:TASK-11:approve:plan:1', 'Approve Plan?']]);
  assert.equal(waitingItem(row, { live }).question, 'Approve Plan?');
  // Approved since: the record holds nothing of theirs, and what Needs you kept before is not said.
  const keptApproval = { ...live[0], readAt: '2026-11-26T11:00:00.000Z' };
  assert.equal(waitingItem(row, { live: [], kept: [keptApproval] }), null, 'the record decides its own kinds');
  // A row kept before its items were: Needs you's copy, only when it was read after the Story's latest record.
  assert.equal(waitingItem(row, { live: null, kept: [keptApproval] }).key, keptApproval.key);
  assert.equal(waitingItem(row, { live: null, kept: [{ ...keptApproval, readAt: '2026-11-26T09:59:59.000Z' }] }), null, 'read before the record changed');
  assert.equal(waitingItem(row, { live: null, kept: [{ ...keptApproval, readAt: null }] }), null, 'no read time, no trust');
  // An item only a checkout can say (a decision) comes from Needs you's copy, by the same rule; another Story's never.
  const decision = { key: 'shop-api:TASK-11:decision:clarification:x', kind: 'decision', group: 'holds-work', repository, story: { id: 'TASK-11' },
    step: { id: 'plan' }, question: 'Which timeout should it use?', waitingSince: '2026-11-25T09:00:00.000Z', readAt: '2026-11-26T10:30:00.000Z' };
  assert.equal(waitingItem(row, { live: [], kept: [decision] }).question, 'Which timeout should it use?');
  assert.equal(waitingItem(row, { live: [], kept: [{ ...decision, readAt: '2026-11-26T09:00:00.000Z' }] }), null);
  assert.equal(waitingItem(row, { live: [], kept: [{ ...decision, story: { id: 'TASK-99' } }] }), null);
  assert.equal(waitingItem(row, { live: [], kept: [{ ...decision, repository: { id: 'shop-web' } }] }), null);
  // Both: Needs you's one order, oldest first.
  assert.equal(waitingItem(row, { live, kept: [decision] }).question, 'Which timeout should it use?', 'the decision waits since before the step was submitted');
});

test('REQ-006, REQ-007: where the plan came from, the rules applied, what happened, the steps it can gain and where it ended', () => {
  const fix = story('TASK-12', { task: FIX, history: [{ at: '2026-11-25T10:00:00Z', event: 'phase_submitted', phase: 'intake' },
    { at: '2026-11-25T10:05:00Z', event: 'phase_approved', phase: 'intake' }, { at: '2026-11-25T11:00:00Z', event: 'phase-approved-automatically', phase: 'implementation' },
    { at: '2026-11-25T11:01:00Z', event: 'guard_noise', phase: 'implementation' }] });
  assert.equal(planNote(fix), 'Composed from your words: a fix. The team\'s rules added the tests and your approval of the code.');
  assert.deepEqual(rulesApplied(fix), [{ rule: 'always[0]', because: 'Every code change gets tests.' }]);
  assert.deepEqual(storyEvents(fix, { now: new Date('2026-11-26T12:00:00Z') }).map((event) => event.words),
    ['Started', 'Intake is ready for approval', 'Intake approved', 'SFlow approved Code'], 'material events only, oldest first');
  assert.deepEqual(addableSteps(fix).map((entry) => entry.step), ['requirements', 'design', 'plan', 'review'], 'ADDABLE minus what it has');
  assert.deepEqual(addableSteps({ ...fix, status: 'closed' }), [], 'a finished task gains nothing');
  assert.deepEqual(addableSteps(story('APP-1')), [], 'a classic Story has no Add a step');
  assert.equal(planNote(story('APP-1')), 'Follows the workflow feature, as it is.');

  assert.equal(endedWhere(fix), 'checked on its branch');
  assert.equal(endedWhere({ resolution: { composition: { kind: 'investigate' } } }), 'report ready');
  assert.equal(endedWhere({ resolution: { composition: { kind: 'fix', pullRequest: true } } }), 'pull request open');

  const now = new Date();
  const repository = { id: 'r', name: 'r' };
  const rows = [
    workRow(story('A-1', { createdAt: new Date(now - 3 * DAY).toISOString() }), { repository, folder: 'f', mine: 'started', now }),
    workRow(story('A-2', { createdAt: new Date(now - DAY).toISOString() }), { repository, folder: 'f', mine: 'started', now }),
    workRow(story('A-3', { status: 'closed', history: [{ at: new Date(now - 2 * DAY).toISOString(), event: 'phase_approved', phase: 'plan' }] }), { repository, folder: 'f', mine: 'started', now }),
    workRow(story('A-4', { status: 'closed', history: [{ at: new Date(now - 9 * DAY).toISOString(), event: 'phase_approved', phase: 'plan' }] }), { repository, folder: 'f', mine: 'started', now })
  ];
  const ordered = orderRows(rows, { now });
  assert.deepEqual(ordered.inProgress.map((row) => row.id), ['A-2', 'A-1'], 'newest first');
  assert.deepEqual(ordered.doneThisWeek.map((row) => [row.id, row.ended.where]), [['A-3', 'checked on its branch']], 'only the last seven days');
});

// ------------------------------------------------------------------------------------------------ A8: the likely plan

/** The nine kinds' sentences: the journeys' own where SFlow can tell their kind from the words, in their style otherwise. */
const SENTENCES = Object.freeze([
  ['fix', 'fix the value module so it returns 2'],
  ['investigate', 'why does the value module return 1'],
  ['change', 'make the value module return 2'],
  ['feature', 'add a second value to the value module'],
  ['refactor', 'tidy the validator in the value module'],
  ['tests', 'add end-to-end tests for the checkout page'],
  ['docs', 'write the docs for the value module'],
  ['review', 'review the value module'],
  ['chore', 'bump the value module\'s version']
]);

test('A8: for each kind\'s sentence the likely plan is the plan line the chat says; no line when the kind cannot be told', async (t) => {
  const story = await journeyRepository(t);
  for (const [kind, words] of SENTENCES) {
    const likely = JSON.parse(story.cli('work', words, '--plan-only', '--json'));
    assert.equal(likely.resultType, 'sflow-task-likely-plan');
    assert.equal(likely.kind, kind, words);
    const chat = JSON.parse(story.cli('work', words, '--kind', kind, '--json'));
    assert.equal(likely.plan, chat.plan, `${kind}: the likely plan is the chat's plan line`);
  }
  // The chat's own start says the same line.
  const started = JSON.parse(story.cli('work', SENTENCES[0][1], '--kind', 'fix', '--start', '--json'));
  const likely = JSON.parse(story.cli('work', SENTENCES[0][1], '--plan-only', '--json'));
  assert.equal((started.data ?? started).task.plan, likely.plan);
  story.git('checkout', '-q', 'main');
  // The words alone do not say the kind, or say nothing: no line, and nothing is refused.
  for (const words of ['hello there', '/sf-task', '']) {
    const none = story.raw(['work', ...(words ? [words] : []), '--plan-only', '--json']);
    assert.equal(none.status, 0, none.stderr);
    assert.equal(JSON.parse(none.stdout).plan, null, words);
  }
  assert.equal(story.git('status', '--porcelain'), '', 'a likely plan writes nothing');

  // REQ-006: the task page's read of the started task, from its own checkout.
  story.git('checkout', '-q', 'TASK-1');
  await story.write('src/value.mjs', 'export const value = 2;\nexport const other = 3;\n');
  const page = JSON.parse(story.cli('work', 'status', 'TASK-1', '--json'));
  assert.equal(page.task, true);
  assert.ok(page.startedBy && !page.startedBy.includes('@'), page.startedBy);
  assert.match(page.planNote, /^Composed from your words: a fix\./u);
  assert.deepEqual(page.chips.map((chip) => chip.state), ['now', 'to-do', 'to-do']);
  // A fix sized by its requirement (ITW v1.2): its requirement, then the step that implements and tests.
  assert.equal(page.now, 'Requirement');
  assert.equal(page.next, 'Implement and test');
  assert.equal(page.events[0].words, 'Started');
  assert.deepEqual(page.addable.map((entry) => entry.step), ['requirements', 'design', 'plan', 'review']);
  assert.deepEqual(page.changed.files.map((file) => [file.path, file.added, file.removed]), [['src/value.mjs', 2, 1]],
    'the files changed against its base, the Story\'s own records apart');
  assert.doesNotMatch(JSON.stringify([page.planNote, page.events, page.chips]), /[0-9a-f]{40}|sha256|\bphase\b|\bgeneration\b/u);
});

// ------------------------------------------------------------------------------------------- A9: across the workspace

async function publishStory(f, state, { again = false } = {}) {
  const { appendLedgerIntent, createLedgerIntent } = await import('../src/ledger.mjs');
  const { storyLifecycleProgress } = await import('../src/session-roster.mjs');
  const branch = state.workItem.branch;
  // A Story's next record is a new commit on its branch.
  f.git(f.source, 'switch', '--quiet', ...(again ? [branch] : ['-c', branch, 'main']));
  const file = path.join(f.source, f.definition.workItemRoot, state.workItem.id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', `record ${state.workItem.id}`);
  f.git(f.source, 'push', '--quiet', 'origin', branch);
  const commit = f.git(f.source, 'rev-parse', 'HEAD');
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.invalid' },
    subject: { kind: 'story', workId: state.workItem.id, branch, workType: state.workItem.workType, title: state.workItem.title, status: state.status,
      currentPhase: state.currentPhase, aliases: [], progress: storyLifecycleProgress(state) }
  }), commit);
  f.git(f.source, 'switch', '--quiet', 'main');
}

const cli = (f, args, { cwd = f.original } = {}) => spawnSync(process.execPath, [path.join(root, 'bin/singularity-flow.mjs'), ...args], {
  cwd, env: f.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });

async function lastTiming(checkout) {
  const lines = (await readFile(path.join(checkout, '.git/singularity-flow/dx/timings.jsonl'), 'utf8').catch(() => '')).trim().split('\n');
  try { return JSON.parse(lines.at(-1)); } catch { return null; }
}

test('A9: In progress lists this person\'s Stories across the workspace, waits for you where Needs you holds one, and paints offline', async (t) => {
  const { createSessionListingFixture } = await import('../scripts/session-listing-benchmark.mjs');
  const app = await createSessionListingFixture(); t.after(app.cleanup);
  delete app.env.SINGULARITY_FLOW_TEST_IDENTITY;
  const api = await createSessionListingFixture(); t.after(api.cleanup);
  const workspacePath = path.join(app.directory, 'workspace');
  app.git(app.directory, 'clone', '--quiet', api.remote, path.join(workspacePath, 'repos', 'api'));
  const manifestFile = path.join(workspacePath, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.repositories.api = { url: api.remote, path: 'repos/api', defaultBranch: 'main', capabilities: [] };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const [{ rememberWorkspace }, { readWorkspace }] = await Promise.all([import('../src/workspace.mjs'), import('../src/workspace-manifest.mjs')]);
  await rememberWorkspace(app.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));
  for (const clone of [app.original, path.join(workspacePath, 'repos', 'api')]) {
    app.git(clone, 'config', 'user.email', me.email); app.git(clone, 'config', 'user.name', me.name);
  }
  const now = Date.now();
  // app: one of theirs waiting for their group (a Needs-you item), one of another person's, one done this week, one done
  // before it, one cancelled. api: one of theirs waiting for another group.
  await publishStory(app, story('APP-1', { createdAt: new Date(now - 2 * DAY).toISOString() }));
  await publishStory(app, story('APP-2', { createdBy: { name: 'Builder', email: 'builder@example.invalid' } }));
  await publishStory(app, story('APP-3', { status: 'closed', step: 'approved', task: { ...FIX, kind: 'investigate', composition: { ...FIX.composition, kind: 'investigate' },
    steps: FIX.steps.map((entry) => ({ ...entry, status: 'approved' })) }, history: [{ at: new Date(now - 2 * DAY).toISOString(), event: 'phase_approved', phase: 'verification' }] }));
  await publishStory(app, story('APP-4', { status: 'closed', step: 'approved', history: [{ at: new Date(now - 10 * DAY).toISOString(), event: 'phase_approved', phase: 'plan' }] }));
  await publishStory(app, story('APP-5', { status: 'cancelled', step: 'in_progress' }));
  await publishStory(api, story('API-1', { authorities: ['release-owners'], createdAt: new Date(now - DAY).toISOString() }));

  const first = cli(app, ['work', 'list', '--json']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const listed = JSON.parse(first.stdout);
  assert.equal(listed.resultType, 'sflow-work-list');
  assert.deepEqual(listed.inProgress.map((row) => [row.repository.id, row.id, row.mine]), [['api', 'API-1', 'started'], ['app', 'APP-1', 'started']],
    'this person\'s, newest first; not APP-2 (another person\'s), APP-4 (ended before this week) or APP-5 (cancelled)');
  assert.deepEqual(listed.doneThisWeek.map((row) => [row.id, row.ended.where]), [['APP-3', 'report ready']]);
  assert.equal(listed.inProgress[0].statusLine, 'Waiting for Release owners: approve Plan');
  // Their own group approves APP-1's plan: its record says so, with no Needs-you read first.
  assert.equal(listed.inProgress[1].statusLine, 'Waiting for you: Approve Plan?', 'computed from the record the row was read from');
  assert.match(listed.inProgress[1].waiting.key, /^app:APP-1:approve:plan:1$/u);
  assert.deepEqual(listed.here, { id: 'app', name: 'app' });
  // What /sf-task with no words says in the chat [REQ-038]: the same rows and words.
  assert.deepEqual(listed.say, ['Story API-1 (API-1, api): Waiting for Release owners: approve Plan',
    'Story APP-1 (APP-1, app): Waiting for you: Approve Plan?', 'Done this week: Story APP-3 (APP-3), report ready.']);
  assert.equal(listed.inProgress[0].route.here, undefined);
  assert.match(listed.inProgress[0].route.elsewhere.commands[0], /^singularity-flow session open API-1 --workspace readiness-bench --repository api$/u);

  // After a Needs-you read, the Story it holds says "Waiting for you: …" and names the card [A9].
  assert.equal(cli(app, ['needs-you', '--json']).status, 0);
  const joined = JSON.parse(cli(app, ['work', 'list', '--json']).stdout);
  const mine = joined.inProgress.find((row) => row.id === 'APP-1');
  assert.equal(mine.statusLine, 'Waiting for you: Approve Plan?');
  assert.match(mine.waiting.key, /^app:APP-1:/u);
  assert.equal(mine.chips[0].state, 'waits-for-you');
  assert.deepEqual(joined.scope.repositories.find((entry) => entry.id === 'app').stories, { read: 0, kept: 5 }, 'a second read reads no workflow.json');

  // The chips are `work status`'s steps, read where the Story's record is (here, by its state index: no checkout).
  const status = cli(app, ['work', 'status', 'APP-1', '--json']);
  assert.equal(status.status, 0, status.stderr + status.stdout);
  assert.deepEqual(JSON.parse(status.stdout).steps, mine.steps);

  // Offline paints the same rows from what is kept, and fetches nothing.
  const offline = cli(app, ['work', 'list', '--offline', '--json', '--timings']);
  assert.equal(offline.status, 0, offline.stderr);
  const painted = JSON.parse(offline.stdout);
  assert.deepEqual(painted.inProgress.map((row) => row.id), joined.inProgress.map((row) => row.id));
  assert.equal(painted.inProgress.find((row) => row.id === 'APP-1').statusLine, 'Waiting for you: Approve Plan?');
  assert.equal((await lastTiming(app.original))?.counters?.['git.remote.total'] ?? 0, 0, 'an offline read fetches nothing');

  // They approve APP-1's plan, and it waits for a second reviewer. Needs you is not read again, so what it kept still
  // asks "Approve Plan?"; work list says what the record says, fresh and offline alike.
  const approved = story('APP-1', { createdAt: new Date(now - 2 * DAY).toISOString(),
    history: [{ at: new Date().toISOString(), event: 'approval_recorded', phase: 'plan', actor: me }] });
  approved.phases.plan.approvalPolicy.minimum = 2;
  approved.phases.plan.approvals = [{ actor: me, decision: 'approved', at: new Date().toISOString(), authorityGroup: 'quality-reviewers', generation: 1 }];
  await publishStory(app, approved, { again: true });
  const stale = JSON.parse(cli(app, ['needs-you', '--offline', '--json']).stdout);
  assert.ok(stale.items.some((item) => item.story?.id === 'APP-1' && item.question === 'Approve Plan?'), 'Needs you still keeps the old item');
  const current = JSON.parse(cli(app, ['work', 'list', '--json']).stdout).inProgress.find((row) => row.id === 'APP-1');
  assert.equal(current.statusLine, 'Waiting for Quality reviewers: approve Plan', 'never an item already decided');
  assert.equal(current.waiting, undefined);
  assert.notEqual(current.chips[0].state, 'waits-for-you');
  const paintedAgain = JSON.parse(cli(app, ['work', 'list', '--offline', '--json']).stdout).inProgress.find((row) => row.id === 'APP-1');
  assert.equal(paintedAgain.statusLine, 'Waiting for Quality reviewers: approve Plan', 'offline, from the row and its items as kept together');
  assert.doesNotMatch(cli(app, ['work', 'list', '--offline']).stdout, /Waiting for you: Approve Plan\?/u);

  // With api's remote away, app's rows still show, and api keeps its last rows with one line.
  await rename(api.remote, `${api.remote}.away`);
  t.after(() => rename(`${api.remote}.away`, api.remote).catch(() => {}));
  const partial = JSON.parse(cli(app, ['work', 'list', '--json']).stdout);
  assert.deepEqual(partial.scope.repositories.map((entry) => [entry.id, entry.read]), [['app', 'fresh'], ['api', 'kept']]);
  assert.ok(partial.inProgress.some((row) => row.id === 'API-1'), 'api keeps its last-known rows');
  assert.equal(partial.lines.filter((line) => /^api could not be read \(.+\); showing \d\d:\d\d\.$/u.test(line)).length, 1, partial.lines.join('\n'));

  // The terminal says the same, in the same order.
  const text = cli(app, ['work', 'list', '--offline']).stdout;
  assert.match(text, /In progress\n {2}Story API-1 · API-1 · api · started [^\n]+\n {4}Plan, now, waits for approval\n {4}Waiting for Release owners: approve Plan/u);
  assert.match(text, /Done this week\n {2}Story APP-3 · APP-3 · app · report ready/u);
});
