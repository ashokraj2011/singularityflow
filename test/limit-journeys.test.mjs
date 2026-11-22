/**
 * Limits on a real Story, driven past them as a person and an agent meet them [owner, 2026-11-20: every limit has an
 * exit; limit audit §6, check 6]. Each journey reaches a limit through SFlow's own commands and hooks (the hooks run as the
 * CLI processes Copilot starts, test/helpers/route-follower.mjs copilotTurn) and keeps going: the way on it is given must
 * change something, in this chat or the next.
 *
 *   - a turn past its window and past its one unchanged renewal: every read is told to invoke the skill again, never to run
 *     another read; a new request goes on;
 *   - a request whose automatic continuations are spent: its last stop says so once, and a new chat's request starts with
 *     its own (the route differs, as the follower's new-chat check asks);
 *   - the follower itself catches a kept result older than the Story's last change (stale-replay), the replay of an earlier
 *     run's result as this call's that started the limit audit.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { CLI, copilotTurn, followRoutes, formatTrail, journeyRepository, startStory } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const W = 'LIM-1';
const EXPIRED = /PHASE_MUTATION_TURN_EXPIRED: /u;

/** A started quick fix, and the folder its Copilot hooks keep their turn records in. */
async function quickFix(t) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  const boundaries = path.join(path.dirname(story.env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const recordOf = (sessionId, kind = 'mutation') => path.join(boundaries, `${createHash('sha256').update(sessionId).digest('hex')}.${kind}.json`);
  const stop = (sessionId) => {
    const ran = story.spawn(process.execPath, [CLI, 'hook', 'boundary-stop'], { input: JSON.stringify({ cwd: story.root, sessionId, stopReason: 'end_turn' }) });
    try { return JSON.parse(ran.stdout || '{}'); } catch { return { unparsed: ran.stdout, stderr: ran.stderr }; }
  };
  return { story, recordOf, stop };
}

test('a turn past its window and its one renewal is told to invoke its skill again, never another read; a new request goes on', slowLane({ timeout: 600_000 }), async (t) => {
  const { story, recordOf } = await quickFix(t);
  const sessionId = 'limit-journey-turn';
  const turn = copilotTurn(story, sessionId);
  turn.prompt('/sf-phase');
  const draft = { path: path.join(story.root, story.item, 'artifacts/intake/intake.md') };
  const entry = { command: 'singularity-flow phase enter --compose --for-agent --json', cwd: story.root };
  turn.tool('bash', entry);
  story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']);
  turn.after('bash', entry, { resultType: 'success', textResultForLlm: '{"act":{"state":"author"}}' });
  const inside = turn.tool('edit', draft);
  assert.notEqual(inside.permissionDecision, 'deny', `inside its window the turn writes its draft: ${JSON.stringify(inside).slice(0, 800)}`);
  // Thirty-one minutes later (a long test run, a person away): the edit is refused and says how it goes on.
  assert.ok(turn.age(31).length >= 1, 'the turn record was aged');
  assert.match(turn.tool('edit', draft).permissionDecisionReason ?? '', EXPIRED);
  // The read it names, with nothing changed, renews it once.
  const read = { command: 'singularity-flow session current --for-agent --json', cwd: story.root };
  assert.notEqual(turn.tool('bash', read).permissionDecision, 'deny', 'the read the refusal names runs');
  const renewed = turn.after('bash', read, { resultType: 'success', textResultForLlm: '{"act":{"state":"next"}}' });
  const goesOn = turn.tool('edit', draft);
  assert.notEqual(goesOn.permissionDecision, 'deny', `the one unchanged renewal goes on: ${JSON.stringify({ renewed, goesOn }).slice(0, 1500)}`);
  // Thirty-one minutes past that renewal: no read renews it again, and none is offered.
  const renewal = recordOf(sessionId, 'renewal');
  const kept = JSON.parse(readFileSync(renewal, 'utf8'));
  const earlier = Date.now() - 31 * 60_000;
  writeFileSync(renewal, JSON.stringify({ ...kept, renewedAt: earlier, unchangedAt: earlier }));
  const after = turn.after('bash', read, { resultType: 'success', textResultForLlm: '{"act":{"state":"next"}}' });
  t.diagnostic(JSON.stringify(after).slice(0, 1200));
  assert.match(after.additionalContext ?? '', /PHASE_MUTATION_TURN_EXPIRED: [^\n]*Invoke \/sf-phase again to continue/u, JSON.stringify(after));
  assert.doesNotMatch(after.additionalContext ?? '', /PHASE_MUTATION_CONTRACT_STALE|first run singularity-flow session current/u, 'never a read that comes back to the same stop');
  const denied = turn.tool('edit', draft);
  assert.match(denied.permissionDecisionReason ?? '', EXPIRED);
  assert.match(denied.permissionDecisionReason, /renewed once already with nothing changed/u);
  // The way it names changes something: a new request of the skill goes on.
  turn.prompt('/sf-phase');
  turn.tool('bash', entry);
  story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']);
  turn.after('bash', entry, { resultType: 'success', textResultForLlm: '{"act":{"state":"author"}}' });
  assert.notEqual(turn.tool('edit', draft).permissionDecision, 'deny', 'a new request has its own window');
});

test('a request whose continuations are spent says so once; a new chat\'s request starts with its own', slowLane({ timeout: 600_000 }), async (t) => {
  const { story, recordOf, stop } = await quickFix(t);
  const { reserveWorkflowTaskContinuation } = await import('../src/workflow-task-store.mjs');
  const enter = (sessionId) => {
    const turn = copilotTurn(story, sessionId);
    turn.prompt('/sf-phase');
    const entry = { command: 'singularity-flow phase enter --compose --for-agent --json', cwd: story.root };
    turn.tool('bash', entry);
    const entered = story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']);
    turn.after('bash', entry, { resultType: 'success', textResultForLlm: entered.stdout.slice(0, 4000) });
    return JSON.parse(readFileSync(recordOf(sessionId), 'utf8'));
  };
  const first = enter('limit-journey-chat-1');
  const operation = first.taskOperation;
  assert.ok(operation?.operationId, `the entry armed the step's task: ${JSON.stringify(operation)}`);
  const expected = { workId: operation.workId, phaseId: operation.phaseId, generation: operation.generation, role: 'author' };
  // This request spends its own continuations, as several stops in it would.
  while ((await reserveWorkflowTaskContinuation(story.root, operation.operationId, expected, { request: `${first.sessionId}:${first.turnId}` })).allowed) { /* spent */ }
  const spent = stop('limit-journey-chat-1');
  t.diagnostic(JSON.stringify(spent).slice(0, 800));
  assert.equal(spent.decision, 'block');
  assert.match(spent.reason, /^SFLOW_TASK_CONTINUATION_SPENT: /u, 'never a silent stop');
  assert.deepEqual(stop('limit-journey-chat-1'), {}, 'said once; the stop after it ends the turn');
  // A new chat: its request starts with its own continuations, so the route it is given differs from the spent one.
  enter('limit-journey-chat-2');
  const fresh = stop('limit-journey-chat-2');
  assert.equal(fresh.decision, 'block');
  assert.match(fresh.reason, /^SFLOW_WORKFLOW_TASK_INCOMPLETE: /u, JSON.stringify(fresh));
});

test('the follower catches a kept result older than the Story\'s last change, replayed as this call\'s', slowLane({ timeout: 600_000 }), async (t) => {
  const { story } = await quickFix(t);
  // An earlier run of the entry keeps its result; the Story then changes (the intake is written).
  story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']);
  // The follower allows a kept result one second of clock slack; on a fast machine the change came within it and the
  // result read as fresh (red on main 580e86bb3, 2026-11-22). The change comes clearly after it, as in a real chat.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  const walk = await followRoutes(story, {
    label: 'stale replay', start: { shell: 'singularity-flow result last --command "phase enter" --for-agent --json' },
    done: () => false, maxSteps: 1
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.deepEqual(walk.findings.map((entry) => entry.kind).slice(0, 1), ['stale-replay'], JSON.stringify(walk.findings));
});
