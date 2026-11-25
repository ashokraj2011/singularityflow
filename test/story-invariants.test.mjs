import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { packetViolations, readViolations, refusalViolations, reportViolations, unknownViolations } from '../src/story-invariants.mjs';

// What every Story step must leave true (owner, 2026-11-23: "do 1 and 2"). Each case is a d-story shape that every test
// passed: the checks must find it.

const story = () => ({
  workItem: { id: 'D' }, status: 'in_progress', currentPhase: 'release', phaseOrder: ['implementation', 'verification', 'release'],
  phases: { implementation: { id: 'implementation', status: 'approved' }, verification: { id: 'verification', status: 'approved' }, release: { id: 'release', status: 'awaiting_approval' } },
  upstreamIssues: [{ id: 'UPI-001', phase: 'verification', at: '2026-11-23T03:48:43.294Z' }, { id: 'UPI-002', phase: 'verification', at: '2026-11-23T03:48:48.682Z' }],
  changeRequests: []
});
const allowed = { allowed: true };
const issueItem = (id, issue, options) => ({ id, kind: 'upstream-issue', decidedBy: allowed, plain: { question: '?' }, details: { issue }, options });
const option = (id, outcome, issue, extra = {}) => ({ id, label: id, decidedBy: allowed,
  effects: [{ kind: 'upstream-issue-decision', issue, issuePhase: 'verification', outcome }], ...extra });

test('two returns to one step chosen together: the second must still run once the first is recorded (d-story)', () => {
  const packet = { items: ['UPI-001', 'UPI-002'].map((issue, at) => issueItem(`d${at + 1}`, issue,
    [option('accept-risk', 'accept-risk', issue), option('dismiss', 'dismiss', issue), option('return', 'return', issue)])) };
  // With the join (31f452c55) the second joins the first's change request: nothing to report.
  assert.deepEqual(packetViolations(story(), packet, { at: '2026-11-23T03:56:13.057Z' }), []);
  // Before it, the first sent the work back and the second could not run: modelled by an issue raised after the return.
  const later = story();
  later.upstreamIssues[1].at = '2026-11-23T04:00:00.000Z';
  const found = packetViolations(later, packet, { at: '2026-11-23T03:56:13.057Z' });
  assert.deepEqual(found.map((entry) => [entry.invariant, entry.item]), [['later-return-not-runnable', 'd2']]);
});

test('a return offered that cannot run now, and an open item with nothing to choose, are found', () => {
  const back = story();
  back.currentPhase = 'verification';
  back.phases.verification.status = 'in_progress';
  const packet = { items: [issueItem('d1', 'UPI-001', [option('return', 'return', 'UPI-001')]),
    issueItem('d2', 'UPI-002', [option('dismiss', 'dismiss', 'UPI-002', { available: false })])] };
  assert.deepEqual(packetViolations(back, packet).map((entry) => [entry.invariant, entry.item]),
    [['return-not-runnable', 'd1'], ['open-item-without-choice', 'd2'], ['later-return-not-runnable', 'd1']]);
});

test('a recommendation names only a choice the item shows (the d-story lean said "return the work" with no return)', () => {
  const lean = { option: null, form: 'lean', words: 'Recommended: Return the work if the reported problem is real, and dismiss it if it is not.' };
  const item = issueItem('d1', 'UPI-002', [option('accept-risk', 'accept-risk', 'UPI-002'), option('dismiss', 'dismiss', 'UPI-002')]);
  assert.deepEqual(packetViolations(story(), { items: [{ ...item, recommended: lean }] }).map((entry) => [entry.invariant, entry.verb]),
    [['lean-names-missing-choice', 'return']]);
  assert.deepEqual(packetViolations(story(), { items: [{ ...item, recommended: { option: 'return', form: 'option' } }] }).map((entry) => entry.invariant),
    ['recommended-not-offered']);
  assert.deepEqual(packetViolations(story(), { items: [{ ...item, settled: true, recommended: lean }] }), [], 'what was settled is no question');
  // A person's own step (an approval's "Review and approve") is shown though the list never records it.
  const approval = { id: 'd3', kind: 'approval', decidedBy: allowed, recommended: { option: 'approve', form: 'option' },
    options: [{ id: 'approve', recordable: false, action: { command: 'singularity-flow approve release' }, decidedBy: allowed, effects: [] }] };
  assert.deepEqual(packetViolations(story(), { items: [approval] }), []);
});

test('a refusal routed to the very command it refused is found; another command is not', () => {
  const refusal = (command) => ({ code: 'X', details: { nextAction: { command } } });
  assert.equal(refusalViolations(['decisions', 'record', 'D', '--json'], refusal('singularity-flow decisions record D'))[0]?.invariant, 'refusal-routes-to-itself');
  assert.deepEqual(refusalViolations(['decisions', 'record', 'D', '--answers', 'a.json'], refusal('singularity-flow decisions record D')), []);
  assert.deepEqual(refusalViolations(['status'], { message: 'no route' }), []);
  // The same command for a person's own terminal (SF Guard's presence signature, a confirmation only a person gives) is a
  // hand-over, not a loop.
  assert.deepEqual(refusalViolations(['spec', 'author', 'settle', 'SPEC-1'],
    { code: 'PSS_CARD_NOT_SHOWN', details: { nextAction: { command: 'singularity-flow spec author settle SPEC-1', where: 'own-terminal' } } }), []);
});

test('every isolated test run logs what the checks find, and the runner fails on what the known list does not cover', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-invariants-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = isolatedTestEnvironment(root, { PATH: process.env.PATH });
  assert.equal(env.SINGULARITY_FLOW_INVARIANTS, path.join(root, 'invariants.jsonl'));
  assert.equal(isolatedTestEnvironment(root, { SINGULARITY_FLOW_INVARIANTS: '/elsewhere.jsonl' }).SINGULARITY_FLOW_INVARIANTS, '/elsewhere.jsonl', 'a nested run keeps its parent\'s log');
  reportViolations([{ invariant: 'stale-record-document', path: 'artifacts/release/verification/evidence-index.md', words: 'stale' },
    { invariant: 'lean-names-missing-choice', kind: 'upstream-issue', words: 'return' }], { story: 'D' }, env);
  reportViolations([], {}, env);
  reportViolations([{ invariant: 'x', words: 'not logged' }], {}, {});
  const found = await readViolations(env.SINGULARITY_FLOW_INVARIANTS);
  assert.deepEqual(found.map((entry) => [entry.invariant, entry.story]), [['stale-record-document', 'D'], ['lean-names-missing-choice', 'D']]);
  assert.deepEqual(unknownViolations(found, [{ invariant: 'stale-record-document', path: 'evidence-index.md', why: 'known' }]).map((entry) => entry.invariant),
    ['lean-names-missing-choice']);
  const known = JSON.parse(await readFile(new URL('./fixtures/known-invariant-violations.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(known.entries) && known.entries.every((entry) => entry.invariant && entry.why), 'each known entry names its invariant and why');
  await writeFile(env.SINGULARITY_FLOW_INVARIANTS, 'not json\n');
  assert.deepEqual(await readViolations(env.SINGULARITY_FLOW_INVARIANTS), [], 'a torn line is skipped, never a crash');
});
