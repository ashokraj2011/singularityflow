/**
 * Journey tests, full tier (slow lane) [owner, 2026-11-16]: whole Stories driven by their own routes, as an agent and a
 * person take them (test/helpers/route-follower.mjs), each reproducing an incident of 2026-11-16 as a check. The fast
 * tier (journey C, the quick fix's first step, the skill entry map) is test/journey-routes.test.mjs.
 *
 *   A  a spec-driven Story from its start to its release, every step reviewed;
 *   B  a code review asks for corrections three times: versions 2 and 3 start on their own (only the reviewer saw each),
 *      the third in a row is the person's "Start version 4?", and version 4 is re-reviewed, submitted in the author's turn
 *      (which then ends) and approved (owner, 2026-11-19);
 *   D  a required test would fail for an environment reason (the wrong Node): SFlow runs it on the installed Node the
 *      package accepts, settled with an undo, and the step publishes (owner, 2026-11-19, ceremony cut 5; before, the card's pin);
 *   E  a person answers after the 30-minute turn window (the Node pin, once they undid SFlow's settled Node): the turn renews;
 *   F  a code step a person sends back opens version 2 on that send-back, nothing asked; its review asks corrections of
 *      a version only the reviewer saw, version 3 starts on its own, and it goes on to its submission (ask once, owner
 *      2026-11-28; before, "Start version 2?" and "Start version 3?") [OSA:AC-013];
 *   G  version 2 open on a step with no review: submit refuses with the route to write it, which is then followed
 *      [OSA:REQ-032, AC-013];
 *   I  a document step's review asks corrections of a version only its reviewer saw: version 2 starts on its own, settled
 *      for the person, as for code (owner, 2026-11-19, ceremony cut 10; the asked path is F's);
 *   K  a change typed after /sf-code once the code is published, without the step's name and with it: the entry, its edit
 *      permission, the kernel and the guard all ask "Start version N?", and the routes write and publish the change.
 *   L  a change typed after the code is published while its review is still owed: the person says No to "Start version
 *      2?", and /sf-submit goes on by that review to the submission, never the question again (review 2026-11-17, kernel #8).
 *   R  a quick design whose published code still owes the account of what the person typed, and a change typed after it:
 *      the person says No, and /sf-submit names that account, never a submission the engine refuses (review, kernel #10).
 *   Q  a quick design (daily run, 2026-11-17): a change typed twice is one instruction; published without its account,
 *      every view leads with that account, and the code step nobody approves completes once it is made; the code step is
 *      offered to /sf-code, never as a generated publish; once closed, the Story says it is done.
 *   T  a test step that changes no code runs its check and it fails: SFlow returns it to the code step and starts its next
 *      version on its own, settled with an undo; once the fix is approved the test step runs again on its own and passes,
 *      and nobody is asked to start a version (owner, 2026-11-20, D1);
 *   U  the same check fails again after SFlow's fix: SFlow stops, and the approval gives the person filled choices; their
 *      return starts the code step's next version at once, and the fix then passes the test step run again (D1's brake).
 *   V  a feature Story from its start to its close, as shipped, as `workflow walk` walks it: a person approves the plan and
 *      the code, and SFlow the rest, its verification included (owner, 2026-11-20, D1, adopted in step intents Stage 7);
 *   W  a spec-driven Story whose code misses the test its plan names for a requirement: the code approval already shows
 *      the gap, the convergence check does not approve itself, the person sends it back to the code step, the next
 *      version delivers it, and SFlow approves the clean check (owner, 2026-11-21: convergence folds into the code approval).
 *   X  a quick design's Implement, which nobody approves, completes in its own turn; the person's change typed after it
 *      (with and without the step's name, or in their own terminal) asks "Start version 2 of Implement for this change?",
 *      and one yes goes back to Implement, makes the change there and runs Verify again (daily run, 2026-11-22).
 *
 * Journeys A and V also count the person's approvals on the clean path: the plan and the code, nothing else (with the
 * intake's answers and the scope decisions, which are answers, not approvals).
 *
 * Every walk writes through the real edit guard and reads the person's views at each hand-off (route-follower.mjs).
 *
 * A check that fails on main until its fix branch lands is reported as todo with that branch (KNOWN_BAD in
 * test/helpers/journey-scripts.mjs) and counts once the branch lands.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { accountForAskedFor, check, clarifications, cooperativePerson, decideCard, quickFixIntake, report, reviewer, scopeAnswers, settle, specDrivenAuthor, viewsAgree, writeValueCode } from './helpers/journey-scripts.mjs';
import { argvOf, CLI, copilotTurn, entryCommand, followRoutes, formatTrail, journeyRepository, personViews, publishedGeneration, returnedRoute, skillEntries, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { packagedWorkflowWithoutIntents } from '../src/workspace-configuration-refresh.mjs';

const posix = process.platform === 'win32' ? { skip: 'the fake Nodes are shell scripts' } : {};

/** A quick fix whose intake is approved and whose code step is next, every step reviewed (the shipped default). */
async function quickFixAtCode(t, W, options = {}) {
  const story = await journeyRepository(t, options);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  return story;
}

const approved = (record, phase) => ['approved', 'completed'].includes(record?.phases?.[phase]?.status);

/**
 * The spec-versus-code check the code step's approval carries while it waits (approval evidence `convergence`, read as the
 * decisions list gives it to an approval page), once per code version: convergence folds into the code approval.
 */
function codeApprovalCheck(story, seen) {
  const record = storyRecord(story);
  const code = record?.phases?.implementation;
  if (record?.currentPhase !== 'implementation' || code?.status !== 'awaiting_approval' || seen.has(code.generation)) return;
  const listed = JSON.parse(story.cli('decisions', story.workId, '--json'));
  seen.set(code.generation, listed?.data?.approvalEvidence?.convergence ?? null);
}

/** Who approved each step of a closed Story, in its order: the steps a person approved, and those SFlow approved itself. */
function approvers(record) {
  const order = record?.phaseOrder ?? [];
  return {
    people: order.filter((id) => (record.phases[id]?.approvals ?? []).some((entry) => entry?.decision === 'approved')),
    sflow: order.filter((id) => record.phases[id]?.approvalDisposition === 'approved_automatically')
  };
}

// ------------------------------------------------------------------------------------------- A

test('journey A: a spec-driven Story from its start to its release, every step written, reviewed and approved by its routes', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-A';
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer' };
    configuration.workTypes['spec-driven-standard'].spec = { ...(configuration.workTypes['spec-driven-standard'].spec ?? {}), coverage: 'record' };
  } });
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  const checks = new Map();
  const person = cooperativePerson(({ route }) => {
    codeApprovalCheck(story, checks);
    // The scope the specification defines: each statement of the Story's sources, included through its first clause,
    // by the scope decision the approval's refusal names; then the person approves again.
    if (/^\/sf-decide\b/u.test(route.copilot ?? '') || /^singularity-flow decisions\b/u.test(route.shell ?? '')) {
      const scope = scopeAnswers(story, `${W}:AC-001`);
      if (scope.length) return { commands: scope, then: { copilot: '/sf-approve', person: true } };
      const card = decideCard(story);
      if (card) return { command: card.command };
    }
    return null;
  });
  const walk = await followRoutes(story, {
    label: 'journey A',
    start: { shell: `singularity-flow start ${W} --from-branch main --work-type spec-driven-standard --title "Validate a value" --description "Return an approved value."` },
    agent: { author: specDrivenAuthor(W), review: reviewer(), clarify: clarifications() },
    person,
    done: ({ record }) => record?.status === 'closed',
    maxSteps: 140
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the Story reaches its end by its routes alone: every step progresses, nothing loops or dead-ends', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  // Approve twice with ceremony turns (landing-6): the specification, which SFlow approves when ready, completes at its
  // in-turn submission. That turn ends there, and the next step is typed in a new turn, never written in it.
  await check(t, 'a submission SFlow approved automatically ends the author\'s turn, and the next step starts in a new turn', {}, () => {
    const ended = walk.trail.findIndex((entry) => entry.act === 'end-turn' && /--submit-if-ready/u.test(entry.ran ?? ''));
    assert.ok(ended >= 0, report(walk));
    assert.equal(walk.trail[ended + 1]?.typed, true, report(walk));
  });
  await check(t, 'every authored step was reviewed before it was submitted', {}, () => {
    const record = storyRecord(story);
    const reviewed = new Set(walk.trail.filter((entry) => /reviewer wrote/u.test(entry.did ?? '')).map((entry) => entry.state.split(':')[1]));
    for (const phase of ['specification', 'planning', 'implementation', 'verification', 'release']) {
      assert.ok(reviewed.has(phase), `${phase} was not reviewed: ${[...reviewed]}\n${report(walk)}`);
      assert.ok(publishedGeneration(record, phase) >= 1, phase);
    }
  });
  // A kernel-built step is published by its own work command, never handed to /sf-publish (Stage 3, C9).
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => viewsAgree(walk));
  await check(t, 'no hand-off names /sf-publish for a kernel-built step\'s publication', {}, () => {
    assert.equal(walk.trail.some((entry) => /^\/sf-publish\b/u.test(entry.taking ?? '')), false, report(walk));
  });
  // Stage 7 (owner, 2026-11-20 and 2026-11-21): verification changes no source code, and convergence folds into the code
  // approval. A person approves the plan and the code; SFlow approves the rest, convergence's clean check included.
  await check(t, 'a person approved exactly the plan and the code; SFlow approved every other step, convergence included', {}, () => {
    const record = storyRecord(story);
    assert.deepEqual(approvers(record), { people: ['planning', 'implementation'], sflow: ['specification', 'convergence', 'verification', 'release'] }, report(walk));
    assert.match(record.phases.convergence.automaticApproval.checked.join('; '), /the convergence check found every requirement delivered/u);
    assert.equal(record.phases.convergence.automaticApproval.convergence.requirements, 2, JSON.stringify(record.phases.convergence.automaticApproval));
  });
  await check(t, 'the code approval carried the spec-versus-code check: both requirements delivered, nothing to decide', {}, () => {
    const section = checks.get(1);
    assert.equal(section?.clean, true, JSON.stringify(section));
    assert.deepEqual(section.requirements.map((entry) => entry.status), ['delivered', 'delivered'], JSON.stringify(section));
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- B

// Incidents 3, 4 and 5 (2026-11-16): a code review returned correction-required with the continuation /sf-recover,
// which runs `recover --fetch`, finds nothing and never runs the rollover; after the rollover every entry was held
// (SOURCE_REVIEW_RECORD_UNPUBLISHED, fixed in e1574fa2d), and recovery then routed the code step to /sf-phase-documents;
// and a reviewer's reply dropped its next step.
test('journey B: a code review asks for corrections three times: versions 2 and 3 start on their own, the person is asked for 4, and it is submitted and approved by the routes', slowLane({ timeout: 2_400_000 }), async (t) => {
  const W = 'JRN-B';
  const story = await quickFixAtCode(t, W);
  const clauses = [`${W}:AC-001`];
  // A different blocking finding on each of versions 1 to 3, so no finding comes back after a fix (that asks at once).
  const ROUNDS = { 1: ['explain-the-value', 'The clause comment must say why the value is 2, as the plan row says.'],
    2: ['name-the-caller', 'The clause comment must name who reads the value.'], 3: ['cite-the-intake', 'The clause comment must cite the intake it comes from.'] };
  const blocking = (phase, packet) => (packet.kind === 'code' && ROUNDS[packet.generation] ? [(() => {
    const code = packet.sources.find((source) => source.path === 'src/value.mjs');
    const line = code.text.split('\n').findIndex((text) => text.includes(`@clause:${W}:AC-001`)) + 1;
    const [id, message] = ROUNDS[packet.generation];
    return { id, severity: 'blocking', check: 'plan', clauseId: `${W}:AC-001`, message, sourceId: code.id, line, quote: `// @clause:${W}:AC-001` };
  })()] : []);
  const writing = (s) => Number(storyRecord(s)?.phases?.implement?.generationIntent?.generation ?? 0);
  const author = async ({ story: s, phase, generation }) => {
    if (phase !== 'implement') return false;
    const version = Math.max(Number(generation ?? 0), writing(s));
    await writeValueCode(s, { value: 2, clauses, note: version >= 2
      ? `returns 2, the value the intake approves for every caller${version > 2 ? ` (version ${version})` : ''}` : 'returns the approved value' });
    return true;
  };
  const opened = ({ record }) => Number(record?.phases?.implement?.generationIntent?.generation ?? 0) >= 2 && record.phases.implement.generationIntent.status === 'open';
  // Should the continuation break, the person types its Shell line at their terminal, so the rest is still checked.
  const detour = ({ finding, result }) => {
    if (opened({ record: storyRecord(story) })) return null;
    const continuation = result?.continuation?.actions?.find((entry) => /phase rollover/u.test(entry.command ?? '')) ?? null;
    return ['skill-skips-route', 'no-progress', 'dead-end', 'loop'].includes(finding.kind)
      ? { shell: continuation?.command ?? 'singularity-flow phase rollover implement --json' } : null;
  };
  const first = await followRoutes(story, {
    label: 'journey B, to version 2', start: { copilot: '/sf-next' },
    agent: { author, review: reviewer({ findings: blocking }) }, person: cooperativePerson(), detour,
    done: opened, maxSteps: 30
  });
  t.diagnostic(formatTrail(first.trail));
  const reviewAt = first.trail.findIndex((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? ''));
  // What the known-bad checks below stand on: the review asked for corrections, by the routes.
  assert.ok(reviewAt > 0, `the code review never asked for corrections\n${report(first)}`);

  await check(t, 'version 1 is written, published and reviewed through /sf-code\'s routes', {}, () => {
    assert.ok(reviewAt > 0, report(first));
    assert.deepEqual(first.findings.filter((entry) => entry.step <= reviewAt + 1), [], report(first));
  });
  // Incident 5: the reviewer ends its turn on what the retained review returned; a route alone was dropped from its reply.
  await check(t, 'the reviewer\'s reply carries the next step: a route, and the words to relay', {}, () => {
    const { act, continuation } = first.trail[reviewAt].retained;
    assert.ok(returnedRoute({ act, continuation }), JSON.stringify({ act, continuation }).slice(0, 2000));
    assert.match(String(act?.show ?? ''), /- Copilot: `?\/sf-/u, `the reply's next step to show: ${JSON.stringify(act ?? null).slice(0, 1500)}`);
  });
  await check(t, 'the correction\'s continuation opens version 2 by its routes, with no detour', {}, () => {
    assert.equal(first.reached, true, report(first));
    assert.deepEqual(first.findings, [], report(first));
  });
  assert.equal(first.reached, true, `version 2 was never opened, even with the detour\n${report(first)}`);
  // Only the reviewer had seen version 1: version 2 starts on its own in the author's turn, settled with an undo on the
  // decisions card, and nobody is asked "Start version 2?" (owner, 2026-11-19, ceremony cut 10).
  await check(t, 'only the reviewer had seen version 1, so version 2 started on its own, settled with an undo', {}, () => {
    const record = storyRecord(story);
    assert.equal(record.phases.implement.versionOpening?.consent?.surface, 'settled', JSON.stringify(record.phases.implement.versionOpening ?? null));
    assert.ok((record.settledDecisions ?? []).some((entry) => entry.kind === 'review-corrections' && entry.phase === 'implement'), JSON.stringify(record.settledDecisions ?? null));
    assert.ok(first.trail.some((entry) => /--review-findings/u.test(entry.ran ?? '')), report(first));
    assert.ok(!first.trail.some((entry) => /Start version 2/u.test(entry.did ?? '')), report(first));
  });

  // Incident 4: the entry to version 2 is held by nothing (fixed in e1574fa2d), and recovery right after the
  // rollover sends the code step to its author, never to a view of its documents.
  const entries = skillEntries();
  const at = { workId: W, phases: storyRecord(story).phaseOrder, currentPhase: 'implement' };
  await check(t, 'after the rollover, /sf-code\'s entry is admitted, not held', {}, () => {
    const entry = JSON.parse(story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']).stdout);
    assert.doesNotMatch(JSON.stringify(entry), /SOURCE_REVIEW_RECORD_UNPUBLISHED/u, JSON.stringify(entry).slice(0, 2000));
    assert.notEqual(entry.act?.state, 'attention-required', JSON.stringify(entry.act));
  });
  await check(t, 'after the rollover, /sf-recover routes the code step to its author, never /sf-phase-documents', {}, () => {
    const command = entryCommand(entries, '/sf-recover', at);
    const recovered = JSON.parse(story.raw([...command.replace(/^singularity-flow /u, '').split(' ')]).stdout);
    const routes = [returnedRoute(recovered), ...(recovered.actions ?? []).map((action) => ({ copilot: action.skill ?? action.copilotCommand ?? null, shell: action.command ?? null }))].filter(Boolean);
    assert.doesNotMatch(JSON.stringify(routes), /\/sf-phase-documents/u, JSON.stringify(routes));
    assert.ok(routes.some((route) => /^\/sf-code\b/u.test(route.copilot ?? '')), `no route to the code author: ${JSON.stringify(routes)}`);
  });

  // Version 2's review asks again, for another finding: version 3 starts on its own too, the second in a row. A walk stopped
  // inside the author's turn (the entry it reads next) goes on as that turn does: /sf-code again, never a bare command.
  const resume = (walk) => (walk.next && !walk.next.inTurn && walk.next.copilot ? walk.next : { copilot: '/sf-code implement' });
  const opens = (version) => ({ record }) => Number(record?.phases?.implement?.generationIntent?.generation ?? 0) >= version
    && record.phases.implement.generationIntent.status === 'open';
  const second = await followRoutes(story, {
    label: 'journey B, version 2 to version 3', start: resume(first),
    agent: { author, review: reviewer({ findings: blocking }) }, person: cooperativePerson(), done: opens(3), maxSteps: 24
  });
  t.diagnostic(formatTrail(second.trail));
  const starts = () => (storyRecord(story).settledDecisions ?? []).filter((entry) => entry.kind === 'review-corrections' && entry.phase === 'implement');
  await check(t, 'version 2 is fixed and re-reviewed; its corrections start version 3 on their own, the second in a row', {}, () => {
    assert.equal(second.reached, true, report(second));
    assert.deepEqual(second.findings, [], report(second));
    assert.deepEqual(starts().map((entry) => [entry.effect?.generation, entry.effect?.toGeneration]), [[1, 2], [2, 3]]);
    assert.equal(storyRecord(story).phases.implement.versionOpening?.consent?.surface, 'settled');
    assert.ok(!second.trail.some((entry) => entry.act === 'confirm'), report(second));
  });

  // Version 3's review asks a third time: SFlow stops starting versions and asks the person, saying why (owner, 2026-11-19).
  const questions = [];
  const third = await followRoutes(story, {
    label: 'journey B, version 3: the person is asked for version 4', start: resume(second),
    agent: { author, review: reviewer({ findings: blocking }) }, done: opens(4), maxSteps: 24,
    // What the person was told when asked; then the cooperative yes.
    person: cooperativePerson(({ act }) => { if (act?.state === 'confirm') questions.push(act); return null; })
  });
  t.diagnostic(formatTrail(third.trail));
  await check(t, 'the third correction in a row is the person\'s question, with its reason; their yes opens version 4', {}, () => {
    assert.equal(third.reached, true, report(third));
    assert.deepEqual(third.findings, [], report(third));
    const corrections = third.trail.findIndex((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? ''));
    const asked = third.trail.findIndex((entry, index) => index > corrections && entry.act === 'confirm');
    assert.ok(corrections > 0 && asked > corrections, report(third));
    assert.ok(!third.trail.some((entry) => /--review-findings/u.test(entry.ran ?? '')) || third.trail.some((entry) => entry.code === 'VERSION_REVIEW_FINDINGS_ASK'), report(third));
    assert.equal(starts().length, 2, 'no third start on its own');
    assert.ok(storyRecord(story).phases.implement.versionOpening?.consent?.receiptId, JSON.stringify(storyRecord(story).phases.implement.versionOpening ?? null));
  });
  await check(t, 'the question says the reviewer asked for corrections 3 times in a row', {}, () => {
    const asked = questions.find((act) => /Start version 4\b/u.test(act.ask?.question ?? ''));
    assert.ok(asked, JSON.stringify(questions).slice(0, 2000));
    assert.match(asked.said, /^The reviewer has asked for corrections 3 times in a row\./u);
    // The hold is the question's why, said first, with what each answer does (ask once, owner 2026-11-28).
    assert.equal(asked.ask.why, 'The reviewer has asked for corrections 3 times in a row.');
    assert.match(asked.ask.how, /^Say ask\.why first, as one line, and each choice with its does\./u);
  });

  // Version 4: fixed, re-reviewed ready and submitted in the author's turn, which then ends: the code step completes (a
  // quick fix's code step has no approver), and the next step is the person's to start, never this turn's [decision 7].
  const fourth = await followRoutes(story, {
    label: 'journey B, version 4 to its submission', start: third.next ?? { copilot: '/sf-code implement' },
    agent: { author, review: reviewer({ findings: blocking }) }, person: cooperativePerson(),
    done: ({ record }) => record?.currentPhase !== 'implement', maxSteps: 20
  });
  t.diagnostic(formatTrail(fourth.trail));
  await check(t, 'version 4 is fixed, published, re-reviewed ready and submitted by its routes', {}, () => {
    assert.equal(fourth.reached, true, report(fourth));
    assert.deepEqual(fourth.findings, [], report(fourth));
    assert.equal(storyRecord(story).phases.implement.generation, 4);
    assert.ok(fourth.trail.some((entry) => /reviewer wrote.*ready/u.test(entry.did ?? '')), report(fourth));
  });
  await check(t, 'the submission that completes the code step ends the author\'s turn and names the next step for a new one', {}, () => {
    const submitted = fourth.trail.findLast((entry) => /--submit-if-ready/u.test(entry.ran ?? ''));
    assert.ok(submitted, report(fourth));
    assert.equal(submitted.act, 'end-turn', report(fourth));
    assert.ok(!/^singularity-flow (?:prepare|phase begin) verify\b/u.test(fourth.trail.at(-1)?.ran ?? ''), report(fourth));
  });

  // On to the Story's end: Verify is built by the kernel and approved by its group. Should its route break, the person
  // types the Shell line of the route they were given, so the approval is still checked.
  const last = await followRoutes(story, {
    label: 'journey B, Verify to the end', start: fourth.next ?? { copilot: '/sf-next' },
    agent: { author, review: reviewer() }, person: cooperativePerson(),
    detour: ({ finding, route }) => (['no-progress', 'dead-end', 'skill-skips-route'].includes(finding.kind) && route.shell
      ? { shell: route.shell } : null),
    done: ({ record }) => record?.status === 'closed', maxSteps: 30
  });
  t.diagnostic(formatTrail(last.trail));
  await check(t, 'after the code step, the Story is approved to its end by its routes, with no detour', {}, () => {
    assert.equal(last.reached, true, report(last));
    assert.deepEqual(last.findings, [], report(last));
  });
  assert.equal(last.reached, true, `the Story never reached its end, even with the detour\n${report(last)}`);
  assert.ok(approved(storyRecord(story), 'verify'), JSON.stringify(storyRecord(story).phases.verify?.status));
  // Verify, built by the kernel, is published by its own work command (Stage 3, C9), as in A.
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    for (const walk of [first, second, third, fourth, last]) viewsAgree(walk);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- D

async function fakeNode(directory, version) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'node');
  await writeFile(file, `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nFAKE_NODE=${version} exec '${process.execPath}' "$@"\n`);
  await chmod(file, 0o755);
  return directory;
}

/** A quick fix at its code step whose test passes only on Node 22: this machine runs 26, .nvmrc asks for 18, nvm has 22. */
async function wrongNodeStory(t, W) {
  const story = await quickFixAtCode(t, W, { files: {
    'package.json': JSON.stringify({ type: 'module', private: true, engines: { node: '>=20 <25' }, scripts: { test: 'node --test' } }), '.nvmrc': '18\n' } });
  await fakeNode(path.join(story.home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), '22.14.0');
  const bin = await fakeNode(path.join(story.base, 'bin'), '26.1.0');
  Object.assign(story.env, { NVM_DIR: path.join(story.home, '.nvm'), PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  return story;
}

const nodeTest = "\ntest('runs on the Node the package asks for', () => assert.equal(process.env.FAKE_NODE, '22.14.0'));";

// Ceremony cut 5 (code-env, owner 2026-11-19): a .nvmrc naming a Node not installed here, with an installed one the package
// accepts, is SFlow's to settle. This Story's tests run on Node 22, settled with an undo on the decisions card, .nvmrc stays,
// and nobody is asked. Before it, the test failed on the wrong Node and the person pinned 22 on the card (test/node-pin-flow).
test('journey D: a required test would fail on the wrong Node; SFlow runs it on the installed Node the package accepts, and the step publishes', { ...posix, ...slowLane({ timeout: 1_200_000 }) }, async (t) => {
  const W = 'JRN-D';
  const story = await wrongNodeStory(t, W);
  let asked = null;
  const person = cooperativePerson(({ route }) => {
    if (/^\/sf-decide\b/u.test(route.copilot ?? '') || /^singularity-flow decisions\b/u.test(route.shell ?? '')) asked = route;
    return null;
  });
  const walk = await followRoutes(story, {
    label: 'journey D', start: { copilot: '/sf-code' },
    agent: { author: async ({ story: s, phase }) => phase === 'implement' && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], extraTest: nodeTest }), true), review: reviewer() },
    person, done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 20
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the required test never fails on the wrong Node, and nobody is asked which Node', {}, () => {
    assert.equal(walk.trail.some((entry) => entry.code === 'CODE_TEST_FAILED'), false, report(walk));
    assert.equal(asked, null, `the person was routed to the card: ${JSON.stringify(asked)}\n${report(walk)}`);
  });
  await check(t, 'the Node is settled for the person with an undo, and .nvmrc still names 18', {}, async () => {
    const listed = JSON.parse(story.cli('decisions', W, '--json')).data;
    assert.ok((listed.settled ?? []).some((entry) => entry.details?.settledKind === 'node-version'), JSON.stringify(listed.settled ?? []));
    assert.equal((listed.items ?? []).some((item) => item.kind === 'node-pin'), false, JSON.stringify((listed.items ?? []).map((item) => item.kind)));
    assert.equal(await readFile(path.join(story.root, '.nvmrc'), 'utf8'), '18\n');
  });
  await check(t, 'the step publishes on the settled Node by its routes: no loop, no stall, no dead end', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => viewsAgree(walk));
  settle(t);
});

// ------------------------------------------------------------------------------------------- E

// Incident 2 (2026-11-16): /sf-code opened the decisions card at 09:24; the person confirmed it at 09:57, 34 minutes
// into the turn, and the agent's next edit was denied: the turn's permissions ran 30 minutes from its prompt.
test('journey E: the person answers the card after the 30-minute turn window, and the turn that asked goes on', { ...posix, ...slowLane({ timeout: 900_000 }) }, async (t) => {
  const W = 'JRN-E';
  const story = await wrongNodeStory(t, W);
  // The code step reaches the card. Since ceremony cut 5 (code-env, owner 2026-11-19) SFlow settles the Node itself when the
  // version opens (journey D), so the person undoes that in their own terminal and the Node pin is theirs on the card again.
  const settledNode = (s) => (JSON.parse(s.cli('decisions', W, '--json')).data.settled ?? []).find((entry) => entry.details?.settledKind === 'node-version') ?? null;
  const walk = await followRoutes(story, {
    label: 'journey E, to the open version', start: { copilot: '/sf-code' },
    agent: { author: async ({ story: s, phase }) => phase === 'implement' && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], extraTest: nodeTest }), true), review: reviewer() },
    person: () => null, done: ({ story: s }) => settledNode(s) !== null, maxSteps: 8
  });
  assert.equal(walk.reached, true, report(walk));
  const undone = story.raw(['decisions', 'undo', W, '--settled', settledNode(story).details.settledId, '--json']);
  assert.equal(undone.status, 0, undone.stdout.slice(-2000));
  const edit = { path: path.join(story.root, 'src/value.mjs') };

  // The turn as Copilot's hooks see it: its prompt, the card it opens, the person's answer 34 minutes in, the next edit.
  const turn = copilotTurn(story, 'journey-e-code-turn');
  turn.prompt('/sf-code');
  await check(t, 'inside its window, the turn may edit the step\'s code', {}, () => {
    const allowed = turn.tool('edit', edit);
    assert.notEqual(allowed.permissionDecision, 'deny', JSON.stringify(allowed));
  });
  assert.notEqual(turn.tool('sflow_decide', { workId: W }).permissionDecision, 'deny', 'the turn opens the decisions card');
  assert.ok(turn.age(34).length >= 1, 'the turn record was aged');
  await check(t, 'past its window with no answer, the turn\'s edit is denied and says why', {}, () => {
    const denied = turn.tool('edit', edit);
    assert.equal(denied.permissionDecision, 'deny', JSON.stringify(denied));
    assert.match(denied.permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: /u);
  });
  // The person answers on the card the turn opened: the pin, recorded by the card's own command (decisions record
  // --answers, which no chat may run), 34 minutes after the turn's prompt.
  const card = decideCard(story, { reason: 'Node 18 is not installed here and the package asks for 20 or later.',
    choose: (item) => (item.kind === 'node-pin' ? item.options.find((option) => option.id === 'pin-node') : null) });
  assert.ok(card, 'the card has the pin to answer');
  const answers = path.join(story.base, 'card-answers.json');
  await writeFile(answers, JSON.stringify(card.card));
  const answered = story.raw(['decisions', 'record', W, '--answers', answers, '--json']);
  assert.equal(answered.status, 0, answered.stdout.slice(-2000));
  await check(t, 'the person\'s answer on the card renews the turn: its next edit goes on', {}, () => {
    const after = turn.tool('edit', edit);
    assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  });
  // The same through the turn's own question tool: a second turn, asked in chat and answered 31 minutes in.
  const asked = copilotTurn(story, 'journey-e-ask-turn');
  asked.prompt('/sf-code');
  asked.age(31);
  asked.answered('Pin Node 22.');
  await check(t, 'the person\'s answer to the turn\'s question renews it too', {}, () => {
    const after = asked.tool('edit', edit);
    assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- F

/** A JSON result from a command's output: its first object, as an agent reads it. */
const json = (output) => { const text = String(output ?? ''); const start = text.indexOf('{'); return start < 0 ? null : JSON.parse(text.slice(start)); };

/** The reviewer's blocking finding on the code of `generation`: the clause comment must say why the value is 2. */
const explainTheValue = (W, generation) => (phase, packet) => (packet.kind === 'code' && packet.generation === generation ? [(() => {
  const code = packet.sources.find((source) => source.path === 'src/value.mjs');
  const line = code.text.split('\n').findIndex((text) => text.includes(`@clause:${W}:AC-001`)) + 1;
  return { id: 'explain-the-value', severity: 'blocking', check: 'plan', clauseId: `${W}:AC-001`,
    message: 'The clause comment must say why the value is 2, as the plan row says.', sourceId: code.id, line, quote: `// @clause:${W}:AC-001` };
})()] : []);

/** The code each version of the value step is written with: its clause comment names the version it was written for. */
const versionedAuthor = (W) => async ({ story: s, phase, generation }) => {
  if (phase !== 'implement') return false;
  const open = storyRecord(s)?.phases?.implement?.generationIntent;
  const version = open?.status === 'open' ? Number(open.generation) : generation + 1;
  await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], note: version >= 3 ? 'returns 2, the value the intake approves for every caller'
    : `returns the approved value (version ${version})` });
  // The change the person asked for, as the entry says: accounted for within the plan [SCS:REQ-042].
  accountForAskedFor(s, phase, `${W}:AC-001`);
  return true;
};

// C8 and C13 (2026-11-16 review): a code step returned for rework said "next: prepare" while its edit permission and task
// said `phase begin`. Ask once (owner, 2026-11-28): the person's send-back already answers "Start version 2?", and the
// version written for it is one only the reviewer saw, so neither next version is asked (d-story answered 9 such questions).
test('journey F: a code step a person sends back opens version 2 on that send-back, its review starts version 3 on its own, and the person is asked nothing', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-F';
  // The code step has an approver here, who returns it for rework.
  const story = await quickFixAtCode(t, W, { configure: (configuration) => {
    configuration.workTypes['quick-fix'].phaseOverrides.implement = { ...(configuration.workTypes['quick-fix'].phaseOverrides.implement ?? {}),
      approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['implement'] } };
  } });
  const agent = { author: versionedAuthor(W), review: reviewer({ findings: explainTheValue(W, 2) }) };
  // What the person did after their send-back: each answer and each step of their own (on main: "Start version 2?" and
  // "Start version 3?", one answer each, and in a real chat the preview asked each once more).
  const personActions = (trail) => trail.filter((entry) => entry.turn === 'person' || ['confirm', 'ask-person'].includes(entry.act)).length;
  // Version 1: written, reviewed ready and submitted by the routes; the approver then returns it.
  const first = await followRoutes(story, { label: 'journey F, version 1', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(() => null),
    done: ({ record }) => record?.phases?.implement?.status === 'awaiting_approval', maxSteps: 24 });
  t.diagnostic(formatTrail(first.trail));
  assert.equal(first.reached, true, report(first));
  const rejected = story.raw(['reject', 'implement', '--work-id', W, '--to', 'implement', '--reason', 'Say in the code why the value is 2.', '--yes', '--json']);
  assert.equal(rejected.status, 0, rejected.stdout.slice(-2000) + rejected.stderr.slice(-2000));
  assert.ok(storyRecord(story).phases.implement.reworkRevalidation, 'the code step was returned for rework');

  // The rework: version 2 opens on the send-back, is written, republished, and its review asks corrections.
  const corrections = ({ trail }) => trail.some((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? ''));
  const rework = await followRoutes(story, { label: 'journey F, the rework', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(() => null),
    done: corrections, maxSteps: 20 });
  t.diagnostic(formatTrail(rework.trail));
  await check(t, 'the returned code step opens version 2 on the person\'s send-back, names the answer it used, and asks nothing', {}, () => {
    assert.equal(rework.reached, true, report(rework));
    assert.deepEqual(rework.findings, [], report(rework));
    const text = (item) => `${item.ran ?? ''} ${item.did ?? ''}`;
    const opened = rework.trail.findIndex((item) => /phase rollover implement --sent-back --json/u.test(text(item)));
    assert.ok(opened >= 0, report(rework));
    assert.equal(personActions(rework.trail), 0, report(rework));
    // Nothing is prepared, begun or written before it opens [C13].
    assert.ok(rework.trail.slice(0, opened).every((item) => !/^singularity-flow (?:prepare|phase begin)\b/u.test(item.ran ?? '')), report(rework));
    const record = storyRecord(story);
    assert.equal(record.phases.implement.generation, 2);
    // Settled on the send-back, with the person's words as its evidence and an undo on the decisions card.
    const settled = (record.settledDecisions ?? []).find((entry) => entry.kind === 'sent-back');
    assert.ok(settled, JSON.stringify(record.settledDecisions ?? []));
    assert.match(settled.evidence[0].what, /Say in the code why the value is 2\./u);
    assert.ok((record.history ?? []).some((event) => event.event === 'version_opened' && event.phase === 'implement'
      && /version 2 opened \(rework\) settled for the person \(STL-\d+; the person sent it back/u.test(event.detail ?? '')), JSON.stringify((record.history ?? []).slice(-12)));
  });
  await check(t, 'after the rewrite\'s review asks corrections, version 3 starts on its own: only the reviewer saw version 2', {}, () => {
    const entry = json(story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']).stdout);
    assert.equal(entry?.act?.state, 'next', JSON.stringify(entry?.act ?? entry).slice(0, 1500));
    assert.match(String(entry.act.do?.shell ?? ''), /phase rollover implement --review-findings --json/u, JSON.stringify(entry.act).slice(0, 1500));
    assert.equal(entry.act.ask, undefined);
  });

  // Onward: version 3 starts on its own, is written, reviewed ready and submitted by its routes.
  const onward = await followRoutes(story, { label: 'journey F, version 3', start: rework.next ?? { copilot: '/sf-code' }, agent, person: cooperativePerson(() => null),
    done: ({ record }) => record?.phases?.implement?.status === 'awaiting_approval' && Number(record.phases.implement.generation) === 3, maxSteps: 24 });
  t.diagnostic(formatTrail(onward.trail));
  await check(t, 'version 3 starts on its own, is written, reviewed ready and submitted by its routes, with nothing asked', {}, () => {
    assert.equal(onward.reached, true, report(onward));
    assert.deepEqual(onward.findings, [], report(onward));
    assert.equal(personActions(onward.trail), 0, report(onward));
    assert.ok(onward.trail.some((entry) => /phase rollover implement --review-findings/u.test(`${entry.ran ?? ''} ${entry.did ?? ''}`)), report(onward));
    assert.ok(onward.trail.some((entry) => /reviewer wrote.*ready/u.test(entry.did ?? '')), report(onward));
  });
  t.diagnostic(`person actions from the send-back to version 3's submission: ${personActions(rework.trail) + personActions(onward.trail)} (main: 2)`);
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    for (const walk of [first, rework, onward]) viewsAgree(walk);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- G

// C2 (2026-11-16 review): with version 2 of a step open, readiness said "ready to submit", and nothing said whether
// submit would send version 1 instead [OSA:REQ-032].
test('journey G: version 2 open on a step with no review: submit refuses with the route to write it, and the routes then write and submit it', slowLane({ timeout: 1_200_000 }), async (t) => {
  const W = 'JRN-G';
  const story = await quickFixAtCode(t, W, { configure: (configuration) => {
    configuration.workTypes['quick-fix'].sourceReview = { skip: ['implement'] };
  } });
  const agent = { author: versionedAuthor(W), review: reviewer() };
  // At the validation offer a code step's publication makes when no review is owed, the person chooses "Continue workflow".
  const person = cooperativePerson(({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '')
    ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null));
  const first = await followRoutes(story, { label: 'journey G, version 1', start: { copilot: '/sf-code' }, agent, person,
    done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 16 });
  t.diagnostic(formatTrail(first.trail));
  assert.equal(first.reached, true, report(first));
  // The person asks for a change and confirms version 2.
  const preview = json(story.raw(['phase', 'rollover', 'implement', '--reason', 'Say in the code why the value is 2', '--json']).stdout);
  assert.match(String(preview?.command ?? ''), /--confirm /u, JSON.stringify(preview).slice(0, 1500));
  // In a /sf-code turn the agent asks the preview's question; the person's yes reaches the hooks, and the guard keeps it for
  // this version [OSA:REQ-030]. The confirmation then opens it through the opening operation.
  const asking = copilotTurn(story, 'journey-g-yes');
  asking.prompt('/sf-code');
  asking.tool('ask_user', { question: preview.question, choices: ['Yes', 'No'] });
  asking.after('ask_user', { question: preview.question, choices: ['Yes', 'No'] }, { resultType: 'success', textResultForLlm: 'User responded: Yes' });
  assert.notEqual(asking.tool('bash', { command: preview.command }).permissionDecision, 'deny', 'the guard admits it on the person\'s yes');
  const opened = story.raw([...argvOf(preview.command), '--json']);
  assert.equal(opened.status, 0, opened.stdout.slice(-2000) + opened.stderr.slice(-2000));
  assert.equal(storyRecord(story).phases.implement.generationIntent?.status, 'open');

  await check(t, 'submit refuses while version 2 is being written, and its first route is writing it, with no recover or phase show', {}, () => {
    const refused = story.raw(['submit', 'implement', '--work-id', W, '--json']);
    assert.notEqual(refused.status, 0, refused.stdout.slice(-2000));
    const result = json(refused.stdout);
    assert.equal(result?.error?.code, 'PHASE_VERSION_BEING_WRITTEN', JSON.stringify(result).slice(0, 2000));
    const [first] = result.remediationPlan.steps;
    assert.equal(first.command, 'singularity-flow prepare implement');
    assert.equal(first.copilotCommand?.split(' ')[0], '/sf-code');
    assert.doesNotMatch(JSON.stringify(result.remediationPlan.steps), /singularity-flow recover\b|phase show\b/u);
    const record = storyRecord(story);
    assert.equal(record.phases.implement.status, 'in_progress');
    assert.equal(record.phases.implement.generation, 1);
  });
  await check(t, 'submission readiness says to write version 2, never "ready to submit", and /sf-submit\'s entry submits nothing', {}, () => {
    const readiness = json(story.raw(['status', W, '--submission-readiness', '--json']).stdout);
    assert.equal(readiness.classification, 'generation-required', JSON.stringify(readiness).slice(0, 1500));
    assert.equal(readiness.nextSkill, '/sf-code');
    assert.equal(readiness.nextCommand, 'singularity-flow prepare implement');
    const entry = entryCommand(skillEntries(), '/sf-submit', { workId: W, phases: storyRecord(story).phaseOrder, currentPhase: 'implement' });
    story.raw(argvOf(entry));
    assert.equal(storyRecord(story).currentPhase, 'implement');
    assert.equal(storyRecord(story).phases.implement.generation, 1);
  });
  // The person takes the refusal's route: /sf-code writes version 2, publishes it and submits it.
  const second = await followRoutes(story, { label: 'journey G, version 2', start: { copilot: '/sf-code implement' }, agent, person,
    done: ({ record }) => record?.currentPhase !== 'implement', maxSteps: 16 });
  t.diagnostic(formatTrail(second.trail));
  await check(t, 'version 2 is written, published and submitted by its routes', {}, () => {
    assert.equal(second.reached, true, report(second));
    assert.deepEqual(second.findings, [], report(second));
    assert.equal(storyRecord(story).phases.implement.generation, 2);
  });
  // The validation offer is read and asked in the publication's own turn (Stage 3): no hand-off differs from the views.
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    for (const walk of [first, second]) viewsAgree(walk);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- K

// Daily run 2026-11-17: Implement version 1 was published, and the person typed `/sf-code Start each retry log line with
// "[retry]"…`. The entry's act asked to preview version 2 for it, but its edit permission said "No direct edits: this step is
// not being written now" with `submit-version:implement@1`, and the agent told the person they had asked for nothing. The
// same words typed after `/sf-code implement` went on. Both typings must give one answer everywhere: the version question.
const CHANGES = Object.freeze(['Say in the clause comment which version wrote it.', 'Name the version in the clause comment again.']);

test('journey K: a change typed after /sf-code, with and without the step\'s name, is asked as "Start version N?" by the entry, its permission, the kernel and the guard, then written', slowLane({ timeout: 1_500_000 }), async (t) => {
  const W = 'JRN-K';
  const story = await quickFixAtCode(t, W, { configure: (configuration) => {
    configuration.workTypes['quick-fix'].sourceReview = { skip: ['implement'] };
  } });
  const agent = { author: versionedAuthor(W), review: reviewer() };
  const validation = ({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '') ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null);
  const first = await followRoutes(story, { label: 'journey K, version 1', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(validation),
    done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 16 });
  t.diagnostic(formatTrail(first.trail));
  assert.equal(first.reached, true, report(first));

  const walks = [first];
  for (const [index, typed] of [`/sf-code ${CHANGES[0]}`, `/sf-code implement ${CHANGES[1]}`].entries()) {
    const version = index + 2;
    // What every surface said when the version question was asked, read at that moment.
    let seen = null;
    const person = cooperativePerson((context) => {
      if (!seen && context.act?.state === 'confirm' && context.act.ask?.question) {
        const guard = copilotTurn(story, `journey-k-guard-${version}`).prompt('/sf-code');
        seen = { act: context.act, entry: json(story.raw(['phase', 'enter', '--json']).stdout), guard: JSON.stringify(guard) };
      }
      return validation(context);
    });
    const walk = await followRoutes(story, { label: `journey K, ${typed.split(' ').slice(0, 2).join(' ')}…`, start: { copilot: typed }, agent, person,
      done: ({ record }) => publishedGeneration(record, 'implement') >= version, maxSteps: 16 });
    t.diagnostic(formatTrail(walk.trail));
    walks.push(walk);
    await check(t, `${typed.split(' ').slice(0, 2).join(' ')}…: the entry asks "Start version ${version} of Implement?" first, never "submit"`, {}, () => {
      assert.ok(seen, `the version question was never asked\n${report(walk)}`);
      assert.match(seen.act.ask.question, new RegExp(`^Start version ${version} of Implement\\?`, 'u'));
      assert.equal(seen.act.do.shell, 'singularity-flow phase rollover implement --json');
      assert.equal(seen.entry.status, 'successor-confirmation-required', JSON.stringify(seen.entry.authoring?.entry).slice(0, 1500));
      assert.deepEqual(seen.entry.successor.requests, [CHANGES[index]]);
    });
    await check(t, `${typed.split(' ').slice(0, 2).join(' ')}…: the edit permission, the kernel and the guard say the same`, {}, () => {
      const contract = seen.entry.mutationContract;
      assert.equal(contract.policy.step.next, `open-version:implement@${version}`, JSON.stringify(contract.policy));
      assert.ok(contract.policy.step.reasons.includes('CHANGE_REQUESTED'), JSON.stringify(contract.policy));
      assert.equal(contract.next[0].command, 'singularity-flow phase rollover implement --json', JSON.stringify(contract.next));
      assert.match(contract.summary, new RegExp(`person's yes to version ${version} of implement`, 'u'));
      for (const said of [contract.summary, seen.guard]) assert.doesNotMatch(said, /not being written now|submit-version/u);
      assert.match(seen.guard, new RegExp(`person's yes to version ${version} of implement`, 'u'));
    });
    await check(t, `${typed.split(' ').slice(0, 2).join(' ')}…: the person's one yes opens version ${version}, and the change is written and published by the routes`, {}, () => {
      assert.equal(walk.reached, true, report(walk));
      assert.deepEqual(walk.findings, [], report(walk));
      assert.equal(storyRecord(story).phases.implement.generation, version);
      assert.equal(walk.trail.filter((entry) => /the person answered/u.test(entry.did ?? '')).length >= 1, true, report(walk));
    });
  }
  // Next steps, phase show and submission readiness lead with the same version question: the kernel's decision they read
  // is handed the typed change with the step's task fact (workflow-task-outcome.mjs readTaskOutcome).
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    for (const walk of walks) viewsAgree(walk);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- L

// Review findings 2026-11-17 (kernel #8): the person typed a change after version 1 of the code was published and before its
// review; asked "Start version 2?", they said No and asked to submit it as it is. Readiness led with the change and named
// only the version question while the review was owed, so /sf-submit asked it again, and again. Now the question leads, and
// the person's No goes on with the review, then the submission.
test('journey L: a change typed while the review is owed, the person says No, and /sf-submit goes on by the review to the submission', slowLane({ timeout: 1_500_000 }), async (t) => {
  const W = 'JRN-L';
  const story = await quickFixAtCode(t, W);
  const agent = { author: versionedAuthor(W), review: reviewer() };
  const validation = ({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '') ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null);
  const first = await followRoutes(story, { label: 'journey L, version 1', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(validation),
    done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 16 });
  t.diagnostic(formatTrail(first.trail));
  assert.equal(first.reached, true, report(first));
  const owed = json(story.raw(['status', W, '--submission-readiness', '--json']).stdout);
  assert.equal(owed?.classification, 'source-review-required', `the review is owed before the change is typed: ${JSON.stringify(owed).slice(0, 1500)}`);

  // The person types a change, is asked "Start version 2 of Implement?", says No, and asks to submit it as it is.
  const questions = [];
  const person = cooperativePerson((context) => {
    if (context.act?.state === 'confirm' && /^Start version 2 of Implement\?/u.test(context.act.ask?.question ?? '')) {
      questions.push(context.act.ask.question);
      return { route: { copilot: '/sf-submit' } };
    }
    return validation(context);
  });
  const walk = await followRoutes(story, { label: 'journey L, No', start: { copilot: `/sf-code ${CHANGES[0]}` }, agent, person,
    done: ({ record }) => ['awaiting_approval', 'approved', 'completed'].includes(record?.phases?.implement?.status), maxSteps: 30 });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the person is asked once, says No, and /sf-submit reviews version 1 and submits it: no loop, no stall, no dead end', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
    assert.equal(questions.length, 1, `the version question was asked ${questions.length} times\n${report(walk)}`);
  });
  await check(t, 'version 1 was reviewed before it was submitted, and no version 2 opened', {}, () => {
    const reviewed = walk.trail.findIndex((entry) => /reviewer wrote/u.test(entry.did ?? ''));
    assert.ok(reviewed > 0, report(walk));
    const record = storyRecord(story);
    assert.equal(record.phases.implement.generation, 1);
    assert.notEqual(record.phases.implement.generationIntent?.status, 'open');
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- I

// Journey I (SPEC-OSA v1.1 §12.2): the same rule for a document's corrections as for code. The planning step's independent
// review asks corrections of version 1, which only its reviewer has seen: SFlow starts version 2 itself, through the opening
// operation, settled for the person with an undo, and nobody is asked "Start version 2?", a yes that only agreed with a
// reviewer they had not read (owner, 2026-11-19, ceremony cut 10); version 2 is written, reviewed ready, submitted and
// approved by its routes [OSA:REQ-020]. A version a person has seen is still asked [D3, OSA:REQ-030, AC-013].
test('journey I: a document step\'s review asks corrections of a version only its reviewer saw: version 2 starts on its own, and the step goes on by its routes', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-I';
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['planning'], reviewerAgent: 'sflow-source-reviewer' };
    configuration.workTypes['spec-driven-standard'].spec = { ...(configuration.workTypes['spec-driven-standard'].spec ?? {}), coverage: 'record' };
  } });
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  const person = cooperativePerson(({ route }) => {
    if (/^\/sf-decide\b/u.test(route.copilot ?? '') || /^singularity-flow decisions\b/u.test(route.shell ?? '')) {
      const scope = scopeAnswers(story, `${W}:AC-001`);
      if (scope.length) return { commands: scope, then: { copilot: '/sf-approve', person: true } };
      const card = decideCard(story);
      if (card) return { command: card.command };
    }
    return null;
  });
  // The reviewer's one blocking finding on version 1 of the plan, about the plan itself.
  const nameTheTest = (phase, packet) => (packet.kind === 'planning' && packet.generation === 1
    ? [{ id: 'name-the-test', severity: 'blocking', clauseId: `${W}:AC-001`, message: 'The plan must name the test that proves the value is 2.' }] : []);
  const walk = await followRoutes(story, {
    label: 'journey I',
    start: { shell: `singularity-flow start ${W} --from-branch main --work-type spec-driven-standard --title "Validate a value" --description "Return an approved value."` },
    agent: { author: specDrivenAuthor(W), review: reviewer({ findings: nameTheTest }), clarify: clarifications() },
    person,
    done: ({ record }) => approved(record, 'planning'),
    maxSteps: 90
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the plan is written, reviewed, corrected in version 2 and approved by its routes: no loop, no stall, no dead end', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  await check(t, 'the review asked corrections of version 1, and the author\'s turn started version 2 on its own before preparing it, asking nobody', {}, () => {
    const corrections = walk.trail.findIndex((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? '') && /planning/u.test(entry.state ?? ''));
    assert.ok(corrections > 0, report(walk));
    const started = walk.trail.findIndex((entry, index) => index >= corrections && /phase rollover planning --review-findings/u.test(`${entry.ran ?? ''} ${entry.did ?? ''}`));
    assert.ok(started >= corrections, report(walk));
    assert.ok(!walk.trail.some((entry, index) => index > corrections && entry.act === 'confirm'), report(walk));
    // Nothing of version 2 was prepared before it was started.
    assert.ok(walk.trail.slice(corrections, started).every((entry) => !/^singularity-flow prepare planning\b/u.test(entry.ran ?? '')), report(walk));
  });
  await check(t, 'version 2 opened through the opening operation, settled for the person in the same commit, for the review\'s corrections', {}, () => {
    const record = storyRecord(story);
    const planning = record.phases.planning;
    assert.equal(planning.generation, 2);
    assert.equal(planning.versionOpening?.version, 2);
    assert.equal(planning.versionOpening?.reason, 'review-corrections');
    assert.equal(planning.versionOpening?.consent?.surface, 'settled', JSON.stringify(planning.versionOpening ?? null));
    const start = (record.settledDecisions ?? []).find((entry) => entry.id === planning.versionOpening.consent.settled);
    assert.deepEqual([start?.kind, start?.phase, start?.effect?.generation, start?.effect?.toGeneration], ['review-corrections', 'planning', 1, 2]);
  });
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => viewsAgree(walk));
  settle(t);
});

// ------------------------------------------------------------------------------------------- Q

// The daily real-Story run of 2026-11-17, a quick design (scope and plan, design, then code nobody approves, and verify):
//   1. the person typed the same change twice (the first turn ended before it), and the Story kept two identical
//      instructions; Implement needs no approval, so the Story closed with neither accounted for. Now its submission waits,
//      and while it does next steps, phase show and submission readiness lead with the author's account, never submit;
//   2. after `approve verify` said "nothing further to do", next steps still listed "Now: confirm the final gate";
//   3. after `approve fix-design`, next steps offered "the deterministically generated Implement" on /sf-publish, for
//      code /sf-code writes, and labelled its submission "for approval".
test('journey Q: a quick design is written, its change typed twice is accounted for once, and once closed it says it is done', slowLane({ timeout: 1_500_000 }), async (t) => {
  const W = 'JRN-QD';
  const story = await journeyRepository(t, { configure: (configuration) => {
    // Written before step intents: its own workflow of shipped steps runs as a repository on version 2 has it.
    Object.assign(configuration, packagedWorkflowWithoutIntents(configuration, 2));
    delete configuration.phases['fix-design'].clarification;
    configuration.workTypes['quick-design'] = { ...configuration.workTypes['quick-fix'], label: 'Quick design', phases: ['intake', 'fix-design', 'implement', 'verify'],
      sourceReview: { mode: 'off' } };
  } });
  startStory(story, W, { workType: 'quick-design', title: 'Change the value', description: 'Return 2.' });
  // The scope and plan, and the design: the person writes, submits and approves each.
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  story.cli('prepare', 'fix-design');
  await story.write(`${story.item}/artifacts/fix-design/fix-design.md`, [`# ${W} — Fix Design`, '', '## Root cause', '',
    'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
    `Change the one literal that holds the value, as ${W}:AC-001 asks; no import changes.`, '', '## Alternatives and regression risk', '',
    'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
  story.cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'fix-design');
  const designApproved = story.raw(['approve', 'fix-design', '--yes']);
  assert.equal(designApproved.status, 0, designApproved.stdout.slice(-2000) + designApproved.stderr.slice(-2000));

  await check(t, 'after the design is approved, Implement is written and published by /sf-code, and its submission completes it without approval', {}, () => {
    const printed = `${designApproved.stdout}\n${designApproved.stderr}`;
    assert.doesNotMatch(printed, /deterministically generated Implement|\/sf-publish implement|Implement for approval/u, printed.slice(-4000));
    const next = json(story.raw(['nextsteps', W, '--json']).stdout);
    const publication = next.actions.find((entry) => entry.operationId === 'phase');
    assert.equal(publication?.skill, '/sf-code', JSON.stringify(next.actions).slice(0, 3000));
    assert.match(publication.command, /^singularity-flow phase prepublish implement\b/u);
    const submit = next.actions.find((entry) => /^singularity-flow submit implement/u.test(entry.command));
    assert.equal(submit?.label, 'Submit the Implement; it completes without approval', JSON.stringify(next.actions).slice(0, 3000));
  });

  // The person types the change in a /sf-code turn that ends before it, then types it again.
  const change = 'Start each value comment with "[value]".';
  for (const session of ['journey-qd-first', 'journey-qd-again']) copilotTurn(story, session).prompt(`/sf-code implement ${change}`);
  // The agent writes the code and publishes it, as the daily run's did, without accounting for what the person asked.
  const author = async ({ story: s, phase }) => phase === 'implement'
    && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], note: '[value] returns the approved value to its callers' }), true);
  const person = cooperativePerson(({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '')
    ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null));
  const written = await followRoutes(story, { label: 'journey Q, the code', start: { copilot: '/sf-code implement' }, agent: { author, review: reviewer() }, person,
    done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 16 });
  t.diagnostic(formatTrail(written.trail));
  assert.equal(written.reached, true, report(written));

  // No mixed signals: while the instruction waits for its account, every view leads with the author's account, which the
  // decisions list names too, and /sf-submit submits nothing.
  const account = `singularity-flow departure account --work-id ${W} --instruction 1 --clauses <CLAUSES>`;
  await check(t, 'the change typed twice is one instruction, and every view leads with its author\'s account, never submit', {}, () => {
    assert.deepEqual((storyRecord(story).askedFor ?? []).map((entry) => [entry.phase, entry.instruction, entry.text]), [['implement', 1, change]]);
    const next = json(story.raw(['nextsteps', W, '--json']).stdout);
    const now = next.actions.find((entry) => entry.timing === 'now');
    assert.deepEqual([now?.skill, now?.command], ['/sf-code', account], JSON.stringify(next.actions).slice(0, 3000));
    assert.ok(!next.actions.some((entry) => /^singularity-flow submit implement/u.test(entry.command)), JSON.stringify(next.actions).slice(0, 3000));
    const shown = json(story.raw(['phase', 'show', 'implement', '--json']).stdout)?.continuation;
    assert.deepEqual([shown?.nextSkill, shown?.nextCommand], ['/sf-code', account], JSON.stringify(shown).slice(0, 2000));
    const readiness = json(story.raw(['status', W, '--submission-readiness', '--json']).stdout);
    assert.deepEqual([readiness?.classification, readiness?.nextSkill, readiness?.nextCommand], ['instructions-unaccounted', '/sf-code', account],
      JSON.stringify(readiness).slice(0, 2000));
    const listed = json(story.raw(['decisions', W, '--json']).stdout);
    const item = (listed.data ?? listed).items.find((entry) => entry.kind === 'asked-for');
    assert.equal(item?.options?.[0]?.action?.command, account, JSON.stringify(item).slice(0, 2000));
    const submitted = json(story.raw(['status', W, '--submission-readiness', '--json', '--submit-if-ready']).stdout);
    assert.equal(submitted?.submitIfReady?.submitted, false, JSON.stringify(submitted?.submitIfReady));
    assert.equal(storyRecord(story).phases.implement.status, 'in_progress');
  });
  // The agent takes that route: it names the clause the plan covers it by, and the step goes on to its end by its routes.
  const accounted = story.raw(account.replace(/^singularity-flow /u, '').replace('<CLAUSES>', `${W}:AC-001`).split(' ').concat('--json'));
  assert.equal(accounted.status, 0, accounted.stdout.slice(-1500) + accounted.stderr.slice(-1500));
  const walk = await followRoutes(story, { label: 'journey Q, to the end', start: { copilot: '/sf-submit' }, agent: { author, review: reviewer() }, person,
    detour: ({ finding, route }) => (['no-progress', 'dead-end', 'skill-skips-route'].includes(finding.kind) && route.shell ? { shell: route.shell } : null),
    done: ({ record }) => record?.status === 'closed', maxSteps: 30 });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, `the Story never reached its end, even with the detour\n${report(walk)}`);
  const record = storyRecord(story);

  await check(t, 'accounted for once, before the step nobody approves completed, and its commit says it completed', {}, () => {
    assert.deepEqual((record.askedFor ?? []).map((entry) => [entry.phase, entry.instruction]), [['implement', 1]]);
    assert.deepEqual((record.instructionAccounts ?? []).map((entry) => [entry.phase, entry.instruction, entry.as]), [['implement', 1, 'within-plan']]);
    assert.equal(record.phases.implement.approvalDisposition, 'not_required');
    const subjects = story.git('log', '--format=%s');
    assert.match(subjects, new RegExp(`\\[${W}\\]\\[phase:implement\\]\\[submit\\] complete without approval`, 'u'));
  });
  await check(t, 'every step went by its routes, with no detour, and the person\'s views named the agent\'s skill at each hand-off', {}, () => {
    assert.deepEqual([...written.findings, ...walk.findings], [], `${report(written)}\n${report(walk)}`);
    viewsAgree(written);
    viewsAgree(walk);
  });
  await check(t, 'the closed Story says it is done: nothing is "now" in next steps, in what /sf-next reads or in the person\'s views', {}, async () => {
    const next = json(story.raw(['nextsteps', W, '--json']).stdout);
    assert.equal(next.done, true, JSON.stringify(next).slice(0, 2000));
    assert.deepEqual(next.actions.filter((entry) => !['alternative', 'optional'].includes(entry.timing)), [], JSON.stringify(next.actions));
    const text = story.raw(['nextsteps', W]).stdout;
    assert.match(text, /This Story is done/u);
    assert.doesNotMatch(text, /\bNow —/u, text);
    // What /sf-next reads: no action is "now", least of all the final gate.
    const agent = json(story.raw(['nextsteps', W, '--for-agent', '--json']).stdout);
    assert.deepEqual((agent?.actions ?? []).filter((entry) => entry.timing === 'now'), [], JSON.stringify(agent).slice(0, 2000));
    for (const view of await personViews(story)) assert.equal(view.skill, null, JSON.stringify(view));
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- R

// Review findings 2026-11-17 (kernel #10, case 1): a quick design's Implement (nobody approves it) was published without its
// author's account of what the person typed, and the person then typed a change. Readiness led with the change and offered
// "submit it as it is", which the engine refuses with INSTRUCTIONS_UNACCOUNTED. The question still leads; the person's No
// now names the account first, and once it is made the same /sf-submit completes the step.
test('journey R: an unaccounted instruction and a typed change: the person says No, and /sf-submit names the account, never a refused submission', slowLane({ timeout: 1_500_000 }), async (t) => {
  const W = 'JRN-R';
  const story = await journeyRepository(t, { configure: (configuration) => {
    // Written before step intents: its own workflow of shipped steps runs as a repository on version 2 has it.
    Object.assign(configuration, packagedWorkflowWithoutIntents(configuration, 2));
    delete configuration.phases['fix-design'].clarification;
    configuration.workTypes['quick-design'] = { ...configuration.workTypes['quick-fix'], label: 'Quick design', phases: ['intake', 'fix-design', 'implement', 'verify'],
      sourceReview: { mode: 'off' } };
  } });
  startStory(story, W, { workType: 'quick-design', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  story.cli('prepare', 'fix-design');
  await story.write(`${story.item}/artifacts/fix-design/fix-design.md`, [`# ${W} — Fix Design`, '', '## Root cause', '',
    'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
    `Change the one literal that holds the value, as ${W}:AC-001 asks; no import changes.`, '', '## Alternatives and regression risk', '',
    'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
  story.cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'fix-design');
  story.cli('approve', 'fix-design', '--yes');
  // What the person types while the code is written, which the published version then owes an account of.
  const instruction = 'Start each value comment with "[value]".';
  copilotTurn(story, 'journey-r-writing').prompt(`/sf-code implement ${instruction}`);
  const author = async ({ story: s, phase }) => phase === 'implement'
    && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], note: '[value] returns the approved value to its callers' }), true);
  const validation = ({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '') ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null);
  const written = await followRoutes(story, { label: 'journey R, the code', start: { copilot: '/sf-code implement' }, agent: { author, review: reviewer() },
    person: cooperativePerson(validation), done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 16 });
  t.diagnostic(formatTrail(written.trail));
  assert.equal(written.reached, true, report(written));

  // The person types a change, is asked "Start version 2 of Implement?", says No, and asks to submit it as it is.
  const account = `singularity-flow departure account --work-id ${W} --instruction 1 --clauses <CLAUSES>`;
  const questions = [];
  const person = cooperativePerson((context) => {
    if (context.act?.state === 'confirm' && /^Start version 2 of Implement\?/u.test(context.act.ask?.question ?? '')) {
      questions.push(context.act.ask.question);
      return { route: { copilot: '/sf-submit' } };
    }
    return validation(context);
  });
  const declined = await followRoutes(story, { label: 'journey R, No', start: { copilot: `/sf-code ${CHANGES[0]}` }, agent: { author, review: reviewer() }, person,
    done: ({ result }) => result?.act?.do?.shell === account, maxSteps: 8 });
  t.diagnostic(formatTrail(declined.trail));
  await check(t, 'asked once, the person says No, and /sf-submit names the author\'s account: no submission is tried and refused', {}, () => {
    assert.equal(declined.reached, true, report(declined));
    assert.deepEqual(declined.findings, [], report(declined));
    assert.equal(questions.length, 1, report(declined));
    const submit = declined.trail.find((entry) => /--submit-if-ready/u.test(entry.ran ?? ''));
    assert.equal(submit?.status, 0, report(declined));
    const readiness = json(story.raw(['status', W, '--submission-readiness', '--json']).stdout);
    assert.deepEqual([readiness?.classification, readiness?.lifecycleReady, readiness?.submission, readiness?.otherwise?.command],
      ['change-requested', false, undefined, account], JSON.stringify(readiness).slice(0, 2000));
    const next = json(story.raw(['nextsteps', W, '--json']).stdout);
    assert.ok(!next.actions.some((entry) => /^singularity-flow submit implement/u.test(entry.command)), JSON.stringify(next.actions).slice(0, 3000));
    assert.ok(next.actions.some((entry) => entry.command === account), JSON.stringify(next.actions).slice(0, 3000));
    assert.equal(storyRecord(story).phases.implement.status, 'in_progress');
  });
  // The author makes the account (the plan's clause covers it), and the same /sf-submit completes the step as it is.
  const accounted = story.raw(account.replace(/^singularity-flow /u, '').replace('<CLAUSES>', `${W}:AC-001`).split(' ').concat('--json'));
  assert.equal(accounted.status, 0, accounted.stdout.slice(-1500) + accounted.stderr.slice(-1500));
  const submitted = await followRoutes(story, { label: 'journey R, submitted', start: { copilot: '/sf-submit' }, agent: { author, review: reviewer() }, person,
    done: ({ record }) => ['approved', 'completed'].includes(record?.phases?.implement?.status), maxSteps: 8 });
  t.diagnostic(formatTrail(submitted.trail));
  await check(t, 'once accounted for, /sf-submit completes version 1 as it is, with no version 2 opened', {}, () => {
    assert.equal(submitted.reached, true, report(submitted));
    assert.deepEqual(submitted.findings, [], report(submitted));
    const record = storyRecord(story);
    assert.equal(record.phases.implement.generation, 1);
    assert.equal(record.phases.implement.approvalDisposition, 'not_required');
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- T and U

// D1 (owner, 2026-11-20, step intents spec §11): a test step changes no source code, and a failing test goes back to the
// code step on its own, under the workflow's review brake (src/failing-tests-return.mjs). The workflow: a scope-and-plan
// step, a code step and a test step that changes no source and runs its own check of the value.
const VALUE_CHECK = ["import { value } from '../src/value.mjs';", '',
  "if (value !== 2) { console.error(`AssertionError: the value must be 2, got ${value}`); process.exit(1); }", "console.log('ok: the value is 2');", ''].join('\n');
const fillTodos = (text, words) => text.replace(/TODO:[^\n]*/gu, words).replace(/\bTODO\b/gu, 'none');

/** A Story of the tested-change workflow whose scope and plan is approved and whose code step is next, every step reviewed. */
async function testedChangeAtCode(t, W) {
  const story = await journeyRepository(t, { files: { 'checks/value-check.mjs': VALUE_CHECK }, configure: (configuration) => {
    configuration.workTypes['tested-change'] = { label: 'Tested change', description: 'Scope and plan, code, and a test step that runs the value check and changes no code.',
      phases: ['intake', 'implementation', 'verification'],
      plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } },
      templateOverrides: { intake: 'quick-fix/intake.md' },
      phaseOverrides: {
        intake: { label: 'Scope and plan', artifact: { kind: 'requirements' }, clarification: { mode: 'off' },
          approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] } },
        implementation: { inputs: ['intake'], approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation'] } },
        // The shipped verification step as it is: it changes no source code (D1, Stage 7).
        verification: { inputs: ['intake', 'implementation'], clarification: { mode: 'off' },
          qualityCommands: [{ id: 'value-check', kind: 'test', argv: [process.execPath, 'checks/value-check.mjs'], modelPolicy: 'never' }],
          approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['intake', 'implementation', 'verification'] } }
      } };
  } });
  startStory(story, W, { workType: 'tested-change', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  return story;
}

/** The code step writes the value `valueFor(version)` (its own test reads that value); the test step reports its run. */
const testedChangeAuthor = (W, valueFor) => async ({ story: s, phase, generation }) => {
  if (phase === 'implementation') {
    const open = storyRecord(s)?.phases?.implementation?.generationIntent;
    const version = open?.status === 'open' ? Number(open.generation) : Number(generation ?? 0) + 1;
    const value = valueFor(version);
    await writeValueCode(s, { value, clauses: [`${W}:AC-001`], note: `returns the approved value (version ${version})` });
    await s.write(`${s.item}/artifacts/implementation/implementation-summary.md`, [`# ${W} — Implementation Summary`, '', '## Agent brief', '',
      `Version ${version} sets the exported value to ${value}; its focused test reads that value and nothing else changes.`, '', '## Implemented outcome', '',
      `\`src/value.mjs\` exports ${value}.`, '', '## Changed components and decisions', '',
      `- \`src/value.mjs\` carries \`@clause:${W}:AC-001\` beside the constant it sets.`, '', '## Tests and operational notes', '',
      `\`test/value.test.mjs\` (tagged \`@ac:${W}:AC-001\`) reads the value; \`npm test\` runs it. Nothing changes for an operator.`, ''].join('\n'));
    return true;
  }
  if (phase === 'verification') {
    const file = `${s.item}/artifacts/verification/test-evidence.md`;
    const before = await s.read(file).catch(() => '');
    await s.write(file, fillTodos(before, `Ran the value check (\`node checks/value-check.mjs\`) on the code ${W}:AC-001 names; its result is the run this step records.`));
    return true;
  }
  return false;
};

const settledOf = (story, kind) => (storyRecord(story)?.settledDecisions ?? []).filter((entry) => entry.kind === kind);

test('journey T: the test step\'s check fails, SFlow starts the code step\'s next version on its own, the fix passes the check, and nobody is asked', slowLane({ timeout: 2_400_000 }), async (t) => {
  const W = 'JRN-T';
  const story = await testedChangeAtCode(t, W);
  const asked = [];
  const walk = await followRoutes(story, {
    label: 'journey T', start: { copilot: '/sf-code' },
    agent: { author: testedChangeAuthor(W, (version) => (version >= 2 ? 2 : 1)), review: reviewer(), clarify: clarifications() },
    person: cooperativePerson(({ act }) => { if (act?.state === 'confirm') asked.push(act.ask?.question ?? act.said ?? ''); return null; }),
    done: ({ record }) => ['approved', 'completed'].includes(record?.phases?.verification?.status) && Number(record.phases.verification.generation) >= 2, maxSteps: 120
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the Story goes from the failing check to the passing one by its routes alone: nothing loops or dead-ends', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  const record = storyRecord(story);
  await check(t, 'SFlow returned the test step itself, with the failure as the code step\'s change request', {}, () => {
    assert.equal(record.resolution.phases.find((phase) => phase.id === 'verification').writeScope, 'artifact-only', 'the shipped step changes no source code');
    const [request] = record.changeRequests;
    assert.deepEqual([request.sourcePhase, request.sourceGeneration, request.targetPhase, request.requestedBy?.login, request.automatic?.kind],
      ['verification', 1, 'implementation', 'sflow-returned-automatically', 'failing-tests'], JSON.stringify(request));
    assert.match(request.comment, /value-check .*exit 1.*AssertionError: the value must be 2, got 1/u, request.comment);
    assert.match(request.comment, /Fix the code, or its tests, in Implementation so these pass; Verification then runs them again\.$/u);
    assert.ok(record.history.some((event) => event.event === 'phase_rejected' && /returned to implementation automatically by SFlow/u.test(event.detail)), 'the return is in the history');
  });
  await check(t, 'both starts are settled for the person with an undo: the code step\'s version 2, then the test step\'s run again', {}, () => {
    const [returned] = settledOf(story, 'failing-tests');
    assert.deepEqual([returned?.phase, returned?.effect?.generation, returned?.effect?.toGeneration, returned?.effect?.testPhase, returned?.effect?.round],
      ['implementation', 1, 2, 'verification', 1], JSON.stringify(returned));
    const [rerun] = settledOf(story, 'tests-rerun');
    assert.deepEqual([rerun?.phase, rerun?.effect?.generation, rerun?.effect?.toGeneration, rerun?.effect?.codeGeneration],
      ['verification', 1, 2, 2], JSON.stringify(rerun));
    assert.equal(record.phases.implementation.generation, 2);
    assert.equal(record.phases.verification.generation, 2);
    assert.equal(record.phases.verification.checks.find((entry) => entry.id === 'value-check')?.status, 'passed');
  });
  await check(t, 'no person was asked to start a version: only the plan, the code and the tests were approved by a person', {}, () => {
    assert.deepEqual(asked, [], report(walk));
    assert.ok(!walk.trail.some((entry) => /phase rollover \S+ --confirm /u.test(entry.ran ?? '')), report(walk));
    // The failing submission ended the test step's turn, and the code step's fix started in a new turn by /sf-code.
    const failed = walk.trail.findIndex((entry) => entry.act === 'end-turn' && /--submit-if-ready/u.test(entry.ran ?? '') && /returned it to the code step/u.test(entry.did ?? entry.said ?? ''));
    assert.ok(failed < 0 || walk.trail[failed + 1]?.typed === true, report(walk));
  });
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => viewsAgree(walk));
  settle(t);
});

/** A command line a choice names, as the argv a person's terminal runs: its one quoted reason kept whole. */
const choiceArgv = (command) => [...command.replace(/^singularity-flow /u, '').matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]);

test('journey U: the same check fails again after SFlow\'s fix, so the person decides with filled choices; their return starts the next version once', slowLane({ timeout: 2_400_000 }), async (t) => {
  const W = 'JRN-U';
  const story = await testedChangeAtCode(t, W);
  // The code step's version 2 does not fix the value; version 3 does.
  const agent = { author: testedChangeAuthor(W, (version) => (version >= 3 ? 2 : 1)), review: reviewer(), clarify: clarifications() };
  const asked = [];
  const person = cooperativePerson(({ act }) => { if (act?.state === 'confirm') asked.push(act.ask?.question ?? act.said ?? ''); return null; });
  const first = await followRoutes(story, { label: 'journey U, to the brake', start: { copilot: '/sf-code' }, agent, person, maxSteps: 120,
    done: ({ record }) => record?.phases?.verification?.status === 'awaiting_approval' && Number(record.phases.verification.generation) === 2 });
  t.diagnostic(formatTrail(first.trail));
  await check(t, 'the first failure goes back on its own, and the same failure after SFlow\'s fix stops there, by the routes alone', {}, () => {
    assert.equal(first.reached, true, report(first));
    assert.deepEqual(first.findings, [], report(first));
    assert.deepEqual(asked, [], report(first));
    assert.equal(settledOf(story, 'failing-tests').length, 1, 'one return on its own, never a second for the same failure');
    const record = storyRecord(story);
    assert.equal(record.currentPhase, 'verification');
    assert.equal(record.phases.verification.validationVerdict, 'failed');
  });
  // The person's view at the brake: the approval says why it waits, and every choice is filled.
  const refused = story.raw(['approve', 'verification', '--work-id', W, '--yes', '--json']);
  const refusal = json(refused.stdout);
  const returns = (refusal?.error?.details?.choices ?? []).map((choice) => choice.command);
  await check(t, 'the approval is refused with the filled choices: another version, or the tests again; nothing to type', {}, () => {
    assert.notEqual(refused.status, 0);
    assert.equal(refusal?.error?.code, 'PHASE_VALIDATION_FAILED', refused.stdout.slice(-2000));
    assert.match(refusal.error.message, /changes no source code, and its tests fail on the code implementation delivered, which implementation fixes\. Start another version of implementation /u);
    assert.deepEqual(refusal.error.details.choices.map((choice) => choice.id), ['another-version', 'dispute'], JSON.stringify(refusal.error.details).slice(0, 3000));
    assert.deepEqual(returns.map((command) => / --to (\S+) /u.exec(command)?.[1]), ['implementation', 'verification']);
    for (const command of returns) {
      assert.doesNotMatch(command, /<[A-Za-z-]+>/u, command);
      assert.match(command, / --reason "[^"<>]+"$/u, command);
    }
    // The plan every surface renders leads with the first choice, with its words.
    const [first] = refusal.remediationPlan?.steps ?? [];
    assert.deepEqual([first?.command, first?.label], [returns[0], 'Start another version of Implementation to fix the failing tests'], JSON.stringify(refusal.remediationPlan).slice(0, 3000));
  });
  // The person takes "Start another version": their own return, and SFlow starts that version with it (no second question).
  const back = returns[0];
  const returned = story.raw([...choiceArgv(back), '--json']);
  await check(t, 'the person\'s return starts version 3 of the code step at once, settled, citing their return', {}, () => {
    assert.equal(returned.status, 0, returned.stdout.slice(-2000) + returned.stderr.slice(-2000));
    const record = storyRecord(story);
    assert.equal(record.currentPhase, 'implementation');
    assert.equal(Number(record.phases.implementation.versionOpening?.version), 3);
    assert.equal(record.phases.implementation.versionOpening?.consent?.surface, 'settled');
    const [, mine] = settledOf(story, 'failing-tests');
    assert.equal(mine?.effect?.byPerson, record.changeRequests.at(-1).id, JSON.stringify(mine));
    assert.equal(json(returned.stdout)?.data?.codeVersion?.opened?.generation, 3, returned.stdout.slice(-2000));
  });
  const rest = await followRoutes(story, { label: 'journey U, the fix', start: { copilot: '/sf-code' }, agent, person, maxSteps: 80,
    done: ({ record }) => ['approved', 'completed'].includes(record?.phases?.verification?.status) });
  t.diagnostic(formatTrail(rest.trail));
  await check(t, 'version 3 fixes it, the test step runs again on its own and passes, and nobody is asked to start a version', {}, () => {
    assert.equal(rest.reached, true, report(rest));
    assert.deepEqual(rest.findings, [], report(rest));
    assert.deepEqual(asked, [], report(rest));
    const record = storyRecord(story);
    assert.equal(record.phases.verification.generation, 3);
    assert.equal(settledOf(story, 'tests-rerun').length, 2);
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- V

// D1 adopted (step intents Stage 7): the shipped feature workflow's verification changes no source code, so SFlow approves
// a clean run of it. Walked as `workflow walk feature` walks it (src/workflow-walk/walk.mjs): one throwaway Story through
// every step with the kernel's own commands on an isolated copy, a stub author writing each step from its own template
// and a stub reviewer; the walk approves a step only when it waits for a person, and says so in that step's people.
test('journey V: a feature Story from its start to its close, as shipped: a person approves the plan and the code, SFlow every other step', slowLane({ timeout: 2_400_000 }), async (t) => {
  const { walkWorkflows } = await import('../src/workflow-walk/walk.mjs');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const result = await walkWorkflows(root, { workflow: 'feature', shipped: true, stepSeconds: 600, totalSeconds: 1800 });
  const [workflow] = result.workflows;
  t.diagnostic(JSON.stringify(workflow.steps.map((step) => [step.id, step.outcome, step.people.map((entry) => entry.kind)])));
  await check(t, 'the feature Story walks from its start to its close with no stop', {}, () => {
    assert.deepEqual(workflow.stops, [], JSON.stringify(workflow.stops));
    assert.equal(workflow.outcome, 'completed', JSON.stringify(workflow.steps.map((step) => [step.id, step.outcome])));
    assert.ok(workflow.steps.every((step) => ['approved', 'completed'].includes(step.outcome)), JSON.stringify(workflow.steps.map((step) => [step.id, step.outcome])));
  });
  await check(t, 'a person approved exactly the plan and the code; SFlow approved the rest, the verification included', {}, () => {
    const people = workflow.steps.filter((step) => step.people.some((entry) => entry.kind === 'approval')).map((step) => step.id);
    assert.deepEqual(people, ['implementation-spec', 'implementation'], JSON.stringify(workflow.steps.map((step) => [step.id, step.people])));
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- W

// Convergence folds into the code approval (owner, 2026-11-21). The plan binds the second requirement to a test version 1
// of the code does not deliver, and the Story records coverage rather than refusing it at the code step, so the gap
// reaches the convergence check (test/helpers/story-to-verification.mjs, as the convergence tests walk it).
test('journey W: a convergence gap does not approve itself and goes back to the code step; the next version delivers it, and SFlow approves the clean check', slowLane({ timeout: 1_500_000 }), async (t) => {
  const { storyAtVerification } = await import('./helpers/story-to-verification.mjs');
  const W = 'JRN-W';
  const REQ = `${W}:REQ-002`;
  const sections = [];
  const readCheck = ({ cli }) => sections.push(JSON.parse(cli('decisions', W, '--json').stdout).data?.approvalEvidence?.convergence ?? null);
  const story = await storyAtVerification(t, W, { untested: REQ, onCodeSubmitted: readCheck, atConvergence: async (at) => at });
  const { cli, run, item, write } = story;
  const json = (args) => { const text = cli(...args).stdout; return JSON.parse(text.slice(text.search(/^\{/mu))); };
  const record = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  await check(t, 'the code approval already carried the gap, the code step\'s own to fix', {}, () => {
    const [first] = sections;
    assert.equal(first?.clean, false, JSON.stringify(first));
    assert.equal(first.requirements.find((entry) => entry.status === 'gap')?.clause, REQ, JSON.stringify(first));
    assert.ok(first.gaps.length && first.gaps.every((gap) => gap.fixedBy === 'code-step'), JSON.stringify(first.gaps));
  });
  const listed = json(['story', 'adjudications', '--json']);
  const gaps = listed.items.filter((entry) => entry.clauseIds.includes(REQ));
  await check(t, 'the convergence check found the gap and does not approve itself', {}, async () => {
    assert.ok(gaps.length, JSON.stringify(listed.items));
    const refused = run(process.execPath, [CLI, '--no-model', 'story', 'advance', '--work-id', W, '--json'], { allowFailure: true });
    assert.notEqual(refused.status, 0, refused.stdout.slice(-1500));
    assert.match(refused.stdout + refused.stderr, /CONVERGENCE_REVIEW_REQUIRED|cannot advance/u);
    const now = await record();
    assert.equal(now.phases.convergence.status, 'in_progress');
    assert.equal(now.phases.convergence.approvalDisposition ?? null, null);
  });
  // The person's decision, as the decisions card's "Send back to fix" records it (no reason on a fact SFlow found itself).
  for (const entry of listed.items) {
    cli('story', 'adjudicate', entry.id, '--disposition', gaps.includes(entry) ? 'rework' : 'dismissed', ...(gaps.includes(entry) ? [] : ['--reason', 'Not part of this Story.']));
  }
  cli('story', 'rework', '--confirm');
  await check(t, 'the gap went back to the code step, with the requirement it is about', {}, async () => {
    const now = await record();
    assert.equal(now.currentPhase, 'implementation');
    const request = now.changeRequests.at(-1);
    assert.deepEqual([request.sourcePhase, request.targetPhase], ['convergence', 'implementation'], JSON.stringify(request));
    assert.ok(request.clauseIds.includes(REQ), JSON.stringify(request));
  });
  // Version 2 of the code delivers the test the plan names.
  const preview = json(['phase', 'rollover', 'implementation', '--json']);
  cli('phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json');
  cli('prepare', 'implementation');
  await write('test/second.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';", '',
    `// @ac:${REQ}`, "test('the application returns that same approved value', () => assert.equal(value, 1));", ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  readCheck(story);
  cli('approve', 'implementation', '--yes');
  cli('prepare', 'convergence');
  cli('phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator');
  const digest = json(['story', 'advance', '--work-id', W, '--json']).confirmationDigest;
  cli('story', 'advance', '--work-id', W, '--confirm', digest);
  await check(t, 'the next version delivers it, and SFlow approves the clean check: no person approves convergence', {}, async () => {
    assert.equal(sections[1]?.clean, true, JSON.stringify(sections[1]));
    const now = await record();
    assert.equal(now.phases.convergence.approvalDisposition, 'approved_automatically', JSON.stringify(now.phases.convergence.automaticApproval ?? null));
    assert.deepEqual((now.phases.convergence.approvals ?? []).filter((entry) => entry?.decision === 'approved'), []);
    assert.match(now.phases.convergence.automaticApproval.checked.join('; '), /the convergence check found every requirement delivered/u);
    assert.equal(now.currentPhase, 'verification');
  });
  settle(t);
});

// ------------------------------------------------------------------------------------------- X

// Daily run 2026-11-22: since a ready version is submitted in the turn that wrote it (ceremony cut 2), a quick design's
// Implement, which nobody approves, completes in its own turn and the Story moves on to Verify. The person's change then
// had three dead ends: `/sf-code <change>` built Verify and dropped their words, `/sf-code implement <change>` said there
// was nothing to implement, and `phase rollover implement` refused. Now each asks "Start version 2 of Implement for this
// change?", and on the person's yes the Story goes back to Implement, version 2 opens, the change is made there, and Verify
// runs again after it (completed-step-change.mjs).
test('journey X: a change typed after a code step nobody approves has finished goes back to it on one yes, is made there, and Verify runs again', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-X';
  const story = await journeyRepository(t, { configure: (configuration) => {
    Object.assign(configuration, packagedWorkflowWithoutIntents(configuration, 2));
    delete configuration.phases['fix-design'].clarification;
    configuration.workTypes['quick-design'] = { ...configuration.workTypes['quick-fix'], label: 'Quick design', phases: ['intake', 'fix-design', 'implement', 'verify'],
      sourceReview: { mode: 'off' } };
  } });
  startStory(story, W, { workType: 'quick-design', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  story.cli('prepare', 'fix-design');
  await story.write(`${story.item}/artifacts/fix-design/fix-design.md`, [`# ${W} — Fix Design`, '', '## Root cause', '',
    'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
    `Change the one literal that holds the value, as ${W}:AC-001 asks; no import changes.`, '', '## Alternatives and regression risk', '',
    'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
  story.cli('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'fix-design');
  story.cli('approve', 'fix-design', '--yes');

  // Version 1 of the code: written, published and submitted in its own turn, which completes Implement.
  let note = 'returns the approved value to its callers';
  const author = async ({ story: s, phase }) => phase === 'implement' && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], note }), true);
  const person = cooperativePerson(({ act }) => (/^What would you like to validate\b/u.test(act?.ask?.question ?? '')
    ? { route: { shell: `singularity-flow nextsteps ${W} --json` } } : null));
  const written = await followRoutes(story, { label: 'journey X, version 1', start: { copilot: '/sf-code implement' }, agent: { author, review: reviewer() }, person,
    done: ({ record }) => record?.phases?.implement?.status === 'approved', maxSteps: 20 });
  t.diagnostic(formatTrail(written.trail));
  assert.equal(written.reached, true, report(written));
  assert.equal(storyRecord(story).phases.implement.approvalDisposition, 'not_required');

  const change = 'Start each value comment with "[value]".';
  const question = /^Start version 2 of Implement for this change\? The Story goes back to Implement: version 1 and its tests stay as published/u;
  copilotTurn(story, 'journey-x-change').prompt(`/sf-code ${change}`);
  await check(t, 'the words typed after /sf-code are Implement\'s, and every way in asks the same question, never Verify\'s work', {}, () => {
    for (const args of [['phase', 'enter', '--compose', '--for-agent', '--json'], ['phase', 'enter', 'implement', '--compose', '--for-agent', '--json']]) {
      const entered = json(story.raw(args).stdout);
      assert.equal(entered?.act?.state, 'confirm', JSON.stringify(entered).slice(0, 3000));
      assert.match(entered.act.ask?.question ?? '', question, JSON.stringify(entered.act));
      assert.match(entered.act.do?.shell ?? '', /^singularity-flow phase rollover implement --json$/u, JSON.stringify(entered.act));
    }
    // Their own terminal's preview asks it too; nothing changes until the person says yes.
    const preview = json(story.raw(['phase', 'rollover', 'implement', '--json']).stdout);
    assert.equal(preview?.kind, 'person-change', JSON.stringify(preview).slice(0, 2000));
    assert.match(preview.question, question);
    assert.deepEqual(preview.requestedChange?.requests, [change]);
    assert.equal(storyRecord(story).currentPhase, 'verify');
  });

  // One /sf-code turn, as the daily run's (2026-11-22 09:47): the preview, the person's yes to the question tool, its
  // confirmation, and then the change in Implement in that same turn. Before, the guard refused the turn's next command
  // ("The phase changed during this turn") and sent the person to a new turn (owner, 2026-11-22: "Continue same turn").
  await check(t, 'the turn that asked goes on in Implement once the person said yes: its entry and its edits are allowed', {}, () => {
    const turn = copilotTurn(story, 'journey-x-one-turn');
    turn.prompt(`/sf-code ${change}`);
    const allowed = (said, what) => assert.notEqual(said?.permissionDecision, 'deny', `${what}: ${said?.permissionDecisionReason ?? ''}`);
    const previewCommand = 'singularity-flow phase rollover implement --json';
    allowed(turn.tool('bash', { command: previewCommand }), 'the preview');
    const preview = json(story.raw(['phase', 'rollover', 'implement', '--json']).stdout);
    turn.tool('ask_user', { question: preview.question, choices: ['Yes', 'No'] });
    turn.after('ask_user', { question: preview.question, choices: ['Yes', 'No'] }, { resultType: 'success', textResultForLlm: 'User responded: Yes' });
    const confirm = `singularity-flow phase rollover implement --confirm ${preview.confirmation} --json`;
    allowed(turn.tool('bash', { command: confirm }), 'the confirmation');
    const opened = story.raw(['phase', 'rollover', 'implement', '--confirm', preview.confirmation, '--json']);
    assert.equal(opened.status, 0, opened.stdout.slice(-1500) + opened.stderr.slice(-1500));
    assert.equal(storyRecord(story).currentPhase, 'implement');
    allowed(turn.tool('bash', { command: 'singularity-flow phase enter implement --compose --for-agent --json' }), 'Implement\'s entry in the same turn');
    allowed(turn.tool('edit', { path: path.join(story.root, 'src/value.mjs') }), 'the change to the code in the same turn');
  });

  // The change is made in version 2, and the Story goes on to its end by its routes.
  note = '[value] returns the approved value to its callers';
  const changed = await followRoutes(story, { label: 'journey X, the change', start: { copilot: '/sf-code implement' }, agent: { author, review: reviewer() }, person,
    done: ({ record }) => publishedGeneration(record, 'implement') >= 2, maxSteps: 20 });
  t.diagnostic(formatTrail(changed.trail));
  assert.equal(changed.reached, true, report(changed));
  // The author accounts for what the person typed, as every view names it (journey Q): the clause the plan covers it by.
  const accounted = story.raw(['departure', 'account', '--work-id', W, '--instruction', '1', '--clauses', `${W}:AC-001`, '--json']);
  assert.equal(accounted.status, 0, accounted.stdout.slice(-1500) + accounted.stderr.slice(-1500));
  const walk = await followRoutes(story, { label: 'journey X, to the end', start: { copilot: '/sf-submit' }, agent: { author, review: reviewer() }, person,
    detour: ({ finding, route }) => (['no-progress', 'dead-end', 'skill-skips-route'].includes(finding.kind) && route.shell ? { shell: route.shell } : null),
    done: ({ record }) => record?.status === 'closed', maxSteps: 40 });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, `the Story never reached its end\n${report(walk)}`);
  const record = storyRecord(story);
  await check(t, 'one yes went back to Implement and opened version 2; the change was made there and Verify ran again', {}, () => {
    const request = (record.changeRequests ?? []).find((entry) => entry.personChange);
    assert.deepEqual([request?.sourcePhase, request?.targetPhase], ['verify', 'implement'], JSON.stringify(record.changeRequests));
    assert.match(request.comment, /\[value\]/u);
    assert.equal(Number(record.phases.implement.generation), 2);
    assert.ok(Number(record.phases.verify.generation) >= 1);
    const settled = (record.settledDecisions ?? []).find((entry) => entry.kind === 'person-change');
    assert.equal(settled?.effect?.toGeneration, 2, JSON.stringify(record.settledDecisions));
    assert.deepEqual((record.askedFor ?? []).map((entry) => [entry.phase, entry.text]), [['implement', change]]);
  });
  await check(t, 'every step went by its routes, with no detour', {}, () => {
    assert.deepEqual([...written.findings, ...changed.findings, ...walk.findings], [], `${report(written)}\n${report(changed)}\n${report(walk)}`);
  });
  settle(t);
});
