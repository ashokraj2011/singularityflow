/**
 * A yes kept for one person, and another person opening the version (review of the opening flow, 2026-11-17, finding 4).
 * The kept grant was read before anything else, so the second person's own yes, typed in their terminal, was ignored and
 * the opening refused VERSION_CONSENT_PRINCIPAL_CHANGED again and again for the grant's 30 minutes; its route was the
 * terminal-only preview, with no --json for an agent. Now the person opening it gives their own yes: their new answer is
 * preferred over a grant another person gave, that grant is dropped on the refusal, and the route is the step's preview
 * [D3, OSA:REQ-030].
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { copilotTurn, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';

const W = 'VCP-1';
const json = (story, args, { fail = false, env = null } = {}) => {
  const ran = story.raw([...args, '--json'], env ? { environment: env } : {});
  if (!fail) assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-2000)}`);
  return { status: ran.status, value: JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null') };
};
const grantFile = (story, digest) => path.join(story.root, '.git', 'singularity-flow', 'version-consents',
  `${createHash('sha256').update(digest).digest('hex').slice(0, 40)}.grant.json`);

/** A published intake, a change previewed by the first person, and their yes on the card. */
async function keptByFirst(t) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  const preview = json(story, ['phase', 'rollover', 'intake', '--reason', 'Name the callers that read the value.']).value;
  const listed = json(story, ['decisions', W]).value;
  const opening = (listed.data ?? listed).versionOpening;
  json(story, ['decisions', 'record', W, '--version-consent', opening.confirmation, '--expect', opening.digest]);
  assert.equal(existsSync(grantFile(story, opening.digest)), true);
  return { story, preview, opening, other: { ...story.env, SINGULARITY_FLOW_TEST_IDENTITY: 'Other Person' } };
}

test('another person\'s kept yes never stands for this person in a Copilot turn: refused once with the step\'s preview, and the grant is dropped', async (t) => {
  const { story, preview, opening, other } = await keptByFirst(t);
  // Another person works in this checkout now, in a Copilot turn bound to the Story: their own yes has not reached SFlow.
  copilotTurn(story, 'other-person').prompt('/sf-phase intake');
  const refused = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation], { fail: true, env: other }).value;
  assert.equal(refused.error?.code, 'VERSION_CONSENT_PRINCIPAL_CHANGED', JSON.stringify(refused).slice(0, 2000));
  const named = typeof refused.error.details.nextAction === 'string' ? refused.error.details.nextAction : refused.error.details.nextAction?.command;
  assert.equal(named, 'singularity-flow phase rollover intake --json', JSON.stringify(refused.error.details));
  assert.equal(existsSync(grantFile(story, opening.digest)), false, 'the other person\'s yes is dropped on this refusal');
  // Asked again, it is no longer that refusal: this person's own yes is what is missing, and its route is the preview.
  const again = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation], { fail: true, env: other }).value;
  assert.equal(again.error?.code, 'VERSION_CONSENT_REQUIRED', JSON.stringify(again).slice(0, 2000));
});

test('another person confirming in their own terminal is their own new yes: it is preferred over the first person\'s kept grant and opens the version', async (t) => {
  const { story, preview, other } = await keptByFirst(t);
  // Outside every Copilot turn bound to the Story: the exact confirmation run there is the person's own yes [§7.1].
  const opened = json(story, ['phase', 'rollover', 'intake', '--confirm', preview.confirmation], { fail: true, env: other }).value;
  assert.equal(opened.error, undefined, JSON.stringify(opened).slice(0, 2000));
  assert.equal(opened.mutates, true);
  const record = JSON.parse(await readFile(path.join(story.root, story.item, 'context/version-openings/intake-v2.json'), 'utf8'));
  assert.equal(record.consent.principal.identity.name, 'Other Person');
  assert.equal(record.consent.response.surface, 'terminal');
  assert.equal(storyRecord(story).phases.intake.versionOpening.version, 2);
});
