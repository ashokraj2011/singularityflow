/**
 * SPEC-OSA v1.1 Stage 4 qualification journeys, slow lane (plan section 6): every walk follows SFlow's own routes through
 * the real pre-tool guard (test/helpers/route-follower.mjs) [OSA:AC-010–AC-013].
 *
 *   J   a fresh-chat /sf-next completes the current step's agent work, a code step and a document step, without a second
 *       relay command: the work command's steps run in /sf-next's own turn [D2, OSA:REQ-025];
 *   D1  /sf-code and /sf-phase give the same targets and the same behaviour on a code step, a document step and a
 *       kernel-built step [OSA:REQ-024];
 *   D5  a kernel-built step is built by its declared generator in the work command's turn, and its next version opens on
 *       the person's send-back (their yes, never asked again: ask once, 2026-11-28) before its generator builds it, with
 *       refusing AI and harness ports: no model and no Copilot runs [OSA:REQ-026].
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { clarifications, cooperativePerson, quickFixIntake, report, reviewer, writeValueCode } from './helpers/journey-scripts.mjs';
import { followRoutes, formatTrail, journeyRepository, publishedGeneration, startStory, storyRecord } from './helpers/route-follower.mjs';
import { reviewStep } from './helpers/step-review.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const posix = process.platform === 'win32' ? { skip: 'the refusing ports are shell scripts' } : {};

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

/**
 * Refusing AI and harness ports: Copilot's executables on PATH record any run and fail, so no harness runs; with
 * SINGULARITY_FLOW_NO_MODEL (journeyRepository sets it), every kernel-owned model invocation is refused too.
 */
async function refusingPorts(base) {
  const bin = path.join(base, 'refusing-ports');
  const log = path.join(base, 'ports-invoked.log');
  await mkdir(bin, { recursive: true });
  for (const name of ['copilot', 'github-copilot-cli']) {
    await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 97\n`);
    await chmod(path.join(bin, name), 0o755);
  }
  return { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, invoked: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}

const typedCommands = (walk) => walk.trail.filter((entry) => entry.typed).map((entry) => entry.taking);
const ranCommands = (walk) => walk.trail.map((entry) => entry.ran).filter(Boolean).map((line) => line.replace(/ --for-agent| --json/gu, ''));

const codeAuthor = (W) => async ({ story, phase }) => {
  if (phase !== 'implement') return false;
  await writeValueCode(story, { value: 2, clauses: [`${W}:AC-001`] });
  return true;
};
const intakeAuthor = (W) => async ({ story, phase }) => {
  if (phase !== 'intake') return false;
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  return true;
};

test('journey J: a fresh-chat /sf-next writes, publishes and reviews a code step in its own turn, with no second command typed', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRN-J1';
  const story = await quickFixAtCode(t, W);
  const walk = await followRoutes(story, {
    label: 'journey J, code', start: { copilot: '/sf-next' },
    agent: { author: codeAuthor(W), review: reviewer() }, person: cooperativePerson(),
    done: ({ trail }) => trail.some((entry) => /the reviewer wrote, checked and retained/u.test(entry.did ?? '')), maxSteps: 30
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  assert.deepEqual(walk.findings, [], report(walk));
  assert.deepEqual(typedCommands(walk), ['/sf-next'], `the person typed only /sf-next\n${report(walk)}`);
  assert.ok(walk.trail.some((entry) => entry.within === '/sf-next' && /^\/sf-code\b/u.test(entry.taking ?? '')), `/sf-code's steps ran inside /sf-next's turn\n${report(walk)}`);
  assert.ok(walk.trail.some((entry) => /the agent wrote implement \([1-9]\d* file\(s\) through the guard\)/u.test(entry.did ?? '')), report(walk));
  assert.ok(ranCommands(walk).some((line) => /^singularity-flow phase begin implement\b/u.test(line)), 'the code version opened in the same turn');
  assert.ok(publishedGeneration(storyRecord(story), 'implement') >= 1);
});

test('journey J: a fresh-chat /sf-next writes and publishes a document step in its own turn, with no second command typed', slowLane({ timeout: 900_000 }), async (t) => {
  const W = 'JRN-J2';
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  const walk = await followRoutes(story, {
    label: 'journey J, document', start: { copilot: '/sf-next' },
    agent: { author: intakeAuthor(W), review: reviewer(), clarify: clarifications() }, person: cooperativePerson(),
    done: ({ record }) => publishedGeneration(record, 'intake') >= 1, maxSteps: 25
  });
  t.diagnostic(formatTrail(walk.trail));
  assert.equal(walk.reached, true, report(walk));
  assert.deepEqual(walk.findings, [], report(walk));
  assert.deepEqual(typedCommands(walk), ['/sf-next'], `the person typed only /sf-next\n${report(walk)}`);
  assert.ok(walk.trail.some((entry) => entry.within === '/sf-next' && /^\/sf-phase\b/u.test(entry.taking ?? '')), `/sf-phase's steps ran inside /sf-next's turn\n${report(walk)}`);
  assert.ok(walk.trail.some((entry) => /the agent wrote intake \([1-9]\d* file\(s\) through the guard\)/u.test(entry.did ?? '')), report(walk));
});

test('D1: /sf-code on a document step and /sf-phase on a code step do exactly what the other name does', slowLane({ timeout: 1_200_000 }), async (t) => {
  const walks = {};
  for (const [label, skill] of [['code by /sf-code', '/sf-code'], ['code by /sf-phase', '/sf-phase']]) {
    const W = skill === '/sf-code' ? 'D1-C1' : 'D1-C2';
    const story = await quickFixAtCode(t, W);
    walks[label] = await followRoutes(story, { label, start: { copilot: skill },
      agent: { author: codeAuthor(W), review: reviewer() }, person: cooperativePerson(),
      done: ({ record }) => publishedGeneration(record, 'implement') >= 1, maxSteps: 25 });
    t.diagnostic(`${label}\n${formatTrail(walks[label].trail)}`);
  }
  for (const [label, skill] of [['document by /sf-code', '/sf-code'], ['document by /sf-phase', '/sf-phase']]) {
    const W = skill === '/sf-code' ? 'D1-D1' : 'D1-D2';
    const story = await journeyRepository(t);
    startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
    walks[label] = await followRoutes(story, { label, start: { copilot: skill },
      agent: { author: intakeAuthor(W), review: reviewer(), clarify: clarifications() }, person: cooperativePerson(),
      done: ({ record }) => publishedGeneration(record, 'intake') >= 1, maxSteps: 25 });
    t.diagnostic(`${label}\n${formatTrail(walks[label].trail)}`);
  }
  for (const walk of Object.values(walks)) {
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
    assert.equal(typedCommands(walk).length, 1, `one command typed, never a relay to the other name\n${report(walk)}`);
  }
  // The same commands, in the same order, whichever name was typed (the Work ID aside).
  const same = (label) => ranCommands(walks[label]).map((line) => line.replace(/\bD1-[CD][12]\b/gu, '<W>'));
  assert.deepEqual(same('code by /sf-phase'), same('code by /sf-code'));
  assert.deepEqual(same('document by /sf-code'), same('document by /sf-phase'));
});

test('D5: a kernel-built step is built by its generator in the work command\'s turn, the same from /sf-code, /sf-phase and /sf-next, with no model and no harness', { ...posix, ...slowLane({ timeout: 900_000 }) }, async (t) => {
  const walks = {};
  for (const skill of ['/sf-code', '/sf-phase', '/sf-next']) {
    const W = `KB-${skill.slice(4, 8).toUpperCase()}`;
    const story = await journeyRepository(t);
    const ports = await refusingPorts(story.base);
    Object.assign(story.env, { PATH: ports.env.PATH });
    startStory(story, W, { workType: 'poc-lite', title: 'Change the value', description: 'Return 2.' });
    const walk = await followRoutes(story, { label: `POC Lite plan from ${skill}`, start: { copilot: skill },
      agent: { author: async () => false }, person: cooperativePerson(),
      done: ({ record }) => publishedGeneration(record, 'poc-lite-plan') >= 1, maxSteps: 10 });
    t.diagnostic(`${skill}\n${formatTrail(walk.trail)}`);
    assert.equal(walk.reached, true, report(walk));
    assert.deepEqual(walk.findings, [], report(walk));
    assert.deepEqual(typedCommands(walk), [skill], report(walk));
    assert.ok(ranCommands(walk).includes('singularity-flow prepare poc-lite-plan'), 'its generator ran');
    assert.deepEqual(ports.invoked(), [], 'no AI or harness port was called');
    const authorship = storyRecord(story).phases['poc-lite-plan'].authorship?.at(-1) ?? {};
    assert.match(JSON.stringify(authorship), /deterministic/u, JSON.stringify(authorship));
    walks[skill] = ranCommands(walk).map((line) => line.replace(/\bKB-[A-Z]+\b/gu, '<W>')).filter((line) => !/^singularity-flow nextsteps\b/u.test(line));
  }
  assert.deepEqual(walks['/sf-phase'], walks['/sf-code'], 'the two names build it the same way');
  assert.deepEqual(walks['/sf-next'], walks['/sf-code'], '/sf-next builds it in its own turn, the same way');
});

test('D5: a kernel-built step a person sent back opens its next version on that send-back, then its generator builds it; no model, no harness', { ...posix, ...slowLane({ timeout: 600_000 }) }, async (t) => {
  const W = 'KB-RET';
  const story = await journeyRepository(t, { configure: (configuration) => {
    // The plan returns to itself: a kernel-built step with a person's approval, so a return reopens it.
    configuration.phases['poc-lite-plan'].approval = { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['poc-lite-plan'] };
  } });
  const ports = await refusingPorts(story.base);
  Object.assign(story.env, { PATH: ports.env.PATH });
  startStory(story, W, { workType: 'poc-lite', title: 'Change the value', description: 'Return 2.' });
  const run = (...args) => { const ran = story.raw([...args, '--json']); return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null'), stderr: ran.stderr }; };
  // Version 1, built and published by its generator, then submitted and returned by its person.
  assert.equal(run('prepare', 'poc-lite-plan').status, 0);
  const published = run('phase', 'prepublish', 'poc-lite-plan', '--for-agent', '--publish-if-ready');
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 2000));
  assert.equal(publishedGeneration(storyRecord(story), 'poc-lite-plan'), 1, JSON.stringify(published.value?.act ?? published.value).slice(0, 2000));
  story.cli('submit', 'poc-lite-plan');
  story.cli('reject', 'poc-lite-plan', '--to', 'poc-lite-plan', '--reason', 'The plan must name the changed module explicitly.');
  // The person's send-back answers "Start version 2?" (ask once, owner 2026-11-28): the kernel's route starts it on that
  // answer, by the step's work command; its generator does not run first.
  const shown = run('phase', 'show', 'poc-lite-plan');
  const next = shown.value?.continuation?.nextAction ?? null;
  assert.match(next?.command ?? '', /^singularity-flow phase rollover poc-lite-plan --sent-back --json$/u, JSON.stringify(shown.value?.continuation ?? shown.value).slice(0, 2000));
  assert.match(next?.skill ?? next?.copilotCommand ?? '', /^\/sf-phase\b/u);
  const refused = run('prepare', 'poc-lite-plan');
  assert.notEqual(refused.status, 0, 'the generator never builds a successor before it opens');
  assert.equal(refused.value?.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(refused.value).slice(0, 1500));
  // The start on the send-back opens version 2 through the opening operation, settled with the person's reason.
  const opened = run('phase', 'rollover', 'poc-lite-plan', '--sent-back');
  assert.equal(opened.status, 0, JSON.stringify(opened.value).slice(0, 2000));
  assert.match(opened.value.line, /^Using your answer from .* version 1: "The plan must name the changed module explicitly\." SFlow started version 2 /u);
  const opening = JSON.parse(readFileSync(path.join(story.root, story.item, 'context/version-openings/poc-lite-plan-v2.json'), 'utf8'));
  assert.equal(opening.consent, null);
  assert.equal(opening.settled?.kind, 'sent-back');
  assert.equal(opening.proposal.version, 2);
  // Then its generator builds version 2, and it is published.
  assert.equal(run('prepare', 'poc-lite-plan').status, 0);
  const second = run('phase', 'prepublish', 'poc-lite-plan', '--for-agent', '--publish-if-ready');
  assert.equal(second.status, 0, JSON.stringify(second.value).slice(0, 2000));
  assert.equal(publishedGeneration(storyRecord(story), 'poc-lite-plan'), 2, JSON.stringify(second.value?.act ?? second.value).slice(0, 2000));
  assert.deepEqual(ports.invoked(), [], 'no AI or harness port was called');
});
