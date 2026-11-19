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
  const packet = decisionPacket(workflow, { phaseId: 'code', pending: {}, departures: { phase: 'code', planRows: [{ clauseId: 'W-1:REQ-001' }], codeStepOpen: false,
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

// A row that only checks tests takes no file that is not a test, so no screen offers to add one there [owner, 2026-11-19].
const testOnlyCase = async ({ paths = ['src/pages/form-page.ts', 'src/pages/form-page-contract.ts'], clauses, rows }) => {
  const { decisionPacket } = await import('../src/decision-list.mjs');
  const workflow = { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'code', phaseOrder: ['plan', 'code'],
    phases: { plan: { id: 'plan', label: 'Plan', status: 'approved', generation: 1, approvalPolicy: { authorities: ['planners'] } },
      code: { id: 'code', label: 'Code', status: 'awaiting_approval', generation: 1, approvalPolicy: { authorities: ['engineers'], minimum: 1 } } },
    resolution: { plannedClaims: { owners: { code: 'plan' } } } };
  const authorities = { planners: { label: 'Planners', allowAnyGitIdentity: true }, engineers: { label: 'Engineers', allowAnyGitIdentity: true } };
  const departure = { id: 'DEP-001', kind: 'path', phase: 'code', paths, clauses, reason: 'The page objects the end-to-end checks drive.', recordedBy: 'agent' };
  const planRows = rows.map(([id, testOnly]) => ({ clauseId: `W-1:${id}`, ...(testOnly ? { testOnly: true } : {}) }));
  const packet = decisionPacket(workflow, { phaseId: 'code', pending: {}, departures: { phase: 'code', planRows, codeStepOpen: false,
    entries: [{ departure, status: 'open', groups: ['planners'], words: departure.id, acceptAll: true }], acceptance: {}, reopens: {}, tests: {} } },
  { authorities, actor: { email: 'person@example.invalid' }, at: '2026-11-19T08:00:00.000Z' });
  return packet.items.find((item) => item.kind === 'departure');
};

test('Accept adds the files only to the named rows that can take them, and says which row only checks tests', async () => {
  const item = await testOnlyCase({ clauses: ['W-1:AC-001', 'W-1:AC-002', 'W-1:AC-005'], rows: [['AC-001'], ['AC-002', true], ['AC-005']] });
  const accept = item.options.find((option) => option.id === 'accept');
  assert.deepEqual(item.options.map((option) => option.id), ['accept', 'reject']);
  assert.deepEqual([...new Set(accept.effects[0].changes.map((change) => change.clauseId))], ['W-1:AC-001', 'W-1:AC-005']);
  assert.equal(accept.effects[0].changes.length, 4, 'each file under each row that can take it');
  assert.match(accept.words, /part of AC-001 and AC-005's delivery/u);
  assert.match(accept.words, /AC-002 only checks tests, so these files are not added to it\./u);
  assert.match(accept.does, /AC-002 only checks tests, so these files are not added to it\./u, 'the card shows what Accept does, left-out row included');
  assert.match(accept.chat.command, /--as accepted --reason "<REASON>"$/u, 'the command takes the same rows by itself');
  assert.deepEqual(item.details.leftOut.clauses, ['W-1:AC-002']);
  assert.match(item.recommended.why, /names AC-001 and AC-005 as what it serves/u);
});

test('when every named row only checks tests, Accept is offered under each other row that can take the files', async () => {
  const item = await testOnlyCase({ clauses: ['W-1:AC-002'], rows: [['AC-001'], ['AC-002', true], ['AC-003', true], ['AC-004']] });
  assert.deepEqual(item.options.map((option) => option.id), ['accept-w-1-ac-001', 'accept-w-1-ac-004', 'reject']);
  const [first] = item.options;
  assert.deepEqual(first.effects[0].changes.map((change) => change.clauseId), ['W-1:AC-001', 'W-1:AC-001']);
  assert.match(first.words, /AC-002 only checks tests, so these files are not added to it\./u);
  assert.match(first.chat.command, /--as accepted --clause W-1:AC-001 --reason "<REASON>"$/u);
  assert.ok(item.options.every((option) => option.available !== false));
});

test('when no row of the plan can take the files, Accept is shown as not available with why, and only Reject is a choice', async () => {
  const item = await testOnlyCase({ clauses: ['W-1:AC-002'], rows: [['AC-002', true], ['AC-003', true]] });
  const [accept, reject] = item.options;
  assert.deepEqual(item.options.map((option) => [option.id, option.available !== false, option.recordable !== false]), [['accept', false, false], ['reject', true, true]]);
  assert.equal(accept.chat, undefined, 'no chat offers it');
  assert.match(item.why, /^AC-002 only checks tests, so these files cannot be added to it\. No other row of the plan can take them\. /u);
  assert.match(accept.does, /Reject it, and the model restores them; to keep them, the scope changes first .*intent amendment/u);
  assert.ok(reject.chat.command.includes('--as rejected'));
  assert.equal(item.recommended.option, null, 'nothing that cannot be done is recommended');
  assert.match(item.recommended.why, /reject it to undo the change/u);
  // A departure that names no row, in a plan whose every row only checks tests, says so the same way.
  const unnamed = await testOnlyCase({ clauses: [], rows: [['AC-002', true]] });
  assert.match(unnamed.why, /^Every row of the plan only checks tests, so no row can take /u);
  assert.equal(unnamed.options[0].available, false);
});

test('a test file in a tests folder is still added to a row that only checks tests, and a plan with none is as before', async () => {
  const tests = await testOnlyCase({ paths: ['tests/pages/form-helpers.ts'], clauses: ['W-1:AC-001', 'W-1:AC-002'], rows: [['AC-001'], ['AC-002', true]] });
  const accept = tests.options.find((option) => option.id === 'accept');
  assert.deepEqual(accept.effects[0].changes.map((change) => change.clauseId), ['W-1:AC-001', 'W-1:AC-002']);
  assert.doesNotMatch(accept.words, /only checks tests/u);
  assert.equal(tests.details.leftOut, undefined);
  const plain = await testOnlyCase({ clauses: ['W-1:AC-001', 'W-1:AC-005'], rows: [['AC-001'], ['AC-005']] });
  assert.equal(plain.options.find((option) => option.id === 'accept').words, 'src/pages/form-page.ts and src/pages/form-page-contract.ts becomes part of AC-001 and AC-005\'s delivery: a plan amendment names it, and no step is reset.');
});

test('a named clause the plan has no row for is left out the same way, and alone it is never offered', async () => {
  const item = await testOnlyCase({ clauses: ['W-1:AC-001', 'W-1:AC-009'], rows: [['AC-001'], ['AC-002', true]] });
  const accept = item.options.find((option) => option.id === 'accept');
  assert.deepEqual([...new Set(accept.effects[0].changes.map((change) => change.clauseId))], ['W-1:AC-001']);
  assert.match(accept.does, /AC-009 has no row in the plan, so these files are not added to it\./u);
  assert.deepEqual(item.details.leftOut.clauses, ['W-1:AC-009']);
  const alone = await testOnlyCase({ clauses: ['W-1:AC-009'], rows: [['AC-001'], ['AC-002', true]] });
  assert.deepEqual(alone.options.map((option) => option.id), ['accept-w-1-ac-001', 'reject']);
  const { departureAmendmentChanges } = await import('../src/departure-records.mjs');
  assert.throws(() => departureAmendmentChanges({ id: 'DEP-001', kind: 'path', paths: ['src/a.ts'], clauses: [] }, { clause: 'AC-009', rows: [{ clauseId: 'W-1:AC-001' }], workId: 'W-1', reason: 'x' }),
    (error) => error.code === 'DEPARTURE_CLAUSE_REQUIRED' && /^DEP-001 cannot be accepted as recorded\. AC-009 has no row in the plan, so src\/a\.ts cannot be added to it\./u.test(error.message)
      && error.details.recoveryCommands[0].command === 'singularity-flow decision departure W-1 --fetch --departure DEP-001 --as accepted --clause W-1:AC-001 --reason "<REASON>"');
});

test('the command accepts a file under the named rows that can take it, and refuses with complete commands when none can', async () => {
  const { departureAmendmentChanges } = await import('../src/departure-records.mjs');
  const rows = [{ clauseId: 'W-1:AC-001' }, { clauseId: 'W-1:AC-002', testOnly: true }, { clauseId: 'W-1:AC-005' }];
  const departure = { id: 'DEP-001', kind: 'path', paths: ['src/pages/form-page.ts'], clauses: ['W-1:AC-001', 'W-1:AC-002', 'W-1:AC-005'] };
  const mixed = departureAmendmentChanges(departure, { rows, workId: 'W-1', reason: 'x' });
  assert.deepEqual(mixed.changes.map((change) => change.clauseId), ['W-1:AC-001', 'W-1:AC-005']);
  assert.equal(mixed.leftOut, 'AC-002 only checks tests, so src/pages/form-page.ts was not added to it.');
  assert.equal(departureAmendmentChanges({ ...departure, clauses: ['W-1:AC-001'] }, { rows, workId: 'W-1', reason: 'x' }).leftOut, null, 'nothing left out, nothing said');
  // A short clause ID finds its row as decision plan reads it.
  assert.deepEqual(departureAmendmentChanges({ ...departure, clauses: ['AC-002', 'AC-005'] }, { rows, workId: 'W-1', reason: 'x' }).changes.map((change) => change.clauseId), ['AC-005']);
  let refusal = null;
  try { departureAmendmentChanges({ ...departure, clauses: ['W-1:AC-002'] }, { rows, workId: 'W-1', reason: 'x' }); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'DEPARTURE_CLAUSE_REQUIRED');
  assert.match(refusal.message, /^DEP-001 cannot be accepted as recorded\. AC-002 only checks tests, so src\/pages\/form-page\.ts cannot be added to it\./u);
  assert.deepEqual(refusal.details.commands, [
    'singularity-flow decision departure W-1 --fetch --departure DEP-001 --as accepted --clause W-1:AC-001 --reason "<REASON>"',
    'singularity-flow decision departure W-1 --fetch --departure DEP-001 --as accepted --clause W-1:AC-005 --reason "<REASON>"',
    'singularity-flow decision departure W-1 --fetch --departure DEP-001 --as rejected --reason "<REASON>"']);
  for (const command of refusal.details.commands) assert.ok(refusal.message.includes(`\n  ${command}`), command);
  assert.doesNotMatch(refusal.message, /<CLAUSE>/u);
  // A row named by --clause that only checks tests is refused the same way.
  assert.throws(() => departureAmendmentChanges({ ...departure, clauses: [] }, { clause: 'W-1:AC-002', rows, workId: 'W-1', reason: 'x' }), { code: 'DEPARTURE_CLAUSE_REQUIRED' });
  // No row can take it: the reject command, and what keeping it needs.
  assert.throws(() => departureAmendmentChanges({ ...departure, clauses: ['W-1:AC-002'] }, { rows: [rows[1]], workId: 'W-1', reason: 'x' }), (error) => error.code === 'DEPARTURE_NO_PLAN_ROW'
    && error.details.commands.length === 1 && error.message.includes('\n  singularity-flow decision departure W-1 --fetch --departure DEP-001 --as rejected --reason "<REASON>"')
    && /No other row of the plan can take it\. Reject it, and the model restores it:/u.test(error.message) && /an intent amendment/u.test(error.message));
  // A test file joins a row that only checks tests.
  assert.deepEqual(departureAmendmentChanges({ ...departure, paths: ['tests/pages/form-helpers.ts'] }, { rows, workId: 'W-1', reason: 'x' }).changes.map((change) => change.clauseId),
    ['W-1:AC-001', 'W-1:AC-002', 'W-1:AC-005']);
});

test('a wording departure on a submitted code step offers its filled return, and is not asked as a yes or no in chat', async () => {
  const { decisionPacket } = await import('../src/decision-list.mjs');
  const workflow = { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'code', phaseOrder: ['design', 'code'],
    phases: { design: { id: 'design', label: 'Design', status: 'approved', generation: 1, approvalPolicy: { authorities: ['designers'] } },
      code: { id: 'code', label: 'Code', status: 'awaiting_approval', generation: 1, approvalPolicy: { authorities: ['engineers'], minimum: 1 } } } };
  const authorities = { designers: { label: 'Designers', allowAnyGitIdentity: true }, engineers: { label: 'Engineers', allowAnyGitIdentity: true } };
  // Wording is amended only while the code step is open; once it awaits approval, Accept is not available.
  const departure = { id: 'DEP-001', kind: 'wording', phase: 'code', paths: [], clauses: [], target: { phase: 'design' }, reason: 'The design said callers never keep a copy.', recordedBy: 'agent' };
  const packet = decisionPacket(workflow, { phaseId: 'code', pending: {}, departures: { phase: 'code', planRows: [], codeStepOpen: false,
    entries: [{ departure, status: 'open', groups: ['designers'], words: departure.id, acceptAll: true }], acceptance: {}, reopens: {}, tests: {} } },
  { authorities, actor: { email: 'person@example.invalid' }, at: '2026-11-19T08:00:00.000Z' });
  const item = packet.items.find((entry) => entry.kind === 'departure');
  assert.deepEqual(item.options.map((option) => [option.id, option.available !== false]), [['accept', false], ['return', true], ['reject', true]]);
  const back = 'singularity-flow reject code --work-id W-1 --to code --reason "<REASON>"';
  assert.equal(item.options[1].action.command, back, 'nothing for the person to compose but the reason');
  assert.ok(item.options[0].words.includes(back));
  assert.equal(item.chatYesNo, false);
  // A row whose only live choice is Reject builds too (it crashed reading it as a yes or no).
  const { yesNoOf } = await import('../src/decision-advice.mjs');
  assert.equal(yesNoOf(workflow, { ...item, options: [item.options[0], item.options[2]] }), null);
});

test('a clause departure with no saved draft is accepted from one drafted for its clauses, never a file name to make up', async () => {
  // [owner, 2026-11-19] A person never composes a command.
  const { acceptanceCommand } = await import('../src/departure-records.mjs');
  const workflow = { workItem: { id: 'W-1' } };
  assert.equal(acceptanceCommand(workflow, { id: 'DEP-004', kind: 'clause', clauses: ['W-1:AC-001', 'W-1:AC-002'] }),
    'singularity-flow story intent-amendment draft --work-id W-1 --clause W-1:AC-001 --clause W-1:AC-002');
  assert.equal(acceptanceCommand(workflow, { id: 'DEP-004', kind: 'clause', clauses: ['W-1:AC-001'], proposal: { path: 'singularity/work-items/W-1/context/departures/DEP-004-scope.md' } }),
    'singularity-flow story intent-amendment propose --work-id W-1 --file singularity/work-items/W-1/context/departures/DEP-004-scope.md --departure DEP-004 --reason "<REASON>"');
});
