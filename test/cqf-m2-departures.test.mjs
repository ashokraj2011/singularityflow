/**
 * CQF M2: departures in the code step [CQF:REQ-020 to REQ-029], through the real CLI.
 *
 * The acceptance: a code step adds a file the plan does not name, publishes it with DEP-001, a person
 * accepts it in one table and the step approves, with no appeal, no decide turn and no terminal trip.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

async function draft(t) {
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'Require a human implementation review in this fixture']);
  await startQuickFix(repo);
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  // A file no row of the plan names: the change needed it.
  await writeFile(path.join(repo.root, 'index.html'), '<!-- @clause:QF-1:AC-001 show the approved value -->\n<title>Calendar</title>\n');
  repo.sflow('prepare', 'implement');
  return repo;
}

const state = async (repo) => JSON.parse(await readFile(path.join(repo.root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
const sha = async (repo, file) => createHash('sha256').update(await readFile(path.join(repo.root, file))).digest('hex');

test('a file the plan does not name is published with DEP-001, accepted in one table, and the step approves', async (t) => {
  const repo = await draft(t);
  // A person's own check records nothing: the refusal it always gave stands.
  const own = repo.sflowJson('phase', 'prepublish', 'implement');
  assert.match(JSON.stringify(own.value.findings), /GENERATION_EXCLUDED_CHANGES_UNRESOLVED/u);
  assert.equal((await state(repo)).departures, undefined);
  // The agent's check, as /sf-code runs it, records the departure and keeps going.
  const checked = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.equal(checked.status, 0, JSON.stringify(checked.value));
  assert.ok(!JSON.stringify(checked.value).includes('GENERATION_EXCLUDED_CHANGES_UNRESOLVED'), JSON.stringify(checked.value.findings));
  assert.deepEqual(checked.value.departures.recorded, ['DEP-001']);
  assert.match(checked.value.departures.words, /DEP-001 waits for a person on the decisions table/u);
  let recorded = await state(repo);
  assert.equal(recorded.departures[0].kind, 'path');
  assert.deepEqual(recorded.departures[0].paths, ['index.html']);
  assert.equal(recorded.departures[0].recordedBy, 'sflow');
  assert.equal(recorded.departures[0].author.producer, 'governed-agent');
  assert.deepEqual(recorded.departures[0].findings, []);
  // The one row this step delivers is the clause it serves.
  assert.deepEqual(recorded.departures[0].clauses, ['QF-1:AC-001']);

  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  recorded = await state(repo);
  assert.ok(recorded.phases.implement.deliveryEvidence.sourcePaths.includes('index.html'), 'the departure file is published with the step');
  assert.equal((recorded.departures ?? []).length, 1, 'publish records nothing twice');
  repo.sflow('submit', 'implement');

  // The table: one row, accepted with the person's reason.
  const list = repo.sflowJson('decisions', 'QF-1');
  assert.equal(list.status, 0, JSON.stringify(list.value));
  const packet = list.value.data ?? list.value;
  const item = packet.items.find((entry) => entry.kind === 'departure');
  assert.ok(item, JSON.stringify(packet.items.map((entry) => entry.kind)));
  assert.equal(item.details.departure, 'DEP-001');
  assert.equal(item.details.acceptAll, true);
  assert.equal(item.holdsApproval, true);
  assert.deepEqual(item.options.map((option) => option.id), ['accept', 'reject']);
  const approval = packet.items.find((entry) => entry.kind === 'approval');
  assert.deepEqual(approval.details.heldBy, [item.id]);

  const approve = () => repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--work-id', 'QF-1', '--yes', '--json']);
  const refused = approve();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /DEPARTURES_UNDECIDED/u);

  const reason = 'The entry page shows the approved value, so it ships with this code.';
  const answers = path.join(repo.root, '..', 'answers.json');
  await writeFile(answers, JSON.stringify({ choose: { [item.id]: 'accept' }, reason: { [item.id]: reason }, confirm: packet.packetSha256 }));
  const decided = repo.sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(decided.status, 0, JSON.stringify(decided.value));
  recorded = await state(repo);
  const amendment = recorded.planAmendments.at(-1);
  assert.deepEqual(amendment.departures, ['DEP-001']);
  assert.deepEqual(amendment.changes, [{ kind: 'add-location', clauseId: 'QF-1:AC-001', path: 'index.html' }]);
  assert.equal(amendment.contentHashes['index.html'], await sha(repo, 'index.html'));
  const shown = repo.sflowJson('departure', 'show', 'DEP-001');
  assert.equal((shown.value.data ?? shown.value).departure.status, 'accepted');

  const approved = approve();
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  recorded = await state(repo);
  assert.equal(recorded.phases.implement.status, 'approved');
  assert.equal((recorded.phaseAppeals ?? []).length, 0, 'no appeal was needed');
});

test('a rejected departure is restored by the model in the same generation, and the next prepublish checks it is back', async (t) => {
  const repo = await draft(t);
  assert.deepEqual(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures.recorded, ['DEP-001']);
  // A /sf-decide turn's command, the same write as the table's reject.
  repo.sflow('decision', 'departure', 'QF-1', '--departure', 'DEP-001', '--as', 'rejected', '--reason', 'The entry page is a separate change for later.');
  let recorded = await state(repo);
  assert.deepEqual(recorded.departureDecisions.map((entry) => [entry.decision, entry.departures]), [['rejected', ['DEP-001']]]);
  const held = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.match(JSON.stringify(held.value.findings), /DEPARTURE_REJECTED_NOT_REVERTED/u);
  assert.match(held.value.departures.words, /DEP-001 was rejected: restore index\.html/u);
  assert.equal((await state(repo)).departures.length, 1, 'a rejected file is never recorded again');
  // The file was new in this generation, so restoring it is removing it.
  repo.must('rm', ['index.html']);
  const clean = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.ok(!JSON.stringify(clean.value.findings).includes('DEPARTURE_REJECTED_NOT_REVERTED'), JSON.stringify(clean.value.findings));
  assert.equal(repo.sflowJson('departure', 'show', 'DEP-001').value.data.departure.status, 'reverted');
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  recorded = await state(repo);
  assert.ok(!recorded.phases.implement.deliveryEvidence.sourcePaths.includes('index.html'));
});

test('"Accept all" accepts every file departure with one reason as one plan amendment naming each', async (t) => {
  const repo = await draft(t);
  await writeFile(path.join(repo.root, 'about.html'), '<title>About the calendar</title>\n');
  assert.deepEqual(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures.recorded, ['DEP-001', 'DEP-002']);
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  const rows = packet.items.filter((entry) => entry.kind === 'departure');
  assert.deepEqual(rows.map((entry) => [entry.details.departure, entry.details.acceptAll]), [['DEP-001', true], ['DEP-002', true]]);
  // One answer for both: the same option on each row, never marked one by one.
  assert.ok(rows.every((entry) => entry.options.find((option) => option.id === 'accept') && !entry.options.find((option) => option.id === 'accept').oneByOne));
  // Before submission a departure never stops the step: only its approval waits for it.
  assert.ok(rows.every((entry) => entry.holdsApproval === false));
  const reason = 'Both pages show the approved value and ship with this code.';
  const answers = path.join(repo.root, '..', 'answers-all.json');
  await writeFile(answers, JSON.stringify({ choose: Object.fromEntries(rows.map((entry) => [entry.id, 'accept'])),
    reason: Object.fromEntries(rows.map((entry) => [entry.id, reason])), confirm: packet.packetSha256 }));
  const decided = repo.sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(decided.status, 0, JSON.stringify(decided.value));
  const recorded = await state(repo);
  assert.equal(recorded.planAmendments.length, 1, 'one record for one answer');
  assert.deepEqual(recorded.planAmendments[0].departures, ['DEP-001', 'DEP-002']);
  assert.deepEqual(recorded.planAmendments[0].changes.map((change) => change.path).sort(), ['about.html', 'index.html']);
  assert.deepEqual(repo.sflowJson('departure', 'list', '--open').value.data.departures, []);
});

test('departure record keeps every hard limit: secrets, configuration, tests, unchanged files and closed generations', async (t) => {
  const repo = await draft(t);
  const record = (...args) => repo.run(process.execPath, [cli, '--no-model', 'departure', 'record', ...args, '--reason', 'The change needed this file to be edited.', '--json']);
  const refusedWith = (result, code) => {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout + result.stderr, new RegExp(code, 'u'));
  };
  await writeFile(path.join(repo.root, '.env'), 'TOKEN=abc\n');
  refusedWith(record('--kind', 'path', '--path', '.env'), 'DEPARTURE_NOT_ALLOWED');
  refusedWith(record('--kind', 'path', '--path', 'singularity/workflow.yml'), 'DEPARTURE_NOT_ALLOWED');
  refusedWith(record('--kind', 'path', '--path', 'test/value.test.mjs'), 'DEPARTURE_NOT_ALLOWED');
  refusedWith(record('--kind', 'path', '--path', '.git/config'), 'DEPARTURE_NOT_ALLOWED');
  refusedWith(record('--kind', 'path', '--path', 'package.json'), 'DEPARTURE_UNCHANGED');
  refusedWith(record('--kind', 'test', '--clause', 'QF-1:AC-001', '--row-op', 'remove-test', '--test', 'test/value.test.mjs'), 'DEPARTURE_NOT_ALLOWED');
  // The model's own record, with the clause it serves.
  const recorded = record('--kind', 'path', '--path', 'index.html', '--clause', 'QF-1:AC-001');
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const departure = (await state(repo)).departures[0];
  assert.equal(departure.recordedBy, 'agent');
  assert.deepEqual(departure.baseHashes, { 'index.html': null });
  assert.equal(departure.contentHashes['index.html'], await sha(repo, 'index.html'));
  // Prepublish records nothing twice: the file already has its departure.
  assert.deepEqual(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures.recorded, []);
  repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  refusedWith(record('--kind', 'path', '--path', 'index.html'), 'DEPARTURE_LIFECYCLE');
});

test('a file edited after its departure was accepted reopens only that row, and accepting it again binds the new bytes', async (t) => {
  const repo = await draft(t);
  await writeFile(path.join(repo.root, 'about.html'), '<title>About the calendar</title>\n');
  repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  const accept = (id, reason) => repo.sflow('decision', 'departure', 'QF-1', '--departure', id, '--as', 'accepted', '--reason', reason);
  // Recorded in path order: about.html is DEP-001, index.html DEP-002.
  accept('DEP-001', 'The about page ships with the calendar it describes.');
  accept('DEP-002', 'The entry page shows the approved value with this code.');
  await writeFile(path.join(repo.root, 'index.html'), '<!-- @clause:QF-1:AC-001 show the approved value -->\n<title>Calendar, edited</title>\n');
  const listed = repo.sflowJson('departure', 'list').value.data.departures;
  assert.deepEqual(listed.map((entry) => [entry.id, entry.paths, entry.status]), [['DEP-001', ['about.html'], 'accepted'], ['DEP-002', ['index.html'], 'reopened']]);
  assert.deepEqual(listed[1].changedSinceAccepted, ['index.html']);
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  assert.deepEqual(packet.items.filter((entry) => entry.kind === 'departure').map((entry) => entry.details.departure), ['DEP-002']);
  accept('DEP-002', 'The edited entry page still shows the approved value.');
  const recorded = await state(repo);
  assert.equal(recorded.planAmendments.at(-1).contentHashes['index.html'], await sha(repo, 'index.html'));
  assert.equal(repo.sflowJson('departure', 'show', 'DEP-002').value.data.departure.status, 'accepted');
});

test('appeal prepare records a departure for each change it names, and the appeal reads stay', async (t) => {
  const repo = await draft(t);
  const prepared = repo.sflowJson('appeal', 'prepare', '--phase', 'implement', '--add-location', 'QF-1:AC-001=index.html',
    '--reason', 'The entry page shows the approved value, so it belongs to AC-001.');
  assert.equal(prepared.status, 0, JSON.stringify(prepared.value));
  const data = prepared.value.data;
  assert.equal(data.status, 'departure-recorded');
  assert.deepEqual(data.departures.map((entry) => [entry.id, entry.kind, entry.paths, entry.clauses]), [['DEP-001', 'path', ['index.html'], ['QF-1:AC-001']]]);
  assert.equal(data.nextAction.skill, '/sf-decide');
  const recorded = await state(repo);
  assert.equal((recorded.phaseAppeals ?? []).length, 0, 'no appeal packet waits for a review');
  assert.deepEqual(recorded.departures[0].baseHashes, { 'index.html': null });
  assert.equal(recorded.departures[0].contentHashes['index.html'], await sha(repo, 'index.html'));
  // The reads stay reads, and the same change named again records nothing twice.
  assert.equal(repo.sflowJson('appeal', 'list', '--phase', 'implement').status, 0);
  repo.sflowJson('appeal', 'prepare', '--phase', 'implement', '--add-location', 'QF-1:AC-001=index.html',
    '--reason', 'The entry page shows the approved value, so it belongs to AC-001.');
  assert.equal((await state(repo)).departures.length, 1);
});
