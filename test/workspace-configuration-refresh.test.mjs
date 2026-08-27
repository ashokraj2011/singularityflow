import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { run } from '../src/util.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { installWorkflow } from '../src/workflow-catalog.mjs';
import {
  mergePackagedConfiguration,
  PACKAGE_BASELINE_PATH,
  refreshPackagedConfiguration,
  refreshWorkspaceConfigurations,
  STATE_CONFIGURATION_MANIFEST
} from '../src/workspace-configuration-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';
process.env.GIT_LFS_SKIP_SMUDGE = '1';
if (process.platform === 'darwin') process.env.TMPDIR = '/tmp';
const INITIAL_FILES = [
  ['workflow.yml', 'singularity/workflow.yml'],
  ['portfolio.yml', 'singularity/portfolio.yml'],
  ['capabilities.yml', 'singularity/capabilities.yml'],
  ['agent-mappings.yml', 'singularity/agent-mappings.yml'],
  ['impact.yml', 'singularity/impact.yml'],
  ['modelTiers.yml', 'singularity/modelTiers.yml'],
  ['artifacts', 'singularity/templates'],
  ['agents', '.github/agents'],
  ['worldmodel-builder.md', 'singularity/prompts/worldmodel-builder.md'],
  ['copilot-planning.md', 'singularity/prompts/copilot-planning.md']
];

function git(root, args) {
  return run('git', args, { cwd: root }).stdout.trim();
}

async function copyBytes(source, destination) {
  const info = await lstatForCopy(source);
  if (info.directory) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyBytes(path.join(source, entry), path.join(destination, entry));
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
}

async function lstatForCopy(source) {
  const entries = await readdir(source, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOTDIR') return null;
    throw error;
  });
  return { directory: entries !== null };
}

async function initializeFixture(root) {
  for (const [source, destination] of INITIAL_FILES) {
    await copyBytes(path.join(ROOT, 'templates', source), path.join(root, destination));
  }
}

async function repositoryFixture(root, id = 'application') {
  const remote = path.join(root, `${id}.git`);
  const repository = path.join(root, 'workspace', 'repos', id);
  run('git', ['init', '--bare', '--initial-branch=main', remote]);
  run('git', ['init', '--initial-branch=main', repository]);
  git(repository, ['config', 'user.name', 'Configuration Test']);
  git(repository, ['config', 'user.email', 'configuration@example.test']);
  await writeFile(path.join(repository, 'application.txt'), 'application source\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Initialize application']);
  git(repository, ['remote', 'add', 'origin', remote]);
  git(repository, ['push', '-u', 'origin', 'main']);

  // Seed only the authority file this regression needs. The refresh itself installs the packaged
  // assets; avoiding a second full fixture commit keeps this test about refresh rather than macOS
  // metadata-copy performance.
  const publisher = path.join(root, 'configuration-publisher');
  run('git', ['init', '--initial-branch=sflow/config', publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const workflow = YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
  delete workflow.phases.implementation.generation.task;
  workflow.defaultBaseBranch = 'release';
  await mkdir(path.join(publisher, 'singularity'), { recursive: true });
  await writeFile(path.join(publisher, 'singularity/workflow.yml'), YAML.stringify(workflow));
  git(publisher, ['add', 'singularity/workflow.yml']);
  git(publisher, ['commit', '-m', 'Retain older workflow policy']);
  git(publisher, ['remote', 'add', 'origin', remote]);
  git(publisher, ['push', 'origin', 'HEAD:sflow/config']);
  return { remote, repository };
}

test('three-way package merging updates untouched values and retains repository customizations', () => {
  const base = {
    phases: { implementation: { generation: { task: 'code', allowed: ['model'] } } },
    defaultBaseBranch: 'main'
  };
  const incoming = {
    phases: { implementation: { generation: { task: 'implement', allowed: ['model', 'human'] } } },
    defaultBaseBranch: 'main'
  };
  const local = {
    phases: { implementation: { generation: { task: 'code', allowed: ['model'] } } },
    defaultBaseBranch: 'release'
  };
  const merged = mergePackagedConfiguration(base, local, incoming);
  assert.equal(merged.value.phases.implementation.generation.task, 'implement');
  assert.deepEqual(merged.value.phases.implementation.generation.allowed, ['model', 'human']);
  assert.equal(merged.value.defaultBaseBranch, 'release');
  assert.equal(merged.conflicts.length, 0, 'the package did not change the customized branch field');

  const conflict = mergePackagedConfiguration(base, {
    ...local,
    phases: { implementation: { generation: { task: 'repository-task', allowed: ['model'] } } }
  }, incoming);
  assert.equal(conflict.value.phases.implementation.generation.task, 'repository-task');
  assert.equal(conflict.conflicts[0].path, 'workflow.phases.implementation.generation.task');
  assert.equal(conflict.conflicts[0].resolution, 'preserved-local');
});

test('first package baseline safely expands allowlists and supports one reviewed conflict choice', () => {
  const local = {
    ledger: { enabled: true },
    phases: { implementation: { allowedAgents: ['developer'], allowedTools: ['git'] } }
  };
  const incoming = {
    ledger: { enabled: false },
    phases: { implementation: { allowedAgents: ['developer', 'qa'], allowedTools: ['git', 'tests'] } }
  };
  const preserved = mergePackagedConfiguration({}, local, incoming);
  assert.deepEqual(preserved.value.phases.implementation.allowedAgents, ['developer', 'qa']);
  assert.deepEqual(preserved.value.phases.implementation.allowedTools, ['git', 'tests']);
  assert.equal(preserved.value.ledger.enabled, true);
  assert.ok(preserved.conflicts.some((entry) => entry.path === 'workflow.ledger.enabled'
    && entry.resolution === 'preserved-local'));

  const selected = mergePackagedConfiguration({}, local, incoming, {
    resolutions: { 'workflow.ledger.enabled': 'bundled' }
  });
  assert.equal(selected.value.ledger.enabled, false);
  assert.ok(selected.conflicts.some((entry) => entry.path === 'workflow.ledger.enabled'
    && entry.resolution === 'accepted-bundled'));
});

test('explicit workflow replacement also replaces its shared phase contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-replace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  workflow.phases.implementation.generation.task = 'analyze';
  await writeFile(workflowFile, YAML.stringify(workflow));

  await installWorkflow(root, 'feature', { replace: true });
  const replaced = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(replaced.phases.implementation.generation.task, 'code');
});

test('repository refresh restores additive policy and missing assets without overwriting custom files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  delete workflow.phases.implementation.generation.task;
  workflow.defaultBaseBranch = 'release';
  await writeFile(workflowFile, YAML.stringify(workflow));
  const missing = path.join(root, 'singularity/templates/feature/implementation-spec.md');
  await rm(missing);
  const customAgent = path.join(root, '.github/agents/developer.agent.md');
  const customizedAgent = `${await readFile(path.join(ROOT, 'templates/agents/developer.agent.md'), 'utf8')}\n<!-- repository customization -->\n`;
  await writeFile(customAgent, customizedAgent);

  const result = await refreshPackagedConfiguration(root);
  const refreshed = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.equal(refreshed.phases.implementation.generation.task, 'code');
  assert.equal(refreshed.defaultBaseBranch, 'release');
  assert.match(await readFile(missing, 'utf8'), /implementation/i);
  assert.equal(await readFile(customAgent, 'utf8'), customizedAgent);
  assert.ok(result.conflicts.some((entry) => entry.path === '.github/agents/developer.agent.md'));
  assert.equal(YAML.parse(await readFile(path.join(root, PACKAGE_BASELINE_PATH), 'utf8')).format,
    'singularity-flow-configuration-baseline/v1');
  const repeated = await refreshPackagedConfiguration(root);
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.files, []);
});

test('configuration refresh restores the standard spec-driven workflow after a prior baseline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-standard-workflow-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);

  // Record the current package as the prior reviewed baseline, then reproduce an approved
  // configuration that lacks the standard profile. Generic three-way merging calls this a local
  // deletion; product refresh must still restore the standard workflow contract.
  await refreshPackagedConfiguration(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowFile, 'utf8'));
  delete workflow.workTypes['spec-driven-standard'];
  await writeFile(workflowFile, YAML.stringify(workflow));

  const refreshed = await refreshPackagedConfiguration(root);
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  assert.deepEqual(definition.workTypes['spec-driven-standard'],
    YAML.parse(await readFile(path.join(ROOT, 'templates/workflow.yml'), 'utf8'))
      .workTypes['spec-driven-standard']);
  assert.ok(refreshed.files.includes('singularity/workflow.yml'));
  assert.ok(!refreshed.conflicts.some((entry) =>
    entry.path === 'workflow.workTypes.spec-driven-standard'));
});

test('configuration refresh upgrades an exact retired bundled model map without treating it as customization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-model-map-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const target = path.join(root, 'singularity/modelTiers.yml');
  const retired = await readFile(path.join(ROOT, 'test/fixtures/legacy-modelTiers-gpt4o.yml'));
  await writeFile(target, retired);

  const result = await refreshPackagedConfiguration(root);
  assert.equal(await readFile(target, 'utf8'), await readFile(path.join(ROOT, 'templates/modelTiers.yml'), 'utf8'));
  assert.ok(result.files.includes('singularity/modelTiers.yml'));
  assert.ok(!result.conflicts.some((entry) => entry.path === 'singularity/modelTiers.yml'));
});

test('configuration refresh refuses a cross-file-invalid preserved agent and accepts an explicit repair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-refresh-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeFixture(root);
  const qaFile = path.join(root, '.github/agents/qa.agent.md');
  const currentQa = await readFile(qaFile, 'utf8');
  const olderQa = currentQa.replaceAll(
    'reproduction,verify,verification,testing,visual-verification,conformance,release',
    'reproduction,verify,verification,visual-verification,conformance,release'
  );
  assert.notEqual(olderQa, currentQa, 'the fixture removes the default for the testing phase');
  await writeFile(qaFile, olderQa);

  await assert.rejects(() => refreshPackagedConfiguration(root), (error) => {
    assert.equal(error.code, 'CONFIGURATION_REFRESH_INVALID');
    assert.match(error.message, /testing.*default governed agent/i);
    assert.match(error.message, /--resolve PATH=bundled/);
    assert.ok(error.details.conflicts.some((entry) => entry.path === '.github/agents/qa.agent.md'));
    return true;
  });

  const repaired = await refreshPackagedConfiguration(root, {
    resolutions: { '.github/agents/qa.agent.md': 'bundled' }
  });
  assert.ok(repaired.conflicts.some((entry) => entry.path === '.github/agents/qa.agent.md'
    && entry.resolution === 'accepted-bundled'));
  assert.equal(await readFile(qaFile, 'utf8'), currentQa);
});

test('workspace refresh preview returns an actionable packaged-agent repair instead of losing conflicts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-agent-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote } = await repositoryFixture(root, 'agent-repair');

  const publisher = path.join(root, 'agent-repair-publisher');
  run('git', ['clone', '--quiet', '--branch', 'sflow/config', remote, publisher]);
  git(publisher, ['config', 'user.name', 'Configuration Test']);
  git(publisher, ['config', 'user.email', 'configuration@example.test']);
  const currentQa = await readFile(path.join(ROOT, 'templates/agents/qa.agent.md'), 'utf8');
  const olderQa = currentQa.replaceAll(
    'reproduction,verify,verification,testing,visual-verification,conformance,release',
    'reproduction,verify,verification,visual-verification,conformance,release'
  );
  await mkdir(path.join(publisher, '.github/agents'), { recursive: true });
  await writeFile(path.join(publisher, '.github/agents/qa.agent.md'), olderQa);
  git(publisher, ['add', '.github/agents/qa.agent.md']);
  git(publisher, ['commit', '-m', 'Preserve an older QA agent']);
  git(publisher, ['push', 'origin', 'HEAD:sflow/config']);

  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'agent-repair-workspace',
    name: 'Agent repair workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'agent-repair-workspace', title: 'Agent repair workspace' },
    leadRepository: 'agent-repair',
    repositories: {
      'agent-repair': {
        id: 'agent-repair', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/agent-repair', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  const blocked = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.planId, undefined, 'an invalid contract cannot produce an applicable plan');
  assert.equal(blocked.results[0].status, 'blocked');
  assert.match(blocked.results[0].error, /testing.*default governed agent/i);
  assert.deepEqual(blocked.results[0].repair, {
    kind: 'packaged-agents',
    label: 'Restore packaged agents',
    paths: ['.github/agents/qa.agent.md']
  });
  assert.ok(blocked.results[0].conflicts.some((entry) =>
    entry.path === '.github/agents/qa.agent.md' && entry.resolution === 'preserved-local'));

  const repaired = await refreshWorkspaceConfigurations({
    registryFile: registry,
    dryRun: true,
    resolutions: { '.github/agents/qa.agent.md': 'bundled' }
  });
  assert.equal(repaired.status, 'preview');
  assert.match(repaired.planId, /^cfgp-[a-f0-9]{24}$/);
  assert.ok(repaired.results[0].conflicts.some((entry) =>
    entry.path === '.github/agents/qa.agent.md' && entry.resolution === 'accepted-bundled'));
});

test('all-workspace refresh leaves a dirty clone untouched and mirrors approved configuration to state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { remote, repository } = await repositoryFixture(root);

  const workspaceRoot = path.join(root, 'workspace');
  const manifest = {
    version: 1,
    id: 'refresh-workspace',
    name: 'Refresh workspace',
    path: workspaceRoot,
    anchor: { provider: 'workspace', key: 'refresh-workspace', title: 'Refresh workspace' },
    leadRepository: 'application',
    repositories: {
      application: {
        id: 'application', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/application', role: 'lead', capabilities: []
      }
    }
  };
  const registry = path.join(root, 'workspaces.json');
  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rememberWorkspace(registry, manifest);

  await writeFile(path.join(repository, 'application.txt'), 'dirty application work\n');
  const dirtyBefore = git(repository, ['status', '--porcelain']);
  const headBefore = git(repository, ['rev-parse', 'HEAD']);

  // An older install mirrored configuration below configuration/files and also left one retired
  // canonical policy file. Runtime world-model bytes share the state branch but are not part of the
  // configuration projection and must survive the migration exactly.
  const statePublisher = path.join(root, 'state-publisher');
  run('git', ['init', '--initial-branch=state', statePublisher]);
  git(statePublisher, ['config', 'user.name', 'Configuration Test']);
  git(statePublisher, ['config', 'user.email', 'configuration@example.test']);
  await mkdir(path.join(statePublisher, 'configuration/files/singularity'), { recursive: true });
  await mkdir(path.join(statePublisher, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(statePublisher, 'configuration/manifest.json'),
    '{"format":"singularity-flow-configuration-mirror/v1"}\n');
  await writeFile(path.join(statePublisher, 'configuration/files/singularity/workflow.yml'), 'legacy: true\n');
  await writeFile(path.join(statePublisher, 'singularity/obsolete-policy.yml'), 'retired: true\n');
  const worldModelBytes = Buffer.from('expensive world model: preserve exactly\n');
  await writeFile(path.join(statePublisher, 'singularity/world-model/model.md'), worldModelBytes);
  git(statePublisher, ['add', '-A']);
  git(statePublisher, ['commit', '-m', 'Seed legacy state projection']);
  git(statePublisher, ['remote', 'add', 'origin', remote]);
  git(statePublisher, ['push', 'origin', 'HEAD:state']);

  const preview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(preview.status, 'preview');
  assert.match(preview.planId, /^cfgp-[a-f0-9]{24}$/);
  assert.equal(preview.results[0].stateStatus, 'would-follow-configuration');

  const result = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: preview.planId
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].configurationChanged, true);
  assert.equal(result.results[0].stateChanged, true);
  assert.equal(git(repository, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(git(repository, ['status', '--porcelain']), dirtyBefore);

  const approved = YAML.parse(run('git', [
    '--git-dir', remote, 'show', 'sflow/config:singularity/workflow.yml'
  ]).stdout);
  assert.equal(approved.phases.implementation.generation.task, 'code');
  assert.equal(approved.defaultBaseBranch, 'release');
  const manifestText = run('git', [
    '--git-dir', remote, 'show', `state:${STATE_CONFIGURATION_MANIFEST}`
  ]).stdout;
  const mirror = JSON.parse(manifestText);
  assert.equal(mirror.format, 'singularity-flow-configuration-mirror/v2');
  assert.equal(mirror.layout, 'canonical-paths');
  assert.equal(mirror.source.commit, run('git', ['--git-dir', remote, 'rev-parse', 'sflow/config']).stdout.trim());
  const mirroredWorkflow = run('git', [
    '--git-dir', remote, 'show', 'state:singularity/workflow.yml'
  ]).stdout;
  assert.equal(YAML.parse(mirroredWorkflow).phases.implementation.generation.task, 'code');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:configuration/files/singularity/workflow.yml'
  ], { allowFailure: true }).status, 128);
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/obsolete-policy.yml'
  ], { allowFailure: true }).status, 128);
  assert.deepEqual(run('git', [
    '--git-dir', remote, 'show', 'state:singularity/world-model/model.md'
  ], { encoding: 'buffer' }).stdout, worldModelBytes);

  const current = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(current.results[0].status, 'current');
  assert.equal(current.results[0].configurationChanged, false);
  assert.equal(current.results[0].stateChanged, false);

  // A preview-bound UI apply may also be the first operation to establish sflow/config. Its plan
  // must be checked before initialization, then remain valid across that intentional branch create.
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
  const initializePreview = await refreshWorkspaceConfigurations({ registryFile: registry, dryRun: true });
  assert.equal(initializePreview.results[0].status, 'would-initialize');
  const initialized = await refreshWorkspaceConfigurations({
    registryFile: registry, confirmPlan: initializePreview.planId
  });
  assert.equal(initialized.status, 'complete');
  assert.match(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config']).stdout.trim(),
    /^[a-f0-9]{40}$/);
});
