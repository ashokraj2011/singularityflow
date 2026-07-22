import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import {
  desktopSnapshot,
  publishDesktopConfiguration,
  saveDesktopFile,
  selectDesktopPersona,
  validateDesktopConfiguration
} from '../src/desktop.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Desktop Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Desktop Tester'], root);
  run('git', ['config', 'user.email', 'desktop@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Desktop test\n');
  run(process.execPath, [bin, 'init'], root);
  const workflowPath = path.join(root, '.singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(workflowPath, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('desktop snapshot exposes configuration and visual workflow data', async () => {
  const root = await repository();
  let snapshot = await desktopSnapshot(root);
  assert.equal(snapshot.repository.branch, 'main');
  assert.equal(snapshot.workItems.length, 0);
  assert.ok(snapshot.templates.some((item) => item.name === 'feature/design.md'));
  assert.ok(snapshot.personaPrompts.some((item) => item.name === 'architect.md'));
  assert.ok(snapshot.agents.some((item) => item.id === 'sflow-workflow'));
  assert.equal(snapshot.agentsLock.path, '.singularity/agents.lock.yml');
  assert.ok(snapshot.agentStatus.some((item) => item.id === 'sflow-workflow'));

  run(process.execPath, [bin, 'start', 'DESK-1', '--title', 'Desktop workflow'], root);
  snapshot = await desktopSnapshot(root, 'DESK-1');
  assert.equal(snapshot.progress.currentPhase, 'intake');
  assert.equal(snapshot.progress.percentage, 0);
  assert.equal(snapshot.workflow.workItem.workType, 'feature');
  assert.ok(snapshot.documents.some((item) => item.id === 'SYS-WORKFLOW'));
});

test('desktop configuration saves validate atomically and publish scoped changes', async () => {
  const root = await repository();
  const workflowPath = path.join(root, '.singularity/workflow.yml');
  const original = await readFile(workflowPath, 'utf8');
  await assert.rejects(() => saveDesktopFile(root, '.singularity/workflow.yml', 'version: 9\n'), /validation failed/i);
  assert.equal(await readFile(workflowPath, 'utf8'), original);

  const templatePath = '.singularity/templates/feature/design.md';
  const template = await readFile(path.join(root, templatePath), 'utf8');
  await saveDesktopFile(root, templatePath, `${template}\nDesktop-only design guidance.\n`);
  await assert.rejects(() => saveDesktopFile(root, '.singularity/agents.lock.yml', 'version: 1\nagents: {}\n'), /read-only/i);
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work.\n');
  await saveDesktopFile(root, '.github/agents/reviewer.agent.md', '---\nname: reviewer\ndescription: Repository reviewer\ntools: ["bash"]\n---\n\nReview local work carefully.\n');
  assert.equal((await validateDesktopConfiguration(root)).valid, true);
  const published = await publishDesktopConfiguration(root, 'Configure desktop template');
  assert.equal(published.pushed, false);
  assert.deepEqual(published.files.sort(), ['.github/agents/reviewer.agent.md', templatePath].sort());
  assert.match(run('git', ['log', '-1', '--format=%s'], root).stdout, /Configure desktop template/);
});

test('desktop persona selection remains local and requires the active work branch', async () => {
  const root = await repository();
  run(process.execPath, [bin, 'start', 'DESK-2'], root);
  const session = await selectDesktopPersona(root, 'DESK-2', 'architect');
  assert.equal(session.persona, 'architect');
  assert.equal(session.workId, 'DESK-2');
  await assert.rejects(() => selectDesktopPersona(root, 'DESK-2', 'unknown'), /Unknown persona/);
});
