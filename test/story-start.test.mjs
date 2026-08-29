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
  let astWarmLaunch = null;
  const created = await startStory(root, {
    id: 'WORK-901',
    source,
    workType: 'feature',
    agent: 'product-owner',
    baseBranch: 'main',
    files: [sourceFile],
    urls: ['https://example.com/export-reference'],
    astWarmLauncher: (repositoryRoot, workId) => {
      astWarmLaunch = { repositoryRoot, workId };
      return { pid: 1234 };
    }
  });

  assert.equal(created.resumed, false);
  assert.equal(created.workId, 'WORK-901');
  assert.equal(created.documents.length, 2);
  assert.equal(created.astWarm.status, 'scheduled');
  assert.equal(created.astWarm.blocking, false);
  assert.deepEqual(astWarmLaunch, { repositoryRoot: root, workId: 'WORK-901' });
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
  assert.equal((log.match(/\[WORK-901\]\[documents\]\[upload\]/g) ?? []).length, 1,
    'all initial evidence is published in one governed transaction');

  const resumed = await startStory(root, {
    id: 'WORK-901',
    source: manualStorySource('WORK-901', { title: 'Ignored because state exists' }),
    workType: 'bugfix',
    agent: 'developer'
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.workflow.workItem.workType, 'feature');
});

test('Story start refuses a remote retarget after its push authority is captured', async () => {
  const root = await repository();
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'required';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'Require Story publication'], root);
  run('git', ['push', 'origin', 'main'], root);
  const originalRemote = run('git', ['remote', 'get-url', '--push', 'origin'], root).stdout.trim();
  const alternate = `${root}-alternate.git`;
  run('git', ['init', '--bare', '-b', 'main', alternate], root);
  const originalHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-AUTHORITY-RACE',
      source: manualStorySource('WORK-AUTHORITY-RACE', { title: 'Authority race' }),
      workType: 'feature',
      baseBranch: 'main',
      afterPublicationAuthorityCapture: () => {
        run('git', ['remote', 'set-url', 'origin', alternate], root);
      }
    }),
    (error) => error?.code === 'PUBLICATION_REMOTE_AUTHORITY_CHANGED'
  );
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), originalHead);
  for (const authority of [originalRemote, alternate]) {
    assert.notEqual(spawnSync('git', [
      '--git-dir', authority, 'show-ref', '--verify', '--quiet',
      'refs/heads/WORK-AUTHORITY-RACE'
    ]).status, 0);
  }
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

test('desktop Story intake publishes every capability repository and returns a recoverable result', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-capability-story-'));
  const workspaceRoot = path.join(base, 'workspace');
  const repositoriesRoot = path.join(workspaceRoot, 'repos');
  await mkdir(repositoriesRoot, { recursive: true });
  const createRepository = async (id, { governed = false } = {}) => {
    const source = path.join(repositoriesRoot, id);
    const remote = path.join(base, `${id}.git`);
    await mkdir(source, { recursive: true });
    run('git', ['init', '-b', 'main'], source);
    run('git', ['config', 'user.name', 'Desktop Story Tester'], source);
    run('git', ['config', 'user.email', 'desktop-story@example.com'], source);
    await writeFile(path.join(source, 'README.md'), `# ${id}\n`);
    if (governed) run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'init'], source);
    run('git', ['add', '.'], source);
    run('git', ['commit', '-m', 'initial'], source);
    run('git', ['init', '--bare', '-b', 'main', remote], source);
    run('git', ['remote', 'add', 'origin', remote], source);
    run('git', ['push', '-u', 'origin', 'main'], source);
    return { id, source, remote };
  };
  const lead = await createRepository('lead', { governed: true });
  const sibling = await createRepository('sibling');
  await writeFile(path.join(lead.source, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      payments: {
        name: 'Payments', kind: 'delivery', parent: null,
        repositories: ['lead', 'sibling'], leadRepository: 'lead', policy: {}
      }
    }
  }));
  const portfolioPath = path.join(lead.source, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = {
    lead: { url: lead.remote, defaultBranch: 'main', required: true },
    sibling: { url: sibling.remote, defaultBranch: 'main', required: true }
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', 'singularity/capabilities.yml', 'singularity/portfolio.yml'], lead.source);
  run('git', ['commit', '-m', 'map payments capability'], lead.source);
  run('git', ['push', 'origin', 'main'], lead.source);

  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'local--payments',
    name: 'Payments workspace',
    anchor: { provider: 'workspace', siteId: 'local', key: 'payments', title: 'Payments workspace' },
    leadRepository: 'lead',
    repositories: {
      lead: { id: 'lead', url: lead.remote, defaultBranch: 'main', required: true, path: 'repos/lead', capabilities: ['payments'], clone: { mode: 'full', sparseCone: [], fallback: 'refuse' } },
      sibling: { id: 'sibling', url: sibling.remote, defaultBranch: 'main', required: true, path: 'repos/sibling', capabilities: ['payments'], clone: { mode: 'full', sparseCone: [], fallback: 'refuse' } }
    },
    capabilities: ['payments'],
    directories: { repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  await writeFile(registry, '{"schemaVersion":1,"workspaces":[]}\n');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'local--payments', workspaceName: 'Payments workspace',
    workspacePath: workspaceRoot, anchorKey: 'payments', repositoryId: 'lead',
    repositoryPath: lead.source, repositoryState: 'ready', branch: 'main',
    capabilities: ['payments'], repositoryCapabilities: ['payments'], selectedAt: new Date().toISOString()
  })}\n`);
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selection;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;
  try {
    const started = await startStory(lead.source, {
      id: 'WORK-CAP-1',
      source: manualStorySource('WORK-CAP-1', { title: 'Coordinate capability change' }),
      workType: 'feature', baseBranch: 'main', capabilityId: 'payments'
    });
    assert.deepEqual(started.capabilityPublication.pending, []);
    assert.deepEqual(started.capabilityPublication.published.map((entry) => entry.repository), ['sibling']);
    assert.match(run('git', ['ls-remote', sibling.remote, 'refs/heads/WORK-CAP-1'], sibling.source).stdout, /refs\/heads\/WORK-CAP-1/);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
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
