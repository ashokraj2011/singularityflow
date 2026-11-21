/**
 * A Story started from a workflow of step intents (step intents spec §7.6, Stage 2) pins what its intents derived:
 * each step carries its intent and the profile it derived from, the Story's readers accept them, and a later change
 * to the workflow changes nothing in the running Story.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORK_TYPE = 'intents-demo';

function execute(command, args, cwd, { agent = null } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Intents Tester' };
  if (agent) env.SINGULARITY_FLOW_TEST_SELECTION = JSON.stringify({ workType: WORK_TYPE, agent });
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}
const flow = (cwd, args, options) => execute(process.execPath, [bin, ...args], cwd, options);

/** A repository whose workflow.yml is version 4, with a code-free workflow of three shipped steps that all have an intent. */
async function intentsRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-intents-story-'));
  execute('git', ['init', '-b', 'main'], root);
  execute('git', ['config', 'user.name', 'Intents Tester'], root);
  execute('git', ['config', 'user.email', 'intents@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Intents\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.version = 4;
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness = { ...(config.repositoryReadiness ?? {}), requiredBeforeStory: false };
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.phases.intake.intent = 'intake';
  config.phases.requirements.intent = 'requirements';
  config.phases.design.intent = 'design';
  config.workTypes[WORK_TYPE] = { label: 'Intents demo', phases: ['intake', 'requirements', 'design'] };
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'README.md', 'singularity', '.github/hooks'], root);
  execute('git', ['commit', '-m', 'initial'], root);
  const remote = `${root}.git`;
  execute('git', ['init', '--bare', '-b', 'main', remote], root);
  execute('git', ['remote', 'add', 'origin', remote], root);
  execute('git', ['push', '-u', 'origin', 'main'], root);
  return { root, configPath };
}

test('a Story of step intents pins what they derived, and keeps it when the workflow changes', async () => {
  const { root, configPath } = await intentsRepository();
  flow(root, ['start', 'INT-1', '--from-branch', 'main'], { agent: 'product-owner' });
  const workflowFile = path.join(root, 'singularity/work-items/INT-1/workflow.json');
  const stored = JSON.parse(await readFile(workflowFile, 'utf8'));
  const phases = Object.fromEntries(stored.resolution.phases.map((phase) => [phase.id, phase]));
  assert.deepEqual(stored.resolution.phases.map((phase) => [phase.id, phase.intent, phase.intentProfile]),
    [['intake', 'intake', 1], ['requirements', 'requirements', 1], ['design', 'design', 1]]);
  // A workflow that changes no code: a person approves its scope (requirements) and its last step; SFlow the intake.
  assert.equal(phases.intake.approval.automatic, 'when-ready');
  assert.equal(Object.hasOwn(phases.requirements.approval, 'automatic'), false);
  assert.equal(Object.hasOwn(phases.design.approval, 'automatic'), false);
  assert.deepEqual(stored.resolution.documents.allowedPhases, ['intake', 'requirements', 'design']);
  // What it leaves out, with the reason the rule gives, is pinned in its routes.
  const end = stored.resolution.obligationGraph.edges.find((edge) => edge.to === '$end');
  assert.deepEqual(end.omits.map((entry) => entry.responsibility), ['implement', 'verify']);
  // The Story's own readers accept what it pinned.
  assert.match(flow(root, ['validate']).stdout, /workflow is valid/);
  const status = JSON.parse(flow(root, ['status', '--json']).stdout);
  assert.equal(status.workItem?.id ?? status.workId ?? 'INT-1', 'INT-1');

  // The workflow changes: the design step becomes a document step. The running Story keeps its pinned resolution.
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.design.intent = 'document';
  await writeFile(configPath, YAML.stringify(config));
  execute('git', ['add', 'singularity/workflow.yml'], root);
  execute('git', ['commit', '-m', 'design is a document now'], root);
  const after = JSON.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(after.resolution, stored.resolution);
  assert.match(flow(root, ['validate']).stdout, /workflow is valid/);
});
