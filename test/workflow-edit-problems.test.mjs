/**
 * `workflow edit` runs the check `workflow create` runs (ER-F7): an edit that adds a problem `workflow validate` refuses
 * would make a proposal nobody can approve, so it is refused with each new problem and its fix, and nothing is written.
 *
 * A finding's id carries its line, so problems are compared by workflow, code and subject (and file), never by line: an
 * edit that only moves the lines of a problem the workflow already had is not refused for it. The CLI's proposal path,
 * where nothing is proposed, is in configuration-proposal.test.mjs.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { defineWorkflow, editWorkflow } from '../src/workflow-authoring.mjs';
import { editedWithoutNewProblems, validateWorkflows, workflowProblems } from '../src/workflow-validation.mjs';

const PLAN = { mode: 'required', clausePhases: ['requirements'], owners: { implementation: 'implementation-spec' } };
// Requirements' template has no planned-claims table: a plan owned by it is the problem approval refuses.
const THIN_PLAN = { mode: 'required', clausePhases: ['requirements'], owners: { implementation: 'requirements' } };

/** A configuration with a clean workflow and one that already has problems located in workflow.yml. */
async function configuration(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeDefinition(root);
  await defineWorkflow(root, 'clean-plan', { phases: ['requirements', 'implementation-spec', 'implementation'], plannedClaims: PLAN });
  await defineWorkflow(root, 'worn-plan', { description: 'Its shared steps send work back to steps it does not run.',
    phases: ['requirements', 'implementation-spec', 'implementation'], plannedClaims: PLAN });
  // Without the send-back targets its creation pinned, the shared steps return work to steps it does not run.
  const file = path.join(root, 'singularity', 'workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.deleteIn(['workTypes', 'worn-plan', 'phaseOverrides']);
  await writeFile(file, document.toString());
  return { root, file };
}

const problemsOf = async (root, id) => (await validateWorkflows(root, { workflow: id })).workflows[0].findings
  .filter((entry) => entry.severity === 'problem');

test('an edit that adds the planned-claims problem is refused with its fix, and nothing is written', async (t) => {
  const { root, file } = await configuration(t);
  assert.deepEqual(await problemsOf(root, 'clean-plan'), []);
  const before = await readFile(file, 'utf8');
  const options = { 'planned-claims': 'required', 'clause-phases': 'requirements', 'claim-owners': 'implementation=requirements', propose: true };
  await assert.rejects(() => editedWithoutNewProblems(root, 'clean-plan', () => editWorkflow(root, 'clean-plan', { plannedClaims: THIN_PLAN }), options),
    (error) => {
      assert.equal(error.code, 'WORKFLOW_EDIT_PROBLEMS');
      assert.match(error.message, /^Workflow clean-plan was not changed: the edit adds a problem `workflow validate` would refuse, so nobody could approve it\. Nothing was written or proposed\./u);
      assert.match(error.message, /The template of Requirements has no planned-claims table the kernel reads\s+Fix: Give \S+\/requirements\.md the planned-claims table the kernel reads/u);
      assert.match(error.message, /Change what each problem names, then edit it again\.$/u);
      assert.deepEqual(error.details.problems.map((entry) => entry.code), ['CHECK_TEMPLATE_PLANNED_TABLE']);
      // The same command, to run again once the template has the table.
      assert.deepEqual(error.details.nextAction.argv, ['workflow', 'edit', 'clean-plan', '--planned-claims', 'required',
        '--clause-phases', 'requirements', '--claim-owners', 'implementation=requirements', '--propose']);
      return true;
    });
  assert.equal(await readFile(file, 'utf8'), before, 'workflow.yml is as it was');
});

test('an edit that only moves the lines of problems the workflow already had is not refused for them', async (t) => {
  const { root, file } = await configuration(t);
  const before = await problemsOf(root, 'worn-plan');
  assert.ok(before.length >= 1 && before.every((entry) => entry.location?.file === 'singularity/workflow.yml'), 'its problems are located in workflow.yml');
  // Removing its description moves every line after it up one.
  const result = await editedWithoutNewProblems(root, 'worn-plan', () => editWorkflow(root, 'worn-plan', { description: '' }), { description: '' });
  assert.equal(result.workflowId, 'worn-plan');
  assert.equal(YAML.parse(await readFile(file, 'utf8')).workTypes['worn-plan'].description, undefined, 'the edit was written');
  const after = await problemsOf(root, 'worn-plan');
  const shape = (entries) => entries.map((entry) => [entry.code, entry.subject]);
  assert.deepEqual(shape(after), shape(before), 'the same problems');
  assert.deepEqual(after.map((entry) => entry.location.line), before.map((entry) => entry.location.line - 1), 'each one line up');
  assert.ok(after.every((entry, index) => entry.id !== before[index].id), 'their ids changed with their lines');
  // Compared without lines, they are the problems it had: nothing is added.
  assert.deepEqual([...(await workflowProblems(root, ['worn-plan'])).keys()].length, before.length);

  // A new problem on the same workflow is still refused, and only that one is named.
  await assert.rejects(() => editedWithoutNewProblems(root, 'worn-plan', () => editWorkflow(root, 'worn-plan', { plannedClaims: THIN_PLAN })),
    (error) => error.code === 'WORKFLOW_EDIT_PROBLEMS' && error.details.problems.length === 1
      && error.details.problems[0].code === 'CHECK_TEMPLATE_PLANNED_TABLE');
});

test('a clean edit is written as before', async (t) => {
  const { root, file } = await configuration(t);
  const result = await editedWithoutNewProblems(root, 'clean-plan', () => editWorkflow(root, 'clean-plan', { label: 'Clean plan, renamed' }), { label: 'Clean plan, renamed' });
  assert.equal(result.workflowId, 'clean-plan');
  assert.equal(YAML.parse(await readFile(file, 'utf8')).workTypes['clean-plan'].label, 'Clean plan, renamed');
  assert.deepEqual(await problemsOf(root, 'clean-plan'), []);
});
