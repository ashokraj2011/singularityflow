/**
 * A step the kernel builds is built by the route SFlow gives it [journey B, 2026-11-16].
 *
 * A kernel-built step (phaseKernelOwned: a deterministic producer and no code to deliver: quick-fix's Verify, POC Lite's
 * plan, verify and finalize) is routed to /sf-phase with `prepare <step>`, and /sf-phase enters by `phase enter
 * --compose`. That entry refused composition, as it must, but reported attention-required and led to a read-only
 * /sf-appeal inspection, so an agent following SFlow's own routes never built the step. nextsteps also sent it to
 * /sf-resume first, to select an agent the step never binds. Now the entry says `deterministic-generation`, and its
 * route back to /sf-phase is the generator this turn runs; nextsteps goes straight to it.
 *
 * Deterministic convergence keeps its own skill (/sf-converge), whose steps run the generator; journey A walks it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { phaseTaskCompletion } from '../src/phase-authoring-progress.mjs';
import { cooperativePerson, report, reviewer } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, publishedGeneration, startStory, storyRecord } from './helpers/route-follower.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const W = 'KRN-1';

/** A POC Lite Story, started: its first step, the plan, is built by the kernel. */
async function pocLiteStory(t, workId = W) {
  const story = await journeyRepository(t);
  startStory(story, workId, { workType: 'poc-lite', title: 'Change the value', description: 'Return 2.' });
  return story;
}

const json = (story, ...args) => {
  const ran = story.raw([...args, '--json']);
  assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return JSON.parse(ran.stdout);
};

test('a kernel-built step\'s entry routes to its generator in this turn, never to an appeal inspection', async (t) => {
  const story = await pocLiteStory(t);
  const entry = json(story, 'phase', 'enter', '--compose');
  const act = entry.act ?? agentAct(entry);
  assert.equal(entry.phase, 'poc-lite-plan');
  assert.equal(entry.status, 'deterministic-generation', JSON.stringify({ status: entry.status, admission: entry.contextAdmission }));
  assert.deepEqual(entry.contextAdmission.blockers.map((blocker) => blocker.code), ['PHASE_CONTEXT_DETERMINISTIC'], 'nothing is composed for it');
  assert.equal(entry.contextComposition, 'not-needed', 'not "not-admitted", which /sf-phase relays and stops at');
  // The one thing to do: run the generator, in the turn of the skill that was routed here. No skill to type: handing
  // back /sf-phase, the route that brought the turn here, is what a relaying agent would loop on.
  assert.equal(act.state, 'next');
  assert.equal(act.do.shell, 'singularity-flow prepare poc-lite-plan');
  assert.equal(act.do.copilot, null);
  assert.match(act.said, /run do\.shell, its generator, now in this turn, then `singularity-flow phase prepublish poc-lite-plan --for-agent --json --publish-if-ready`/u);
  assert.match(act.said, /this turn's own work, not a route to relay/u);
  assert.doesNotMatch(JSON.stringify(act), /sf-appeal|appeal resolve/u);
  assert.equal(entry.next.some((action) => /appeal resolve/u.test(action.commandGuidance?.command ?? '')), false, JSON.stringify(entry.next.map((action) => action.id)));
  // Its task, across a restart, resumes at the generator, not at this entry again.
  assert.equal(entry.taskCompletion?.nextAction?.command, 'singularity-flow prepare poc-lite-plan', JSON.stringify(entry.taskCompletion));
  assert.equal(entry.taskResume?.nextAction?.command, 'singularity-flow prepare poc-lite-plan', JSON.stringify(entry.taskResume));

  // nextsteps goes straight to the step: no /sf-resume to select an agent a kernel-built step never binds.
  const next = json(story, 'nextsteps', W);
  const now = (next.data?.actions ?? next.actions).filter((action) => action.timing === 'now');
  assert.equal(now.some((action) => /^singularity-flow resume\b/u.test(action.command ?? '')), false, JSON.stringify(now));
  assert.equal(now[0]?.command, 'singularity-flow prepare poc-lite-plan', JSON.stringify(now));
  assert.match(now[0]?.copilotCommand ?? '', /^\/sf-phase\b/u);
});

test('only a kernel-built entry names its generator: a held entry keeps its own route, and the generator\'s task resumes at it', () => {
  const base = { resultType: 'sflow-phase-entry', ready: true, paused: false, workId: W, phase: 'poc-lite-plan', inspectionGeneration: 1 };
  // A hold the entry reports for any step keeps its own route (recovery, a worktree review): not the generator.
  const held = agentAct({ ...base, status: 'attention-required', next: [{ id: 'working-tree', command: `singularity-flow recover ${W} --json` }] });
  assert.equal(held.state, 'next');
  assert.doesNotMatch(held.said, /built by the kernel/u);
  assert.equal(phaseTaskCompletion({ ...base, status: 'attention-required', authoringProgress: null, next: [] }), null);
  // The generator's task: its next action is the generator, the generation the entry inspects.
  const generate = { id: 'generate:poc-lite-plan', commandGuidance: { command: 'singularity-flow prepare poc-lite-plan', copilotCommand: '/sf-phase', modelFreeCommand: null } };
  const task = phaseTaskCompletion({ ...base, status: 'deterministic-generation', authoringProgress: null, next: [generate] });
  assert.equal(task.state, 'author-draft');
  assert.equal(task.generation, 1);
  assert.deepEqual(task.nextAction, { command: 'singularity-flow prepare poc-lite-plan', copilotCommand: '/sf-phase', modelFreeCommand: null });
  assert.match(task.recheck.command, /phase prepublish poc-lite-plan .*--publish-if-ready/u);
});

test('a POC Lite Story\'s kernel-built plan is built and published by its routes from /sf-next', async (t) => {
  const story = await pocLiteStory(t);
  const walk = await followRoutes(story, {
    label: 'the POC Lite plan', start: { copilot: '/sf-next' },
    agent: { author: async () => false }, person: cooperativePerson(),
    done: ({ record }) => publishedGeneration(record, 'poc-lite-plan') >= 1, maxSteps: 8
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  assert.deepEqual(walk.findings, [], report(walk));
  // The generator ran in the /sf-phase turn its route entered; nothing went to /sf-resume or an appeal.
  const generated = walk.trail.findIndex((entry) => /^singularity-flow prepare poc-lite-plan\b/u.test(entry.ran ?? ''));
  assert.ok(generated > 0 && walk.trail[generated].turn === '/sf-phase', report(walk));
  assert.equal(walk.trail.some((entry) => /^\/sf-(?:resume|appeal)\b/u.test(entry.taking ?? '')), false, report(walk));
});

// The whole work type whose every step the kernel builds or codes: the plan, the code (written by /sf-code, its summary
// built by the kernel), verify and finalize, the last approved by its person; each by the route the step before returned.
test('a POC Lite Story goes from its start to its end by its routes: every kernel-built step is built where it is routed', slowLane({ timeout: 900_000 }), async (t) => {
  const story = await pocLiteStory(t, 'KRN-2');
  const author = async ({ story: s, phase }) => {
    if (phase !== 'poc-lite-act') return false;
    await s.write('src/value.mjs', 'export const value = 2;\n');
    await s.write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';",
      "import { value } from '../src/value.mjs';", '', "test('returns the approved value', () => assert.equal(value, 2));", ''].join('\n'));
    return true;
  };
  const walk = await followRoutes(story, {
    label: 'POC Lite', start: { copilot: '/sf-next' },
    agent: { author, review: reviewer() }, person: cooperativePerson(),
    done: ({ record }) => record?.status === 'closed', maxSteps: 40
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  assert.deepEqual(walk.findings, [], report(walk));
  const record = storyRecord(story);
  for (const phase of ['poc-lite-plan', 'poc-lite-verify', 'poc-lite-finalize']) {
    assert.ok(walk.trail.some((entry) => entry.turn === '/sf-phase' && new RegExp(`^singularity-flow prepare ${phase}\\b`, 'u').test(entry.ran ?? '')), `${phase} was not built in its /sf-phase turn\n${report(walk)}`);
    assert.ok(publishedGeneration(record, phase) >= 1, phase);
  }
  assert.equal(walk.trail.some((entry) => /^\/sf-(?:resume|appeal)\b/u.test(entry.taking ?? '')), false, report(walk));
  // A step nobody approves is submitted in the turn that wrote it, and completing it ends that turn: the next step starts in a
  // new one, never in the same turn [decision 7; owner, 2026-11-19].
  assert.ok(walk.trail.some((entry) => /--submit-if-ready/u.test(entry.ran ?? '') && entry.act === 'end-turn'), report(walk));
});
