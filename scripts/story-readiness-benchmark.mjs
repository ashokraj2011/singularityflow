/** Disposable cross-platform intake qualification. No Story, real remote, model or approval. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { readWorkspace } from '../src/workspace-manifest.mjs';
import { rememberWorkspace } from '../src/workspace.mjs';
import { activateWorkspaceContext } from '../src/workspace-context.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function createStoryReadinessFixture({ files = 100, cliRoot = packageRoot } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-bench-'));
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    const remote = path.join(directory, 'remote.git'), source = path.join(directory, 'source');
    git(directory, 'init', '--bare', '--initial-branch=main', remote);
    git(directory, 'clone', '--quiet', remote, source);
    git(source, 'config', 'user.name', 'Readiness Fixture'); git(source, 'config', 'user.email', 'readiness@example.invalid');
    await initializeDefinition(source);
    const workflowFile = path.join(source, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
    definition.worldModel.grounding = 'off'; definition.repositoryReadiness.requiredBeforeStory = false;
    for (const authority of Object.values(definition.approvalAuthorities ?? {})) authority.members = [{ name: 'Fixture', email: 'readiness@example.invalid' }];
    await writeFile(workflowFile, YAML.stringify(definition));
    await mkdir(path.join(source, 'src'));
    for (let index = 0; index < files; index++) await writeFile(path.join(source, 'src', `file-${index}.txt`), `fixture ${index}\n`);
    git(source, 'add', '.'); git(source, 'commit', '--quiet', '-m', 'readiness fixture');
    git(source, 'push', '--quiet', 'origin', 'main', 'main:refs/heads/sflow/config');
    const workspacePath = path.join(directory, 'workspace'), original = path.join(workspacePath, 'repos', 'app');
    await mkdir(path.dirname(original), { recursive: true }); git(directory, 'clone', '--quiet', remote, original);
    await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'readiness-bench', name: 'Readiness benchmark',
      createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
      anchor: { provider: 'workspace', key: 'readiness-bench', title: 'Benchmark', fetchedAt: '2026-10-17T00:00:00Z' },
      leadRepository: 'app', repositories: { app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] } } }));
    const registry = path.join(directory, 'registry.json'), selection = path.join(directory, 'selection.json');
    await rememberWorkspace(registry, await readWorkspace(workspacePath));
    await activateWorkspaceContext(registry, selection, 'readiness-bench', { detectStory: false });
    const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry, SINGULARITY_FLOW_LEAD_REGISTRY: path.join(directory, 'leads.json'),
      SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES: path.join(directory, 'preferences.json') };
    const invoke = async (extra = {}, more = []) => {
      const started = performance.now();
      const run = spawnSync(process.execPath, [path.join(cliRoot, 'bin/singularity-flow.mjs'), 'workspace', 'branches',
        '--intake', '--preflight-story', 'PERF-READY', '--from-branch', 'main', '--work-type', 'feature',
        '--selected-base-only', '--mint-intake-receipt', '--json', '--timings', ...more], {
        cwd: original, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024
      });
      const ms = performance.now() - started;
      assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
      const packet = JSON.parse(run.stdout); assert.equal(packet.preflight.passed, true, run.stdout);
      const lines = (await readFile(path.join(packet.repositoryPath, '.git/singularity-flow/dx/timings.jsonl'), 'utf8')).trim().split('\n');
      const timing = JSON.parse(lines.at(-1));
      const counters = timing.counters ?? {};
      return { packet, timing, metrics: { ms: Math.round(ms), gitSpawns: timing.gitSpawns, gitRequests: timing.gitRequests,
        remoteGitOperations: ['ls-remote', 'fetch', 'clone', 'push'].reduce((sum, verb) => sum + (counters[`git.remote.command.${verb}`] ?? 0), 0),
        fetches: timing.fetches, configurationLoads: counters['configuration.definition-load'] ?? 0,
        snapshot: packet.readinessSnapshot?.source ?? null, counters } };
    };
    return { directory, original, source, remote, env, git, invoke, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function benchmarkStoryReadiness({ cliRoot = packageRoot, files = 100 } = {}) {
  const fixture = await createStoryReadinessFixture({ cliRoot, files });
  try {
    const rows = [];
    for (const [name, mode] of [['cold-download', 'always'], ['reused-fresh', 'always'], ['reused-fresh', 'always'],
      ['cache-fill', 'cached'], ['cache-hit', 'cached'], ['cache-hit', 'cached']]) {
      const result = await fixture.invoke({ SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: mode });
      rows.push({ name, mode, ...result.metrics });
    }
    return { platform: process.platform, node: process.version, files,
      scope: 'Fresh Node processes; disposable local bare Git remote. OS caches not flushed; no real network, Story creation, tests or model.', rows };
  } finally { await fixture.cleanup(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const result = await benchmarkStoryReadiness({ cliRoot: value('--cli-root') ?? packageRoot, files: Number(value('--files') ?? 100) });
  if (value('--output')) await writeFile(value('--output'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
