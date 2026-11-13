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
import { recordSettledDecision } from '../src/settled-decisions.mjs';
import { decisionsTable, firstForm, NOT_NOW, UNDO_SETTLED } from '../plugin/extensions/decisions/card.mjs';
import { decideHtml } from '../apps/vscode/src/views/decide-card-page.ts';
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
  const packet = { ...decisionPacket(workflow, { phaseId: 'implement', gaps: [], issues: [], pending: {}, state: {} },
    { authorities, actor: { name: 'Person', email: 'person@example.invalid' }, at: AT }), phaseLabel: 'Implement' };
  assert.deepEqual([packet.items.length, packet.settled.length, packet.settled[0].id], [0, 1, 'd1']);
  // VS Code: its Undo alone enables the review, under "Settled for you", with no empty table above it.
  const html = decideHtml(packet);
  assert.match(html, /<button type="button" data-review>Review and record<\/button>/u);
  assert.equal(count(html, '<table>'), 1);
  // Copilot CLI: nothing waits, so the first form offers the undo or Not now, never "Decide each one".
  const { form } = firstForm(packet);
  assert.deepEqual(form.requestedSchema.properties.choice.enum, [`${UNDO_SETTLED} (1)`, NOT_NOW]);
  assert.equal(form.message, 'Nothing here waits on a decision from you. 1 is settled for you, which you may undo if it is wrong.');
  assert.doesNotMatch(decisionsTable(packet), /\| What it is \|/u);
  // The terminal: the Decide card is the route, and nothing says "not available".
  const text = packetText(packet);
  assert.match(text, /Undo one on the Decide card:\n- Copilot: \/sf-decide STL-1\n- Shell: singularity-flow decisions undo STL-1 --settled STL-001\n- VS Code \(model-free\): Command Palette: Singularity Flow: Decide Everything/u);
  assert.doesNotMatch(text, /not available/u);
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
  // A file no plan row names: a departure the person decides, advised on the card.
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
  assert.match(departure.recommended.words, /^(?:Recommended|No recommendation)/u);
  assert.ok(departure.options.filter((option) => option.available !== false).every((option) => typeof option.does === 'string' && option.does), JSON.stringify(departure.options));
  // The settled item: its evidence as lines, an Undo that says what it does, nothing recommended, and no chat yes-or-no.
  const settled = card.settled.find((item) => item.details.settledId === settledId);
  assert.deepEqual([settled.kind, settled.settled, settled.recommended, settled.chatYesNo], ['settled', true, undefined, false]);
  assert.ok(settled.evidence.some((line) => /package\.json/u.test(line)), JSON.stringify(settled.evidence));
  assert.deepEqual(settled.options.map((option) => option.id), ['undo']);
  assert.match(settled.options[0].does, /^Makes it your question again: .*waits for a person who approves implement/u);
  assert.match(settled.answer.words, /^Nothing to answer\. Undo it on the Decide card \(\/sf-decide QF-1 opens it\) only if it is wrong/u);
  // Numbered after every item and every offered one, the approval door being d0, so settling or undoing renumbers nothing.
  assert.ok([...card.items, ...(card.offered ?? [])].every((item) => number(item.id) < number(settled.id)), settled.id);

  // Every host shows it once, under its own heading, and the advised item with its recommendation.
  const terminal = sflow('decisions', 'QF-1');
  assert.equal(count(terminal, 'Settled for you'), 1, terminal);
  assert.ok(terminal.includes(departure.recommended.words), terminal);
  assert.ok(terminal.indexOf(departure.recommended.words) < terminal.indexOf('Settled for you'), 'what waits comes first');
  const html = decideHtml(card);
  assert.equal(count(html, '<h2>Settled for you</h2>'), 1);
  assert.ok(html.includes('Makes it your question again'), 'the Undo says what it does');
  const table = decisionsTable(card);
  assert.equal(count(table, '**Settled for you.**'), 1, table);
  // Copilot CLI's forms ask what waits; the settled one only once the person chooses to undo it.
  const first = firstForm(card).form;
  assert.match(first.message, /^1 still need a decision from you\. 1 is settled for you, which you may undo if it is wrong\.$/u);
  assert.ok(first.requestedSchema.properties.choice.enum.includes(`${UNDO_SETTLED} (1)`));
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
  assert.match(asked.recommended.words, /^(?:Recommended|No recommendation)/u);
  assert.ok(asked.options.filter((option) => option.available !== false).every((option) => typeof option.does === 'string' && option.does), JSON.stringify(asked.options));
  assert.ok(after.items.some((item) => item.kind === 'departure' && item.recommended?.words), 'the departure is still advised');
  // A card still showing the undone settlement is refused: the list it was read from changed.
  assert.equal(sflowJson('decisions', 'record', 'QF-1', '--answers', answers).value.error.code, 'DECISIONS_PACKET_CHANGED');
});
