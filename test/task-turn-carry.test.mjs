/**
 * ITW:REQ-008, A11, A17 [docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md]: a `/sf-task` turn carries the task on with nothing typed.
 *
 * Real runs (2026-11-25): after `work --start` the agent had to stop and the person typed `/sf-task` again before the
 * intake ran; after the person approved in the chat, the turn ended ("End this turn …") and the person typed again. The
 * after-tool hook now records the same turn again as the task's next action once the Story shows what the call did
 * (task-turn.mjs taskTurnContinuation, copilot-repository-boundary.mjs carryTaskTurn), so the guard binds it to that Story,
 * step and generation as if the person had typed /sf-task. Driven here through the real hooks, as Copilot's host calls
 * them; the decision itself is held to every other case with the real Story's record.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { taskTurnContinuation } from '../src/task-turn.mjs';
import { parseArgs } from '../src/util.mjs';
import { generatedAgent, generatedPerson } from './helpers/generated-journey.mjs';
import { argvOf, copilotTurn, followRoutes, formatTrail, journeyRepository, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const WORDS = 'fix the value module so it returns 2';
const START = `singularity-flow work "${WORDS}" --kind fix --start --json`;

/** The session's two turn records, as the hooks keep them. */
function records(story, sessionId) {
  const boundaries = path.join(path.dirname(story.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const prefix = createHash('sha256').update(sessionId).digest('hex');
  return {
    turn: () => JSON.parse(readFileSync(path.join(boundaries, `${prefix}.json`), 'utf8')),
    mutation: () => JSON.parse(readFileSync(path.join(boundaries, `${prefix}.mutation.json`), 'utf8'))
  };
}

const parsed = (command) => parseArgs(argvOf(command));
const denied = (answer) => answer?.permissionDecision === 'deny';

test('ITW REQ-008, A11: the start this /sf-task turn ran goes on into the intake in the same turn; a refused start leaves the turn', async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const chat = copilotTurn(story, 'task-start');
  const seen = records(story, 'task-start');
  chat.prompt(`/sf-task ${WORDS}`);
  const first = seen.turn();
  assert.deepEqual([first.skill, first.typedSkill], ['sf-task', undefined], 'no Story yet: the task\'s own turn');
  const intake = path.join(story.root, 'singularity/work-items/TASK-1/artifacts/intake/intake.md');
  assert.ok(denied(chat.tool('edit', { path: path.join(story.root, 'src/value.mjs') })), 'the task\'s own turn writes nothing');

  // A start the CLI refused: nothing to go on with, and the turn is the one the person typed.
  const refusedStart = 'singularity-flow work "/sf-task" --kind chore --start --json';
  assert.ok(!denied(chat.tool('bash', { command: refusedStart })));
  const refused = story.raw(argvOf(refusedStart));
  assert.notEqual(refused.status, 0);
  const afterRefused = chat.after('bash', { command: refusedStart }, { resultType: 'success', textResultForLlm: refused.stdout });
  assert.doesNotMatch(afterRefused.additionalContext ?? '', /goes on/u);
  assert.equal(seen.turn().turnId, first.turnId, 'a refused start leaves the turn as it is');
  // A start the host says succeeded, before it ran: the Story decides, never the host's word.
  chat.after('bash', { command: START }, { resultType: 'success', textResultForLlm: '{"id":"TASK-1"}' });
  assert.equal(seen.turn().turnId, first.turnId, 'no Story yet: nothing is carried on');

  // The start itself: the same turn goes on into the intake, bound to it as a typed /sf-task would be.
  assert.ok(!denied(chat.tool('bash', { command: START })));
  const ran = story.raw(argvOf(START));
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(denied(chat.tool('edit', { path: intake })), 'started, but before SFlow carries the turn on it still writes nothing');
  const after = chat.after('bash', { command: START }, { resultType: 'success', textResultForLlm: ran.stdout });
  assert.match(after.additionalContext ?? '', /SFlow: TASK-1 started, and this \/sf-task turn goes on with it now, under the turn rules below: do \/sf-task's step 1 in this turn\./u);
  assert.match(after.additionalContext ?? '', /SFlow turn boundary \(sf-next\): authoring turn, TASK-1 step intake generation 0\./u);
  const carried = seen.turn();
  assert.deepEqual([carried.skill, carried.typedSkill, carried.recordedAt], ['sf-next', 'sf-task', first.recordedAt], 'the window stays where the prompt put it');
  assert.notEqual(carried.turnId, first.turnId, 'a new turn ID: its answers start afresh');
  const { contract } = seen.mutation();
  assert.deepEqual([contract.turnMode, contract.workId, contract.phaseId, contract.generation], ['authoring', 'TASK-1', 'intake', 0]);
  assert.ok(!denied(chat.tool('edit', { path: intake })), 'the intake\'s own document is this turn\'s to write now');
  assert.ok(denied(chat.tool('edit', { path: path.join(story.root, 'src/value.mjs') })), 'and only the step\'s own files');
  // Carried once: a second start in the same turn changes nothing (it is no longer the task's own turn).
  chat.after('bash', { command: START }, { resultType: 'success', textResultForLlm: ran.stdout });
  assert.equal(seen.turn().turnId, carried.turnId);

  // The decision, held to the real Story's record in every other case.
  const record = storyRecord(story);
  const turn = { ...first };
  const value = { turnId: first.turnId, sessionId: first.sessionId, contract: null, repositoryRoot: contract.repositoryRoot };
  const decide = (overrides = {}) => taskTurnContinuation({ cwd: story.root }, {
    turn: overrides.turn ?? turn, ran: { value: overrides.value ?? value, commands: overrides.commands ?? [parsed(START)] },
    resolveRoot: async () => overrides.root ?? story.root, load: async () => ({ workflow: overrides.workflow ?? record }) });
  assert.deepEqual(await decide(), { skill: 'sf-next', workId: 'TASK-1', reason: 'start' });
  assert.equal(await decide({ workflow: { ...record, workItem: { ...record.workItem, createdAt: new Date(first.recordedAt - 60_000).toISOString() } } }), null,
    'a Story already open before this turn was not started by it');
  const classic = structuredClone(record);
  classic.workItem.workType = 'quick-fix';
  delete classic.resolution.composition;
  assert.equal(await decide({ workflow: classic }), null, 'a classic Story\'s start goes on as before');
  for (const command of ['singularity-flow work status --json', 'singularity-flow work add design --json', `singularity-flow work "${WORDS}" --kind fix --json`]) {
    assert.equal(await decide({ commands: [parsed(command)] }), null, command);
  }
  assert.equal(await decide({ root: story.base }), null, 'a Story in another folder than this turn\'s checkout');
  assert.equal(await decide({ turn: { ...turn, turnId: 'another' } }), null, 'another turn\'s record');
  assert.equal(await decide({ turn: { ...turn, skill: 'sf-next', typedSkill: 'sf-task' } }), null, 'a turn already carried on');
});

test('ITW REQ-008, A17: the person\'s Yes in the chat approves, and only then the same /sf-task turn goes on with the next step', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: 'singularity/work-items/TASK-1' });
  const walk = await followRoutes(story, { label: 'a fix to its plan approval', start: { shell: START.replace(/ --json$/u, '') },
    agent: generatedAgent('TASK-1'), person: generatedPerson(story, 'TASK-1'),
    done: ({ record }) => record?.phases?.intake?.status === 'awaiting_approval', maxSteps: 60 });
  assert.equal(walk.reached, true, formatTrail(walk.trail));
  const chat = copilotTurn(story, 'task-approve');
  const seen = records(story, 'task-approve');
  chat.prompt('/sf-task');
  const first = seen.turn();
  assert.deepEqual([first.skill, first.typedSkill, seen.mutation().contract.turnMode], ['sf-approve', 'sf-task', 'approval-only']);
  const code = 'singularity-flow phase begin implementation --for-agent --json';
  assert.ok(denied(chat.tool('bash', { command: code })), 'the approval-only turn authors nothing');
  assert.ok(denied(chat.tool('edit', { path: path.join(story.root, 'src/value.mjs') })));

  const begin = 'singularity-flow choices begin approve TASK-1 --fetch --for-agent --json --review-packet';
  assert.ok(!denied(chat.tool('bash', { command: begin })));
  const begun = JSON.parse(story.raw(argvOf(begin)).stdout);
  const { question, onYes } = begun.act.ask;
  assert.equal(question, 'Approve Intake v1?');
  // The person's own Yes, as the host hands it to the hooks.
  chat.tool('ask_user', { question, choices: ['Approve Intake v1', 'Not now'] });
  chat.after('ask_user', { question, choices: ['Approve Intake v1', 'Not now'] }, { resultType: 'success', textResultForLlm: 'User responded: Approve Intake v1' });
  assert.ok(!denied(chat.tool('bash', { command: onYes })), onYes);
  const answered = JSON.parse(story.raw(argvOf(onYes)).stdout);
  chat.after('bash', { command: onYes }, { resultType: 'success', textResultForLlm: JSON.stringify(answered) });
  assert.equal(seen.turn().turnId, first.turnId, 'the answer recorded is not yet the approval');
  const approve = answered.next?.command ?? answered.act?.do?.shell;
  assert.match(approve ?? '', /^singularity-flow approve intake --work-id TASK-1 /u, JSON.stringify(answered).slice(0, 2000));
  assert.ok(!denied(chat.tool('bash', { command: approve })), 'the person\'s Yes approves');
  // Before the approval is recorded (the host's word only, or a refusal), the turn stays the approval's and authors nothing.
  chat.after('bash', { command: approve }, { resultType: 'success', textResultForLlm: 'Approved.' });
  assert.equal(seen.turn().turnId, first.turnId);
  assert.ok(denied(chat.tool('bash', { command: code })));

  const approved = story.raw(argvOf(approve));
  assert.equal(approved.status, 0, approved.stderr.slice(-2000));
  const result = JSON.parse(approved.stdout);
  // The approval's own act names /sf-task and says to go on when SFlow says so: never "End this turn" on a task.
  assert.equal(result.turnBoundary, 'task');
  const act = agentAct(result);
  assert.equal(act.state, 'next');
  assert.equal(act.do.copilot, '/sf-task');
  assert.doesNotMatch(`${act.said} ${result.instruction}`, /End this turn/u);
  const after = chat.after('bash', { command: approve }, { resultType: 'success', textResultForLlm: approved.stdout });
  assert.match(after.additionalContext ?? '', /SFlow: the approval is recorded, and this \/sf-task turn goes on with TASK-1's next action now/u);
  assert.match(after.additionalContext ?? '', /SFlow turn boundary \(sf-next\): authoring turn, TASK-1 step implementation generation 0\./u);
  const carried = seen.turn();
  assert.deepEqual([carried.skill, carried.typedSkill], ['sf-next', 'sf-task']);
  assert.notEqual(carried.turnId, first.turnId, 'the Yes just given decides nothing more');
  const { contract } = seen.mutation();
  assert.deepEqual([contract.turnMode, contract.phaseId], ['authoring', 'implementation']);
  assert.ok(!denied(chat.tool('bash', { command: code })), 'the next step\'s work is this turn\'s now');
  assert.ok(denied(chat.tool('bash', { command: 'singularity-flow approve intake --work-id TASK-1 --yes' })), 'and never an approval');

  // The decision on the real Story's record: only an approval this turn recorded, of the step it was bound to, on a task.
  const record = storyRecord(story);
  const turn = { ...first };
  const value = { turnId: first.turnId, sessionId: first.sessionId, originPhase: 'intake',
    contract: { workId: 'TASK-1', turnMode: 'approval-only', phaseId: 'implementation', repositoryRoot: contract.repositoryRoot } };
  const decide = (overrides = {}) => taskTurnContinuation({ cwd: story.root }, {
    turn: overrides.turn ?? turn, ran: { value: overrides.value ?? value, commands: overrides.commands ?? [parsed(approve)] },
    resolveRoot: async () => story.root, load: async () => ({ workflow: overrides.workflow ?? record }) });
  assert.deepEqual(await decide(), { skill: 'sf-next', workId: 'TASK-1', reason: 'approval' });
  assert.equal(await decide({ turn: { ...turn, typedSkill: undefined } }), null, '/sf-approve typed: its own skill ends the turn');
  assert.equal(await decide({ turn: { ...turn, recordedAt: Date.now() + 60_000 } }), null, 'an approval recorded before this turn');
  const waiting = structuredClone(record);
  waiting.phases.intake.status = 'awaiting_approval';
  assert.equal(await decide({ workflow: waiting }), null, 'an approval not recorded');
  const classic = structuredClone(record);
  classic.workItem.workType = 'quick-fix';
  delete classic.resolution.composition;
  assert.equal(await decide({ workflow: classic }), null, 'a classic Story\'s approval ends its turn as before');
  const deciding = structuredClone(record);
  deciding.pendingDecision = { key: 'd1', label: 'Pick one', options: [{ id: 'a', label: 'A' }] };
  assert.equal(await decide({ workflow: deciding }), null, 'a decision is the person\'s on its card');
  assert.equal(await decide({ commands: [parsed('singularity-flow approve intake --work-id OTHER-1 --yes')] }), null, 'another Story\'s approval');
  assert.equal(await decide({ commands: [parsed(onYes)] }), null, 'an answer is not the approval');
});
