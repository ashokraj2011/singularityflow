/**
 * Journeys in VS Code's own chat (slow lane) [hardening C, "walk the VS Code path"; owner's Story, 2026-11-20]: real Stories
 * walked by their routes as VS Code's chat takes them (test/helpers/route-follower.mjs, `host: 'vscode'`), with SFlow's page
 * tools running the extension's own page code against the real CLI, and a scripted person on each page
 * (test/helpers/vscode-host.mjs). Before this, /sf-approve and /sf-decide became a terminal `approve --yes` here, so the
 * approval page loop (the tool, the skill text the chat follows after it, and the card's `remaining`, each green on its own)
 * could not be seen.
 *
 *   V1  /sf-approve with only the approval waiting: one #sflowDecide, the approval page on this Story's step and the person's
 *       own @sflow /approve, no second call and no approve route of the chat's; the person approves there, and the Story's
 *       next step is its code step, as every view says.
 *   V1c the walk itself sees the incident: with /sf-decide step 1 as it was at a6b90f18d it reports the loop, and with the
 *       skills as they are it ends at the approval page.
 *   V1b the same, in a window that shows another Story: never "the approval page is open", but the route that selects the
 *       Story here (Singularity Flow: Stories), then the person approves.
 *   V3  a Decide card already open (the Command Palette's) when the chat asks: the chat waits for it and gets the person's
 *       answer there, never "busy" with nothing to follow, and no second card.
 *   V6  a step's next version on the card: Yes hands the chat the work command that opens it; "Not now" is said back as
 *       declined, and the turn asks nothing more.
 *
 * Each walk fails on the same tool, input, status and next coming back on the same Story state, a route VS Code's chat does
 * not have, a route back to the skill that called the tool, an approval page claimed open on another Story, the approval
 * handed back as still open, and an approval packet that hands the approve turn its own approval (2026-11-21). The static checks (every route exists on VS Code, every status has a rule, no two skills send
 * the chat round) are test/vscode-chat-routes.test.mjs. What these journeys do not walk yet is listed there too.
 */
import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { check, cooperativePerson, quickFixIntake, report, settle } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, personViews, skillOf, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { vscodeHost } from './helpers/vscode-host.mjs';

const SKILLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugin/skills');
// Any route that approves, in what VS Code's chat gets back: Copilot's, @sflow's and the terminal's.
const APPROVE_ROUTE = /\/sf-approve|@sflow \/approve|\b(?:singularity-flow|sflow) approve\b/u;

/** A quick fix whose intake is written, reviewed and submitted: only its approval waits. */
async function intakeAwaitingApproval(t, W) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  return story;
}

/** A quick fix whose intake is published and the person asked for a change: its next version waits for their yes. */
async function versionWaiting(t, W) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const ran = story.raw(['phase', 'rollover', 'intake', '--reason', 'Name the callers that read the value.', '--json']);
  assert.equal(JSON.parse(ran.stdout.slice(ran.stdout.indexOf('{'))).toGeneration, 2, ran.stdout.slice(-2000));
  return story;
}

const intakeApproved = ({ record }) => ['approved', 'completed'].includes(record?.phases?.intake?.status);
const decideCalls = (vscode) => vscode.calls.filter((call) => call.name === 'singularityFlow_decide');

// ------------------------------------------------------------------------------------------- V1

test('journey V1: in VS Code, /sf-approve with only the approval waiting opens the approval page once, and the person approves there', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRV-1';
  const story = await intakeAwaitingApproval(t, W);
  const vscode = await vscodeHost(story);
  const walk = await followRoutes(story, { label: 'journey V1', host: 'vscode', vscode, start: { copilot: `/sf-approve intake --work-id ${W}` },
    person: cooperativePerson(), done: intakeApproved, maxSteps: 4 });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the walk reaches the approval by VS Code\'s routes: no loop, no route VS Code lacks, nothing sent back to its caller', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  await check(t, 'exactly one #sflowDecide, answered approval-open with the person\'s own @sflow /approve and no approve route of the chat\'s', {}, () => {
    const calls = decideCalls(vscode);
    assert.equal(calls.length, 1, JSON.stringify(vscode.calls, null, 1));
    assert.deepEqual(calls[0].input, { workId: W });
    assert.equal(calls[0].answer.status, 'approval-open');
    assert.deepEqual(calls[0].answer.next, { kind: 'approve-in-chat', title: 'Approve Scope and plan v1 yourself: type this in the chat box', command: null, copilotCommand: null,
      modelFreeCommand: `@sflow /approve intake --work-id ${W}` });
    assert.doesNotMatch(JSON.stringify({ ...calls[0].answer, next: null }), APPROVE_ROUTE);
    assert.match(calls[0].answer.message, /^The approval page is open for Scope and plan v1 with its documents\./u);
  });
  await check(t, 'the approval page opened on this Story\'s step, which this window shows', {}, () => {
    assert.deepEqual(vscode.approvals.map((page) => [page.focus, page.shown.status]), [[{ workId: W, phase: 'intake' }, 'here']]);
    assert.doesNotMatch(vscode.approvals[0].html, /not the Story checked out in this window/u);
  });
  await check(t, 'once approved there, the Story\'s next step is its code step, and every view says so', {}, async () => {
    assert.equal(intakeApproved({ record: storyRecord(story) }), true);
    const next = skillOf(walk.next?.copilot);
    assert.match(next ?? '', /^\/sf-(?:code|phase)$/u, report(walk));
    for (const view of await personViews(story)) if (view.skill) assert.equal(view.skill === next || ['/sf-code', '/sf-phase'].includes(view.skill), true, `${view.view}: ${view.skill}`);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- V1c

test('journey V1c: the VS Code walk sees the 2026-11-20 loop the skill text made, and none with the skills as they are', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRV-4';
  const story = await intakeAwaitingApproval(t, W);
  // /sf-decide step 1 as it was at a6b90f18d: the list read ran after the card whatever it answered.
  const before = path.join(story.base, 'skills-at-a6b90f18d');
  await cp(path.join(SKILLS, 'sflow-decide'), path.join(before, 'sflow-decide'), { recursive: true });
  const file = path.join(before, 'sflow-decide', 'SKILL.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Then, unless it returned `approval-*`, run', 'Then run'));
  const vscode = await vscodeHost(story);
  const looped = await followRoutes(story, { label: 'journey V1c before', host: 'vscode', vscode, skillsRoot: before, start: { copilot: `/sf-decide ${W}` },
    person: cooperativePerson(), done: intakeApproved, maxSteps: 4 });
  t.diagnostic(formatTrail(looped.trail));
  await check(t, 'with the old step 1, the chat calls #sflowDecide again on the same state, by /sf-approve, and the walk says so', {}, () => {
    assert.deepEqual(looped.findings.map((entry) => entry.kind), ['vscode-loop'], report(looped));
    assert.match(looped.trail[0].did, /\[tool singularityFlow_decide \{"workId":"JRV-4"\}\] → approval-open; decisions JRV-4; do \/sf-approve 1-6 now; choices begin approve JRV-4 .*\[tool singularityFlow_decide \{"workId":"JRV-4"\}\] → approval-open/u, report(looped));
    assert.equal(intakeApproved({ record: storyRecord(story) }), false);
  });
  const walk = await followRoutes(story, { label: 'journey V1c', host: 'vscode', vscode, start: { copilot: `/sf-decide ${W}` },
    person: cooperativePerson(), done: intakeApproved, maxSteps: 4 });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'with the skills as they are, /sf-decide ends at the approval page, and the person approves there', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
    assert.doesNotMatch(walk.trail[0].did, /do \/sf-approve 1-6 now/u, report(walk));
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- V1b

test('journey V1b: in a VS Code window that shows another Story, the chat is never told the approval page is open, but how to select the Story', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRV-2';
  const story = await intakeAwaitingApproval(t, W);
  const vscode = await vscodeHost(story, { windowStory: 'OTHER-9' });
  const walk = await followRoutes(story, { label: 'journey V1b', host: 'vscode', vscode, start: { copilot: `/sf-approve intake --work-id ${W}` },
    person: cooperativePerson(), done: intakeApproved, maxSteps: 4 });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the walk reaches the approval: the person selects the Story by the route given, then approves', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
    assert.match(walk.trail[0].did, /the person selects JRV-2 in this window \(Command Palette: Singularity Flow: Stories\)/u, report(walk));
  });
  await check(t, 'the card says approval-elsewhere, names the window\'s Story, and hands the Stories route, never "the approval page is open"', {}, () => {
    const [call] = decideCalls(vscode);
    assert.equal(call.answer.status, 'approval-elsewhere');
    assert.doesNotMatch(call.answer.message, /The approval page is open/u);
    assert.match(call.answer.message, /this VS Code window shows OTHER-9\. The person selects JRV-2 here/u);
    assert.deepEqual(call.answer.next, { kind: 'select-story', title: 'Show JRV-2 in this VS Code window', command: null, copilotCommand: null,
      modelFreeCommand: 'Command Palette: Singularity Flow: Stories' });
    assert.doesNotMatch(JSON.stringify(call.answer), APPROVE_ROUTE);
  });
  await check(t, 'the approval page says so too, with its button to select the Story', {}, () => {
    assert.equal(vscode.approvals[0].shown.status, 'elsewhere');
    assert.match(vscode.approvals[0].html, /JRV-2 is not the Story checked out in this window \(OTHER-9 is\): select it here to approve it\. <button class="secondary" data-show-story>Open Stories<\/button>/u);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- V3

test('journey V3: a Decide card already open when VS Code\'s chat asks: the chat waits for it and gets the person\'s answer, never "busy"', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRV-3';
  const story = await versionWaiting(t, W);
  const vscode = await vscodeHost(story, { person: { decide: () => 'version-no' } });
  // The person opened the card from the Command Palette, and has not answered it yet.
  const palette = vscode.command('singularityFlow.decide');
  for (let waited = 0; waited < 20_000 && !vscode.panels.some((panel) => panel.viewType === 'singularityFlow.decide'); waited += 25) await new Promise((resolve) => setTimeout(resolve, 25));
  const walk = await followRoutes(story, { label: 'journey V3', host: 'vscode', vscode, start: { copilot: `/sf-decide ${W}` },
    person: cooperativePerson(), done: ({ trail }) => trail.length >= 1, maxSteps: 2 });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'one card only: the chat\'s ask joined the open one', {}, async () => {
    assert.deepEqual(walk.findings, [], report(walk));
    assert.equal(vscode.panels.filter((panel) => panel.viewType === 'singularityFlow.decide').length, 1);
    const [call] = decideCalls(vscode);
    assert.notEqual(call.answer.status, 'busy');
    assert.equal(call.answer.status, 'cancelled');
    assert.match(call.answer.message, /^The Decide card for JRV-3 was already open; this is what the person did there\. Version 2 of intake was not started\./u);
    assert.equal((await palette).status, 'cancelled', 'the Command Palette\'s card got the same answer');
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- V6

test('journey V6: a next version on the card in VS Code: Yes hands back the work command; "Not now" is declined and not asked again in the turn', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRV-6';
  const story = await versionWaiting(t, W);
  const vscode = await vscodeHost(story, { person: { decide: () => 'version-no' } });
  const declined = await followRoutes(story, { label: 'journey V6 not now', host: 'vscode', vscode, start: { copilot: `/sf-decide ${W}` },
    person: cooperativePerson(), done: ({ trail }) => trail.length >= 1, maxSteps: 2 });
  t.diagnostic(formatTrail(declined.trail));
  await check(t, '"Not now": declined, said back so, and the turn\'s own read asks nothing more', {}, () => {
    assert.deepEqual(declined.findings, [], report(declined));
    const [call] = decideCalls(vscode);
    assert.equal(call.answer.status, 'cancelled');
    assert.equal(call.answer.declined, 'version-opening');
    assert.match(call.answer.message, /The person chose Not now: do not ask it again in this chat\.$/u);
    const act = declined.last?.act ?? null;
    assert.ok(!act?.ask, `the turn's read asks the person again: ${JSON.stringify(act)}`);
  });
  vscode.person = { decide: () => 'version-yes' };
  const accepted = await followRoutes(story, { label: 'journey V6 yes', host: 'vscode', vscode, start: { copilot: `/sf-decide ${W}` },
    person: cooperativePerson(), done: ({ trail }) => trail.length >= 1, maxSteps: 2 });
  t.diagnostic(formatTrail(accepted.trail));
  await check(t, 'Yes: kept, and the chat is handed the work command that opens it, a route VS Code\'s chat has', {}, () => {
    assert.deepEqual(accepted.findings, [], report(accepted));
    const call = decideCalls(vscode).at(-1);
    assert.equal(call.answer.status, 'recorded');
    assert.deepEqual(call.answer.recorded, ['version-opening']);
    assert.match(call.answer.next?.skill ?? call.answer.next?.copilotCommand ?? '', /^\/sf-(?:phase|code)\b/u, JSON.stringify(call.answer));
  });
  settle(t);
});
