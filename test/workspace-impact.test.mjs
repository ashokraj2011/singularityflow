import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeWorkspaceImpact, listWorkspaceImpacts, previewWorkspaceImpact,
  promoteWorkspaceImpact, workspaceImpactStatus
} from '../src/workspace-impact.mjs';
import { createWorkspaceConfiguration, stageWorkspaceDocuments } from '../src/workspace.mjs';
import { run } from '../src/util.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { worldModelSourceSnapshot } from '../src/grounding.mjs';
import { writeV3Manifest } from '../src/world-model-materialization.mjs';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function repository(base, id) {
  const source = path.join(base, `${id}-source`);
  const bare = path.join(base, `${id}.git`);
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Impact Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'impact@example.com'], { cwd: source });
  await writeFile(path.join(source, 'service.txt'), `${id} service\n`);
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initial'], { cwd: source });
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  return bare;
}

async function stateRepository(base, id) {
  const source = path.join(base, `${id}-state-source`);
  const bare = path.join(base, `${id}-state.git`);
  run('git', ['init', '-b', 'main', source], { cwd: base });
  run('git', ['config', 'user.name', 'Impact Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'impact@example.com'], { cwd: source });
  await writeFile(path.join(source, 'service.txt'), `${id} service\n`);
  await initializeDefinition(source);
  const workflowPath = path.join(source, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(workflowPath, 'utf8'));
  definition.worldModel.outputDir = 'governed/repository-model';
  await writeFile(workflowPath, YAML.stringify(definition));
  run('git', ['add', '.'], { cwd: source });
  run('git', ['commit', '-m', 'initialize state model source'], { cwd: source });
  const mainCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  const sourceState = await worldModelSourceSnapshot(source, definition);
  run('git', ['switch', '-c', 'state'], { cwd: source });
  const directory = path.join(source, definition.worldModel.outputDir);
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), '# API brief\n');
  await writeFile(path.join(directory, 'core/summary.md'), '# API full\n');
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'path-index.json'), '{}\n');
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeV3Manifest(directory, {
    schema_version: '3.0', generated_at: '2026-08-31T00:00:00.000Z',
    generated_date: '31 August 2026', builder_version: 'test',
    builder_prompt_sha256: 'a'.repeat(64), analysis_depth: 'standard',
    repository_commit: mainCommit, repository_branch: 'main', working_tree_clean: true,
    source_tree_sha256: sourceState.sha256,
    core: {
      tiers: {
        brief: { status: 'ready', path: 'core/summary.brief.md' },
        full: { status: 'ready', path: 'core/summary.md' }
      }, model: { path: 'core/model.json' }
    },
    views: {}, domains: [], task_guides: [],
    path_index: { path: 'path-index.json' }, evidence: { path: 'evidence/evidence.jsonl' },
    materializations: []
  });
  run('git', ['add', definition.worldModel.outputDir], { cwd: source });
  run('git', ['commit', '-m', 'publish state model'], { cwd: source });
  run('git', ['switch', 'main'], { cwd: source });
  run('git', ['clone', '--bare', source, bare], { cwd: base });
  return bare;
}

async function approveImpactCapabilities(root, api, web) {
  const checkout = path.join(root, 'capability-authority');
  run('git', ['clone', '-q', api, checkout], { cwd: root });
  run('git', ['config', 'user.name', 'Impact Tester'], { cwd: checkout });
  run('git', ['config', 'user.email', 'impact@example.com'], { cwd: checkout });
  run('git', ['switch', '--orphan', 'sflow/config'], { cwd: checkout });
  run('git', ['rm', '-rf', '.'], { cwd: checkout, allowFailure: true });
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await writeFile(path.join(checkout, 'singularity', 'capabilities.yml'), [
    'version: 1',
    'capabilities:',
    '  checkout: { name: Checkout, kind: collection, parent: null }',
    '  checkout-api: { name: Checkout API, kind: delivery, parent: checkout, repository: api }',
    '  checkout-web: { name: Checkout Web, kind: delivery, parent: checkout, repository: web }',
    ''
  ].join('\n'));
  await writeFile(path.join(checkout, 'singularity', 'portfolio.yml'), [
    'version: 1',
    'repositories:',
    `  api: { url: ${JSON.stringify(api)}, defaultBranch: main }`,
    `  web: { url: ${JSON.stringify(web)}, defaultBranch: main }`,
    ''
  ].join('\n'));
  run('git', ['add', '-A'], { cwd: checkout });
  run('git', ['commit', '-m', 'approve impact capabilities'], { cwd: checkout });
  run('git', ['push', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: checkout });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-impact-'));
  const api = await repository(root, 'api');
  const web = await repository(root, 'web');
  await approveImpactCapabilities(root, api, web);
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'),
    id: 'checkout',
    name: 'Checkout',
    leadRepository: 'api',
    capabilities: ['checkout-api', 'checkout-web'],
    repositories: {
      api: { url: api, defaultBranch: 'main', capabilities: ['checkout-api'] },
      web: { url: web, defaultBranch: 'main', capabilities: ['checkout-web'] }
    }
  }, { confirmation: 'checkout', clone: true });
  const note = path.join(root, 'proposal.md');
  await writeFile(note, '# Proposal\nAdd passkey authentication.\n');
  await stageWorkspaceDocuments(created.workspace.path, [note]);
  return { root, workspace: created.workspace };
}

test('workspace impact analyzes immutable repository copies without a Work ID or branch mutation', async () => {
  const { workspace } = await fixture();
  const apiPath = path.join(workspace.path, workspace.repositories.api.path);
  const webPath = path.join(workspace.path, workspace.repositories.web.path);
  const before = {
    api: run('git', ['rev-parse', 'HEAD'], { cwd: apiPath }).stdout.trim(),
    web: run('git', ['rev-parse', 'HEAD'], { cwd: webPath }).stdout.trim(),
    apiBranch: run('git', ['branch', '--show-current'], { cwd: apiPath }).stdout.trim(),
    webBranch: run('git', ['branch', '--show-current'], { cwd: webPath }).stdout.trim()
  };
  let runnerCalled = 0;
  const report = await analyzeWorkspaceImpact(workspace.path, {
    id: 'impact-passkeys',
    title: 'Passkey authentication',
    description: 'Assess the repository and delivery impact of adding passkey authentication.'
  }, {
    runner: async ({ cwd, prompt }) => {
      runnerCalled += 1;
      assert.notEqual(path.resolve(cwd), path.resolve(workspace.path));
      assert.equal(await readFile(path.join(cwd, 'repos/api/service.txt'), 'utf8'), 'api service\n');
      assert.equal(await readFile(path.join(cwd, 'repos/web/service.txt'), 'utf8'), 'web service\n');
      assert.match(await readFile(path.join(cwd, 'documents/proposal.md'), 'utf8'), /passkey authentication/);
      assert.match(prompt, /There is no Work ID and no lifecycle branch/);
      assert.match(prompt, /api: repos\/api/);
      assert.match(prompt, /Clarifying questions and unknowns/);
      await writeFile(path.join(cwd, 'sandbox-only.txt'), 'Copilot may write only inside its disposable copy.\n');
      return { output: '# Impact summary\n\n## Executive summary\nPasskeys affect API and web.' };
    }
  });

  assert.equal(runnerCalled, 1);
  assert.equal(report.status, 'complete');
  assert.equal(report.freshness, 'current');
  assert.equal(report.advisory, true);
  assert.equal(report.repositories.length, 2);
  assert.deepEqual(report.repositories.map((entry) => entry.commit), [before.api, before.web]);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: apiPath }).stdout.trim(), before.api);
  assert.equal(run('git', ['rev-parse', 'HEAD'], { cwd: webPath }).stdout.trim(), before.web);
  assert.equal(run('git', ['branch', '--show-current'], { cwd: apiPath }).stdout.trim(), before.apiBranch);
  assert.equal(run('git', ['branch', '--show-current'], { cwd: webPath }).stdout.trim(), before.webBranch);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: apiPath }).stdout.trim(), '');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: webPath }).stdout.trim(), '');
  assert.equal(await stat(path.join(workspace.path, 'singularity')).catch(() => null), null,
    'advisory analysis does not create governed lifecycle state in the workspace root');

  const stored = await listWorkspaceImpacts(workspace.path);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, 'impact-passkeys');
  assert.equal(await readFile(path.join(workspace.path, workspace.directories.copilotCache,
    'impact/impact-passkeys/summary.md'), 'utf8'), '# Impact summary\n\n## Executive summary\nPasskeys affect API and web.\n');
});

test('workspace impact reuses a custom-output governed-state model in its detached sandbox', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-impact-state-'));
  const api = await stateRepository(root, 'api');
  const web = await repository(root, 'web');
  await approveImpactCapabilities(root, api, web);
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(root, 'workspaces'), id: 'state-impact', name: 'State impact',
    leadRepository: 'api', capabilities: ['checkout-api'],
    repositories: {
      api: { url: api, defaultBranch: 'main', capabilities: ['checkout-api'] }
    }
  }, { confirmation: 'state-impact', clone: true });
  const report = await analyzeWorkspaceImpact(created.workspace.path, {
    id: 'impact-state-model', description: 'Assess the API using shared repository grounding.',
    repositories: ['api']
  }, {
    runner: async ({ cwd, prompt }) => {
      const manifest = JSON.parse(await readFile(path.join(
        cwd, 'repos/api/governed/repository-model/manifest.json'
      ), 'utf8'));
      assert.equal(manifest.generated_at, '2026-08-31T00:00:00.000Z');
      assert.match(prompt, /world model: governed-state/);
      assert.doesNotMatch(prompt, /world model: missing/);
      return { output: '# Impact summary\n\n## Executive summary\nState model reused.' };
    }
  });
  assert.equal(report.repositories[0].worldModel.source, 'state-branch');
  assert.equal(report.repositories[0].worldModel.outputDir, 'governed/repository-model');
  assert.equal(report.warnings.length, 0);
});

test('workspace impact preview is write-free and promotion refuses stale evidence', async () => {
  const { workspace } = await fixture();
  const preview = await previewWorkspaceImpact(workspace.path, {
    id: 'impact-preview', description: 'Preview a checkout schema change.'
  });
  assert.equal(preview.status, 'prepared');
  assert.match(preview.prompt.content, /checkout schema change/);
  assert.equal(await stat(path.join(workspace.path, workspace.directories.copilotCache,
    'impact/impact-preview')).catch(() => null), null);

  await analyzeWorkspaceImpact(workspace.path, {
    id: 'impact-schema', description: 'Assess a checkout schema change.'
  }, { runner: async () => ({ output: '# Impact summary\n\n## Executive summary\nSchema change.' }) });
  const promotion = await promoteWorkspaceImpact(workspace.path, 'impact-schema');
  assert.equal(promotion.analysisId, 'impact-schema');
  assert.match(promotion.document.path, /^documents\/inbox\/summary/);
  assert.equal(await readFile(path.join(workspace.path, promotion.document.path), 'utf8'),
    '# Impact summary\n\n## Executive summary\nSchema change.\n');
  const repeated = await promoteWorkspaceImpact(workspace.path, 'impact-schema');
  assert.equal(repeated.alreadyPromoted, true);
  assert.equal(repeated.document.path, promotion.document.path, 'repeat promotion reuses the exact staged evidence');

  const apiPath = path.join(workspace.path, workspace.repositories.api.path);
  await writeFile(path.join(apiPath, 'service.txt'), 'changed service\n');
  run('git', ['config', 'user.name', 'Impact Tester'], { cwd: apiPath });
  run('git', ['config', 'user.email', 'impact@example.com'], { cwd: apiPath });
  run('git', ['add', 'service.txt'], { cwd: apiPath });
  run('git', ['commit', '-m', 'change API'], { cwd: apiPath });
  const status = await workspaceImpactStatus(workspace.path, 'impact-schema');
  assert.equal(status.freshness, 'stale');
  assert.deepEqual(status.changes.map((entry) => entry.repository), ['api']);
  await assert.rejects(() => promoteWorkspaceImpact(workspace.path, 'impact-schema'), /is stale/);
});

test('workspace impact treats altered local prompt or summary evidence as stale', async () => {
  const { workspace } = await fixture();
  await analyzeWorkspaceImpact(workspace.path, {
    id: 'impact-integrity', description: 'Assess impact record integrity.'
  }, { runner: async () => ({ output: '# Impact summary\n\n## Executive summary\nOriginal.' }) });
  const directory = path.join(workspace.path, workspace.directories.copilotCache, 'impact/impact-integrity');
  await writeFile(path.join(directory, 'summary.md'), '# Impact summary\n\nChanged outside Singularity Flow.\n');
  const status = await workspaceImpactStatus(workspace.path, 'impact-integrity');
  assert.equal(status.freshness, 'stale');
  assert.deepEqual(status.changes.map((change) => change.reason), ['summary.md changed']);
  await assert.rejects(() => promoteWorkspaceImpact(workspace.path, 'impact-integrity'), /is stale/);
});

test('workspace impact CLI supports a no-Copilot dry run', async () => {
  const { root, workspace } = await fixture();
  const result = spawnSync(process.execPath, [
    cli, '--no-model', 'workspace', 'impact', 'analyze', workspace.path,
    '--id', 'impact-cli-preview', '--description', 'Assess a CLI-only preview.', '--dry-run', '--json'
  ], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'registry.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active.json')
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.id, 'impact-cli-preview');
  assert.equal(preview.status, 'prepared');
  assert.match(preview.prompt.content, /Assess a CLI-only preview/);
  assert.equal(await stat(path.join(workspace.path, workspace.directories.copilotCache,
    'impact/impact-cli-preview')).catch(() => null), null);
});
