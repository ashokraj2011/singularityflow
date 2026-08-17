import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { manualStorySource, startStory } from '../src/story-start.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Desktop Story Tester'
    }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Desktop Story Tester'], root);
  run('git', ['config', 'user.email', 'desktop-story@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Desktop Story intake\n');
  run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'init'], root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

test('Story intake creates durable manual state and resumes an existing branch', async () => {
  const root = await repository();
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-source-'));
  const sourceFile = path.join(sourceDirectory, 'brief.md');
  await writeFile(sourceFile, '# Brief\nPinned desktop evidence.\n');
  const source = manualStorySource('WORK-901', {
    title: 'Add customer export',
    user: 'Operations analyst',
    description: 'Exports are assembled manually.',
    desiredOutcome: 'Create an auditable export.',
    inScope: 'Filtered records\nCSV download',
    outOfScope: 'Scheduled delivery',
    acceptanceCriteria: 'Authorized users can export\nUnauthorized users are denied',
    parentEpicId: 'EPIC-42'
  });
  const created = await startStory(root, {
    id: 'WORK-901',
    source,
    workType: 'feature',
    agent: 'product-owner',
    baseBranch: 'main',
    files: [sourceFile],
    urls: ['https://example.com/export-reference']
  });

  assert.equal(created.resumed, false);
  assert.equal(created.workId, 'WORK-901');
  assert.equal(created.documents.length, 2);
  const workRoot = path.join(root, 'singularity/work-items/WORK-901');
  const workflow = JSON.parse(await readFile(path.join(workRoot, 'workflow.json'), 'utf8'));
  assert.equal(workflow.workItem.source.type, 'manual');
  assert.equal(workflow.lineage.epicId, 'EPIC-42');
  const story = await readFile(path.join(workRoot, 'USER-STORY.md'), 'utf8');
  assert.match(story, /Operations analyst/);
  assert.match(story, /Authorized users can export/);
  const documents = JSON.parse(await readFile(path.join(workRoot, 'documents.json'), 'utf8'));
  assert.deepEqual(documents.documents.map((item) => item.type), ['file', 'url']);
  const log = run('git', ['log', '--format=%s'], root).stdout;
  assert.match(log, /\[WORK-901\]\[init\] start feature workflow/);
  assert.equal((log.match(/\[WORK-901\]\[documents\]\[upload\]/g) ?? []).length, 2);

  const resumed = await startStory(root, {
    id: 'WORK-901',
    source: manualStorySource('WORK-901', { title: 'Ignored because state exists' }),
    workType: 'bugfix',
    agent: 'developer'
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.workflow.workItem.workType, 'feature');
});

test('Story intake pins refreshed remote configuration and world-model files from a named corporate remote', async () => {
  const source = await repository();
  const initialDefinitionPath = path.join(source, 'singularity/workflow.yml');
  const initialDefinition = YAML.parse(await readFile(initialDefinitionPath, 'utf8'));
  initialDefinition.git.remote = 'company';
  await writeFile(initialDefinitionPath, YAML.stringify(initialDefinition));
  run('git', ['add', 'singularity/workflow.yml'], source);
  run('git', ['commit', '-m', 'Configure corporate remote'], source);

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-remote-'));
  const remote = path.join(base, 'company.git');
  const clone = path.join(base, 'clone');
  run('git', ['clone', '--bare', source, remote], base);
  run('git', ['clone', remote, clone], base);
  run('git', ['remote', 'rename', 'origin', 'company'], clone);
  run('git', ['config', 'user.name', 'Desktop Story Tester'], clone);
  run('git', ['config', 'user.email', 'desktop-story@example.com'], clone);

  // Another contributor publishes both a newer phase profile and the repository model. The local
  // clone intentionally keeps its main branch behind.
  const refreshed = YAML.parse(await readFile(initialDefinitionPath, 'utf8'));
  refreshed.workTypes.chore.label = 'Remote governed chore';
  await writeFile(initialDefinitionPath, YAML.stringify(refreshed));
  await mkdir(path.join(source, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(source, 'singularity/world-model/manifest.json'), '{"schema_version":"2.0","marker":"remote"}\n');
  run('git', ['add', 'singularity/workflow.yml', 'singularity/world-model/manifest.json'], source);
  run('git', ['commit', '-m', 'Publish refreshed configuration and world model'], source);
  run('git', ['push', remote, 'main'], source);

  const started = await startStory(clone, {
    id: 'WORK-REMOTE-1',
    source: manualStorySource('WORK-REMOTE-1', { title: 'Use refreshed governance' }),
    workType: 'chore',
    baseBranch: 'main'
  });
  assert.equal(started.workflow.workItem.workTypeLabel, 'Remote governed chore');
  assert.match(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'), /"marker":"remote"/);
});

test('POC Story intake requires and durably pins the authorized browser origin', async () => {
  const root = await repository();
  const source = manualStorySource('POC-901', { title: 'Generate staging regression coverage' });

  await assert.rejects(() => startStory(root, {
    id: 'POC-901', source, workType: 'poc-workflow', baseBranch: 'main'
  }), /POC target URL is required/);

  const created = await startStory(root, {
    id: 'POC-901', source, workType: 'poc-workflow', baseBranch: 'main',
    targetUrl: 'https://staging.example.test/application/start'
  });
  assert.equal(created.resumed, false);
  assert.equal(created.workflow.workItem.source.targetOrigin, 'https://staging.example.test');
  assert.deepEqual(created.workflow.mcpAuthorizations.playwright.origins, ['https://staging.example.test']);

  const resumed = await startStory(root, {
    id: 'POC-901', source: manualStorySource('POC-901', { title: 'Existing POC' }),
    workType: 'poc-workflow'
  });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.workflow.mcpAuthorizations.playwright.origins, ['https://staging.example.test']);
});

test('manual Story source requires only a Work ID and title while normalizing optional lists', () => {
  const source = manualStorySource('LOCAL-2', {
    title: 'Small local Story',
    constraints: 'One\n\nTwo',
    acceptanceCriteria: ''
  });
  assert.equal(source.id, 'LOCAL-2');
  assert.deepEqual(source.constraints, ['One', 'Two']);
  assert.deepEqual(source.acceptanceCriteria, []);
  assert.throws(() => manualStorySource('LOCAL-3', {}), /Story title/);
});
