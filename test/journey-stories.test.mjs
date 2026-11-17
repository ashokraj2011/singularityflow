/**
 * Journey tests, full tier (slow lane) [owner, 2026-11-16]: whole Stories driven by their own routes, as an agent and a
 * person take them (test/helpers/route-follower.mjs), each reproducing an incident of 2026-11-16 as a check. The fast
 * tier (journey C, the quick fix's first step, the skill entry map) is test/journey-routes.test.mjs.
 *
 *   A  a spec-driven Story from its start to its release, every step reviewed;
 *   B  a code review asks for corrections: version 2 through the routes, the fix published, re-reviewed, submitted, approved;
 *   D  a required test fails for an environment reason (the wrong Node): the decisions card, the pin, the re-publish;
 *   E  a person answers after the 30-minute turn window: the turn renews;
 *   F  a code step returned for rework is written again, republished, its review asks corrections, the person is asked
 *      "Start version 3?", and it goes on to its submission [OSA:AC-013];
 *   G  version 2 open on a step with no review: submit refuses with the route to write it, which is then followed
 *      [OSA:REQ-032, AC-013];
 *   I  a document step's review asks corrections, and the person is asked "Start version 2?" as for code [OSA:AC-013];
 *   K  a change typed after /sf-code once the code is published, without the step's name and with it: the entry, its edit
 *      permission, the kernel and the guard all ask "Start version N?", and the routes write and publish the change.
 *   Q  a quick design (daily run, 2026-11-17): a change typed twice is one instruction; published without its account,
 *      every view leads with that account, and the code step nobody approves completes once it is made; the code step is
 *      offered to /sf-code, never as a generated publish; once closed, the Story says it is done.
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
import { argvOf, copilotTurn, entryCommand, followRoutes, formatTrail, journeyRepository, personViews, publishedGeneration, returnedRoute, skillEntries, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

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

// ------------------------------------------------------------------------------------------- A

test('journey A: a spec-driven Story from its start to its release, every step written, reviewed and approved by its routes', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-A';
  const story = await journeyRepository(t, { configure: (configuration) => {
    configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'enforce', phases: ['specification', 'planning'], reviewerAgent: 'sflow-source-reviewer' };
    configuration.workTypes['spec-driven-standard'].spec = { ...(configuration.workTypes['spec-driven-standard'].spec ?? {}), coverage: 'record' };
  } });
  Object.assign(story, { workId: W, item: `singularity/work-items/${W}` });
  const person = cooperativePerson(({ route }) => {
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
  settle(t);
});

// ------------------------------------------------------------------------------------------- B

// Incidents 3, 4 and 5 (2026-11-16): a code review returned correction-required with the continuation /sf-recover,
// which runs `recover --fetch`, finds nothing and never runs the rollover; after the rollover every entry was held
// (SOURCE_REVIEW_RECORD_UNPUBLISHED, fixed in e1574fa2d), and recovery then routed the code step to /sf-phase-documents;
// and a reviewer's reply dropped its next step.
test('journey B: a code review asks for corrections, and version 2 is opened, fixed, re-reviewed, submitted and approved by the routes', slowLane({ timeout: 1_200_000 }), async (t) => {
  const W = 'JRN-B';
  const story = await quickFixAtCode(t, W);
  const clauses = [`${W}:AC-001`];
  const blocking = (phase, packet) => (packet.kind === 'code' && packet.generation === 1 ? [(() => {
    const code = packet.sources.find((source) => source.path === 'src/value.mjs');
    const line = code.text.split('\n').findIndex((text) => text.includes(`@clause:${W}:AC-001`)) + 1;
    return { id: 'explain-the-value', severity: 'blocking', check: 'plan', clauseId: `${W}:AC-001`,
      message: 'The clause comment must say why the value is 2, as the plan row says.', sourceId: code.id, line, quote: `// @clause:${W}:AC-001` };
  })()] : []);
  const author = async ({ story: s, phase, generation }) => {
    if (phase !== 'implement') return false;
    await writeValueCode(s, { value: 2, clauses, note: generation >= 2 || storyRecord(s)?.phases?.implement?.generationIntent?.generation >= 2
      ? 'returns 2, the value the intake approves for every caller' : 'returns the approved value' });
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

  const second = await followRoutes(story, {
    label: 'journey B, version 2 to its submission', start: first.next ?? { copilot: '/sf-code implement' },
    agent: { author, review: reviewer({ findings: blocking }) }, person: cooperativePerson(),
    // The code step needs no approver in a quick fix: submitted, the Story moves on to Verify.
    done: ({ record }) => record?.currentPhase !== 'implement', maxSteps: 20
  });
  t.diagnostic(formatTrail(second.trail));
  await check(t, 'version 2 is fixed, published, re-reviewed ready and submitted by its routes', {}, () => {
    assert.equal(second.reached, true, report(second));
    assert.deepEqual(second.findings, [], report(second));
    assert.equal(storyRecord(story).phases.implement.generation, 2);
    assert.ok(second.trail.some((entry) => /reviewer wrote.*ready/u.test(entry.did ?? '')), report(second));
  });

  // On to the Story's end: Verify is built by the kernel and approved by its group. Should its route break, the person
  // types the Shell line of the route they were given, so the approval is still checked.
  const third = await followRoutes(story, {
    label: 'journey B, Verify to the end', start: second.next ?? { copilot: '/sf-next' },
    agent: { author, review: reviewer() }, person: cooperativePerson(),
    detour: ({ finding, route }) => (['no-progress', 'dead-end', 'skill-skips-route'].includes(finding.kind) && route.shell
      ? { shell: route.shell } : null),
    done: ({ record }) => record?.status === 'closed', maxSteps: 30
  });
  t.diagnostic(formatTrail(third.trail));
  await check(t, 'after the code step, the Story is approved to its end by its routes, with no detour', {}, () => {
    assert.equal(third.reached, true, report(third));
    assert.deepEqual(third.findings, [], report(third));
  });
  assert.equal(third.reached, true, `the Story never reached its end, even with the detour\n${report(third)}`);
  assert.ok(approved(storyRecord(story), 'verify'), JSON.stringify(storyRecord(story).phases.verify?.status));
  // Verify, built by the kernel, is published by its own work command (Stage 3, C9), as in A.
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off', {}, () => {
    for (const walk of [first, second, third]) viewsAgree(walk);
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

test('journey D: a required test fails on the wrong Node, and the decisions card\'s pin lets the step re-publish', { ...posix, ...slowLane({ timeout: 1_200_000 }) }, async (t) => {
  const W = 'JRN-D';
  const story = await wrongNodeStory(t, W);
  const reason = 'Node 18 is not installed here and the package asks for 20 or later.';
  let card = null;
  const person = cooperativePerson(({ route }) => {
    if (!/^\/sf-decide\b/u.test(route.copilot ?? '') && !/^singularity-flow decisions\b/u.test(route.shell ?? '')) return null;
    card = decideCard(story, { reason, choose: (item) => (item.kind === 'node-pin' ? item.options.find((option) => option.id === 'pin-node') : null) });
    return card ? { command: card.command, retry: false } : null;
  });
  const walk = await followRoutes(story, {
    label: 'journey D', start: { copilot: '/sf-code' },
    agent: { author: async ({ story: s, phase }) => phase === 'implement' && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], extraTest: nodeTest }), true), review: reviewer() },
    person, done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 20
  });
  t.diagnostic(formatTrail(walk.trail));
  await check(t, 'the failed required test routes to the decisions card, and the person\'s pin is recorded there', {}, () => {
    const failed = walk.trail.findIndex((entry) => entry.code === 'CODE_TEST_FAILED');
    assert.ok(failed >= 0, `the test never failed on the wrong Node\n${report(walk)}`);
    assert.ok(card?.items?.length, `the card offered no pin\n${report(walk)}`);
    assert.ok(walk.trail.slice(failed).some((entry) => /decisions record/u.test(entry.did ?? '')), report(walk));
  });
  await check(t, 'the pin is the file a person was offered: .nvmrc names 22', {}, async () => {
    assert.equal(await readFile(path.join(story.root, '.nvmrc'), 'utf8'), '22\n');
  });
  await check(t, 'the step re-publishes on the pinned Node by its routes: no loop, no stall, no dead end', {}, () => {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
  });
  // The failed test's wait is its task's, which every view names: the decisions card (Stage 3, durable outcomes).
  await check(t, 'the person\'s views name the agent\'s skill at every hand-off, the decisions card the failed test routes to too', {}, () => viewsAgree(walk));
  settle(t);
});

// ------------------------------------------------------------------------------------------- E

// Incident 2 (2026-11-16): /sf-code opened the decisions card at 09:24; the person confirmed it at 09:57, 34 minutes
// into the turn, and the agent's next edit was denied: the turn's permissions ran 30 minutes from its prompt.
test('journey E: the person answers the card after the 30-minute turn window, and the turn that asked goes on', { ...posix, ...slowLane({ timeout: 900_000 }) }, async (t) => {
  const W = 'JRN-E';
  const story = await wrongNodeStory(t, W);
  // The code step reaches the card as in journey D: written, its required test fails on the wrong Node.
  const walk = await followRoutes(story, {
    label: 'journey E, to the card', start: { copilot: '/sf-code' },
    agent: { author: async ({ story: s, phase }) => phase === 'implement' && (await writeValueCode(s, { value: 2, clauses: [`${W}:AC-001`], extraTest: nodeTest }), true), review: reviewer() },
    person: () => null, done: ({ trail }) => trail.some((entry) => entry.code === 'CODE_TEST_FAILED'), maxSteps: 8
  });
  assert.equal(walk.reached, true, report(walk));
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
// said `phase begin`; republished, a review asking corrections was not asked about as "Start version N?".
test('journey F: a code step returned for rework is written again, its review asks corrections, the person is asked "Start version 3?", and it goes on', slowLane({ timeout: 1_800_000 }), async (t) => {
  const W = 'JRN-F';
  // The code step has an approver here, who returns it for rework.
  const story = await quickFixAtCode(t, W, { configure: (configuration) => {
    configuration.workTypes['quick-fix'].phaseOverrides.implement = { ...(configuration.workTypes['quick-fix'].phaseOverrides.implement ?? {}),
      approval: { authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['implement'] } };
  } });
  const agent = { author: versionedAuthor(W), review: reviewer({ findings: explainTheValue(W, 2) }) };
  // Version 1: written, reviewed ready and submitted by the routes; the approver then returns it.
  const first = await followRoutes(story, { label: 'journey F, version 1', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(() => null),
    done: ({ record }) => record?.phases?.implement?.status === 'awaiting_approval', maxSteps: 24 });
  t.diagnostic(formatTrail(first.trail));
  assert.equal(first.reached, true, report(first));
  const rejected = story.raw(['reject', 'implement', '--work-id', W, '--to', 'implement', '--reason', 'Say in the code why the value is 2.', '--yes', '--json']);
  assert.equal(rejected.status, 0, rejected.stdout.slice(-2000) + rejected.stderr.slice(-2000));
  assert.ok(storyRecord(story).phases.implement.reworkRevalidation, 'the code step was returned for rework');

  // The rework: written again, republished as version 2, and its review asks corrections.
  const corrections = ({ trail }) => trail.some((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? ''));
  const rework = await followRoutes(story, { label: 'journey F, the rework', start: { copilot: '/sf-code' }, agent, person: cooperativePerson(),
    done: corrections, maxSteps: 20 });
  t.diagnostic(formatTrail(rework.trail));
  await check(t, 'the returned code step asks the person to start version 2 in its own entry, then writes it: no opening without their yes', {}, () => {
    assert.equal(rework.reached, true, report(rework));
    assert.deepEqual(rework.findings, [], report(rework));
    // A person's return reopens the step, and its next version still opens only on their yes [D3, OSA:REQ-030]: the entry
    // asks "Start version 2?", and only then does the confirmation run, through the guard; nothing is prepared, begun or
    // written before it [C13].
    const text = (item) => `${item.ran ?? ''} ${item.did ?? ''}`;
    const asked = rework.trail.findIndex((item) => item.act === 'confirm');
    const confirmed = rework.trail.findIndex((item) => /phase rollover implement --confirm /u.test(text(item)));
    assert.ok(asked >= 0 && confirmed >= asked, report(rework));
    assert.ok(rework.trail.slice(0, confirmed).every((item) => !/^singularity-flow (?:prepare|phase begin)\b/u.test(item.ran ?? '')), report(rework));
    assert.equal(storyRecord(story).phases.implement.generation, 2);
  });
  await check(t, 'after the rewrite\'s review asks corrections, the person is asked "Start version 3?" before it opens', {}, () => {
    const entry = json(story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']).stdout);
    assert.equal(entry?.act?.state, 'confirm', JSON.stringify(entry?.act ?? entry).slice(0, 1500));
    assert.match(String(entry.act.ask?.question ?? ''), /^Start version 3\b/u);
    assert.equal(storyRecord(story).phases.implement.generationIntent?.status, 'consumed', 'version 3 is not open before the person says yes');
  });

  // Onward: the person says yes, version 3 opens through the opening operation on that yes, and is written, reviewed
  // ready and submitted by its routes.
  const onward = await followRoutes(story, { label: 'journey F, version 3', start: rework.next ?? { copilot: '/sf-code' }, agent, person: cooperativePerson(),
    done: ({ record }) => record?.phases?.implement?.status === 'awaiting_approval' && Number(record.phases.implement.generation) === 3, maxSteps: 24 });
  t.diagnostic(formatTrail(onward.trail));
  await check(t, 'version 3 is opened on the person\'s yes, written, reviewed ready and submitted by its routes', {}, () => {
    assert.equal(onward.reached, true, report(onward));
    assert.deepEqual(onward.findings, [], report(onward));
    // The person's yes comes first: the walk asked "Start version 3?" before the version opened.
    assert.ok(onward.trail.some((entry) => entry.act === 'confirm' && /:consumed2\]?$/u.test(entry.state ?? '')), report(onward));
    assert.ok(onward.trail.some((entry) => /reviewer wrote.*ready/u.test(entry.did ?? '')), report(onward));
  });
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

// ------------------------------------------------------------------------------------------- I

// Journey I (SPEC-OSA v1.1 §12.2): the same consent rule for a document's corrections. The planning step's independent
// review asks corrections of version 1; the person is asked "Start version 2 of Planning to fix the review's findings?"
// before anything of version 2 opens, and only their yes opens it, through the opening operation with their receipt;
// version 2 is written, reviewed ready, submitted and approved by its routes [D3, OSA:REQ-030, REQ-020, AC-013].
test('journey I: a document step\'s review asks corrections, the person is asked "Start version 2?", and the step goes on by its routes', slowLane({ timeout: 1_800_000 }), async (t) => {
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
  await check(t, 'the review asked corrections of version 1, and the person was asked "Start version 2 of Planning" before it opened', {}, () => {
    const corrections = walk.trail.findIndex((entry) => /reviewer wrote.*correction-required/u.test(entry.did ?? '') && /planning/u.test(entry.state ?? ''));
    assert.ok(corrections > 0, report(walk));
    const asked = walk.trail.findIndex((entry, index) => index > corrections && entry.act === 'confirm');
    const confirmed = walk.trail.findIndex((entry) => /phase rollover planning .*--confirm /u.test(`${entry.ran ?? ''} ${entry.did ?? ''}`));
    assert.ok(asked > corrections && confirmed >= asked, report(walk));
    // Nothing of version 2 was prepared before the person's yes.
    assert.ok(walk.trail.slice(corrections, confirmed).every((entry) => !/^singularity-flow prepare planning\b/u.test(entry.ran ?? '')), report(walk));
  });
  await check(t, 'version 2 opened through the opening operation with the person\'s receipt, for the review\'s corrections', {}, () => {
    const planning = storyRecord(story).phases.planning;
    assert.equal(planning.generation, 2);
    assert.equal(planning.versionOpening?.version, 2);
    assert.equal(planning.versionOpening?.reason, 'review-corrections');
    assert.ok(planning.versionOpening?.consent?.receiptId, JSON.stringify(planning.versionOpening ?? null));
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
