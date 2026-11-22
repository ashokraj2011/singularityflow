/**
 * A person's sign-off with no screenshot (owner, 2026-11-22: "even if screenshots are not available a human reviewer should
 * be able to move the story fwd and his signoff will be taken as evidence"). A person who may witness a criterion checked it
 * themselves and says what they checked; that is its evidence, tied to the code as it is, and every view says so.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { witnessContextBinding } from '../src/verification/witness-records.mjs';

const FILE = 'singularity/work-items/QF-1/evidence/value-screen.png';
const CHECKED = 'Opened the app at 1280 and 820 px wide in Chrome: the value 2 shows on the main screen.';

test('with no screenshot at all, a person\'s own sign-off proves the criterion and the step goes on', async (t) => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo, { retainedScreenshot: FILE });
  repo.sflow('prepare', 'implement');
  await writeFile(path.join(repo.root, 'src/value.mjs'), '// @clause:QF-1:REQ-001 return the approved value\nexport const value = 2;\n');
  await writeFile(path.join(repo.root, 'test/value.test.mjs'), ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", '// @ac:QF-1:AC-001', "test('returns two', () => assert.equal(value, 2));", ''].join('\n'));
  // The screenshot the plan names is never taken.
  repo.sflow('prepare', 'implement');
  const published = repo.sflowJson('phase', 'publish', 'implement', '--authored', 'deterministic', '--channel', 'kernel-generator');
  assert.equal(published.status, 0, `a screenshot not taken yet does not hold the code: ${JSON.stringify(published).slice(0, 1500)}`);
  const workflowFile = path.join(repo.root, 'singularity/work-items/QF-1/workflow.json');
  const before = JSON.parse(await readFile(workflowFile));
  const signOff = (extra = []) => repo.sflowJson('decision', 'witness', '--work-id', 'QF-1', '--criterion', 'QF-1:AC-001', '--slot', 'screen', '--attest',
    '--reason', CHECKED, '--expected-context-sha256', witnessContextBinding(before),
    '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change', ...extra);
  // A note too short to say what was checked is refused, and nothing is recorded.
  const short = repo.sflowJson('decision', 'witness', '--work-id', 'QF-1', '--criterion', 'QF-1:AC-001', '--slot', 'screen', '--attest', '--reason', 'Looks fine.',
    '--confirm', 'states-the-outcome', '--confirm', 'matches-the-criterion', '--confirm', 'current-for-this-change');
  assert.notEqual(short.status, 0);
  assert.match(JSON.stringify(short), /say what you checked yourself/iu);
  // --attest and --file together are refused.
  assert.notEqual(signOff(['--file', FILE]).status, 0);
  const decision = signOff();
  assert.equal(decision.status, 0, JSON.stringify(decision).slice(0, 2000));
  const after = JSON.parse(await readFile(workflowFile));
  const [record] = after.witnessRecords;
  assert.deepEqual([record.basis, record.file, record.sha256, record.outcome, record.reason], ['person-attestation', null, null, 'met', CHECKED]);
  assert.match(after.history.at(-1).detail, /a sign-off with no screenshot for QF-1:AC-001 slot screen satisfies it/u);
  // The evidence matrix counts it: the criterion's visual slot is met, on that person's word.
  const matrix = repo.sflowJson('evidence', 'matrix', 'QF-1');
  const read = matrix.value ?? {};
  const row = (read.data?.matrix?.page?.rows ?? read.data?.matrix?.page?.items ?? []).find((entry) => entry.id === 'QF-1:AC-001');
  assert.equal(row?.verification?.contract?.slots?.find((slot) => slot.slot === 'screen')?.status, 'met', String(JSON.stringify(row ?? read)).slice(0, 1500));
});

// ---------------------------------------------------------------------------------------------- every card, every view

import { SIGN_OFF_ANSWERS, attestQuestion, signOffAnswers } from '../src/sign-off-question.mjs';
import * as card from '../plugin/extensions/decisions/card.mjs';
import { runWitnessReview } from '../apps/vscode/src/views/decision-list-model.ts';
import { testEvidence } from '../src/record-documents.mjs';
import { citedSignOffSources } from '../src/source-review-lifecycle.mjs';
import { witnessRecordResults } from '../src/verification/witness-records.mjs';

const BINDING = `sha256:${'c'.repeat(64)}`;
const review = { kind: 'witness', attest: true, clauseId: 'W-1:AC-002', clauseText: 'The graph stays visible at tablet width.', slot: 'graph', method: 'visual',
  files: [], owners: ['implementation'], contextBinding: BINDING };

test('the answer rules: no screenshot needs a note saying what was checked, and the card keeps the same copy', () => {
  assert.equal(attestQuestion(review), 'No screenshot: did you check yourself that the app does what AC-002 asks for?');
  assert.match(signOffAnswers('yes', 'fine', { attest: true }).problem, /Say what you checked yourself, where and how/u);
  assert.deepEqual(signOffAnswers('yes', CHECKED, { attest: true }), { reason: CHECKED, attest: true,
    answers: [['states-the-outcome', true], ['matches-the-criterion', true], ['current-for-this-change', true]] });
  // With a screenshot open, "I checked it myself (no screenshot)" is the same sign-off.
  assert.equal(SIGN_OFF_ANSWERS.self, 'I checked it myself (no screenshot)');
  assert.deepEqual(signOffAnswers('self', CHECKED), signOffAnswers('yes', CHECKED, { attest: true }));
  for (const [answer, note, options] of [['yes', CHECKED, { attest: true }], ['no', CHECKED, { attest: true }], ['self', CHECKED, {}], ['yes', 'x', { attest: true }]]) {
    assert.deepEqual(card.signOffAnswers(answer, note, options), signOffAnswers(answer, note, options), `${answer} ${note}`);
  }
  assert.deepEqual(card.SIGN_OFF_ANSWERS, SIGN_OFF_ANSWERS);
  assert.equal(card.attestQuestion(review), attestQuestion(review));
});

test('Copilot CLI: a sign-off with no screenshot is one question, its note required, recorded with no file', () => {
  const form = card.witnessForm(review);
  assert.equal(form.requestedSchema.properties.answer.title, attestQuestion(review));
  assert.deepEqual(form.requestedSchema.required, ['answer', 'note']);
  assert.equal(form.requestedSchema.properties.file, undefined, 'nothing to pick');
  assert.match(card.witnessAnswers(review, { answer: 'Yes', note: 'ok' }).problem, /Say what you checked yourself/u);
  const given = card.witnessAnswers(review, { answer: 'Yes', note: CHECKED });
  assert.deepEqual([given.attest, given.file, given.reason], [true, null, CHECKED]);
  // With a screenshot, the fourth answer is the same sign-off, whatever file was open.
  const withFile = { ...review, attest: false, files: ['shot.png'] };
  assert.ok(card.witnessForm(withFile).requestedSchema.properties.answer.enum.includes(SIGN_OFF_ANSWERS.self));
  assert.deepEqual(card.witnessAnswers(withFile, { answer: SIGN_OFF_ANSWERS.self, note: CHECKED }).file, null);
});

test('VS Code: a sign-off with no screenshot records --attest and no file, after the person\'s note', async () => {
  const packet = { workId: 'W-1', repositoryPath: '/repo', items: [{ options: [{ decidedBy: { allowed: true }, action: { humanReview: review } }] }] };
  const recorded = [];
  const result = await runWitnessReview({ workId: 'W-1' }, {
    read: async () => packet, choose: async (choices) => choices[0], file: async () => { throw new Error('no file is picked'); },
    digest: async () => { throw new Error('no file is read'); }, inspect: async () => {},
    answer: async (question) => { assert.equal(question, attestQuestion(review)); return 'yes'; },
    note: async (required, checked) => { assert.deepEqual([required, checked], [true, true]); return CHECKED; },
    record: async (repository, argv) => { recorded.push(argv); return { ok: true }; } });
  assert.equal(result.status, 'recorded');
  assert.ok(recorded[0].includes('--attest'));
  assert.ok(!recorded[0].includes('--file'));
  assert.equal(recorded[0][recorded[0].indexOf('--reason') + 1], CHECKED);
});

test('the evidence and its reviewer say it rests on the person\'s word, and a code change asks for it again', async () => {
  const record = { id: 'WIT-002', clauseId: 'W-1:AC-002', slot: 'graph', method: 'visual', file: null, sha256: null, basis: 'person-attestation',
    contextBinding: BINDING, outcome: 'met', reason: CHECKED, actor: 'reviewer-one', at: '2026-11-22T10:00:00.000Z',
    checklist: { 'states-the-outcome': 'yes', 'matches-the-criterion': 'yes', 'current-for-this-change': 'yes' } };
  const row = { id: 'W-1:AC-002', type: 'AC', verification: { witnesses: [], contract: { slots: [{ slot: 'graph', method: 'visual', status: 'satisfied' }] } } };
  assert.equal(testEvidence(row, [record]), `signed off by reviewer-one without a screenshot (\`WIT-002\`): "${CHECKED}"`);
  const [met] = witnessRecordResults([record], new Map(), { contextBinding: BINDING });
  assert.deepEqual([met.status, met.attested], ['met', true]);
  const [stale] = witnessRecordResults([record], new Map(), { contextBinding: `sha256:${'d'.repeat(64)}` });
  assert.equal(stale.status, 'missing');
  assert.match(stale.message, /needs signing off again/u);
  // The reviewer of a report that names the criterion gets the sign-off as text: never blocked for a missing screenshot.
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['build', 'uat'], phases: { build: { id: 'build', generationPolicy: { task: 'code' } },
    uat: { id: 'uat', generationPolicy: { task: 'document' } } }, resolution: { phases: [] }, witnessRecords: [record] };
  const sources = [];
  assert.deepEqual(await citedSignOffSources('/nowhere', workflow, { text: 'W-1:AC-002 is verified.' }, sources, [], workflow.phases.uat), []);
  assert.deepEqual(sources.map((source) => source.id), ['WIT-002']);
  assert.match(sources[0].text, /do not block the clause because no screenshot or file exists/u);
  assert.match(sources[0].text, new RegExp(CHECKED.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});
