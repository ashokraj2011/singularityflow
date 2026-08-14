/**
 * What a developer needs when they come back. `[AMD:REQ-041]` `[AMD:REQ-042]` `[AMD:AC-004]`
 *
 * Four questions in the order they matter: what was fixed when I started, what has moved since,
 * what of mine has gone stale, and — the one this spec adds — what did the specification itself
 * change underneath me.
 *
 * The section that carries risk is AMENDED, because it is the only one that asks the reader to do
 * something. Most of these tests are about *when it does not ask*, since an acknowledgment demanded
 * for work nobody here is doing teaches people to click past the ones that matter.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { continuationPacket, evidenceGeneration, submissionBlockedByAmendment } from '../src/continuation-packet.mjs';

const interval = (overrides = {}) => ({
  intervalId: 'INT-implement-G1-001',
  phaseId: 'implement',
  generation: 1,
  sourceBaseCommit: 'a'.repeat(40),
  configurationSha256: 'c'.repeat(64),
  sourceSha256: 's'.repeat(64),
  requiredChecks: ['npm test'],
  amendments: [],
  ...overrides
});

const amendment = (overrides = {}) => ({
  at: '2026-08-14T09:00:00.000Z', fromGeneration: 1, toGeneration: 2,
  clauses: ['S:AC-003'], author: 'author@example.com', reason: 'tightened the retry rule', ...overrides
});

test('amended-section-renders-diff-and-ack', () => {
  /**
   * `[AMD:AC-004]`. The clause, what the developer claimed against it, and the action — enough to
   * decide without opening the specification.
   */
  const packet = continuationPacket({
    interval: interval({ amendments: [amendment()] }),
    claims: { 'S:AC-003': { expectedPaths: ['src/retry.js'], tests: ['test/retry.test.mjs'] } },
    clauseText: { 'S:AC-003': 'A retry must preserve the original attempt.' }
  });

  assert.deepEqual([...packet.sections], ['pinned', 'sinceYouLeft', 'stale', 'amended']);
  const clause = packet.amended.clauses[0];
  assert.equal(clause.clauseId, 'S:AC-003');
  assert.equal(clause.text, 'A retry must preserve the original attempt.');
  assert.equal(clause.claimed, true);
  assert.deepEqual([...clause.artifacts], ['src/retry.js']);
  assert.deepEqual([...clause.tests], ['test/retry.test.mjs']);

  assert.equal(packet.amended.acknowledgment.required, true);
  assert.match(packet.amended.acknowledgment.action, /interval acknowledge --through 2/);
  assert.match(submissionBlockedByAmendment(packet), /amended to generation 2 and it changes S:AC-003, which you have claimed/);
});

test('an amendment that misses your claims asks nothing of you', () => {
  /**
   * The judgement that keeps the beat meaningful. The amendment happened and is shown; it just does
   * not gate a submission for someone who never claimed the clause it touched.
   */
  const packet = continuationPacket({
    interval: interval({ amendments: [amendment({ clauses: ['S:AC-009'] })] }),
    claims: { 'S:AC-003': { expectedPaths: ['src/retry.js'], tests: [] } }
  });
  assert.equal(packet.amended.quiet, false, 'the amendment was hidden rather than merely non-blocking');
  assert.equal(packet.amended.clauses[0].claimed, false);
  assert.equal(packet.amended.touchesMyWork, false);
  assert.equal(packet.amended.acknowledgment.required, false);
  assert.equal(submissionBlockedByAmendment(packet), null, 'an unrelated amendment blocked a submission');
});

test('acknowledging clears the beat, and a later amendment raises it again', () => {
  const claims = { 'S:AC-003': { expectedPaths: ['src/retry.js'], tests: [] } };
  const acknowledged = continuationPacket({
    interval: interval({ amendments: [amendment()] }), claims, acknowledgedGeneration: 2
  });
  assert.equal(acknowledged.amended.acknowledgment.required, false);
  assert.equal(submissionBlockedByAmendment(acknowledged), null);

  const amendedAgain = continuationPacket({
    interval: interval({ amendments: [amendment(), amendment({ fromGeneration: 2, toGeneration: 3 })] }),
    claims,
    acknowledgedGeneration: 2
  });
  assert.equal(amendedAgain.amended.acknowledgment.required, true, 'a second amendment slipped through an old acknowledgment');
  assert.equal(amendedAgain.amended.acknowledgment.throughGeneration, 3);
});

test('a quiet return says so, in each section, rather than showing empty lists', () => {
  // "Nothing moved" and "here is an empty list" are different messages, and a reader should not have
  // to interpret emptiness.
  const packet = continuationPacket({ interval: interval(), currentConfigSha256: 'c'.repeat(64), currentSourceSha256: 's'.repeat(64) });
  assert.equal(packet.sinceYouLeft.quiet, true);
  assert.equal(packet.stale.quiet, true);
  assert.equal(packet.amended.quiet, true);
  assert.equal(packet.amended.acknowledgment.required, false);
});

test('drift in the ground is reported apart from the reader’s own changes', () => {
  // SINCE-YOU-LEFT is the reader's work moving; STALE is the ground moving underneath it. Collapsing
  // them would make a configuration change look like something the developer did.
  const packet = continuationPacket({
    interval: interval(),
    changedPaths: ['src/retry.js'],
    currentConfigSha256: 'd'.repeat(64),
    currentSourceSha256: 's'.repeat(64)
  });
  assert.deepEqual([...packet.sinceYouLeft.changedPaths], ['src/retry.js']);
  assert.equal(packet.stale.quiet, false);
  assert.equal(packet.stale.drift[0].fact, 'configuration');
  assert.equal(packet.stale.drift.length, 1, 'an unchanged pinned fact was reported as drift');
});

test('evidence produced before an amendment keeps its value, and says which generation it covers', () => {
  /**
   * `[AMD:CON-005]`. Invalidating it throws away work that was correct when it was done; leaving it
   * unlabelled lets a reader mistake it for evidence about the amended clause.
   */
  const before = evidenceGeneration({ generation: 1 }, 2);
  assert.equal(before.current, false);
  assert.match(before.label, /verified against generation 1, before the amendment to generation 2/);

  const after = evidenceGeneration({ generation: 2 }, 2);
  assert.equal(after.current, true);
  assert.equal(after.label, 'verified against generation 2');
});

test('the packet computes and never acts', async () => {
  // `[AMD:CON-003]`: it reports that an acknowledgment is outstanding; it never records one.
  const source = (await (await import('node:fs/promises')).readFile(new URL('../src/continuation-packet.mjs', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['writeJson', 'writeFile', 'invokeModel', 'spawn']) {
    assert.ok(!source.includes(forbidden), `the packet reaches for ${forbidden}`);
  }
  assert.throws(() => continuationPacket({}), /needs an open work interval/);
});
