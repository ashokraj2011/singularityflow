import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { sessionStartAgentHook } from '../src/agent-hooks.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { saveStoryDraft } from '../src/state-stores.mjs';
import { snapshot } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');
const boundary = 'Search only within the working repository; governed artifacts are under singularity/work-items/<WORK-ID>/.';

function git(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function sflow(repository, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.isFile() && /\.(?:md|agent\.md)$/i.test(entry.name)) files.push(target);
  }
  return files;
}

test('every packaged and template agent carries the repository search boundary', async () => {
  const directories = [path.join(root, 'plugin', 'agents'), path.join(root, 'templates', 'agents')];
  for (const directory of directories) {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.md'));
    assert.ok(names.length > 0);
    for (const name of names) {
      const content = await readFile(path.join(directory, name), 'utf8');
      assert.match(content, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
    }
  }
});

test('the two broadest skill reads state their governed base and repository fence', async () => {
  const epicStories = await readFile(path.join(root, 'plugin', 'skills', 'sflow-epic-stories', 'SKILL.md'), 'utf8');
  const implement = await readFile(path.join(root, 'plugin', 'skills', 'sflow-implement', 'SKILL.md'), 'utf8');
  assert.match(epicStories, /singularity\/initiatives\/<EPIC-ID>\/artifacts\/epic-planning\/story-plan\.yml/);
  assert.match(implement, /Inspect further files only as the implementation requires within this repository\./);
});

test('every skill inherits the Flow-root path boundary', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin', 'skills', 'registry.yml'), 'utf8'));
  for (const name of Object.keys(registry.skills)) {
    const content = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /<!-- sflow-execution-boundary -->/, name);
    assert.match(content, /Flow-reported root only \(Story: `singularity\/work-items\/<WORK-ID>\/`\)\./, name);
  }
});

test('model-facing Markdown never instructs a home-wide recursive search', async () => {
  const files = [
    ...await markdownFiles(path.join(root, 'plugin')),
    ...await markdownFiles(path.join(root, 'templates'))
  ];
  const unsafe = /\b(?:find\s+(?:\$HOME|~(?:\/|\s)|\/Users(?:\/|\s))|grep\s+(?:-[^\s]*r[^\s]*|--recursive)\s+(?:\$HOME|~(?:\/|\s)|\/Users(?:\/|\s))|ls\s+-[^\s]*R[^\s]*\s+(?:\$HOME|~(?:\/|\s)|\/Users(?:\/|\s)))/i;
  for (const file of files) assert.doesNotMatch(await readFile(file, 'utf8'), unsafe, path.relative(root, file));
});

test('an active Story session hook injects the repository and governed work-item roots', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-path-hook-'));
  const phase = { id: 'implementation', status: 'in_progress', defaultAgent: 'developer' };
  const workflow = {
    workItem: { id: 'GROUND-1' }, currentPhase: phase.id, phases: { implementation: phase },
    resolution: { session: { workItemSelection: 'off', requireBeforeTools: false } }
  };
  const definition = {
    session: workflow.resolution.session,
    agents: { developer: { id: 'developer', defaultFor: ['implementation'], phases: ['implementation'] } },
    agentCatalog: [{ id: 'developer', defaultFor: ['implementation'], phases: ['implementation'] }]
  };
  const result = await sessionStartAgentHook(repository, definition, workflow, { sessionId: 'path-hook' });
  assert.match(result.additionalContext, new RegExp(`Working repository: ${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.additionalContext, /Governed artifacts for GROUND-1 live under singularity\/work-items\/GROUND-1\//);
  assert.match(result.additionalContext, /Never search the filesystem outside this repository/);
});

test('prepare, inputs, and compose replay complete repository-rooted paths without truncation', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-path-replay-'));
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Path Grounding Test');
  git(repository, 'config', 'user.email', 'path-grounding@example.invalid');
  await writeFile(path.join(repository, 'README.md'), '# Path grounding fixture\n');
  await initializeDefinition(repository);
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'initialize path grounding fixture');
  git(repository, 'switch', '-c', 'GROUND-1');

  const config = await loadConfig(repository);
  const resolved = resolveWorkType(config, 'benchmarking-b');
  const longArtifact = `artifacts/design/${'nested-directory/'.repeat(8)}design.md`;
  resolved.phases.find((phase) => phase.id === 'design').artifact.path = longArtifact;
  resolved.phases.find((phase) => phase.id === 'implementation').inputs[0].path = longArtifact;
  await setAgentSession(repository, config, {
    name: 'Path Grounding Test', email: 'path-grounding@example.invalid', login: null
  }, 'developer', 'GROUND-1', { phaseId: 'implementation', source: 'test' });
  const workflow = await createWorkflow(repository, config, {
    id: 'GROUND-1', title: 'Keep every governed path based',
    source: {
      type: 'manual', key: 'GROUND-1', title: 'Keep every governed path based',
      description: 'Replay preparation, input rendering, and prompt composition.',
      acceptanceCriteria: ['Every path remains repository-rooted and complete.']
    },
    baseBranch: 'main', workType: 'benchmarking-b', agent: 'developer', resolved
  });
  const itemRelative = 'singularity/work-items/GROUND-1';
  const repositoryPath = `${itemRelative}/${longArtifact}`;
  const designFile = path.join(repository, repositoryPath);
  await mkdir(path.dirname(designFile), { recursive: true });
  await writeFile(designFile, '# Approved design\n\nUse the repository-rooted implementation boundary.\n');
  const info = await snapshot(designFile);
  workflow.phases.intake.status = 'approved';
  workflow.phases.intake.generation = 1;
  workflow.phases.design.status = 'approved';
  workflow.phases.design.generation = 1;
  workflow.phases.design.approvedAt = '2026-08-22T00:00:00.000Z';
  workflow.phases.design.approvedBy = 'path-grounding@example.invalid';
  workflow.phases.design.artifacts = [{ path: repositoryPath, status: 'approved', ...info }];
  workflow.currentPhase = 'implementation';
  workflow.phases.implementation.status = 'in_progress';
  await saveStoryDraft(repository, config, workflow);

  const prepared = sflow(repository, 'prepare', 'implementation', '--json');
  assert.equal(prepared.status, 0, prepared.stderr);
  const preparedJson = JSON.parse(prepared.stdout);
  assert.equal(preparedJson.outcome.slots.path, `${itemRelative}/artifacts/implementation/implementation-summary.md`);

  const inputs = sflow(repository, 'inputs', 'implementation', '--json');
  assert.equal(inputs.status, 0, inputs.stderr);
  const inputsJson = JSON.parse(inputs.stdout);
  assert.equal(inputsJson.workItemDirectory, itemRelative);
  assert.equal(inputsJson.records[0].repositoryPath, repositoryPath);

  const human = sflow(repository, 'inputs', 'implementation', '--dry-run');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`Work-item directory: ${itemRelative}`));
  assert.doesNotMatch(human.stdout, /…/);
  const lines = human.stdout.split('\n');
  const firstPathLine = lines.findIndex((line) => line.startsWith('  PATH: '));
  assert.ok(firstPathLine >= 0, human.stdout);
  const renderedPath = [lines[firstPathLine].slice(8)];
  for (let index = firstPathLine + 1; /^ {8}\S/.test(lines[index] ?? ''); index += 1) renderedPath.push(lines[index].slice(8));
  assert.equal(renderedPath.join(''), repositoryPath);

  const promptRelative = '.git/path-grounding-prompt.md';
  const composed = sflow(repository, 'wm', 'compose', '--phase', 'implementation', '--agent', 'developer', '--render-only', '--out', promptRelative);
  assert.equal(composed.status, 0, composed.stderr);
  const prompt = await readFile(path.join(repository, promptRelative), 'utf8');
  const canonicalRepository = git(repository, 'rev-parse', '--show-toplevel');
  assert.match(prompt, new RegExp('Repository root: `' + canonicalRepository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`'));
  assert.match(prompt, new RegExp('Work-item directory: `' + itemRelative + '`'));
  assert.match(prompt, new RegExp('Required artifact: `' + itemRelative + '/artifacts/implementation/implementation-summary\\.md`'));
  assert.match(prompt, new RegExp(`source=${repositoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(prompt, /- Required artifact: `artifacts\//);
});
