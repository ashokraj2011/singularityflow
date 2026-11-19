/**
 * Changes outside the plan on a code step nobody approves, through the real CLI [owner, 2026-11-19, C3 and Q6].
 *
 * A quick fix's implement step completes at its submission. Before, a departure recorded there was never decided: the card
 * said it held an approval that never comes, and once the step moved on it left the list undecided. Now SFlow settles the
 * files whose place is clear (a companion file, documentation), each with its evidence and an undo; the file that can
 * change what the product does is a departure the plan's approvers decide, and it holds the step's completion until then.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const workflowOf = async (root) => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));

test('on a step nobody approves, clear files are settled and a behaviour change holds the step\'s completion until it is decided', slowLane({ timeout: 900_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  const { root, sflow, sflowJson } = repo;
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  // A code step its agent authors, as /sf-code does, completed at its submission: nobody approves it.
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  config.phases.implement.approval = { mode: 'none' };
  await writeFile(configPath, YAML.stringify(config));
  repo.must('git', ['add', 'singularity/workflow.yml']);
  repo.must('git', ['commit', '-m', 'An agent-authored code step nobody approves']);
  await startQuickFix(repo);
  assert.deepEqual((await workflowOf(root)).resolution.settling, { outOfPlan: 1 }, 'a new Story pins the settling it starts with');
  sflow('prepare', 'implement');
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'src/value.d.ts'), 'export declare const value: number;\n');
  await writeFile(path.join(root, 'src/extra.mjs'), 'export const extra = 3;\n');
  await writeFile(path.join(root, 'README.md'), '# Value\n\nThe module exports the approved value.\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  sflow('prepare', 'implement');

  // The agent's prepublish settles the companion and the documentation, and records only the behaviour change.
  const prepublished = sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.ok(prepublished.value, prepublished.stderr);
  const after = await workflowOf(root);
  const settled = (after.settledDecisions ?? []).filter((entry) => entry.kind === 'plan-accounting');
  assert.deepEqual(settled.map((entry) => [entry.subject, entry.effect]).sort(), [
    ['file:README.md', { file: 'README.md', class: 'documentation' }],
    ['file:src/value.d.ts', { clauseId: 'QF-1:AC-001', path: 'src/value.d.ts' }]]);
  assert.deepEqual((after.departures ?? []).map((entry) => entry.paths), [['src/extra.mjs']]);
  const card = sflowJson('decisions', 'QF-1').value.data;
  const row = card.items.find((entry) => entry.kind === 'departure');
  assert.equal(row.holds, 'step-completion');
  assert.equal(row.holdsWords, 'Holds this step\'s submission, which completes it: the step needs no approval.');
  assert.match(row.why, /can change what the product does/u);
  assert.match(row.why, /its submission waits for this decision/u);
  assert.deepEqual(card.settled.map((entry) => entry.subject).sort(), ['file:README.md', 'file:src/value.d.ts']);

  // Published, then submitted: the submission, which would complete the step, waits for the departure.
  const summary = path.join(root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2.\n`);
  const published = sflowJson('phase', 'publish', 'implement', '--authored', 'governed-agent', '--channel', 'copilot-host');
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 2000));
  const held = sflowJson('submit', 'implement');
  assert.notEqual(held.status, 0);
  assert.equal(held.value.error.code, 'DEPARTURES_UNDECIDED', JSON.stringify(held.value).slice(0, 1500));
  assert.match(held.value.error.message, /before it is submitted/u);
  assert.notEqual((await workflowOf(root)).phases.implement.status, 'approved');

  // A plan approver keeps it on the card with the recommended answer, nothing typed; then the submission completes the step.
  const listed = sflowJson('decisions', 'QF-1').value.data;
  const departure = listed.items.find((entry) => entry.kind === 'departure');
  const answers = path.join(repo.base, 'keep.json');
  await writeFile(answers, JSON.stringify({ choose: { [departure.id]: departure.recommended.option }, confirm: listed.packetSha256 }));
  const kept = sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(kept.status, 0, JSON.stringify(kept.value).slice(0, 1500));
  const submitted = sflowJson('submit', 'implement');
  assert.equal(submitted.status, 0, JSON.stringify(submitted.value).slice(0, 2000));
  assert.equal((await workflowOf(root)).phases.implement.status, 'approved');
});
