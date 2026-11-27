/**
 * One decisions card for both halves of the owner's decision [owner, 2026-11-13, "Decisions are really confusing"]:
 * what SFlow settled for the person sits under "Settled for you" with its evidence and an Undo and no recommendation,
 * beside a question it advises on with its recommended answer and what each choice does. An Undo chosen on the card is
 * recorded from the card's own answers file, and the question it hands back is on the card again with its advice.
 * Through the real CLI on a quick-fix Story, rendered by each host's own card code.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { packetText } from '../src/commands/decisions.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { recordSettledDecision } from '../src/settled-decisions.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { plainSettled } from '../src/decision-plain.mjs';
import { decisionsTable, directForm, firstForm, KEEP_ALL, KEEP_SETTLED, NOT_NOW, rowForms, runCard, UNDO_SETTLED } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml, sharedAnswers as vscodeSharedAnswers } from '../apps/vscode/src/views/decide-card-page.ts';
import { buildDecisionListView, decisionAnswersDocument, decisionAnswersFromChoices } from '../apps/vscode/src/views/decision-list-model.ts';
import { decisionListHtml } from '../apps/vscode/src/views/decision-list-page.ts';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const workflowOf = async (root) => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
const number = (id) => Number(String(id).replace(/^d/u, ''));
const count = (text, words) => text.split(words).length - 1;
const AT = '2026-11-13T09:00:00.000Z';

test('a card holding only what was settled still records its Undo on every host, and names the Decide card as the route', () => {
  const authorities = { eng: { label: 'Engineers', allowAnyGitIdentity: true, members: [] } };
  const workflow = { workItem: { id: 'STL-1' }, status: 'in_progress', currentPhase: 'implement', phaseOrder: ['implement'],
    phases: { implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
      generationPolicy: { task: 'code', requirement: 'required' }, approvalPolicy: { authorities: ['eng'] } } },
    resolution: { approvalAuthorities: authorities }, history: [] };
  recordSettledDecision(workflow, { kind: 'story-selection', subject: 'STL-1 on stl-1', answer: 'Opened STL-1: the only Story on this branch.',
    evidence: [{ what: 'stl-1 is STL-1\'s own branch', where: 'workflow.json on stl-1' }], by: 'sflow', at: AT });
  const packet = { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implement', gaps: [], issues: [], pending: {}, state: {} },
    { authorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT })), phaseLabel: 'Implement' };
  assert.deepEqual([packet.items.length, packet.settled.length, packet.settled[0].id], [0, 1, 'd1']);
  // VS Code: its Undo alone enables the review, under "Settled for you", with no empty table above it.
  const html = decideHtml(packet);
  assert.match(html, /<button type="button" data-review>Review and record<\/button>/u);
  assert.equal(count(html, '<table>'), 1);
  // Copilot CLI: nothing waits, so the first form keeps everything first, then the undo, never "Decide each one" [owner, 2026-11-20].
  const { form } = firstForm(packet);
  assert.deepEqual(form.requestedSchema.properties.choice.enum, [KEEP_ALL, `${UNDO_SETTLED} (1)`]);
  // It names what was settled, in one line, instead of counting it [owner, 2026-11-16].
  assert.equal(form.message, 'Nothing waits on you now. Settled for you: SFlow opened STL-1 because its branch is the one checked out here. Undo if wrong.');
  assert.doesNotMatch(decisionsTable(packet), /\| What it is \|/u);
  // The terminal: the Decide card is the route, and nothing says "not available".
  const text = packetText(packet);
  assert.match(text, /Undo one on the Decide card:\n- Copilot: \/sf-decide STL-1\n- Shell: singularity-flow decisions undo STL-1 --settled STL-001\n- VS Code \(model-free\): Command Palette: Singularity Flow: Decide Everything/u);
  assert.doesNotMatch(text, /not available/u);
  // Two settled: one filled undo line each, never one with the ID left blank [owner, 2026-11-19].
  recordSettledDecision(workflow, { kind: 'story-selection', subject: 'STL-1 again', answer: 'Kept STL-1: the only Story here.',
    evidence: [{ what: 'one Story', where: 'workflow.json' }], by: 'sflow', at: AT });
  const two = packetText({ ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implement', gaps: [], issues: [], pending: {}, state: {} },
    { authorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT })), phaseLabel: 'Implement' });
  assert.match(two, /Or in your own terminal:\n- singularity-flow decisions undo STL-1 --settled STL-002\n- singularity-flow decisions undo STL-1 --settled STL-001/u);
  assert.doesNotMatch(two, /<STL-ID>/u);
});

/**
 * The owner's /sf-decide in VS Code (2026-11-20): nothing waited, yet six "Settled for you" lines led, with version starts of
 * long-approved steps among them, and the chat asked a required "How do you want to decide?" whose only choices undid them
 * ("Undo: ask me instead for all 6, with one reason", preselected). "really confusing". What was settled is never a chat
 * question; a form offering its undo keeps everything first; only what can still matter is said, three at most.
 */
function settledStory() {
  const authorities = { eng: { label: 'Engineers', allowAnyGitIdentity: true, members: [] } };
  const workflow = { workItem: { id: 'STL-2' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['specification', 'implementation'],
    phases: { specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 3, approvalPolicy: { authorities: ['eng'] } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 2, versionOpening: { version: 3, reason: 'review-corrections' },
        approvalPolicy: { authorities: ['eng'] } } },
    resolution: { approvalAuthorities: authorities }, history: [] };
  const evidence = [{ what: 'the review asks for corrections', where: 'the retained review' }];
  const start = (phase, from, to) => recordSettledDecision(workflow, { kind: 'review-corrections', phase, subject: `${phase} version ${from}: the review's findings`,
    answer: `Started version ${to} of ${phase} to fix the review's findings on version ${from}`, evidence, effect: { generation: from, toGeneration: to }, by: 'sflow', at: AT });
  // History: two starts on Specification, approved long ago, and a start of Implementation's version 2, superseded by version 3.
  start('specification', 1, 2); start('specification', 2, 3); start('implementation', 1, 2);
  // What can still matter: the start of the version being written, and four more on Implementation.
  start('implementation', 2, 3);
  recordSettledDecision(workflow, { kind: 'node-version', phase: 'implementation', subject: 'Node 22 for implementation\'s tests', answer: 'Pinned Node 22: .nvmrc names it.',
    evidence: [{ what: '.nvmrc names Node 22', where: '.nvmrc' }], effect: { version: '22', file: '.nvmrc' }, by: 'sflow', at: AT });
  recordSettledDecision(workflow, { kind: 'test-command', phase: 'implementation', subject: 'unit for implementation', answer: 'Chose unit: the only test command declared.',
    evidence: [{ what: 'package.json declares one test script', where: 'package.json' }], effect: { commandId: 'unit', request: 'TCD-001' }, by: 'sflow', at: AT });
  recordSettledDecision(workflow, { kind: 'plan-accounting', phase: 'implementation', subject: 'file:README.md', answer: 'Listed README.md in the plan as a supporting change.',
    evidence: [{ what: 'README.md is documentation', where: 'README.md' }], effect: { file: 'README.md', class: 'documentation' }, by: 'sflow', at: AT });
  recordSettledDecision(workflow, { kind: 'plan-accounting', phase: 'implementation', subject: 'file:src/value.test.mjs', answer: 'Accounted src/value.test.mjs to REQ-001\'s row.',
    evidence: [{ what: 'STL-2:REQ-001\'s row names src/value.mjs', where: 'the approved plan' }], effect: { clauseId: 'STL-2:REQ-001', path: 'src/value.test.mjs' }, by: 'sflow', at: AT });
  return { workflow, authorities };
}
const settledPacket = () => {
  const { workflow, authorities } = settledStory();
  return { ...withPlainWords(workflow, decisionPacket(workflow, { phaseId: 'implementation', gaps: [], issues: [], pending: {}, state: {} },
    { authorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT })), phaseLabel: 'Implementation', packetSha256: 'sha256:aaa' };
};

test('what was settled is never a chat question; only what can still matter is said, three at most, and history offers no undo', async () => {
  const packet = settledPacket();
  const id = (item) => item.details.settledId;
  const history = packet.settled.filter((item) => item.details.history);
  assert.deepEqual(history.map(id).sort(), ['STL-001', 'STL-002', 'STL-003'], 'approved steps and a superseded version are history');
  for (const item of history) {
    assert.deepEqual([item.options.length, item.answer.where, item.details.commands.length], [0, 'later', 0], id(item));
    assert.doesNotMatch(item.plain.settled, /Undo/u, id(item));
  }
  const current = packet.settled.filter((item) => !item.details.history);
  assert.equal(current.length, 5);
  for (const item of current) {
    assert.deepEqual([item.chatYesNo, item.yesNo, item.answer.where, item.options[0].id, item.options[0].chat], [false, undefined, 'card', 'undo', undefined], id(item));
  }
  // One line a chat may say, never a question: the newest three, then how many more the Decide page lists.
  assert.equal(packet.plain.headline, 'Nothing waits on you now.');
  assert.equal(packet.plain.settledLine, 'Settled for you: src/value.test.mjs in the plan, README.md in the plan, unit as Implementation\'s tests and 2 more on the Decide page. Undo any there.');
  const act = agentAct(packet);
  assert.equal(act.ask, undefined);
  assert.match(act.said, /Say plain\.settledLine once, as given; never ask it\.$/u);
  // A chat that opened the Copilot CLI card carries on: nothing asked, the one line said.
  const asked = [];
  const chat = await runCard({ askedInChat: true, read: async () => packet, show: async () => {}, inspect: async () => {}, witness: async () => assert.fail('nothing'),
    record: async () => assert.fail('nothing'), ask: async (form) => { asked.push(form); return { action: 'accept', content: {} }; } });
  assert.deepEqual([chat.status, asked.length], ['nothing-to-decide', 0]);
  assert.ok(chat.message.includes(packet.plain.settledLine), chat.message);
  // A person who opened the card: keeping all comes first, no undo for all, and three settled lines then how many more.
  const { form } = firstForm(packet);
  assert.deepEqual(form.requestedSchema.properties.choice.enum, [KEEP_ALL, `${UNDO_SETTLED} (5)`]);
  assert.ok(!form.requestedSchema.properties.choice.enum.includes(NOT_NOW));
  assert.ok(form.message.startsWith('Nothing waits on you now. Settled for you: SFlow added src/value.test.mjs to REQ-001\'s row of the plan'), form.message);
  assert.ok(form.message.endsWith('. Undo if wrong. And 2 more on the Decide page.'), form.message);
  assert.equal(count(form.message, 'Undo if wrong.'), 3);
  assert.doesNotMatch(form.message, /Specification/u, 'history is not said');
  const kept = [];
  const person = await runCard({ read: async () => packet, show: async () => {}, inspect: async () => {}, witness: async () => assert.fail('nothing'),
    record: async () => assert.fail('keeping all records nothing'), ask: async (shown) => { kept.push(shown); return { action: 'accept', content: { choice: shown.requestedSchema.properties.choice?.enum[0] } }; } });
  assert.deepEqual([person.status, kept.length], ['cancelled', 1]);
  // Each settled row, once chosen to change, keeps it first: a form never undoes by default.
  const [page] = rowForms(current);
  for (const field of Object.values(page.form.requestedSchema.properties)) assert.equal(field.enum[0], KEEP_SETTLED);
  // VS Code: no "one answer for all" undo, a history row has no choice, and each settled row's empty choice keeps it.
  assert.deepEqual(vscodeSharedAnswers(packet), []);
  const html = decideHtml(packet);
  assert.equal(count(html, '<option value="">Keep it</option>'), 5);
  // The terminal: history listed with its evidence, with no undo route.
  const text = packetText(packet);
  assert.match(text, /Or in your own terminal:\n(?:- singularity-flow decisions undo STL-2 --settled STL-00[4-8]\n){5}/u);
  assert.doesNotMatch(text, /--settled STL-00[1-3]/u);
});

test('a file settled into the plan names the file and its requirement, or says the plan when either is unknown', () => {
  const { workflow } = settledStory();
  const said = (effect, evidence = [{ what: 'README.md is documentation', where: 'README.md' }]) => plainSettled(workflow, { kind: 'plan-accounting', by: 'sflow', phase: 'implementation',
    subject: 'file:README.md', evidence, effect });
  assert.equal(said({ clauseId: 'STL-2:REQ-001', path: 'src/value.test.mjs' }, [{ what: 'REQ-001\'s row names src/value.mjs', where: 'the approved plan' }]),
    'SFlow added src/value.test.mjs to REQ-001\'s row of the plan because REQ-001\'s row names src/value.mjs beside it. Undo if wrong.');
  assert.equal(said({ file: 'README.md', class: 'documentation' }), 'SFlow added README.md to the plan because README.md is documentation. Undo if wrong.');
  assert.equal(said({}, []), 'SFlow added README.md to the plan. Undo if wrong.', 'the file from its subject');
  assert.doesNotMatch(said({ path: 'a.mjs' }), /'s row|to 's/u);
});

test('a settled item and an advised one on the same card; Undo from the card hands the question back with its recommendation', slowLane({ timeout: 900_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, sflowJson } = repo;
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.approval = { mode: 'required', authorities: ['engineering-reviewers'], minimum: 1, rejectTo: ['intake'] };
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'An agent-authored code step in this fixture']);
  await startQuickFix(repo);
  sflow('prepare', 'implement');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'src/extra.mjs'), 'export const extra = 3;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');
  // A file no plan row names is taken up with the step [WCB:REQ-010]; once the person undoes that, it is a departure they
  // decide, advised on the card.
  const recorded = sflowJson('departure', 'record', '--kind', 'path', '--path', 'src/extra.mjs', '--reason', 'The value module needed a helper.');
  assert.equal(recorded.status, 0, JSON.stringify(recorded.value).slice(0, 1500));
  const taken = ((await workflowOf(root)).settledDecisions ?? []).filter((entry) => entry.effect?.class === 'out-of-plan' && entry.effect.file === 'src/extra.mjs').at(-1);
  assert.ok(taken, 'src/extra.mjs is taken up');
  sflow('decisions', 'undo', 'QF-1', '--settled', taken.id, '--reason', 'I decide this file myself.');
  sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.deepEqual(((await workflowOf(root)).departures ?? []).flatMap((entry) => entry.paths), ['src/extra.mjs']);
  // The only test command the repository declares: settled for the person, never asked.
  const inspected = sflowJson('capability', 'test-setup').value;
  const [suggestion] = inspected.data?.suggestions ?? inspected.suggestions ?? [];
  const requested = sflowJson('decision', 'test-command', 'QF-1', '--phase', 'implement', '--use', suggestion.id, '--reason', 'The repository\'s own test script runs these tests.');
  assert.equal(requested.status, 0, JSON.stringify(requested.value).slice(0, 1500));
  const settledId = requested.value.data.settled.id;

  const card = sflowJson('decisions', 'QF-1').value.data;
  const departure = card.items.find((item) => item.kind === 'departure');
  assert.ok(departure, JSON.stringify(card.items.map((item) => item.kind)));
  assert.equal(card.items.some((item) => item.kind === 'test-command' || item.settled), false, 'nobody is asked about the settled command');
  // The advised item: its recommended answer (or what to weigh), and what each choice does.
  assert.match(departure.recommended.words, /^Recommended/u);
  assert.ok(departure.options.filter((option) => option.available !== false).every((option) => typeof option.does === 'string' && option.does), JSON.stringify(departure.options));
  // The settled item: its evidence as lines, an Undo that says what it does, nothing recommended, and never a chat question:
  // its undo is on the Decide card [owner, 2026-11-20].
  const settled = card.settled.find((item) => item.details.settledId === settledId);
  assert.deepEqual([settled.kind, settled.settled, settled.recommended, settled.chatYesNo, settled.yesNo], ['settled', true, undefined, false, undefined]);
  assert.ok(settled.evidence.some((line) => /package\.json/u.test(line)), JSON.stringify(settled.evidence));
  assert.deepEqual(settled.options.map((option) => option.id), ['undo']);
  assert.match(settled.options[0].does, /^Makes it your question again: .*waits for a person who approves implement/u);
  assert.equal(settled.answer.words, 'Nothing to answer. Undo it on the Decide card (/sf-decide QF-1 opens it) only if it is wrong; a chat never asks it.');
  // Numbered after every item and every offered one, the approval door being d0, so settling or undoing renumbers nothing.
  assert.ok([...card.items, ...(card.offered ?? [])].every((item) => number(item.id) < number(settled.id)), settled.id);

  // Every host shows it once, under its own heading, and the advised item with its recommendation.
  const terminal = sflow('decisions', 'QF-1');
  assert.equal(count(terminal, 'Settled for you'), 1, terminal);
  assert.ok(terminal.includes(departure.plain.recommended), terminal);
  assert.ok(terminal.indexOf(departure.plain.recommended) < terminal.indexOf('Settled for you'), 'what waits comes first');
  const html = decideHtml(card);
  assert.equal(count(html, '<h2>Settled for you</h2>'), 1);
  assert.ok(html.includes('Makes it your question again'), 'the Undo says what it does');
  const table = decisionsTable(card);
  assert.equal(count(table, '**Settled for you.**'), 1, table);
  // Copilot CLI asks the one question that waits directly [owner, 2026-11-16]; the settled one sits beside it, kept unless undone.
  const { form: first } = directForm(card);
  assert.equal(first.requestedSchema.properties.decision0.title, departure.plain.question);
  assert.deepEqual(first.requestedSchema.required, ['decision0']);
  assert.deepEqual(first.requestedSchema.properties.settled0.enum, [KEEP_SETTLED, 'Undo: ask me instead']);
  assert.equal(count(decisionListHtml(buildDecisionListView(card)), '<h2>Settled for you</h2>'), 1);

  // Undo, chosen on VS Code's card and recorded from its answers file, as the card records any answer.
  const chosen = decisionAnswersFromChoices(card, [{ item: settled.id, option: 'undo', reason: 'Not the suite I meant for this Story.' }]);
  assert.deepEqual(chosen.errors, []);
  const answers = path.join(repo.base, 'card-answers.json');
  await writeFile(answers, JSON.stringify(decisionAnswersDocument(chosen.answers, card.packetSha256)));
  const undone = sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(undone.status, 0, JSON.stringify(undone.value).slice(0, 1500));
  const workflow = await workflowOf(root);
  const undo = workflow.settledDecisions.find((entry) => entry.undoes === settledId);
  assert.deepEqual([undo.channel, undo.reason], ['decisions-card', 'Not the suite I meant for this Story.']);

  // The question is the person's again, on the same card, with its recommendation and what each choice does.
  const after = sflowJson('decisions', 'QF-1').value.data;
  assert.equal(after.settled, undefined);
  const asked = after.items.find((item) => item.kind === 'test-command');
  assert.ok(asked, JSON.stringify(after.items.map((item) => item.kind)));
  assert.match(asked.recommended.words, /^Recommended/u);
  assert.ok(asked.options.filter((option) => option.available !== false).every((option) => typeof option.does === 'string' && option.does), JSON.stringify(asked.options));
  assert.ok(after.items.some((item) => item.kind === 'departure' && item.recommended?.words), 'the departure is still advised');
  // A card still showing the undone settlement is refused: the list it was read from changed.
  assert.equal(sflowJson('decisions', 'record', 'QF-1', '--answers', answers).value.error.code, 'DECISIONS_PACKET_CHANGED');
});
