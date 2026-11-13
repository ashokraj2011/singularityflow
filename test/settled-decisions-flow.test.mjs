/**
 * Settled decisions through the real CLI on a quick-fix Story [owner, 2026-11-13]: each site settles only its clear
 * case, records it on the Story with its evidence, never asks, and lists it on the decisions card with an undo; the
 * undo, from the card or a person's terminal, makes it their question again, and the same site then asks.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { recordStorySelection, settledStorySelection } from '../src/story-selection-settle.mjs';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const workflowOf = async (root) => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));
const settledOf = async (root, kind) => ((await workflowOf(root)).settledDecisions ?? []).filter((entry) => entry.kind === kind);

test('which Story a session opens is settled from its checkout\'s branch, listed with an undo, and asked again once undone', slowLane({ timeout: 600_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflowJson } = repo;
  await startQuickFix(repo);

  // The checkout's branch is QF-1's own, from any folder inside it; outside every Story checkout nobody can say.
  const selection = await settledStorySelection([path.join(root, 'src')]);
  assert.equal(selection.workId, 'QF-1');
  assert.match(selection.evidence[0].what, /is QF-1's own branch, recorded in its Story record/u);
  assert.doesNotMatch(JSON.stringify(selection.evidence), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'no machine path in the record');
  assert.equal(await settledStorySelection([repo.base]), null);

  // Recorded once on the Story, with its evidence; the same selection again records nothing more.
  const recorded = await recordStorySelection(root, selection);
  assert.deepEqual([recorded.recorded, recorded.reused], [true, false]);
  assert.equal((await recordStorySelection(root, selection)).reused, true);
  const [entry] = await settledOf(root, 'story-selection');
  assert.deepEqual([entry.id, entry.by, entry.subject], [recorded.id, 'sflow', selection.subject]);

  // The card shows it under Settled for you, counted nowhere.
  const listed = sflowJson('decisions', 'QF-1').value.data;
  const item = listed.settled.find((candidate) => candidate.details.settledId === entry.id);
  assert.equal(item.kind, 'settled');
  assert.equal(item.options[0].id, 'undo');
  assert.equal(listed.items.some((candidate) => candidate.kind === 'settled'), false);

  // The card's undo is one more answer of the list, recorded from its answers file.
  const answers = path.join(repo.base, 'card-answers.json');
  await writeFile(answers, JSON.stringify({ choose: { [item.id]: 'undo' }, reason: { [item.id]: 'Not the Story I meant.' }, confirm: listed.packetSha256 }));
  const undone = sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(undone.status, 0, JSON.stringify(undone.value));
  assert.match(JSON.stringify(undone.value.data.decided), /lists the Stories and asks which one to open/u);
  const workflow = await workflowOf(root);
  const undo = workflow.settledDecisions.find((candidate) => candidate.undoes === entry.id);
  assert.deepEqual([undo.channel, undo.reason], ['decisions-card', 'Not the Story I meant.']);
  assert.equal(workflow.history.at(-1).event, 'decision_settled');
  assert.equal(sflowJson('decisions', 'QF-1').value.data.settled, undefined, 'undone, it is no longer settled');
  // Asked from now on: the same checkout settles nothing.
  assert.equal(await settledStorySelection([root]), null);
  // An undone one is not undone twice.
  assert.equal(sflowJson('decisions', 'undo', 'QF-1', '--settled', entry.id).value.error.code, 'SETTLED_DECISION_UNDONE');
});

test('a covered file, a test command the repository declares and the author\'s own correction are settled, and each undo asks again', slowLane({ timeout: 900_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, sflowJson } = repo;
  // A code step its agent authors, as /sf-code does, with a person's approval (scs-m4-asked-for.test.mjs).
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
  await writeFile(path.join(root, 'src/value.d.ts'), 'export declare const value: number;\n');
  await writeFile(path.join(root, 'src/extra.mjs'), 'export const extra = 3;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');

  // A test command request from the only one the repository declares: settled, not waiting for an approver.
  const inspected = sflowJson('capability', 'test-setup').value;
  const suggestions = [...(inspected.data?.suggestions ?? inspected.suggestions ?? [])];
  assert.equal(suggestions.length, 1, JSON.stringify(inspected).slice(0, 400));
  const requested = sflowJson('decision', 'test-command', 'QF-1', '--phase', 'implement', '--use', suggestions[0].id,
    '--reason', 'The repository\'s own test script runs these tests.');
  assert.equal(requested.status, 0, JSON.stringify(requested.value));
  const settledCommand = requested.value.data.settled;
  assert.equal(settledCommand.kind, 'test-command');
  assert.match(settledCommand.evidence[0].where, /package\.json/u);
  assert.deepEqual((await workflowOf(root)).phases.implement.storyTestCommands.map((entry) => entry.id), [suggestions[0].id]);
  assert.equal(sflowJson('decisions', 'QF-1').value.data.items.some((entry) => entry.kind === 'test-command'), false, 'nobody is asked');
  // Undone in a person's terminal: the request waits for an approver on the list.
  const back = sflowJson('decisions', 'undo', 'QF-1', '--settled', settledCommand.id);
  assert.equal(back.status, 0, JSON.stringify(back.value));
  assert.match(back.value.data.reraised.words, /waits for a person who approves implement/u);
  assert.equal((await workflowOf(root)).phases.implement.storyTestCommands, undefined);
  assert.equal(sflowJson('decisions', 'QF-1').value.data.items.some((entry) => entry.kind === 'test-command'), true);

  // The agent's prepublish settles the file a plan row covers, and records the other as a departure.
  const prepublished = sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.ok(prepublished.value, prepublished.stderr);
  const [covered] = await settledOf(root, 'plan-accounting');
  assert.equal(covered.subject, 'file:src/value.d.ts');
  assert.deepEqual(covered.effect, { clauseId: 'QF-1:AC-001', path: 'src/value.d.ts' });
  const departed = (await workflowOf(root)).departures ?? [];
  assert.deepEqual(departed.flatMap((entry) => entry.paths), ['src/extra.mjs']);
  const card = sflowJson('decisions', 'QF-1').value.data;
  assert.ok(card.settled.some((entry) => entry.details.settledId === covered.id));
  assert.equal(JSON.stringify(card.items).includes('src/value.d.ts'), false, 'the covered file is no question');

  // Undone, the next prepublish records it as a departure a person decides, and settles it no more.
  assert.equal(sflowJson('decisions', 'undo', 'QF-1', '--settled', covered.id).status, 0);
  sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.deepEqual(((await workflowOf(root)).departures ?? []).flatMap((entry) => entry.paths).sort(), ['src/extra.mjs', 'src/value.d.ts']);
  assert.equal((await settledOf(root, 'plan-accounting')).length, 1);

  // The author's own correction of its own published generation: opened without asking, settled with its evidence.
  const summary = path.join(root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2.\n`);
  const published = sflowJson('phase', 'publish', 'implement', '--authored', 'governed-agent', '--channel', 'copilot-host');
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 2000));
  const corrected = sflowJson('phase', 'rollover', 'implement', '--correction', 'Its summary says value 3, which contradicts the recorded plan of value 2.');
  assert.equal(corrected.status, 0, JSON.stringify(corrected.value));
  assert.deepEqual([corrected.value.kind, corrected.value.fromGeneration, corrected.value.toGeneration], ['own-correction', 1, 2]);
  const [own] = await settledOf(root, 'own-correction');
  assert.deepEqual([own.by, own.subject], ['agent', 'implement generation 1']);
  assert.ok(own.evidence.some((entry) => /no independent review report and no approval/u.test(entry.what)));
  assert.equal((await workflowOf(root)).phases.implement.generationIntent.status, 'open');
  const reopened = sflowJson('decisions', 'undo', 'QF-1', '--settled', own.id);
  assert.equal(reopened.status, 0, JSON.stringify(reopened.value).slice(0, 1500));
  assert.equal(reopened.value.data.reraised.copilotCommand, '/sf-phase-documents implement');
});
