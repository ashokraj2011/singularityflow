/**
 * CQF M2: departures in the code step [CQF:REQ-020 to REQ-029], through the real CLI, as watch the code base changed them
 * (docs/SPEC-WCB-WATCH-CODE-BASE-v1.md).
 *
 * A file the plan does not name is no departure since 2026-11-27: the step's publication takes it up, changed outside the
 * plan by Copilot (with its reason) or by you, and its approval lists it; nobody is asked [WCB:REQ-010]. A person who wants
 * to decide one undoes that while the step is open: the next check records the departure they decide, accepted in one
 * table or rejected and restored, as before [WCB:REQ-015].
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { cli, repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

async function draft(t, { agentStep = false } = {}) {
  const repo = await repository(t, { implementCommands: false });
  const configPath = path.join(repo.root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  // A code step the agent authors, as /sf-code does, and a person may still author by hand.
  if (agentStep) config.phases.implement.generation = { requirement: 'required', task: 'code' };
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

/**
 * The agent's own record takes a file up with its reason; a person who wants to decide it undoes that while the step is
 * open, and the agent's next check records the departure they decide [WCB:REQ-015].
 */
async function personDecides(repo, ...files) {
  for (const file of files) {
    const recorded = repo.sflowJson('departure', 'record', '--kind', 'path', '--path', file, '--reason', 'The change needed this page to show the approved value.');
    assert.equal(recorded.status, 0, JSON.stringify(recorded.value));
    const taken = (await state(repo)).settledDecisions.filter((entry) => entry.effect?.class === 'out-of-plan' && entry.effect.file === file).at(-1);
    assert.ok(taken, `${file} is taken up`);
    repo.sflow('decisions', 'undo', 'QF-1', '--settled', taken.id, '--reason', 'I decide this file myself.');
  }
  return repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
}
const sha = async (repo, file) => createHash('sha256').update(await readFile(path.join(repo.root, file))).digest('hex');

test('a file the plan does not name is taken up with the step and listed at its approval; nothing waits [WCB:REQ-010]', async (t) => {
  const repo = await draft(t);
  // Every check says what publication takes up, and records nothing.
  for (const args of [[], ['--for-agent']]) {
    const checked = repo.sflowJson('phase', 'prepublish', 'implement', ...args);
    assert.ok(!JSON.stringify(checked.value.findings ?? []).includes('GENERATION_EXCLUDED_CHANGES_UNRESOLVED'), JSON.stringify(checked.value.findings));
    assert.deepEqual(checked.value.outsidePlan.files.map((entry) => [entry.file, entry.writer]), [['index.html', 'person']]);
    assert.equal(checked.value.departures, undefined);
  }
  assert.equal((await state(repo)).departures, undefined);

  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, JSON.stringify(published.value));
  let recorded = await state(repo);
  assert.ok(recorded.phases.implement.deliveryEvidence.sourcePaths.includes('index.html'), 'the file is published with the step');
  assert.deepEqual(recorded.settledDecisions.filter((entry) => entry.effect?.class === 'out-of-plan').map((entry) => [entry.effect.file, entry.effect.writer]),
    [['index.html', 'person']]);
  assert.equal(recorded.departures, undefined);
  repo.sflow('submit', 'implement');

  // The table has no question; the approval lists the file with who changed it, and nothing holds it.
  const list = repo.sflowJson('decisions', 'QF-1');
  assert.equal(list.status, 0, JSON.stringify(list.value));
  const packet = list.value.data ?? list.value;
  assert.ok(!packet.items.some((entry) => ['departure', 'plan-accounting'].includes(entry.kind)), JSON.stringify(packet.items.map((entry) => entry.kind)));
  const approval = packet.items.find((entry) => entry.kind === 'approval');
  assert.deepEqual(approval.details.outsidePlan.map((entry) => entry.words), ['index.html: by you']);
  assert.deepEqual(approval.details.heldBy, []);
  const approved = repo.run(process.execPath, [cli, '--no-model', 'approve', 'implement', '--work-id', 'QF-1', '--yes', '--json']);
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  recorded = await state(repo);
  assert.equal(recorded.phases.implement.status, 'approved');
  assert.equal((recorded.phaseAppeals ?? []).length, 0, 'no appeal was needed');
});

test('a rejected departure is restored by the model in the same generation, and the next prepublish checks it is back', async (t) => {
  const repo = await draft(t);
  assert.deepEqual((await personDecides(repo, 'index.html')).value.departures.recorded, ['DEP-001']);
  // A /sf-decide turn's command, the same write as the table's reject.
  repo.sflow('decision', 'departure', 'QF-1', '--departure', 'DEP-001', '--as', 'rejected', '--reason', 'The entry page is a separate change for later.');
  let recorded = await state(repo);
  assert.deepEqual(recorded.departureDecisions.map((entry) => [entry.decision, entry.departures]), [['rejected', ['DEP-001']]]);
  const held = repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.match(JSON.stringify(held.value.findings), /DEPARTURE_REJECTED_NOT_REVERTED/u);
  assert.match(held.value.departures.words, /DEP-001 was rejected: restore index\.html/u);
  assert.equal((await state(repo)).departures.length, 1, 'a rejected file is never recorded again');
  // The next turn hears it from its entry, not from a person.
  assert.deepEqual(repo.sflowJson('phase', 'enter').value.departures.rejected.map((entry) => entry.id), ['DEP-001']);
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
  assert.deepEqual((await personDecides(repo, 'about.html', 'index.html')).value.departures.recorded, ['DEP-001', 'DEP-002']);
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
  // A row change names every value it needs (office laptop, 2026-11-19): the same command, only the missing value open.
  const incomplete = record('--kind', 'plan-row', '--clause', 'QF-1:AC-001', '--row-op', 'set-fulfillment');
  refusedWith(incomplete, 'DEPARTURE_ROW_CHANGE_INCOMPLETE');
  assert.match(incomplete.stdout + incomplete.stderr, /one of modified, new, test-only, existing, removed, document, configuration, evidence/u);
  assert.ok((incomplete.stdout + incomplete.stderr).includes("singularity-flow departure record --kind plan-row --clause QF-1:AC-001 --row-op set-fulfillment --fulfillment <KIND> --reason 'The change needed this file to be edited.'"),
    incomplete.stdout + incomplete.stderr);
  refusedWith(record('--kind', 'plan-row', '--clause', 'QF-1:AC-001', '--row-op', 'set-fulfillment', '--fulfillment', 'sometimes'), 'DEPARTURE_ROW_CHANGE_INCOMPLETE');
  refusedWith(record('--kind', 'test', '--clause', 'QF-1:AC-001', '--row-op', 'add-test'), 'DEPARTURE_ROW_CHANGE_INCOMPLETE');
  refusedWith(record('--kind', 'plan-row', '--clause', 'QF-1:AC-001', '--row-op', 'replace-location', '--from', 'src/value.mjs'), 'DEPARTURE_ROW_CHANGE_INCOMPLETE');
  assert.equal((await state(repo)).departures, undefined, 'nothing incomplete is recorded');
  // The model's own record of a file the plan does not name takes it up, as Copilot's, with the reason it gave [WCB:REQ-010].
  const recorded = record('--kind', 'path', '--path', 'index.html', '--clause', 'QF-1:AC-001');
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const taken = (await state(repo)).settledDecisions.find((entry) => entry.effect?.class === 'out-of-plan');
  assert.deepEqual([taken.effect.file, taken.effect.writer, taken.effect.basis, taken.effect.reason],
    ['index.html', 'copilot', 'agent-said', 'The change needed this file to be edited.']);
  assert.equal((await state(repo)).departures, undefined);
  // Prepublish records nothing for it: it is the step's.
  assert.equal(repo.sflowJson('phase', 'prepublish', 'implement', '--for-agent').value.departures, undefined);
  repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  refusedWith(record('--kind', 'path', '--path', 'index.html'), 'DEPARTURE_LIFECYCLE');
});

test('a file edited after its departure was accepted reopens only that row, and accepting it again binds the new bytes', async (t) => {
  const repo = await draft(t);
  await writeFile(path.join(repo.root, 'about.html'), '<title>About the calendar</title>\n');
  await personDecides(repo, 'about.html', 'index.html');
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

test('every publication takes a left-out file up itself, whoever publishes, when no prepublish ran first [WCB:REQ-010]', async (t) => {
  const repo = await draft(t, { agentStep: true });
  const summary = path.join(repo.root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2, and a new entry page shows it to every visitor.\n`);
  // A person's own publication: the file is taken up with the step, by them, and nothing is refused.
  const own = repo.run(process.execPath, [cli, '--no-model', 'phase', 'publish', 'implement', '--authored', 'human', '--channel', 'manual-in-place', '--json']);
  assert.equal(own.status, 0, (own.stdout + own.stderr).slice(-1500));
  const recorded = await state(repo);
  assert.equal(recorded.departures, undefined, 'no departure');
  assert.deepEqual(recorded.settledDecisions.filter((entry) => entry.effect?.class === 'out-of-plan').map((entry) => [entry.effect.file, entry.effect.writer]),
    [['index.html', 'person']]);
  assert.ok(recorded.phases.implement.deliveryEvidence.sourcePaths.includes('index.html'));
});

test('a file the agent records under a row that only checks tests is taken up with the step, and no row changes [WCB:REQ-010]', async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, must } = repo;
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', 'singularity/workflow.yml']);
  must('git', ['commit', '-m', 'Require a human implementation review in this fixture']);
  // startQuickFix's Story, with a second clause whose row only checks tests [owner, 2026-11-19].
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |',
    '| [QF-1:AC-002] | The value test keeps passing. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |',
    '| `QF-1:AC-002` | - | `test/value.test.mjs` | test-only | The test keeps passing. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('prepare', 'implement');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001 @ac:QF-1:AC-002', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  await writeFile(path.join(root, 'index.html'), '<title>Calendar</title>\n');
  await writeFile(path.join(root, 'about.html'), '<title>About the calendar</title>\n');
  sflow('prepare', 'implement');
  const record = (file, ...clauses) => repo.sflowJson('departure', 'record', '--kind', 'path', '--path', file, ...clauses.flatMap((id) => ['--clause', id]),
    '--reason', 'The change needed this page to show the value.');
  assert.equal(record('about.html', 'QF-1:AC-001', 'QF-1:AC-002').status, 0);
  assert.equal(record('index.html', 'QF-1:AC-002').status, 0);

  // Whatever rows the agent names, a file no plan row names is taken up with the step, as Copilot's with its reason, and no
  // row of the plan changes: a test-only row is never asked to take it [WCB:REQ-010]. Accepting a departure under such a
  // row is held by the departure model (cqf-m2-departure-model.test.mjs).
  const recorded = await state(repo);
  assert.equal(recorded.departures, undefined);
  assert.equal(recorded.planAmendments, undefined);
  assert.deepEqual(recorded.settledDecisions.filter((entry) => entry.effect?.class === 'out-of-plan').map((entry) => [entry.effect.file, entry.effect.writer]),
    [['about.html', 'copilot'], ['index.html', 'copilot']]);
  const packet = repo.sflowJson('decisions', 'QF-1').value.data;
  assert.ok(!packet.items.some((entry) => entry.kind === 'departure'), JSON.stringify(packet.items.map((entry) => entry.kind)));
});

test('a plan row change is kept on the card or with the person\'s answer in chat, and its correction accepts the departure', async (t) => {
  // [owner, 2026-11-19] It was the plan approver's own terminal step: answered Keep five times in chat, nothing was recorded.
  const repo = await draft(t);
  const recorded = repo.sflowJson('departure', 'record', '--kind', 'plan-row', '--clause', 'QF-1:AC-001', '--row-op', 'set-fulfillment', '--fulfillment', 'new',
    '--reason', 'The value module is new code, not a change to an existing one.');
  assert.equal(recorded.status, 0, JSON.stringify(recorded.value));
  const item = repo.sflowJson('decisions', 'QF-1').value.data.items.find((entry) => entry.details?.departure === 'DEP-001');
  assert.match(item.title, /DEP-001: a plan row changes: QF-1:AC-001 becomes new/u, 'the exact row is shown before it is kept');
  const accept = item.options.find((option) => option.id === 'accept');
  assert.notEqual(accept.recordable, false);
  assert.equal(accept.chat.command, 'singularity-flow decision departure QF-1 --fetch --departure DEP-001 --as accepted --reason "<REASON>"');
  // The chat's command, with the person's own reason: no terminal review needed, the plan's approval group still checked.
  const kept = repo.run(process.execPath, [cli, '--no-model', 'decision', 'departure', 'QF-1', '--departure', 'DEP-001', '--as', 'accepted',
    '--reason', 'The value module is new code, so the row says new.']);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  const correction = (await state(repo)).planAmendments.at(-1);
  assert.deepEqual([correction.kind, correction.reviewAssurance, correction.authorizationId], ['plan-row-correction', 'person-decision-answer', null]);
  assert.equal(correction.operations[0].fulfillment, 'new');
  assert.equal(repo.sflowJson('departure', 'show', 'DEP-001').value.data.departure.status, 'accepted');
  // decision plan's own correction records the same way where no terminal reviews it.
  const again = repo.run(process.execPath, [cli, '--no-model', 'decision', 'plan', 'QF-1', '--set-fulfillment', 'QF-1:AC-001=modified', '--reason', 'Back to modified: the module existed before.']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal((await state(repo)).planAmendments.at(-1).operations[0].fulfillment, 'modified');
});
