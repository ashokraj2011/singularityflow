/**
 * Every Story carries on like a task, and one way on always works [owner, 2026-11-28: "No one should get stuck"].
 *
 * A classic (workflow) Story's turn goes on in the same chat after its step's submission, into the person's approval
 * question, and after the person's Yes, into the next step's own work, as a task's does (task-turn.mjs
 * storyTurnContinuation, copilot-repository-boundary.mjs carryTaskTurn): driven here through the real hooks, as Copilot's
 * host calls them, on the Story's real records. And the one way on, /sf-next (with its older names), says where the
 * Story is, why it waits and the one thing to do from four states a person got stuck in: after a refusal, in a stale
 * chat, with the chat's hooks off, and while the Story waits on SFlow itself (way-out.mjs).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { completeAgentResult } from '../src/agent-output.mjs';
import { nextStepsSnapshot } from '../src/nextsteps.mjs';
import { initiativeWayOut, storyWayOut, wayOutLine } from '../src/way-out.mjs';
import { adviceForStep } from '../src/step-advice.mjs';
import { storyContextPolicy, contextBoundaryHandoff } from '../src/context-policy.mjs';
import { carryRoute, NEXT_ROUTE, TASK_ROUTE } from '../src/safe-command-guidance.mjs';
import { NEXT_ACTION_SKILLS, STEP_WORK_SKILLS } from '../src/task-turn.mjs';
import { WRITING_ALIASES } from '../src/writing-aliases.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { argvOf, copilotTurn, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const W = 'CARRY-1';
const denied = (answer) => answer?.permissionDecision === 'deny';

/** The session's turn and mutation records, as the hooks keep them. */
function records(story, sessionId) {
  const boundaries = path.join(path.dirname(story.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const prefix = createHash('sha256').update(sessionId).digest('hex');
  return {
    turn: () => JSON.parse(readFileSync(path.join(boundaries, `${prefix}.json`), 'utf8')),
    mutation: () => JSON.parse(readFileSync(path.join(boundaries, `${prefix}.mutation.json`), 'utf8'))
  };
}

/** A classic quick fix whose intake is written, published and reviewed: only its submission is left. */
async function reviewedIntake(t) {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  return story;
}

test('every Story keeps its chat between steps: no /clear or new chat, whatever its workflow pinned', () => {
  const pinned = { resolution: { contextPolicy: { onApproval: 'new', onRejection: 'new' } }, workItem: { workType: 'spec-driven-standard' } };
  assert.deepEqual(contextBoundaryHandoff(storyContextPolicy(pinned), 'planning', { nextPhase: 'implementation', nextSkill: '/sf-code' }).commands, ['/sf-code']);
  assert.equal(carryRoute(pinned), NEXT_ROUTE);
  assert.equal(carryRoute({ workItem: { workType: 'task-fix' } }), TASK_ROUTE);
  for (const name of ['sf-next', 'sf-nextsteps', 'sf-status', 'sf-resume', 'sf-continue', 'sflow-next']) assert.ok(NEXT_ACTION_SKILLS.includes(name), name);
  // The recovery skill keeps its own turn: it runs the repairs the one way on routes to.
  assert.equal(NEXT_ACTION_SKILLS.includes('sf-recover'), false);
  // The step-work turns that carry on after a submission: /sf-next, /sf-submit and every writing alias.
  assert.deepEqual([...STEP_WORK_SKILLS].sort(), ['submit', ...Object.keys(WRITING_ALIASES)].sort());
});

test('a classic Story: the step\'s submission goes on into its approval question, and only the person\'s Yes into the next step', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await reviewedIntake(t);
  const chat = copilotTurn(story, 'classic-carry');
  const seen = records(story, 'classic-carry');
  chat.prompt('/sf-phase');
  const working = seen.turn();
  assert.deepEqual([working.skill, seen.mutation().contract.turnMode, seen.mutation().contract.phaseId], ['sf-phase', 'authoring', 'intake']);
  const yes = `singularity-flow approve intake --work-id ${W} --yes`;
  assert.ok(denied(chat.tool('bash', { command: yes })), 'the step\'s own work never approves it');

  const submit = `singularity-flow status ${W} --submission-readiness --submit-if-ready --for-agent --json`;
  assert.ok(!denied(chat.tool('bash', { command: submit })), submit);
  const submitted = story.raw(argvOf(submit));
  assert.equal(submitted.status, 0, submitted.stderr.slice(-2000));
  assert.equal(storyRecord(story).phases.intake.status, 'awaiting_approval');
  const asked = chat.after('bash', { command: submit }, { resultType: 'success', textResultForLlm: submitted.stdout });
  // The note says what to do in this same turn, with no other skill's text: the approval question, asked of the person.
  assert.match(asked.additionalContext ?? '', /SFlow: the step is submitted and waits for the person's approval, and this turn goes on with CARRY-1 now, under the turn rules below: run `singularity-flow choices begin approve CARRY-1 --fetch --for-agent --json --review-packet`/u);
  assert.match(asked.additionalContext ?? '', /SFlow turn boundary \(sf-approve\): approval-only turn, CARRY-1 step intake generation 1\./u);
  const first = seen.turn();
  assert.deepEqual([first.skill, first.typedSkill, seen.mutation().contract.turnMode], ['sf-approve', 'sf-phase', 'approval-only']);
  assert.notEqual(first.turnId, working.turnId, 'a new turn ID: no answer from the work counts for the approval');
  assert.ok(denied(chat.tool('bash', { command: yes })), 'the approval waits for the person\'s Yes to its question');

  const begin = `singularity-flow choices begin approve ${W} --fetch --for-agent --json --review-packet`;
  assert.ok(!denied(chat.tool('bash', { command: begin })));
  const begun = JSON.parse(story.raw(argvOf(begin)).stdout);
  const { question, onYes } = begun.act.ask;
  chat.tool('ask_user', { question, choices: [question.replace(/\?$/u, ''), 'Not now'] });
  chat.after('ask_user', { question, choices: [question.replace(/\?$/u, ''), 'Not now'] }, { resultType: 'success', textResultForLlm: `User responded: ${question.replace(/\?$/u, '')}` });
  assert.ok(!denied(chat.tool('bash', { command: onYes })), onYes);
  const answered = JSON.parse(story.raw(argvOf(onYes)).stdout);
  chat.after('bash', { command: onYes }, { resultType: 'success', textResultForLlm: JSON.stringify(answered) });
  const approve = answered.next?.command ?? answered.act?.do?.shell;
  assert.match(approve ?? '', /^singularity-flow approve intake --work-id CARRY-1 /u, JSON.stringify(answered).slice(0, 2000));
  assert.ok(!denied(chat.tool('bash', { command: approve })), 'the person\'s Yes approves');
  const approved = story.raw(argvOf(approve));
  assert.equal(approved.status, 0, approved.stderr.slice(-2000));
  const result = JSON.parse(approved.stdout);
  // Never "End this turn" and /clear: the approval says the turn goes on, with /sf-next as the way on if no note comes.
  assert.equal(result.turnBoundary, 'carry');
  assert.doesNotMatch(`${result.act?.said ?? ''} ${result.instruction ?? ''}`, /End this turn|\/clear/u);
  const after = chat.after('bash', { command: approve }, { resultType: 'success', textResultForLlm: approved.stdout });
  assert.match(after.additionalContext ?? '', /SFlow: the approval is recorded, and this turn goes on with CARRY-1 now, under the turn rules below: run `singularity-flow phase enter --compose --for-agent --json`/u);
  const carried = seen.turn();
  assert.deepEqual([carried.skill, carried.typedSkill], ['sf-next', 'sf-phase']);
  const { contract } = seen.mutation();
  assert.deepEqual([contract.turnMode, contract.phaseId], ['authoring', storyRecord(story).currentPhase]);
  assert.notEqual(contract.phaseId, 'intake', 'the next step\'s work is this turn\'s now');
  assert.ok(denied(chat.tool('bash', { command: yes })), 'and never an approval');
});

test('a person\'s send-back carries the same turn straight into writing the returned step\'s next version', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await reviewedIntake(t);
  story.cli('submit', 'intake');
  const chat = copilotTurn(story, 'send-back');
  const seen = records(story, 'send-back');
  chat.prompt('/sf-reject');
  const first = seen.turn();
  assert.deepEqual([first.skill, seen.mutation().contract.turnMode], ['sf-reject', 'approval-only']);
  const reject = `singularity-flow reject intake --work-id ${W} --to intake --reason "Name the value's one caller in the plan." --json`;
  assert.ok(!denied(chat.tool('bash', { command: reject })), reject);
  const ran = story.raw(argvOf(reject));
  assert.equal(ran.status, 0, ran.stderr.slice(-2000));
  const after = chat.after('bash', { command: reject }, { resultType: 'success', textResultForLlm: ran.stdout });
  assert.match(after.additionalContext ?? '', /SFlow: the step went back with the person's reason, and its next version starts on that send-back, and this turn goes on with CARRY-1 now, under the turn rules below: run `singularity-flow phase enter --compose --for-agent --json`/u);
  const carried = seen.turn();
  assert.deepEqual([carried.skill, carried.typedSkill], ['sf-next', 'sf-reject'], 'the returned step\'s work is this turn\'s now');
  assert.equal(seen.mutation().contract.turnMode, 'authoring');
  assert.equal(seen.mutation().contract.phaseId, 'intake');
  assert.notEqual(carried.turnId, first.turnId);
  // Its entry starts the version on the send-back itself and names the writing, with nothing asked (sent-back-opening.mjs).
  const entry = 'singularity-flow phase enter --compose --for-agent --json';
  assert.ok(!denied(chat.tool('bash', { command: entry })), entry);
  const entered = JSON.parse(story.raw(argvOf(entry)).stdout);
  assert.equal(entered.act?.ask, undefined, JSON.stringify(entered.act));
});

test('the one way on from stuck states: after a refusal, in a stale chat, and while SFlow owes a push', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await reviewedIntake(t);
  // 1. After a refusal: the approval typed before the step was submitted is refused; /sf-next then takes the step's turn.
  const early = copilotTurn(story, 'after-refusal');
  early.prompt('/sf-approve');
  const refused = story.raw(argvOf(`singularity-flow approve intake --work-id ${W} --yes --json`));
  assert.notEqual(refused.status, 0, 'nothing is submitted yet');
  early.prompt('/sf-next');
  assert.deepEqual([records(story, 'after-refusal').turn().skill, records(story, 'after-refusal').mutation().contract.phaseId], ['sf-next', 'intake']);
  const read = JSON.parse(story.raw(['nextsteps', '--for-agent', '--json']).stdout);
  assert.equal(read.wayOut.next.by, 'agent', JSON.stringify(read.wayOut));
  assert.match(read.wayOut.where, /^CARRY-1 is at Scope and plan \(version 1\): written, not yet submitted\.$/u);
  assert.ok(read.act.read.includes('wayOut'), 'the bounded view keeps it');

  // 2. A stale chat: its turn was the approval of a step another chat already approved, long ago. /sf-next binds it to now.
  story.cli('submit', 'intake');
  const stale = copilotTurn(story, 'stale-chat');
  stale.prompt('/sf-approve');
  stale.age(45);
  story.cli('approve', 'intake', '--yes');
  const current = storyRecord(story).currentPhase;
  stale.prompt('/sf-status');
  const fresh = records(story, 'stale-chat').turn();
  assert.deepEqual([fresh.skill, fresh.typedSkill], ['sf-next', 'sf-status'], 'an older name takes the Story\'s next turn too');
  assert.equal(records(story, 'stale-chat').mutation().contract.phaseId, current);
  assert.ok(Date.now() - fresh.recordedAt < 60_000, 'a fresh window');
  // Another Story's ID keeps the typed turn, which attaches that Story first.
  stale.prompt('/sf-status OTHER-9');
  assert.equal(records(story, 'stale-chat').turn().skill, 'sf-status');
  assert.equal(records(story, 'stale-chat').turn().typedSkill, undefined);

  // 4. Waiting on SFlow itself: a commit saved here and not pushed. The way on is SFlow's to do: its sync.
  const record = storyRecord(story);
  const snapshot = nextStepsSnapshot({ workflow: record, publicationPending: true });
  assert.equal(snapshot.state, 'publication_pending');
  const pending = storyWayOut(snapshot, record);
  assert.deepEqual([pending.next.by, pending.next.kind], ['sflow', 'push'], JSON.stringify(pending));
  assert.match(pending.next.command, /^singularity-flow sync\b/u);
  assert.equal(pending.why, 'Its last change is committed here but not sent yet.');
  assert.match(wayOutLine(pending), /^CARRY-1 is at .*Next: SFlow sends the commits it saved here, then goes on\.$/u);
});

test('the one way on with the chat\'s hooks off: it says why and the one fix, and changes nothing', slowLane({ timeout: 300_000 }), async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  // The repository expects SFlow's hooks, and this chat's session was never seen by any of them.
  await story.write('.github/hooks/sflow.json', '{}\n');
  const before = storyRecord(story);
  const off = story.raw(['nextsteps', '--for-agent', '--json'], { environment: { ...story.env, COPILOT_AGENT_SESSION_ID: 'never-hooked' } });
  const view = JSON.parse(off.stdout);
  // The act says it and the one fix, and points at the way out, which the bounded view keeps in its file.
  assert.equal(view.act?.state, 'end-turn', off.stdout.slice(0, 1500));
  assert.match(view.act.said, /^SFLOW_HOOKS_OFF: .* Fix: /u);
  assert.deepEqual(view.act.read, ['wayOut']);
  const { wayOut } = completeAgentResult(view);
  assert.equal(wayOut?.next?.kind, 'reload', JSON.stringify(wayOut));
  assert.equal(wayOut.next.by, 'person');
  assert.match(wayOut.why, /guard is off in this chat/u);
  assert.match(wayOut.where, /^CARRY-1 is at /u);
  assert.deepEqual(storyRecord(story), before, 'nothing changed');
});

test('the way on names who does what, in plain words, from any snapshot', () => {
  const workflow = { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'planning',
    phases: { planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 2 } } };
  const approval = storyWayOut({ workId: 'W-1', state: 'in_progress', actions: [{ timing: 'now', skill: '/sf-approve', copilotCommand: '/sf-approve planning --work-id W-1', command: 'singularity-flow approve planning --work-id W-1 --fetch', label: 'Review and approve Planning' }] }, workflow);
  // Why: what the person decides at this step, from the per-intent advice every approval surface reads (step-advice.mjs).
  assert.deepEqual(approval, { where: 'W-1 is at Planning (version 2): submitted, waiting for approval.',
    why: adviceForStep(workflow, 'planning').decides,
    next: { by: 'person', kind: 'approval', words: 'Review and approve Planning: SFlow asks you here; in VS Code it opens the approval page.' } });
  assert.match(approval.why, /^You decide /u);
  const none = storyWayOut(nextStepsSnapshot({ initialized: true }), null);
  assert.equal(none.where, 'No Story is open in this chat.');
  assert.equal(none.next.by, 'person');
  const done = storyWayOut({ workId: 'W-1', state: 'closed', actions: [] }, { ...workflow, status: 'closed' });
  assert.deepEqual([done.where, done.next.kind], ['W-1 is done: every step is decided.', 'done']);
  // No line asks a person to type a command to go on, except the one start of new work.
  for (const way of [approval, done]) assert.doesNotMatch(way.next.words, /singularity-flow|\/sf-(?!task)/u);
});

test('an Epic\'s next, status and resume are /sf-next too: its read answers with the Epic\'s way on', async (t) => {
  // Pure: an approval is a person's, on its card; any other step is named with the skill that does it, never the one way on's
  // own older name (/sf-initiative-next falls back to itself).
  const approve = initiativeWayOut({ initiativeId: 'E-1', currentPhase: 'define', actions: [{ command: 'singularity-flow initiative approve define --initiative E-1', reason: 'All define outputs are ready for approval.', skill: '/sf-initiative-approve' }] });
  assert.deepEqual(approve, { where: 'E-1 is at its define step.', why: 'All define outputs are ready for approval.',
    next: { by: 'person', kind: 'sign-off', words: 'A person approves its outputs: on the Needs-you card in VS Code, or with /sf-initiative-approve.' } });
  const step = initiativeWayOut({ initiativeId: 'E-1', currentPhase: 'epic-intake', actions: [{ command: 'singularity-flow epic requirements prepare', reason: 'Prepare the requirements.', skill: '/sf-epic-requirements' }] });
  assert.deepEqual(step.next, { by: 'person', kind: 'epic-step', words: 'Prepare the requirements. /sf-epic-requirements does it.' });
  const self = initiativeWayOut({ initiativeId: 'E-1', currentPhase: 'define', actions: [{ command: 'singularity-flow initiative unknown', reason: 'Look at it.', skill: '/sf-initiative-next' }] });
  assert.equal(self.next.words, 'Look at it.');
  assert.equal(initiativeWayOut({ initiativeId: 'E-1', actions: [] }).next.kind, 'done');
  // The older names hand to /sf-next with the Epic key; /sf-next reads `nextsteps <ID>` for it.
  const skill = (name) => readFileSync(path.join(import.meta.dirname, '..', 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
  for (const name of ['sflow-epic-next', 'sflow-epic-status', 'sflow-epic-resume', 'sflow-initiative-next', 'sflow-initiative-status']) {
    assert.match(skill(name), /This is the one way on, `\/sf-next`, under an older name: run `\/sflow-next` once with the supplied (?:Epic key|Initiative ID)/u, name);
  }
  assert.match(skill('sflow-epic-resume'), /singularity-flow epic resume <EPIC-KEY> --fetch/u, 'resume still opens an Epic this checkout does not hold');
  assert.match(skill('sflow-next'), /Given an Epic key or Initiative ID, the read is `singularity-flow nextsteps <ID> --for-agent --json`/u);
  // Its read, on an Epic's own checkout where no Story is: the Epic's actions and its way on, read only.
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const YAML = (await import('yaml')).default;
  const { initializeDefinition } = await import('../src/config.mjs');
  const { createInitiative } = await import('../src/initiative-state.mjs');
  const { run } = await import('../src/util.mjs');
  const { nextStepsAgentPacket } = await import('../src/commands/nextsteps.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-way-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Epic Way Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'epic-way@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Epic way\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(file, 'utf8'));
  for (const authority of Object.values(portfolio.approvalAuthorities)) authority.members = [{ name: 'Epic Way Owner', email: 'epic-way@example.invalid' }];
  portfolio.git.publish = 'off';
  await writeFile(file, YAML.stringify(portfolio));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Initialize portfolio'], { cwd: root });
  run('git', ['switch', '-q', '-c', 'INIT-WAY'], { cwd: root });
  await createInitiative(root, { id: 'INIT-WAY', title: 'One way on', profile: 'initiative-lite', agent: 'product-owner' });
  for (const reference of [null, 'INIT-WAY']) {
    const read = await nextStepsAgentPacket(reference, { cwd: root });
    assert.equal(read.resultType, 'sflow-nextsteps', JSON.stringify(read).slice(0, 600));
    assert.equal(read.initiativeId, 'INIT-WAY');
    assert.match(read.wayOut.where, /^INIT-WAY is at its \S+ step\.$/u, JSON.stringify(read.wayOut));
    assert.equal(read.wayOut.next.by, 'person');
    assert.ok(read.wayOut.why && read.wayOut.next.words, JSON.stringify(read.wayOut));
  }
});

test('VS Code: Continue sends the one way on from the status bar, the Work page and an empty Needs-you list', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const manifest = JSON.parse(readFileSync(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.continueStory' && entry.title === 'Singularity Flow: Continue'));
  const extension = readFileSync(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const status = extension.slice(extension.indexOf("createStatusBarItem('singularityFlow.continueStory'"), extension.indexOf('showContinue();'));
  assert.match(status, /continueStatus\.text = '\$\(debug-continue\) Continue'/u);
  assert.match(status, /handlers\.set\(CONTINUE_COMMAND, async \(\) => \{[^]*sendTaskRoute\(carryRoute\(workflow\)\)/u, 'it sends /sf-next, or /sf-task on a task, as typed');
  // With the chat's hooks off (a folder opened through a link, or Copilot's disableAllHooks), Continue says why in one line
  // and offers that one fix (reopen at the real path, or Diagnostics) instead of sending a turn SFlow cannot guard.
  assert.match(status, /if \(hooksOff\) \{[^]*showCompactWarningMessage\(off\.line, off\.action\)[^]*return;\s*\}\s*await sendTaskRoute/u);
  assert.match(extension, /hooksOff = \{ line: prompt\.message, action: prompt\.action, command: reopen \};/u);
  assert.match(extension, /hooksOff = \{ line: `Copilot hooks are off here \(disableAllHooks in /u);
  const { needsYouListHtml } = await import('../apps/vscode/src/views/needs-you-page.ts');
  assert.match(needsYouListHtml({ items: [], lines: [], more: 0, checked: { words: 'Checked now' } }), /Nothing waits on you now\. <button type="button" class="needs-you-more" data-continue="1">Continue<\/button>/u);
});
