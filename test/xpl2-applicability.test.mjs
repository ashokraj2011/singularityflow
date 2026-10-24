/**
 * XPL2 M3: recorded test attempts, criterion witnesses and evidence-reuse applicability.
 *
 * The attempts are real test-execution records written where a delivery admits them; witnesses
 * are judged by the verification owner's own function and reuse decisions by the reuse owner's.
 * XPL2 only displays those results: it computes no footprint, overlap or carry-forward of its own.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildTestExecutionReceipt } from '../src/code-delivery-tests.mjs';
import { evidenceReuseState } from '../src/evidence-reuse.mjs';
import { readStoryRecordSources } from '../src/comprehension/xpl2/record-sources.mjs';
import { explainXpl2Subject } from '../src/comprehension/xpl2/subjects.mjs';
import { attemptSha256 } from '../src/verification/attempts.mjs';
import { createXpl2Fixture } from './helpers/xpl2-fixture.mjs';

const TREE = (character) => `sha256:${character.repeat(64)}`;
const ITEM = 'singularity/work-items/ORD-418';

/** A real attempt record, written where an admitted attempt lives, and its delivery binding. */
async function recordAttempt(root, { attemptId, commandId, status = 'passed', counts = { discovered: 3, passed: 3, failed: 0, skipped: 0 }, tamper = false }) {
  const command = { id: commandId, argv: ['node', '--test'], workingDirectory: '.', affectedRoots: ['src/export'], result: { adapter: 'junit-xml', path: null } };
  const passed = status === 'passed';
  const check = {
    status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1, startedAt: '2026-10-01T10:00:00.000Z',
    completedAt: '2026-10-01T10:00:09.000Z', sourceCommit: 'a'.repeat(40), sourceTreeSha256: TREE('5')
  };
  const parsed = { tests: counts, minimumDiscovered: 1, minimumPassed: 1, adapter: 'junit-xml', result: null, testcaseObservation: { occurrences: [] } };
  const attempt = buildTestExecutionReceipt(command, check, parsed, {
    attemptId, nonce: 'n'.repeat(32), purpose: 'preflight', workId: 'ORD-418', phase: 'implementation', generation: 2
  });
  const receiptPath = `${ITEM}/context/code-delivery/tests/attempts/implementation/${attemptId}.json`;
  await mkdir(path.join(root, path.dirname(receiptPath)), { recursive: true });
  const written = tamper ? { ...attempt, status: 'passed', exitCode: 0 } : attempt;
  await writeFile(path.join(root, receiptPath), `${JSON.stringify(written, null, 2)}\n`);
  return { commandId, attemptId, receiptPath, receiptSha256: attemptSha256(attempt), status: attempt.status, affectedRoots: command.affectedRoots };
}

async function withRecords(t, { attempts = [], witnesses = [], reuses = [] } = {}) {
  const fixture = await createXpl2Fixture(t);
  const workflow = structuredClone(fixture.workflow);
  const delivery = workflow.phases.implementation.deliveryEvidence;
  delivery.preflightAttempts = [];
  for (const spec of attempts) delivery.preflightAttempts.push(await recordAttempt(fixture.root, spec));
  delivery.acceptanceCriteria.witnesses = witnesses;
  workflow.evidenceReuses = reuses;
  const recordSources = await readStoryRecordSources(fixture.root, workflow, { phaseId: 'implementation' });
  const input = { ...fixture.input, workflow, recordSources };
  return { fixture, workflow, recordSources, input, model: explainXpl2Subject(input, { subject: 'change' }) };
}

const of = (model, kind) => model.statements.filter((entry) => entry.kind === kind);

test('recorded attempts and witnesses come from their owners, and a failing run is a reported failure', async (t) => {
  const { model } = await withRecords(t, {
    attempts: [
      { attemptId: `TA-${'1'.repeat(20)}`, commandId: 'range-test' },
      { attemptId: `TA-${'2'.repeat(20)}`, commandId: 'cancellation-test', status: 'failed', counts: { discovered: 2, passed: 1, failed: 1, skipped: 0 } }
    ],
    witnesses: [
      { clauseId: 'ORD:AC-001', testSource: 'test/export-range.test.ts', commandId: 'range-test', profile: 'module-counts-v1' },
      { clauseId: 'ORD:AC-002', testSource: 'test/export-cancel.test.ts', commandId: 'cancellation-test', profile: 'module-counts-v1' }
    ]
  });
  const attempts = of(model, 'test-attempt');
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].text, /^Attempt TA-1{20} \(preflight\) of range-test completed at 2026-10-01T10:00:09\.000Z: passed, 3 passed, 0 failed, 0 skipped; no earlier attempt/u);
  assert.ok(model.sources.some((source) => source.id === 'SRC-RUN-01' && source.properties.integrity === 'verified' && source.digest));
  const witnesses = of(model, 'witness-result');
  assert.equal(witnesses.length, 2);
  assert.match(witnesses[0].text, /test\/export-range\.test\.ts is the recorded witness for ORD:AC-001: it passed in attempt TA-1{20} of range-test\. It is declared by a tag and reached a pass observed through its module command\. This is a local recorded run, not authenticated Candidate execution\./u);
  assert.match(witnesses[1].text, /ORD:AC-002: it failed/u);
  // The verification owner observed the module command, not this test's own occurrence: no exact edge.
  assert.equal(model.relationships.filter((edge) => edge.type === 'test-occurrence-in-run').length, 0);
  assert.ok(model.attention.some((entry) => entry.category === 'blocker' && entry.about === `run:TA-${'2'.repeat(20)}`));
  assert.ok(model.attention.some((entry) => entry.category === 'blocker' && /witness for ORD:AC-002/u.test(model.statements.find((s) => s.id === entry.statement).text)));
  assert.equal(model.inventory.counts.testAttempts, 2);
  assert.equal(model.inventory.counts.witnesses, 2);
  // Nothing calls a criterion satisfied or proven.
  assert.doesNotMatch(model.statements.map((entry) => entry.text).join('\n'), /\b(?:proven|proved|satisfied|verified correct)\b/iu);
});

test('XPL2-AC-007 a tampered attempt record contributes no fact and its witness is judged with no run', async (t) => {
  const { model, recordSources } = await withRecords(t, {
    attempts: [{ attemptId: `TA-${'3'.repeat(20)}`, commandId: 'range-test', status: 'failed', counts: { discovered: 1, passed: 0, failed: 1, skipped: 0 }, tamper: true }],
    witnesses: [{ clauseId: 'ORD:AC-001', testSource: 'test/export-range.test.ts', commandId: 'range-test', profile: 'module-counts-v1' }]
  });
  assert.equal(recordSources.attempts[0].status, 'integrity-failed');
  assert.equal(of(model, 'test-attempt').length, 0, 'the tampered record says nothing');
  assert.ok(model.observations.some((entry) => entry.id === 'OBS-RUN-01' && entry.reason === 'integrity-failed'));
  const [witness] = of(model, 'witness-result');
  assert.match(witness.text, /has no recorded run/u, 'a forged pass never stands in for the run');
  assert.ok(witness.limitations.includes('integrity-failed'));
  assert.equal(model.inventory.counts.changeUnits, 6, 'inventory stays readable');
});

const decision = (overrides = {}) => ({
  id: 'ERU-001', phase: 'verification', reason: 'The implementation run covers verification.', actor: 'Fixture Reviewer',
  authorityGroup: 'reviewers', at: '2026-10-02T09:00:00.000Z',
  attempt: { id: `TA-${'1'.repeat(20)}`, sha256: 'b'.repeat(64), path: `${ITEM}/context/code-delivery/tests/attempts/implementation/TA-${'1'.repeat(20)}.json`,
    phase: 'implementation', generation: 2, commandId: 'range-test', status: 'passed' },
  source: { commit: 'c'.repeat(40), treeSha256: TREE('6'), testInputSha256: null },
  clauses: ['ORD:AC-001'],
  ...overrides
});

/** Judge decisions with the reuse owner's own rule over an explicit observation of the current source. */
function judged(workflow, decisions, observed) {
  const at = '2026-10-03T00:00:00.000Z';
  const scoped = { ...workflow, evidenceReuses: decisions };
  return decisions.filter((entry) => !entry.revokes).map((entry) => ({
    decision: entry,
    state: entry.source?.treeSha256 ? evidenceReuseState(scoped, entry, { at, observed }) : 'unknown',
    digest: `sha256:${'d'.repeat(64)}`
  }));
}

function reuseModel(fixture, workflow, decisions, observed) {
  const approved = structuredClone(workflow);
  approved.phases.implementation = { ...approved.phases.implementation, status: 'approved', generation: 2 };
  const recordSources = { status: 'available', phase: 'implementation', submitted: false, attempts: [], witnesses: [],
    reuses: judged(approved, decisions, observed), omitted: { attempts: 0, witnesses: 0, reuses: 0 }, evaluatedAt: '2026-10-03T00:00:00.000Z' };
  return explainXpl2Subject({ ...fixture.input, workflow: approved, recordSources }, { subject: 'change' });
}

test('XPL2-AC-012 a changed source with disjoint observed lines does not carry earlier evidence forward', async (t) => {
  const fixture = await createXpl2Fixture(t);
  // The source tree the run tested differs from today's, as when a shared flag changed: the
  // owner's rule says the decision no longer applies. XPL2 computes no overlap of its own.
  const changed = reuseModel(fixture, fixture.workflow, [decision()], { status: 'available', sourceTreeSha256: TREE('7'), testInputSha256: null });
  const [statement] = of(changed, 'evidence-reuse');
  assert.match(statement.text, /no longer applies: the source or its test inputs changed after that run/u);
  assert.ok(statement.limitations.includes('revalidation-unestablished'));
  assert.ok(changed.attention.some((entry) => entry.reason === 'revalidation-unestablished' && entry.about === 'decision:ERU-001'));
  assert.doesNotMatch(changed.statements.map((entry) => entry.text).join('\n'), /carr(?:y|ied) forward|still valid|unchanged and proven/iu);
  // Only the owner's exact applicability result permits the "applies now" display.
  const active = reuseModel(fixture, fixture.workflow, [decision()], { status: 'available', sourceTreeSha256: TREE('6'), testInputSha256: null });
  assert.match(of(active, 'evidence-reuse')[0].text, /applies now, because the source and test inputs are unchanged since that run/u);
  const expired = reuseModel(fixture, fixture.workflow, [decision({ expiresAt: '2026-10-02T12:00:00.000Z' })],
    { status: 'available', sourceTreeSha256: TREE('6'), testInputSha256: null });
  assert.match(of(expired, 'evidence-reuse')[0].text, /has expired/u);
  const revoked = reuseModel(fixture, fixture.workflow, [decision(), { id: 'ERU-002', revokes: 'ERU-001', reason: 'withdrawn' }],
    { status: 'available', sourceTreeSha256: TREE('6'), testInputSha256: null });
  assert.match(of(revoked, 'evidence-reuse')[0].text, /was revoked/u);
});

test('XPL2-AC-039 reuse is not a new execution: the earlier run keeps its own step and attempt', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const model = reuseModel(fixture, fixture.workflow, [decision()], { status: 'available', sourceTreeSha256: TREE('6'), testInputSha256: null });
  const [statement] = of(model, 'evidence-reuse');
  assert.match(statement.text, /^ERU-001: Fixture Reviewer recorded that attempt TA-1{20}, run by implementation at c{12}, stands for verification\./u);
  assert.match(statement.text, /A reused run is not a new run on this change\./u);
  const edge = model.relationships.find((entry) => entry.type === 'reuse-decision-cites-run');
  assert.equal(edge.from, 'decision:ERU-001');
  assert.equal(edge.to, `run:TA-${'1'.repeat(20)}`);
  assert.equal(edge.qualifier, 'active');
  const run = model.nodes.find((node) => node.id === edge.to);
  assert.equal(run.status, 'recorded-elsewhere', 'the run is not relabelled as a run of the reusing step');
  assert.equal(of(model, 'test-attempt').length, 0, 'no attempt is invented for the reusing step');
});

test('XPL2-AC-040 an incomplete record or an unobserved source leaves applicability unknown', async (t) => {
  const fixture = await createXpl2Fixture(t);
  const incomplete = reuseModel(fixture, fixture.workflow, [decision({ source: { commit: 'c'.repeat(40) } })],
    { status: 'available', sourceTreeSha256: TREE('6'), testInputSha256: null });
  assert.match(of(incomplete, 'evidence-reuse')[0].text, /cannot be judged: the record lacks what its rule binds/u);
  const unobserved = reuseModel(fixture, fixture.workflow, [decision()], { status: 'unavailable', code: 'X' });
  assert.match(of(unobserved, 'evidence-reuse')[0].text, /is not confirmed: the current source was not compared/u);
  for (const model of [incomplete, unobserved]) {
    assert.ok(of(model, 'evidence-reuse')[0].limitations.includes('revalidation-unestablished'));
  }
  // Through the real reader in a repository whose definition cannot be loaded, the source is not
  // observed and nothing is assumed.
  const { model } = await withRecords(t, { reuses: [decision()] });
  assert.match(of(model, 'evidence-reuse')[0].text, /(?:is not confirmed|no longer applies: the step that ran it was reopened)/u);
  assert.equal(model.availability.reuse, 'available');
});
