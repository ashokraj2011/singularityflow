/**
 * Journey tests, full tier (slow lane) [owner, 2026-11-16]: whole Stories driven by their own routes, as an agent and a
 * person take them (test/helpers/route-follower.mjs), each reproducing an incident of 2026-11-16 as a check. The fast
 * tier (journey C, the quick fix's first step, the skill entry map) is test/journey-routes.test.mjs.
 *
 *   A  a spec-driven Story from its start to its release, every step reviewed;
 *   B  a code review asks for corrections: version 2 through the routes, the fix published, re-reviewed, submitted, approved;
 *   D  a required test fails for an environment reason (the wrong Node): the decisions card, the pin, the re-publish;
 *   E  a person answers after the 30-minute turn window: the turn renews.
 *
 * A check that fails on main until its fix branch lands is reported as todo with that branch (KNOWN_BAD in
 * test/helpers/journey-scripts.mjs) and counts once the branch lands.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { check, clarifications, cooperativePerson, decideCard, quickFixIntake, report, reviewer, scopeAnswers, settle, specDrivenAuthor, writeValueCode } from './helpers/journey-scripts.mjs';
import { copilotTurn, entryCommand, followRoutes, formatTrail, journeyRepository, publishedGeneration, returnedRoute, skillEntries, startStory, storyRecord } from './helpers/route-follower.mjs';
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
  // Until the continuation is right, the person types its Shell line at their terminal, so the rest is still checked.
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
  await check(t, 'the reviewer\'s reply carries the next step: a route, and the words to relay', { knownBad: 'review-next' }, () => {
    const { act, continuation } = first.trail[reviewAt].retained;
    assert.ok(returnedRoute({ act, continuation }), JSON.stringify({ act, continuation }).slice(0, 2000));
    assert.match(String(act?.show ?? ''), /- Copilot: `?\/sf-/u, `the reply's next step to show: ${JSON.stringify(act ?? null).slice(0, 1500)}`);
  });
  await check(t, 'the correction\'s continuation opens version 2 by its routes, with no detour', { knownBad: 'review-next' }, () => {
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
  await check(t, 'after the rollover, /sf-recover routes the code step to its author, never /sf-phase-documents', { knownBad: 'review-next' }, () => {
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
  await check(t, 'the person\'s answer on the card renews the turn: its next edit goes on', { knownBad: 'turn-renew' }, () => {
    const after = turn.tool('edit', edit);
    assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  });
  // The same through the turn's own question tool: a second turn, asked in chat and answered 31 minutes in.
  const asked = copilotTurn(story, 'journey-e-ask-turn');
  asked.prompt('/sf-code');
  asked.age(31);
  asked.answered('Pin Node 22.');
  await check(t, 'the person\'s answer to the turn\'s question renews it too', { knownBad: 'turn-renew' }, () => {
    const after = asked.tool('edit', edit);
    assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  });
  settle(t);
});
