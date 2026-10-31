/**
 * SDA M5, SDA-AC-016 and §12: cleanup and the SDA locations.
 *
 * - An unused clone holding only projections a read rebuilds (the M2 read index's Story summaries,
 *   derived caches) is cleaned up on its own clock. Before M5 those kept every clone that had ever
 *   answered a listing.
 * - A clone holding authored or recovery state is kept, whatever else it holds: configuration
 *   drafts (M3), an unfinished Story start, a pending publication, laptop-local documents.
 * - A terminal Story worktree is kept while a Story start in its clone has not finished.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { runWorkspaceRetention, saveWorkspaceRetention } from '../src/workspace-retention.mjs';
import { workspaceCheckoutInventory } from '../src/workspace-checkout-inventory.mjs';
import { prepareWorkspaceBranch } from '../src/workspace-branch-checkout.mjs';
import { readWorkspace, rememberWorkspace } from '../src/workspace.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const git = (root, args) => {
  const result = spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-m5-retention-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace'), root = path.join(workspacePath, 'repos', 'app');
  await mkdir(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'Retention Tester']);
  git(root, ['config', 'user.email', 'retention@example.com']);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_AUTOMATIC_CLEANUP: 'off',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Retention Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json') };
  const flow = (args, { cwd = root } = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(120000), maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    return result;
  };
  flow(['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed']);
  const remote = path.join(base, 'remote.git');
  git(base, ['init', '--bare', '-q', '-b', 'main', remote]);
  git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-q', '-u', 'origin', 'main']);
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'retention', name: 'Retention',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), anchor: { provider: 'workspace', key: 'retention', title: 'Retention', fetchedAt: new Date().toISOString() },
    leadRepository: 'app', capabilities: [], repositories: { app: { url: remote, path: 'repos/app', defaultBranch: 'main', capabilities: [] } } }));
  const workspace = await readWorkspace(workspacePath);
  await rememberWorkspace(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, workspace);
  const previous = Object.fromEntries(Object.keys(env).filter(key => key.startsWith('SINGULARITY_FLOW_')).map(key => [key, process.env[key]]));
  for (const key of Object.keys(previous)) process.env[key] = env[key];
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { base, root, workspacePath, workspace, flow };
}

async function place(file, text = '{}') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test('an unused clone holding only rebuildable projections is cleaned up; authored and recovery state keeps it', slowLane({ timeout: 180000 }), async t => {
  const f = await fixture(t);
  const unused = await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  await prepareWorkspaceBranch(f.workspace, 'app', 'main');
  const runtime = path.join(unused.repositoryPath, '.git', 'singularity-flow');
  const eligible = async () => (await workspaceCheckoutInventory(f.workspacePath)).clones
    .find((clone) => clone.root === unused.repositoryPath)?.cleanupEligible;
  assert.equal(await eligible(), true);
  // What any read rebuilds never keeps a clone.
  await place(path.join(runtime, 'story-summaries.json'));
  await place(path.join(runtime, 'cache', 'repository-checks', 'refresh.json'));
  await place(path.join(runtime, 'cache', 'publishing-commits.json'));
  assert.equal(await eligible(), true, 'the read index and derived caches are rebuilt by the next read');
  // A person's reviewed lock release, recorded beside the locks, holds nothing: it kept the clone forever (D8).
  await place(path.join(runtime, 'locks', 'released-leases.jsonl'), '{"releasedAt":"2026-10-31T00:00:00.000Z"}\n');
  assert.equal(await eligible(), true, 'the release audit holds no lock');
  // Authored or recovery state keeps it, each on its own.
  for (const [what, file, directory] of [
    ['a configuration draft', path.join(runtime, 'configuration-drafts', 'v2', `cdr-${'b'.repeat(24)}.json`), path.join(runtime, 'configuration-drafts')],
    ['an unfinished Story start', path.join(runtime, 'story-start', 'APP-1.json'), path.join(runtime, 'story-start')],
    ['a pending publication', path.join(runtime, 'pending-publication', 'story--APP-1.json'), path.join(runtime, 'pending-publication')],
    ['a laptop-local document', path.join(unused.repositoryPath, '.git', 'singularity-flow-documents', 'APP-1', 'x'),
      path.join(unused.repositoryPath, '.git', 'singularity-flow-documents')]
  ]) {
    await place(file);
    assert.equal(await eligible(), false, `${what} keeps the clone`);
    const kept = await runWorkspaceRetention(f.workspacePath, { force: true, now: Date.now() + 30 * 86400000 });
    assert.ok(!kept.removed.some((item) => item.from === unused.repositoryPath), `${what}: ${JSON.stringify(kept)}`);
    assert.ok(await lstat(file));
    await rm(directory, { recursive: true });
  }
  // With only projections left, the clone's own unused clock starts, and runs out.
  const started = Date.now() + 30 * 86400000;
  assert.equal((await runWorkspaceRetention(f.workspacePath, { force: true, now: started })).removed.length, 0);
  const late = await runWorkspaceRetention(f.workspacePath, { force: true, now: started + 8 * 86400000 });
  assert.ok(late.removed.some((item) => item.from === unused.repositoryPath), JSON.stringify(late));
  assert.equal(await lstat(unused.repositoryPath).catch(() => null), null);
});

test('a terminal Story worktree is kept while a Story start in its clone has not finished', slowLane({ timeout: 180000 }), async t => {
  const f = await fixture(t);
  const started = JSON.parse(f.flow(['start', 'DONE', '--isolated-worktree', '--from-branch', 'main', '--ref', 'delivery/done',
    '--work-type', 'feature', '--title', 'Retention', '--description', 'Terminal Story cleanup fixture', '--json']).stdout);
  const target = (started.data ?? started).repositoryPath;
  f.flow(['cancel', '--reason', 'Cleanup qualification', '--confirm', 'DONE', '--json'], { cwd: target });
  git(target, ['push', '-q', '-u', 'origin', 'delivery/done']);
  await saveWorkspaceRetention(f.workspacePath, { cancelledDays: 0 });
  const journal = path.join(f.root, '.git', 'singularity-flow', 'story-start', 'NEXT.json');
  await place(journal);
  const kept = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.equal(kept.removed.length, 0, JSON.stringify(kept));
  assert.ok(kept.preserved.some((item) => item.message === 'Shared publication/recovery state is retained.'), JSON.stringify(kept));
  await rm(journal);
  const removed = await runWorkspaceRetention(f.workspacePath, { force: true });
  assert.ok(removed.removed.some((item) => item.kind === 'story-worktree' && item.workId === 'DONE'), JSON.stringify(removed));
  assert.equal(await lstat(target).catch(() => null), null);
});
