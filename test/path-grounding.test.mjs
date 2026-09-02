import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { buildSpecIndex, canonicalJson, derivePlannedClaimMap } from '../src/specifications.mjs';
import { removeTemporaryTree, snapshot } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');
const boundary = 'Resolve the active Story checkout with `singularity-flow session current --json`';

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

test('every packaged and template agent rebinds tools to the active repository after context clears', async () => {
  const directories = [path.join(root, 'plugin', 'agents'), path.join(root, 'templates', 'agents')];
  for (const directory of directories) {
    const names = (await readdir(directory)).filter((name) => name.endsWith('.md'));
    assert.ok(names.length > 0);
    for (const name of names) {
      const content = await readFile(path.join(directory, name), 'utf8');
      assert.match(content, new RegExp(boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), name);
      assert.match(content, /require `ready`, bind `workId`, and use its absolute `repositoryPath` as cwd for every shell and file tool/, name);
      assert.match(content, /Never search `\$HOME`, a parent directory, or outside that repository/, name);
      assert.match(content, /singularity\/work-items\/<WORK-ID>\//, name);
    }
  }
});

test('the two broadest skill reads state their governed base and repository fence', async () => {
  const epicStories = await readFile(path.join(root, 'plugin', 'skills', 'sflow-epic-stories', 'SKILL.md'), 'utf8');
  const implement = await readFile(path.join(root, 'plugin', 'skills', 'sflow-implement', 'SKILL.md'), 'utf8');
  assert.match(epicStories, /singularity\/initiatives\/<EPIC-ID>\/artifacts\/epic-planning\/story-plan\.yml/);
  assert.match(implement, /Inspect further files only as the implementation requires within this repository\./);
});

test('the skill boundary lattice keeps entry points storyless without weakening lifecycle scope', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin', 'skills', 'registry.yml'), 'utf8'));
  const machineEntry = [
    'sflow-about', 'sflow-advise', 'sflow-docs', 'sflow-doctor', 'sflow-fresh-install',
    'sflow-help', 'sflow-home', 'sflow-local-reset', 'sflow-plugin', 'sflow-quickstart',
    'sflow-recommend', 'sflow-reinstall', 'sflow-workspace', 'sflow-workspace-bootstrap',
    'sflow-workspace-session', 'sflow-workspaces'
  ];
  const repositoryEntry = [
    'sflow-adhoc', 'sflow-auto', 'sflow-factory-reset', 'sflow-init', 'sflow-reset-all',
    'sflow-resume', 'sflow-return', 'sflow-session', 'sflow-sgos-create', 'sflow-start',
    'sflow-story-fetch', 'sflow-story-inbox', 'sflow-story-start', 'sflow-workflows',
    'sflow-workspace-impact', 'sflow-worldmodel'
  ];
  for (const name of machineEntry) {
    assert.equal(registry.skills[name]?.executionBoundary, 'machine', `${name} must work before repository or Story selection`);
  }
  for (const name of repositoryEntry) {
    assert.equal(registry.skills[name]?.executionBoundary, 'repository', `${name} must work before active Story selection`);
  }
  for (const name of Object.keys(registry.skills).filter((name) => /^sflow-(?:epic|initiative)-/.test(name))) {
    assert.equal(registry.skills[name]?.executionBoundary, 'repository', `${name} is not a Story lifecycle`);
  }
  for (const name of ['sflow-capability-doctor', 'sflow-capability-map']) {
    assert.equal(registry.skills[name]?.executionBoundary, 'organisation', `${name} is rooted in a lead authority`);
  }
  for (const name of ['sflow-approve', 'sflow-phase', 'sflow-submit', 'sflow-verify']) {
    assert.equal(registry.skills[name]?.executionBoundary ?? 'story', 'story', `${name} must retain the active Story fence`);
  }
  assert.ok(Object.values(registry.skills).every((rule) =>
    ['machine', 'repository', 'story', 'organisation'].includes(rule.executionBoundary ?? 'story')));
  assert.ok(Object.values(registry.skills).every((rule) => rule.executionBoundary !== 'workspace'),
    'workspace is a selection mechanism, not an execution boundary');
});

test('every generated skill boundary forbids home search and uses only its declared authority', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin', 'skills', 'registry.yml'), 'utf8'));
  for (const [name, rule] of Object.entries(registry.skills)) {
    const content = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /<!-- sflow-execution-boundary -->/, name);
    const executionBoundary = rule.executionBoundary ?? 'story';
    const declared = content.match(/<!-- sflow-execution-boundary -->\r?\n([^\n]+)/)?.[1] ?? '';
    assert.match(declared, /never (?:search )?`\$HOME`/, name);
    if (executionBoundary === 'machine') {
      assert.match(declared, /machine-local; no repository or Story required/, name);
      assert.doesNotMatch(declared, /session current|ready.*workId/, name);
      assert.doesNotMatch(content, /singularity-flow session current|git rev-parse --show-toplevel/, `${name} must not discover a repository or Story`);
    } else if (executionBoundary === 'repository') {
      assert.match(declared, /no Story required; cwd=opened Git root or verified `repositoryPath`/, name);
      assert.match(declared, /from `singularity-flow workspace current --json`/, name);
      assert.match(declared, /refuse if neither resolves/, name);
      assert.doesNotMatch(declared, /session current|ready.*workId/, name);
    } else if (executionBoundary === 'organisation') {
      assert.match(declared, /no Story or repository required; use only the selected lead URL/, name);
      assert.match(declared, /Resolve local checks with `singularity-flow workspace current --json`/, name);
      assert.doesNotMatch(declared, /session current|ready.*workId/, name);
    } else {
      assert.equal(executionBoundary, 'story', `${name} declares an unknown execution boundary`);
      assert.match(declared, /`singularity-flow session current --json` → verified `ready`\/`workId`, cwd=`repositoryPath`/, name);
      assert.match(declared, /`singularity\/work-items\/<WORK-ID>\/`/, name);
    }
  }
});

test('blank-machine entry skills execute before workspace, repository, or Story selection', {
  timeout: 45_000
}, async (t) => {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-machine-'));
  const machineHome = path.join(machine, 'home');
  const cwd = path.join(machine, 'empty-cwd');
  await mkdir(machineHome, { recursive: true });
  await mkdir(cwd, { recursive: true });
  t.after(() => removeTemporaryTree(machine));
  const env = {
    ...process.env,
    HOME: machineHome,
    XDG_CONFIG_HOME: path.join(machineHome, '.config'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineHome, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineHome, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineHome, 'leads.json'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(machineHome, 'journal')
  };
  for (const key of [
    'GIT_DIR', 'GIT_WORK_TREE', 'SINGULARITY_FLOW_NO_NETWORK',
    'SINGULARITY_FLOW_WORKSPACE_ROOT'
  ]) delete env[key];
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd, env, encoding: 'utf8', timeout: 30_000
  });
  const succeeds = (label, args) => {
    const result = invoke(...args);
    assert.equal(result.status, 0, `${label} failed before selection:\n${result.stderr || result.stdout}`);
    return result.stdout;
  };

  const workspaceList = succeeds('/sf-workspaces and /sf-workspace', ['workspace', 'list', '--json']);
  assert.deepEqual(JSON.parse(workspaceList), []);
  const workspaceCurrent = succeeds('/sf-workspaces current state', ['workspace', 'current', '--json']);
  assert.deepEqual(JSON.parse(workspaceCurrent), { active: false });
  const bootstrap = JSON.parse(succeeds('/sf-workspace-bootstrap', [
    'workspace', 'bootstrap', 'status', '--json'
  ]));
  assert.deepEqual(bootstrap, []);

  const help = JSON.parse(succeeds('/sf-help and /sf-docs', ['explain', '--json']));
  assert.equal(help.operation.id, 'explain');
  const doctor = JSON.parse(succeeds('/sf-doctor', ['workspace', 'doctor', '--json']));
  assert.equal(doctor.healthy, true);
  const homeResult = JSON.parse(succeeds('/sf-home', ['home', '--json']));
  assert.equal(homeResult.operation.id, 'home.overview');

  const quickstart = succeeds('/sf-quickstart', ['quickstart']);
  assert.match(quickstart, /0 model invocation\(s\) · network access: no/);
  assert.match(quickstart, /Guide sandbox removed after successful completion/);
  assert.deepEqual(await readdir(cwd), [], 'entry skills searched or wrote the blank cwd');
});

test('repository entry initializes an explicitly opened unregistered Git root without a workspace or Story', {
  timeout: 45_000
}, async (t) => {
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-skill-repository-'));
  const machineHome = path.join(machine, 'home');
  const repository = path.join(machine, 'repository');
  await mkdir(machineHome, { recursive: true });
  await mkdir(repository, { recursive: true });
  t.after(() => removeTemporaryTree(machine));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'Repository Entry Tester');
  git(repository, 'config', 'user.email', 'repository-entry@example.com');
  await writeFile(path.join(repository, 'README.md'), '# unregistered repository\n');
  git(repository, 'add', 'README.md');
  git(repository, 'commit', '-qm', 'application baseline');

  const env = {
    ...process.env,
    HOME: machineHome,
    XDG_CONFIG_HOME: path.join(machineHome, '.config'),
    NODE_ENV: 'test',
    SINGULARITY_FLOW_NO_NETWORK: '1',
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineHome, 'active-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineHome, 'workspaces.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineHome, 'leads.json'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(machineHome, 'journal')
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'SINGULARITY_FLOW_WORKSPACE_ROOT']) delete env[key];

  const initialized = spawnSync(process.execPath, [cli, 'init'], {
    cwd: repository, env, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(initialized.status, 0,
    `repository entry failed before registration:\n${initialized.stderr || initialized.stdout}`);
  assert.match(initialized.stdout, /(?:^|\n)(?:Created|Verified) /,
    'repository entry must reach deterministic initialization rather than a Story guard');
  assert.equal((await readdir(machineHome)).includes('workspaces.json'), false,
    'repository initialization must not silently create a workspace registration');

  const checked = spawnSync(process.execPath, [cli, 'init', '--check', '--json'], {
    cwd: repository, env, encoding: 'utf8', timeout: 30_000
  });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.repository, git(repository, 'rev-parse', '--show-toplevel'));
  assert.equal(report.configurationMode, 'working-tree');
});

test('sf-next reapplies the repository boundary after clear or compact', async () => {
  const content = await readFile(path.join(root, 'plugin', 'skills', 'sflow-next', 'SKILL.md'), 'utf8');
  assert.match(content, /run `\/clear` and then `\/sf-next`/);
  assert.match(content, /After either reset, reapply the Boundary before artifact reads/);
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
  assert.match(result.additionalContext, /Use this exact repository as the cwd for every shell and file tool/);
  assert.match(result.additionalContext, /Never search \$HOME, a parent directory, or outside this repository/);
});

test('an active Story session hook uses the immutable non-default work-item root', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-custom-path-hook-'));
  const phase = { id: 'implementation', status: 'in_progress', defaultAgent: 'developer' };
  const current = {
    workItem: { id: 'GROUND-CUSTOM' }, currentPhase: phase.id, phases: { implementation: phase },
    resolution: {
      workItemRoot: 'governed/story-state',
      session: { workItemSelection: 'off', requireBeforeTools: false }
    }
  };
  const customDefinition = {
    workItemRoot: 'different/live-configuration',
    session: current.resolution.session,
    agents: { developer: { id: 'developer', defaultFor: ['implementation'], phases: ['implementation'] } },
    agentCatalog: [{ id: 'developer', defaultFor: ['implementation'], phases: ['implementation'] }]
  };
  const result = await sessionStartAgentHook(repository, customDefinition, current, { sessionId: 'custom-path-hook' });
  assert.match(result.additionalContext, /Governed artifacts for GROUND-CUSTOM live under governed\/story-state\/GROUND-CUSTOM\//);
  assert.doesNotMatch(result.additionalContext, /singularity\/work-items\/GROUND-CUSTOM|different\/live-configuration/);
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
  const designText = [
    '# Approved design', '', 'Use the repository-rooted implementation boundary.', '',
    '| Clause | Expected paths | Planned tests |',
    '|---|---|---|',
    '| `GROUND-1:AC-001` | `src/implementation.ts` | `test/implementation.test.ts` |', ''
  ].join('\n');
  await writeFile(designFile, designText);
  const intakeRelative = `${itemRelative}/${workflow.phases.intake.requiredArtifact.path}`;
  const intakeFile = path.join(repository, intakeRelative);
  await writeFile(intakeFile, [
    '# Intake', '', '[GROUND-1:AC-001]',
    'Preparation and composition preserve every complete repository-rooted path.', ''
  ].join('\n'));
  const intakeInfo = await snapshot(intakeFile);
  const specIndex = await buildSpecIndex(repository, intakeRelative, {
    workId: 'GROUND-1', phase: 'intake', generation: 1,
    outputPath: `${itemRelative}/context/spec-indexes/intake-gen1.json`,
    policy: workflow.resolution.spec
  });
  const planned = {
    ...derivePlannedClaimMap(designText, {
      clauseIds: ['GROUND-1:AC-001'], policy: workflow.resolution.spec
    }).claimMap,
    workId: 'GROUND-1', phase: 'design', generation: 1
  };
  const plannedRelative = `${itemRelative}/context/claims/design-gen1-planned.json`;
  await mkdir(path.dirname(path.join(repository, plannedRelative)), { recursive: true });
  await writeFile(path.join(repository, plannedRelative), canonicalJson(planned));
  const info = await snapshot(designFile);
  workflow.phases.intake.status = 'approved';
  workflow.phases.intake.generation = 1;
  workflow.phases.intake.artifacts = [{ path: intakeRelative, status: 'approved', ...intakeInfo }];
  workflow.phases.intake.specIndex = {
    generation: 1,
    path: `${itemRelative}/context/spec-indexes/intake-gen1.json`,
    clauses: specIndex.clauses.length,
    indexSha256: specIndex.indexSha256,
    sourceSha256: specIndex.source.sha256
  };
  workflow.phases.design.status = 'approved';
  workflow.phases.design.generation = 1;
  workflow.phases.design.approvedAt = '2026-08-22T00:00:00.000Z';
  workflow.phases.design.approvedBy = 'path-grounding@example.invalid';
  workflow.phases.design.artifacts = [{ path: repositoryPath, status: 'approved', ...info }];
  workflow.phases.design.claimMaps = {
    planned: {
      generation: 1,
      path: plannedRelative,
      sha256: createHash('sha256').update(canonicalJson(planned)).digest('hex')
    }
  };
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
  assert.match(prompt, /Authored content: at least 250 UTF-8 bytes/);
  assert.match(prompt, /managed metadata and approved-input blocks do not count/);
  assert.match(prompt, /unchanged prepared template is refused/);
  assert.match(prompt, new RegExp(`source=${repositoryPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(prompt, /- Required artifact: `artifacts\//);
});
