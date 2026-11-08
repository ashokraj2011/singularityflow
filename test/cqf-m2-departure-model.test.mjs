/** CQF M2: the departure record and how its status is read [CQF:REQ-021, REQ-026, REQ-028]. Pure. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptAllEligible, departureCandidatePaths, departureHolds, departureStatus, recordDeparture, recordDepartureRejection, rejectedDeparturePaths
} from '../src/departures.mjs';

const AT = '2026-11-08T08:00:00.000Z';
const story = () => ({ workItem: { id: 'W-1' }, history: [] });
const file = (workflow, fields = {}) => recordDeparture(workflow, { kind: 'path', phase: 'code', generation: 1, paths: ['src/a.mjs'],
  contentHashes: { 'src/a.mjs': 'new' }, baseHashes: { 'src/a.mjs': null }, clauses: ['W-1:REQ-001'], reason: 'The change needed a module of its own.', at: AT, ...fields });

test('a departure is one append-only record with its kind, files, hashes and findings, numbered once', () => {
  const workflow = story();
  const first = file(workflow);
  const second = recordDeparture(workflow, { kind: 'wording', phase: 'code', generation: 1, target: { phase: 'design', generation: 1, sha256: 'abc', path: 'design.md' },
    diff: '-old\n+new', reason: 'The design said callers never keep a copy.', at: AT });
  assert.deepEqual([first.id, second.id], ['DEP-001', 'DEP-002']);
  assert.deepEqual(first.findings, [], 'a field M6 fills with the finding IDs a departure fixes');
  assert.deepEqual(first.author, { producer: 'governed-agent', actor: null, agent: null });
  assert.deepEqual(second.paths, [], 'a wording departure changes no file of this checkout');
  assert.throws(() => recordDeparture(story(), { kind: 'path', phase: 'code', generation: 1, paths: [], reason: 'x'.repeat(30), at: AT }), /names the file/u);
  assert.throws(() => file(story(), { reason: 'Too short.' }), { code: 'DEPARTURE_REASON_REQUIRED' });
  assert.throws(() => file(story(), { paths: ['../outside.mjs'] }), /exact repository-relative/u);
  assert.throws(() => recordDeparture(story(), { kind: 'test', phase: 'code', generation: 1, change: { op: 'remove-test', clauseId: 'W-1:AC-001', test: 't.mjs' },
    reason: 'The planned test is no longer needed.', at: AT }), { code: 'DEPARTURE_NOT_ALLOWED' }, 'removing a planned test is never a departure');
});

test('"Accept all" covers files, supporting files and wording that names no clause; the rest are one by one', () => {
  assert.equal(acceptAllEligible({ kind: 'path' }), true);
  assert.equal(acceptAllEligible({ kind: 'supporting' }), true);
  assert.equal(acceptAllEligible({ kind: 'wording', clauses: [] }), true);
  assert.equal(acceptAllEligible({ kind: 'wording', clauses: ['W-1:REQ-001'] }), false);
  for (const kind of ['plan-row', 'test', 'clause']) assert.equal(acceptAllEligible({ kind, clauses: [] }), false, kind);
});

test('accepted while a counted amendment names it and its file holds what was accepted; an edit reopens it', () => {
  const workflow = story();
  const departure = file(workflow);
  assert.equal(departureStatus(workflow, departure, { 'src/a.mjs': 'new' }).status, 'open');
  assert.equal(departureHolds('open'), true);
  workflow.planAmendments = [{ id: 'PAM-001', changes: [{ kind: 'add-location', clauseId: 'W-1:REQ-001', path: 'src/a.mjs' }], contentHashes: { 'src/a.mjs': 'new' },
    departures: ['DEP-001'], actor: 'a', authorityGroup: 'planners', at: AT }];
  assert.equal(departureStatus(workflow, departure, { 'src/a.mjs': 'new' }).status, 'accepted');
  assert.equal(departureHolds('accepted'), false);
  const reopened = departureStatus(workflow, departure, { 'src/a.mjs': 'edited' });
  assert.deepEqual([reopened.status, reopened.changed], ['reopened', ['src/a.mjs']]);
  assert.equal(departureHolds('reopened'), true);
});

test('a rejected file departure holds until its file is back to what the generation began with, and leaves the candidate', () => {
  const workflow = story();
  const departure = file(workflow);
  assert.deepEqual(departureCandidatePaths(workflow, 'code'), ['src/a.mjs']);
  recordDepartureRejection(workflow, { departures: ['DEP-001'], reason: 'This module is a separate change for later.', actor: 'a', authorityGroup: 'planners', at: AT });
  assert.equal(departureStatus(workflow, departure, { 'src/a.mjs': 'new' }).status, 'rejected');
  assert.equal(departureHolds('rejected'), true);
  assert.deepEqual(departureCandidatePaths(workflow, 'code'), [], 'publication no longer carries it');
  assert.deepEqual([...rejectedDeparturePaths(workflow, 'code').keys()], ['src/a.mjs']);
  assert.equal(departureStatus(workflow, departure, { 'src/a.mjs': null }).status, 'reverted', 'a new file is restored by removing it');
  // A rejected wording or row leaves the approved document as it was: nothing in this checkout to restore.
  const wording = recordDeparture(workflow, { kind: 'wording', phase: 'code', generation: 1, target: { phase: 'design' }, reason: 'The design said callers never keep a copy.', at: AT });
  recordDepartureRejection(workflow, { departures: [wording.id], reason: 'The design stays as it was approved.', actor: 'a', authorityGroup: 'designers', at: AT });
  assert.equal(departureStatus(workflow, wording).status, 'declined');
  assert.equal(departureHolds('declined'), false);
});

test('a later departure that replaces one leaves only itself to decide', () => {
  const workflow = story();
  const first = file(workflow, { clauses: [] });
  file(workflow, { supersedes: first.id });
  assert.equal(departureStatus(workflow, first).status, 'superseded');
  assert.deepEqual(departureCandidatePaths(workflow, 'code'), ['src/a.mjs']);
  assert.throws(() => file(workflow, { supersedes: 'DEP-099' }), /not a departure/u);
});

test('the terminal table asks once to accept every file departure with one reason, and the rest one by one', async () => {
  const { PassThrough, Readable } = await import('node:stream');
  const { promptDecisionAnswers } = await import('../src/commands/decisions.mjs');
  const yours = { allowed: true, groups: ['planners'], labels: ['Planners'], words: 'You may decide this (Planners).' };
  const option = (id, label, extra = {}) => ({ id, label, recommended: false, words: '', effects: [{ kind: 'departure' }], needs: { reason: { default: '', minimum: 20, maximum: 1000 } }, decidedBy: yours, ...extra });
  const row = (id, departure, acceptAll) => ({ id, kind: 'departure', title: `${departure}: a change`, why: 'The model recorded it.', decidedBy: yours,
    details: { departure, acceptAll }, options: [option('accept', 'Accept', acceptAll ? {} : { oneByOne: true }), option('reject', 'Reject')] });
  const packet = { headline: 'Code can\'t be approved yet: 3 decisions needed.', items: [row('d1', 'DEP-001', true), row('d2', 'DEP-002', true), row('d3', 'DEP-003', false)] };
  const input = Readable.from(['y\n', 'Both pages ship with the code they show.\n', '1\n', 'The renamed test still proves the clause.\n']);
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => { shown += chunk; });
  const prompt = await promptDecisionAnswers(packet, { input, output });
  prompt.close();
  assert.match(shown, /Accept all 2 departures \(DEP-001, DEP-002\) with one reason\?/u);
  assert.deepEqual(Object.fromEntries(prompt.answers.choose), { d1: 'accept', d2: 'accept', d3: 'accept' });
  assert.deepEqual(Object.fromEntries(prompt.answers.reason), { d1: 'Both pages ship with the code they show.', d2: 'Both pages ship with the code they show.',
    d3: 'The renamed test still proves the clause.' });
  assert.doesNotMatch(shown, /1\. DEP-001/u, 'a row accepted with the others is not asked again');
});

test('on the list a file departure is one of "Accept all", and a planned test change is decided on its own row, in its own terminal', async () => {
  const { decisionPacket, effectWords } = await import('../src/decision-list.mjs');
  const workflow = { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'code', phaseOrder: ['plan', 'code'],
    phases: { plan: { id: 'plan', label: 'Plan', status: 'approved', generation: 1, approvalPolicy: { authorities: ['planners'] } },
      code: { id: 'code', label: 'Code', status: 'awaiting_approval', generation: 1, approvalPolicy: { authorities: ['engineers'], minimum: 1 } } },
    resolution: { plannedClaims: { owners: { code: 'plan' } } } };
  const authorities = { planners: { label: 'Planners', allowAnyGitIdentity: true }, engineers: { label: 'Engineers', allowAnyGitIdentity: true } };
  const file = { id: 'DEP-001', kind: 'path', phase: 'code', paths: ['src/a.mjs'], clauses: ['W-1:REQ-001'], reason: 'The change needed a module of its own.', recordedBy: 'agent' };
  const test = { id: 'DEP-002', kind: 'test', phase: 'code', paths: [], clauses: ['W-1:REQ-001'], change: { op: 'add-test', clauseId: 'W-1:REQ-001', test: 't.mjs' },
    reason: 'A format test the plan did not list.', recordedBy: 'agent' };
  const entry = (departure, acceptAll) => ({ departure, status: 'open', groups: ['planners'], words: departure.id, acceptAll });
  const packet = decisionPacket(workflow, { phaseId: 'code', pending: {}, departures: { phase: 'code', planRows: [], codeStepOpen: false,
    entries: [entry(file, true), entry(test, false)], acceptance: { 'DEP-002': 'singularity-flow decision plan W-1 --fetch --add-test W-1:REQ-001=t.mjs --reason "<REASON>"' }, reopens: {}, tests: {} } },
  { authorities, actor: { email: 'person@example.invalid' }, at: '2026-11-08T08:00:00.000Z' });
  const [fileRow, testRow] = packet.items.filter((item) => item.kind === 'departure');
  assert.deepEqual(fileRow.options.map((option) => [option.id, Boolean(option.oneByOne)]), [['accept', false], ['reject', false]]);
  assert.deepEqual(fileRow.options[0].effects[0].changes, [{ kind: 'add-location', clauseId: 'W-1:REQ-001', path: 'src/a.mjs' }]);
  assert.match(fileRow.options[0].chat.command, /^singularity-flow decision departure W-1 --fetch --departure DEP-001 --as accepted --reason "<REASON>"$/u);
  assert.deepEqual(testRow.options.map((option) => [option.id, Boolean(option.oneByOne), option.recordable !== false]), [['accept', true, false], ['reject', true, true]]);
  assert.match(testRow.options[0].action.command, /--add-test W-1:REQ-001=t\.mjs/u, 'a plan row correction is its own terminal step');
  assert.match(effectWords(workflow, testRow.options[1].effects[0]), /the approved document stays as it was/u);
  assert.match(effectWords(workflow, fileRow.options[1].effects[0]), /the model restores what it changed/u);
});
