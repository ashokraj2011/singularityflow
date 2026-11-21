/**
 * Step intents Stage 3 in `workflow assess` (spec §6.5): three model-free findings for a workflow that derives from its
 * steps' intents, each with the builder move that settles it: a step's text that contradicts its intent, a framework
 * setting changed with no reason, and a setting written as the intent gives it anyway.
 */
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Assess Tester' };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
const json = (root, args) => JSON.parse(run(process.execPath, [bin, ...args, '--json'], root).stdout);

test('workflow assess finds text against a step\'s intent, a setting changed with no reason, and one the intent gives anyway', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-assess-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Assess Tester'], root); run('git', ['config', 'user.email', 'assess@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Assess\n');
  run(process.execPath, [bin, 'init'], root);
  await repositoryOwnedWorkflows(root);
  const model = json(root, ['workflow', 'studio']);
  const changes = path.join(root, '..', `${path.basename(root)}-changes.json`);
  await writeFile(changes, JSON.stringify({ schema: 'sflow-studio-change-set@1', base: model.base, changes: [
    { op: 'workflow.create', id: 'checks-only', label: 'Checks only', phases: ['gather-needs', 'run-checks', 'checks-report'] },
    { op: 'phase.create', id: 'gather-needs', label: 'Gather needs', intent: 'requirements', agent: 'product-owner' },
    { op: 'phase.create', id: 'run-checks', label: 'Run checks', intent: 'test', agent: 'qa' },
    { op: 'phase.create', id: 'checks-report', label: 'Checks report', intent: 'report', agent: 'qa' },
    { op: 'workflow.intents', id: 'checks-only', steps: { 'gather-needs': 'requirements', 'run-checks': 'test', 'checks-report': 'report' } }
  ] }));
  json(root, ['workflow', 'studio', 'apply', '--change-set', changes]);
  // Written by hand, as a file from before intents would be: a kind the intent gives anyway, and tests turned off with no reason.
  const file = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parseDocument(await readFile(file, 'utf8'));
  definition.setIn(['phases', 'run-checks', 'artifact', 'kind'], 'test-evidence');
  definition.setIn(['phases', 'run-checks', 'repositoryTests'], 'off');
  await writeFile(file, definition.toString());
  await writeFile(path.join(root, 'singularity/templates/common/run-checks.md'),
    '# {{work.id}} — Run checks\n\n## Results\n\nRun the payment tests. Then edit the source files to fix each failing test.\n');
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'a workflow of intents'], root);

  const assessed = json(root, ['workflow', 'assess', 'checks-only']);
  const findings = assessed.workflows[0].findings;
  const byCode = (code) => findings.filter((entry) => entry.code === code);
  const text = byCode('ASSESS_TEXT_CONTRADICTS_INTENT')[0];
  assert.ok(text, JSON.stringify(findings.map((entry) => entry.code)));
  assert.equal(text.title, 'Run checks is a test step, but its text tells it to change code');
  assert.deepEqual(text.suggestion.alternatives[0].moves, [{ move: 'step.intent', id: 'run-checks', intent: 'code' }]);
  const reason = byCode('ASSESS_OVERRIDE_WITHOUT_REASON').find((entry) => entry.steps[0] === 'run-checks');
  assert.ok(reason, JSON.stringify(findings.map((entry) => [entry.code, entry.steps])));
  assert.equal(reason.title, 'Run checks sets repositoryTests itself, with no reason');
  assert.deepEqual(reason.suggestion.alternatives[0].moves, [{ move: 'step.reset', id: 'run-checks', settings: ['repositoryTests'] }]);
  const same = byCode('ASSESS_OVERRIDE_SAME_AS_INTENT').find((entry) => entry.steps[0] === 'run-checks');
  assert.ok(same, JSON.stringify(findings.map((entry) => [entry.code, entry.steps])));
  assert.equal(same.title, 'Run checks sets artifact.kind to what its intent gives');
  assert.equal(same.suggestion.decidedBy, 'sflow');
  assert.deepEqual(same.suggestion.moves, [{ move: 'step.reset', id: 'run-checks', settings: ['artifact.kind'] }]);
});
