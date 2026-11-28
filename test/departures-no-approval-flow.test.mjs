/**
 * Changes outside the plan on a code step nobody approves, through the real CLI [owner, 2026-11-19, C3 and Q6; WCB].
 *
 * A quick fix's implement step completes at its submission. Before, a departure recorded there was never decided: the card
 * said it held an approval that never comes, and once the step moved on it left the list undecided. SFlow settles the
 * files whose place is clear (a companion file, documentation), each with its evidence and an undo; since 2026-11-27 the file
 * that can change what the product does is taken up with the step too, changed outside the plan by you, and nothing holds
 * its completion [WCB:REQ-010].
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const workflowOf = async (root) => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));

test('on a step nobody approves, clear files are settled and a behaviour change is taken up with the step, nothing held', slowLane({ timeout: 900_000 }), async (t) => {
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

  // The agent's prepublish settles the companion and the documentation, records no departure, and says what publication
  // takes up.
  const prepublished = sflowJson('phase', 'prepublish', 'implement', '--for-agent');
  assert.ok(prepublished.value, prepublished.stderr);
  const after = await workflowOf(root);
  const settled = (after.settledDecisions ?? []).filter((entry) => entry.kind === 'plan-accounting');
  assert.deepEqual(settled.map((entry) => [entry.subject, entry.effect]).sort(), [
    ['file:README.md', { file: 'README.md', class: 'documentation' }],
    ['file:src/value.d.ts', { clauseId: 'QF-1:AC-001', path: 'src/value.d.ts' }]]);
  assert.equal((after.departures ?? []).length, 0, 'no departure waits for a person');
  assert.deepEqual(prepublished.value.outsidePlan.files.map((entry) => [entry.file, entry.writer]), [['src/extra.mjs', 'person']]);
  const card = sflowJson('decisions', 'QF-1').value.data;
  assert.ok(!card.items.some((entry) => ['departure', 'plan-accounting'].includes(entry.kind)), JSON.stringify(card.items.map((entry) => entry.kind)));
  assert.deepEqual(card.settled.map((entry) => entry.subject).sort(), ['file:README.md', 'file:src/value.d.ts']);

  // Published, then submitted: the behaviour change is taken up with the step, and the submission completes it.
  const summary = path.join(root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2.\n`);
  const published = sflowJson('phase', 'publish', 'implement', '--authored', 'governed-agent', '--channel', 'copilot-host');
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 2000));
  const taken = (await workflowOf(root)).settledDecisions.filter((entry) => entry.effect?.class === 'out-of-plan');
  assert.deepEqual(taken.map((entry) => [entry.effect.file, entry.effect.writer, entry.effect.kind]), [['src/extra.mjs', 'person', 'behaviour']]);
  const submitted = sflowJson('submit', 'implement');
  assert.equal(submitted.status, 0, JSON.stringify(submitted.value).slice(0, 2000));
  assert.equal((await workflowOf(root)).phases.implement.status, 'approved');
});
