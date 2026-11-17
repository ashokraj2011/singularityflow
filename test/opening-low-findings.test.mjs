/**
 * Two low findings of the review of the opening flow (2026-11-17):
 *   - 7: a step with nothing published whose version 1 was reserved before (the kernel's `watermark` successor, published 0
 *     and its next number above 1) asks the person's yes through the step's preview, but `phase rollover` sent it to the
 *     requested-change preview, which refused GENERATION_ROLLOVER_UNAVAILABLE with no route. It is a successor awaiting
 *     consent like a returned one;
 *   - 8a: an approved intent amendment recorded before `acknowledgementRequired` existed holds the step until it is
 *     acknowledged (the hold, the preview refusal and the version question read `!== false`), but the decisions card listed
 *     only `=== true`, so the person had nothing to click. One predicate now says what is owed, everywhere.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { successorAwaitsConsent } from '../src/commands/phase-opening.mjs';
import * as policy from '../src/source-review-policy.mjs';
import { journeyRepository, startStory } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';

test('a step with nothing published whose earlier reservation used version 1 awaits the person\'s yes through the step\'s preview', async () => {
  const workflow = { workItem: { id: 'LOW-7' }, currentPhase: 'intake', status: 'in_progress',
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 0, generationHighWatermark: 1, generationPolicy: {} } } };
  assert.equal(await successorAwaitsConsent(workflow, workflow.phases.intake), true, 'its version 2 opens on the person\'s yes');
  // Version 1 with nothing reserved before is no successor: it opens without consent, as before.
  const initial = { ...workflow, phases: { intake: { ...workflow.phases.intake, generationHighWatermark: 0 } } };
  assert.equal(await successorAwaitsConsent(initial, initial.phases.intake), false);
});

test('an approved amendment that owes its acknowledgement is owed in every reader, a legacy one without the field included', async (t) => {
  const legacy = { id: 'AMD-001', status: 'approved', changedClauses: ['LOW-8:AC-001'] };
  const marked = { ...legacy, acknowledgementRequired: true, acknowledgedAt: null };
  const none = { ...legacy, acknowledgementRequired: false };
  const done = { ...legacy, acknowledgedAt: '2026-11-17T10:00:00.000Z' };
  assert.equal(policy.pendingIntentAmendmentAcknowledgement({ intentAmendments: [legacy] })?.id, 'AMD-001');
  // The decisions card lists what holds the step: a legacy approved amendment is an item there, with its acknowledgement.
  const story = await journeyRepository(t);
  startStory(story, 'LOW-8', { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake('LOW-8'));
  const inherited = { ...process.env };
  Object.assign(process.env, story.env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in inherited)) delete process.env[key]; Object.assign(process.env, inherited); });
  const [{ loadAcceptedStoryExecution }, { decisionListFacts }] = await Promise.all([import('../src/accepted-story-execution.mjs'), import('../src/decision-list-reads.mjs')]);
  const { config, workflow } = await loadAcceptedStoryExecution(story.root, 'LOW-8');
  workflow.intentAmendments = [legacy];
  const facts = await decisionListFacts(story.root, config, workflow, { reuse: false });
  assert.deepEqual(facts.pending.intentAmendments.map((entry) => entry.id), ['AMD-001'], JSON.stringify(facts.pending.intentAmendments));
  // One predicate, the hold's, says it for every reader.
  const owed = (entry) => Boolean(policy.pendingIntentAmendmentAcknowledgement({ intentAmendments: [entry] }));
  assert.deepEqual([legacy, marked, none, done].map(owed), [true, true, false, false]);
  for (const entry of [marked, none, done]) {
    workflow.intentAmendments = [entry];
    const listed = (await decisionListFacts(story.root, config, workflow, { reuse: false })).pending.intentAmendments.map((item) => item.id);
    assert.deepEqual(listed, owed(entry) ? ['AMD-001'] : [], JSON.stringify(entry));
  }
});
