/**
 * A changed file the plan lists counts for its row, and the check runs at the code step's own submission, through the
 * real CLI (owner, 2026-11-20).
 *
 * Story fix-issues (quick-fix): the plan listed three files for a criterion and all three changed, but only one carried
 * its `@clause` comment, so only that one counted. Implement completes without approval, so the gap surfaced one step
 * late, at verify, with an issue raised against intake as its route. Now every changed planned file counts (the comment
 * locates and explains the change), and a planned file that did not change refuses implement's own submission, with the
 * step's next version as the route, filled with what is missing.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { cli, repository } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const FILES = { 'src/format.mjs': 'export const format = (value) => String(value);\n', 'src/value.css': '.value { color: black; }\n' };
const workflowOf = async (root) => JSON.parse(await readFile(path.join(root, 'singularity/work-items/QF-1/workflow.json'), 'utf8'));

/** A quick fix whose plan puts AC-001 in three files, at its implement step; implement completes at its submission. */
async function threeFileStory(t) {
  const repo = await repository(t, { implementCommands: false, files: FILES });
  const { root, sflow, must } = repo;
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implement.generation = { requirement: 'required', task: 'code' };
  config.phases.implement.approval = { mode: 'none' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', 'singularity/workflow.yml']);
  must('git', ['commit', '-m', 'An agent-authored code step nobody approves']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Show the value', '--description', 'Return and show 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), [
    '# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2, formatted and styled where it is shown.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The shown value equals 2. |', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    '| `QF-1:AC-001` | `src/value.mjs`, `src/format.mjs`, `src/value.css` | `test/value.test.mjs` | modified | The test reads 2. |', '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n'));
  sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  sflow('submit', 'intake');
  sflow('approve', 'intake', '--yes');
  sflow('resume', 'QF-1');
  sflow('prepare', 'implement');
  // The comment is in one planned file only, as in fix-issues; the other two change with none.
  await writeFile(path.join(root, 'src/value.mjs'), '// @clause:QF-1:AC-001 the exported value is the approved 2\nexport const value = 2;\n');
  await writeFile(path.join(root, 'src/format.mjs'), 'export const format = (value) => `${value}`;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from '../src/value.mjs';\n\n// @ac:QF-1:AC-001\ntest('value is two', () => assert.equal(value, 2));\n");
  return repo;
}

async function publish(repo) {
  const { root, sflow, sflowJson } = repo;
  sflow('prepare', 'implement');
  const summary = path.join(root, 'singularity/work-items/QF-1/artifacts/implement/implementation-summary.md');
  await writeFile(summary, `${await readFile(summary, 'utf8')}\n## What changed\n\nThe value module returns the approved value 2, formatted and styled.\n`);
  const published = sflowJson('phase', 'publish', 'implement', '--authored', 'governed-agent', '--channel', 'copilot-host');
  assert.equal(published.status, 0, JSON.stringify(published.value).slice(0, 2000));
}

test('fix-issues: three planned files changed and one carries the comment, so implement submits and completes', slowLane({ timeout: 900_000 }), async (t) => {
  const repo = await threeFileStory(t);
  await writeFile(path.join(repo.root, 'src/value.css'), '.value { color: green; }\n');
  await publish(repo);
  const submitted = repo.sflowJson('submit', 'implement');
  assert.equal(submitted.status, 0, JSON.stringify(submitted.value).slice(0, 2000));
  const after = await workflowOf(repo.root);
  assert.equal(after.phases.implement.status, 'approved', 'a step nobody approves completes at its submission');
  const observed = JSON.parse(await readFile(path.join(repo.root, after.phases.implement.claimMaps.observed.path), 'utf8'));
  assert.deepEqual(observed.claims['QF-1:AC-001'].observedPaths, ['src/format.mjs', 'src/value.css', 'src/value.mjs']);
  assert.equal(observed.claims['QF-1:AC-001'].verdict, 'matched');
});

test('a planned file that did not change refuses implement\'s own submission, with its next version filled in', slowLane({ timeout: 900_000 }), async (t) => {
  const repo = await threeFileStory(t);
  // src/value.css, planned for the criterion, does not change.
  await publish(repo);
  const held = repo.sflowJson('submit', 'implement');
  assert.notEqual(held.status, 0);
  const { error } = held.value;
  assert.equal(error.code, 'SPEC_COVERAGE_INCOMPLETE', JSON.stringify(held.value).slice(0, 2000));
  assert.match(error.message, /^Phase 'implement' cannot be submitted: it completes here, and the Story's ending would refuse it\./u);
  // Its route leads the plan: the step's next version, filled with what SFlow knows is missing.
  const command = 'singularity-flow phase rollover implement --reason "Deliver QF-1:AC-001 (src/value.css does not change) where the plan puts it." --json';
  assert.equal(error.details.nextAction, command);
  const [first] = held.value.remediationPlan.steps;
  assert.deepEqual([first.command, first.skill], [command, '/sf-code'], JSON.stringify(held.value.remediationPlan.steps).slice(0, 3000));
  assert.equal(first.label, 'Start version 2 of Implement for QF-1:AC-001');
  assert.ok(held.value.remediationPlan.steps.some((entry) => entry.command === 'singularity-flow decisions QF-1'), 'or the Decide card, for a person\'s risk');
  assert.doesNotMatch(JSON.stringify(held.value), /upstream-issue raise|<what-is-wrong>|<what to change>/u, 'never an issue against intake, never a placeholder');
  const after = await workflowOf(repo.root);
  assert.equal(after.phases.implement.status, 'in_progress', 'the gap stays in the step that repairs it');
  assert.equal(after.currentPhase, 'implement');
  // The route runs as given: it previews version 2 for the person to confirm, and opens nothing on its own.
  const preview = repo.run(process.execPath, [cli, '--no-model', 'phase', 'rollover', 'implement', '--reason',
    'Deliver QF-1:AC-001 (src/value.css does not change) where the plan puts it.', '--json']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /version 2|"toGeneration": 2|"generation": 2/u);
  assert.equal((await workflowOf(repo.root)).phases.implement.generation, 1, 'version 1 stays as published until the person confirms');
});
