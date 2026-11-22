/**
 * Journey tests, fast tier [owner, 2026-11-16]: SFlow driven by its own routes, as an agent and a person take them
 * (test/helpers/route-follower.mjs). The full journeys (A, B, D, E) are in test/journey-stories.test.mjs, in the slow lane.
 *
 * Here: the skill entry map the follower derives from plugin/skills/<skill>/SKILL.md; journey C (a document step
 * reviewed before it is written is routed to writing it, incident 1 of 2026-11-16); and the short part of every
 * journey, a quick-fix Story's first step from `start` to its approval.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMAND_LINE_SKILL_ROUTES, COMMAND_SKILLS } from '../src/command-skills.mjs';
import { check, cooperativePerson, quickFixIntake, report, reviewer, scopeAnswers, settle, specDrivenAuthor, viewsAgree } from './helpers/journey-scripts.mjs';
import { argvOf, copilotTurn, entryCommand, followRoutes, formatTrail, journeyRepository, publishedGeneration, skillEntries, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { specification } from './helpers/submitted-planning-story.mjs';

test('the follower enters each skill by the first command its SKILL.md names, for every skill a route can name', () => {
  const entries = skillEntries();
  // The incidents' skills, as their SKILL.md files say today.
  assert.equal(entries.get('/sf-code').entry, 'singularity-flow phase enter --compose --for-agent --json');
  assert.equal(entries.get('/sf-phase').entry, 'singularity-flow phase enter --compose --for-agent --json');
  assert.equal(entries.get('/sf-review-source').entry, 'singularity-flow review-source context --for-agent --json');
  assert.equal(entries.get('/sf-recover').entry, 'singularity-flow recover $ARGUMENTS --fetch --for-agent --json');
  assert.equal(entries.get('/sf-decide').entry, 'singularity-flow decisions <WORK-ID> --for-agent --json');
  assert.equal(entries.get('/sf-submit').entry, 'singularity-flow status <WORK-ID> --submission-readiness --for-agent --json --submit-if-ready');
  assert.match(entries.get('/sf-code').finish, /^singularity-flow phase prepublish <phase> --for-agent --json --publish-if-ready$/u);
  // An alias enters as the skill it hands its turn to.
  assert.equal(entries.get('/sf-implement').entry, entries.get('/sf-code').entry);
  assert.equal(entries.get('/sf-implement').delegate, '/sf-code');
  // A route's arguments and the Story fill the entry: the step a review names, the Story a decision is for.
  const story = { workId: 'JRN-1', phases: ['specification', 'planning'], currentPhase: 'planning' };
  assert.equal(entryCommand(entries, '/sf-review-source planning', story), 'singularity-flow review-source context planning --for-agent --json');
  assert.equal(entryCommand(entries, '/sf-recover', story), 'singularity-flow recover --fetch --for-agent --json');
  assert.equal(entryCommand(entries, '/sf-decide JRN-1', story), 'singularity-flow decisions JRN-1 --for-agent --json');
  assert.equal(entryCommand(entries, '/sf-phase-documents', story), 'singularity-flow phase show planning --for-agent --json');
  // Every skill a command line routes to is packaged and enters somewhere; only a skill that first picks a subcommand has no single entry.
  const routed = new Set([...Object.values(COMMAND_SKILLS).flat(),
    ...Object.values(COMMAND_LINE_SKILL_ROUTES).flatMap((route) => [route.defaultSkill, ...Object.values(route.subcommands)])].filter(Boolean));
  const without = [...routed].filter((skill) => !entries.get(`/${skill}`)?.entry);
  assert.deepEqual(without.filter((skill) => !entries.get(`/${skill}`)?.choice), [], 'a routed skill with no command to enter by');
});

test('every landing runs the journeys: they are always selected, and the full ones are in the slow lane', async () => {
  const { ALWAYS_SELECTED_TESTS, SLOW_LANE_IMPORT } = await import('../scripts/test-suite-plan.mjs');
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual([...ALWAYS_SELECTED_TESTS].sort(), ['test/journey-routes.test.mjs', 'test/journey-stories.test.mjs', 'test/journey-vscode.test.mjs', 'test/vscode-chat-routes.test.mjs']);
  for (const name of ['journey-stories', 'journey-vscode']) {
    const full = await readFile(new URL(`./${name}.test.mjs`, import.meta.url), 'utf8');
    assert.match(full, SLOW_LANE_IMPORT, `the full journeys (${name}) run with npm run test:slow`);
  }
});

/** A spec-driven Story with every authored step reviewed, its specification approved and planning not yet written. */
async function specStoryAtPlanning(t, W) {
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer' };
    configuration.workTypes['spec-driven-standard'].spec = { ...(configuration.workTypes['spec-driven-standard'].spec ?? {}), coverage: 'record' };
  } });
  startStory(story, W, { workType: 'spec-driven-standard' });
  await story.write(`${story.item}/artifacts/specification/spec.md`, specification(W, 1));
  story.cli('artifact', 'scan', '--phase', 'specification');
  story.cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'specification');
  story.cli('submit', 'specification', '--skip-checks');
  for (const command of scopeAnswers(story, `${W}:AC-001`)) story.cli(...argvOf(command));
  story.cli('approve', 'specification', '--yes');
  return story;
}

// Incident 1 (2026-11-16): `/sf-review-source planning` before planning was written. The refusal routed to generic
// /sf-help, and the agent made up /sf-session; the way on is writing planning, then its review.
test('journey C: a document step reviewed before it is written is routed to writing it', async (t) => {
  const W = 'JRN-C';
  const story = await specStoryAtPlanning(t, W);
  const walk = await followRoutes(story, {
    label: 'journey C',
    start: { copilot: '/sf-review-source planning' },
    agent: { author: specDrivenAuthor(W), review: reviewer() },
    person: cooperativePerson(),
    // Should the route break, the person types the authoring skill themselves, so the rest is still checked.
    detour: ({ finding }) => (finding.step === 1 ? { copilot: '/sf-phase planning' } : null),
    done: ({ record }) => publishedGeneration(record, 'planning') >= 1,
    maxSteps: 12
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the refusal routes to writing the step: no generic help, no dead end', {}, () => {
    assert.deepEqual(walk.findings.filter((entry) => entry.step === 1), [], report(walk));
    assert.match(walk.trail[1]?.ran ?? '', /^singularity-flow phase enter\b/u, `the route enters the authoring skill\n${report(walk)}`);
  });
  await check(t, 'its route leads to the step written and published, with no loop and no stall', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings.filter((entry) => entry.step !== 1), [], report(walk));
  });
  await check(t, 'the step is written through the edit guard, and the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    assert.ok(walk.trail.some((entry) => /through the guard/u.test(entry.did ?? '')), report(walk));
    viewsAgree(walk);
  });
  settle(t);
});

// The short part of every journey: a quick fix from `start` to its first step approved, every route SFlow's own.
test('journey start: a quick fix is started, its intake written, reviewed, submitted and approved by its routes', async (t) => {
  const W = 'JRN-Q';
  const story = await journeyRepository(t);
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  const walk = await followRoutes(story, {
    label: 'the quick fix start',
    start: { shell: `singularity-flow start ${W} --from-branch main --work-type quick-fix --title "Change the value" --description "Return 2."` },
    agent: { author: async ({ story: s, phase }) => phase === 'intake' && (await s.write(`${s.item}/artifacts/intake/intake.md`, quickFixIntake(W)), true), review: reviewer() },
    person: cooperativePerson(),
    done: ({ record }) => record?.phases?.intake?.status === 'approved' || (record && record.currentPhase !== 'intake'),
    maxSteps: 16
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'every step progresses, no route loops or dead-ends, and the intake is approved', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  await check(t, 'the intake was reviewed before it was submitted', {}, () => {
    const reviewed = walk.trail.findIndex((entry) => /reviewer wrote/u.test(entry.did ?? ''));
    const submitted = walk.trail.findIndex((entry) => /--submit-if-ready|\bsubmit intake\b/u.test(entry.ran ?? ''));
    assert.ok(reviewed >= 0 && submitted > reviewed, report(walk));
  });
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => viewsAgree(walk));
  settle(t);
});

// A real /sf-approve turn, 2026-11-22: the person answered "Approve Planning v1", `choices answer` recorded it and returned
// `next: null`, because its filled approve command carries the receipt, which only the private execution check admits; the
// agent then ran a bare `approve`, the guard refused it, and Planning stayed unapproved. Here: the same turn through the
// hooks, its filled command named and allowed, and the step approved by it.
test('journey approve in chat: the person\'s Yes, the filled approve command with its receipt, allowed and run, approves the step', async (t) => {
  const W = 'JRN-AC';
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  const json = (ran) => JSON.parse(ran.stdout.slice(ran.stdout.indexOf('{')));
  const allowed = (said, what) => assert.notEqual(said?.permissionDecision, 'deny', `${what}: ${said?.permissionDecisionReason ?? ''}`);
  const turn = copilotTurn(story, 'journey-approve-chat');
  turn.prompt(`/sf-approve intake --work-id ${W}`);
  const beginArgs = ['choices', 'begin', 'approve', W, '--fetch', '--json', '--review-packet'];
  allowed(turn.tool('bash', { command: `singularity-flow ${beginArgs.join(' ')}` }), 'the review packet');
  const begun = json(story.raw(beginArgs));
  const question = begun.choiceSets?.find((entry) => entry.id === 'phase-confirmation')?.question;
  assert.match(question ?? '', /^Approve .+ v1\?$/u, JSON.stringify(begun.choiceSets));
  turn.tool('ask_user', { message: question, requestedSchema: { properties: { decision: { type: 'string', title: 'Approval decision', enum: ['Approve', 'Not now'] } } } });
  turn.after('ask_user', { message: question }, { resultType: 'success', textResultForLlm: `User responded: ${question.replace(/\?$/u, '')}` });
  const answer = ['choices', 'answer', begun.token, 'phase-confirmation', 'intake', '--json'];
  allowed(turn.tool('bash', { command: `singularity-flow ${answer.join(' ')}` }), 'recording the Yes');
  const answered = json(story.raw(answer));
  await check(t, 'the ready receipt names its filled approve command, receipt and all', {}, () => {
    assert.equal(answered.ready, true);
    assert.equal(answered.next?.command, `singularity-flow approve intake --work-id ${W} --fetch --selection-receipt ${begun.token} --for-agent --json`, JSON.stringify(answered.next));
  });
  await check(t, 'the guard allows that command in the same turn, and it approves the step', {}, () => {
    allowed(turn.tool('bash', { command: answered.next.command }), 'the filled approve command');
    const approved = story.raw(argvOf(answered.next.command));
    assert.equal(approved.status, 0, approved.stdout.slice(-1500) + approved.stderr.slice(-1500));
    assert.equal(storyRecord(story).phases.intake.status, 'approved');
  });
  settle(t);
});

