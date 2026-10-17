import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStoryReadinessFixture } from '../scripts/story-readiness-benchmark.mjs';
import { storyReadinessSnapshot } from '../src/story-readiness-snapshot.mjs';
import { saveRepositoryCheckSettings } from '../src/repository-check-settings.mjs';

test('intake catalogs share the cache policy, explicit refresh and complete-only admission', async t => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  const first = await f.invokeCatalog();
  assert.equal(first.packet.readinessSnapshot.scope, 'story-intake-catalog');
  assert.equal(first.packet.readinessSnapshot.source, 'fresh');
  const hit = await f.invokeCatalog();
  assert.equal(hit.metrics.snapshot, 'cache');
  assert.ok(hit.metrics.gitSpawns <= 1, 'at most the uncached native repository-location lookup, never the heavy catalog');
  assert.equal(hit.metrics.remoteGitOperations, 0);
  t.diagnostic(JSON.stringify({ catalogCacheMs: hit.metrics.ms, gitProcesses: hit.metrics.gitSpawns,
    remoteOperations: hit.metrics.remoteGitOperations, configurationLoads: hit.metrics.configurationLoads }));
  assert.deepEqual(hit.packet.intake.storyWorkflows, first.packet.intake.storyWorkflows);
  f.git(f.source, 'push', '--quiet', 'origin', 'main:refs/heads/catalog-added');
  assert.equal((await f.invokeCatalog()).metrics.snapshot, 'cache', 'remote-only changes wait for refresh or TTL');
  const refreshed = await f.invokeCatalog({}, ['--refresh-readiness']);
  assert.equal(refreshed.metrics.snapshot, 'fresh'); assert.ok(refreshed.metrics.remoteGitOperations > 0);
  assert.match(JSON.stringify(refreshed.packet.choices), /catalog-added/u);
  assert.equal((await f.invokeCatalog()).metrics.snapshot, 'cache');

  let calls = 0;
  const read = async () => { calls++; return { choicesComplete: true, intake: { storyWorkflows: [] },
    unreachable: [{ repository: 'offline' }] }; };
  await storyReadinessSnapshot(f.original, { intake: true, json: true, test: 'incomplete' }, null, read);
  await storyReadinessSnapshot(f.original, { intake: true, json: true, test: 'incomplete' }, null, read);
  assert.equal(calls, 2, 'degraded catalogs never replace complete cached snapshots');
  calls = 0;
  await storyReadinessSnapshot(f.original, { intake: true, 'work-id': 'EXISTING' }, null, read);
  await storyReadinessSnapshot(f.original, { intake: true, 'work-id': 'EXISTING' }, null, read);
  assert.equal(calls, 2, 'existing Story conflict reads never use the advisory catalog cache');
});

test('readiness uses one fresh snapshot, then zero Git processes and zero remote operations across CLI invocations', async t => {
  const f = await createStoryReadinessFixture(); t.after(f.cleanup);
  const cold = await f.invoke();
  const warm = await f.invoke(); // Initial object/config download may invalidate the first stamp.
  const hit = await f.invoke();
  assert.equal(hit.metrics.snapshot, 'cache');
  assert.equal(hit.metrics.gitSpawns, 0);
  assert.equal(hit.metrics.remoteGitOperations, 0);
  assert.equal(cold.metrics.counters['git.remote.command.push'] ?? 0, 0, 'preview never probes push permissions');
  assert.ok((cold.metrics.configurationLoads ?? 0) <= 1, 'one approved definition compilation');
  assert.equal(hit.packet.readinessSnapshot.intervalMinutes, 30);
  assert.equal(hit.packet.readinessSnapshot.provisional, true);
  assert.equal(hit.packet.readinessSnapshot.publicationAccess, 'checked-on-start');
  assert.deepEqual(hit.packet.preflight.repositories, warm.packet.preflight.repositories);
  const root = hit.packet.repositoryPath;
  assert.equal(f.git(root, 'branch', '--list', 'PERF-READY'), '', 'preview did not create a Story branch');
  const forced = await f.invoke({}, ['--refresh-readiness']);
  assert.equal(forced.metrics.snapshot, 'fresh'); assert.ok(forced.metrics.remoteGitOperations > 0);
  assert.equal(forced.metrics.counters['git.remote.command.push'] ?? 0, 0);
  await writeFile(path.join(f.source, 'state-only.txt'), 'unrelated state change');
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', 'state only');
  f.git(f.source, 'push', '--quiet', 'origin', 'HEAD:refs/heads/state');
  const stateChanged = await f.invoke({}, ['--refresh-readiness']);
  assert.equal(stateChanged.metrics.fetches, 0, 'missing state tracking ref must not refetch unchanged main');
  await saveRepositoryCheckSettings({ mode: 'always', intervalMinutes: 7 }, {
    workspacePath: await realpath(f.original), file: f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES });
  assert.equal((await f.invoke()).packet.readinessSnapshot.intervalMinutes, 7, 'branch checkout inherits original resource preferences');
  assert.equal((await f.invoke()).metrics.snapshot, 'fresh', 'original always-mode override survives the branch-folder handoff');
  const changed = await f.invoke({}, ['--preflight-story', 'OTHER-READY']);
  assert.equal(changed.metrics.snapshot, 'fresh', 'a different Story cannot reuse the prior tuple');
});

test('readiness cache respects modes, configurable TTL, dependency changes and refused refresh', async t => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  const root = f.original;
  const prior = process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE;
  const interval = process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES;
  process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE = 'cached';
  process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES = '1';
  t.after(() => { for (const [name, value] of [['SINGULARITY_FLOW_REPOSITORY_CHECK_MODE', prior],
    ['SINGULARITY_FLOW_REPOSITORY_CHECK_INTERVAL_MINUTES', interval]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const options = { 'selected-base-only': true, 'preflight-story': 'CACHE-TEST', 'from-branch': 'main' };
  let calls = 0, passed = true;
  const read = async () => { calls++; return { preflight: { passed, readiness: { authority: { commit: 'a'.repeat(40) } } } }; };
  const invoke = extra => storyReadinessSnapshot(root, { ...options, ...extra }, null, read);
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh');
  assert.equal((await invoke()).readinessSnapshot.source, 'cache'); assert.equal(calls, 1);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 60_001);
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh', 'configured expiry');
  t.mock.restoreAll();
  // An observation in the future is not reused either.
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh');
  await writeFile(path.join(root, 'singularity/workflow.yml'), `${await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8')}\n`);
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh', 'local YAML changes invalidate');
  f.git(root, 'config', 'sflow.fixture', 'changed');
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh', 'Git configuration changes invalidate');
  process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE = 'always';
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh');
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh');
  process.env.SINGULARITY_FLOW_REPOSITORY_CHECK_MODE = 'manual';
  await invoke(); assert.equal((await invoke()).readinessSnapshot.source, 'cache');
  passed = false;
  assert.equal((await invoke({ 'refresh-readiness': true })).preflight.passed, false);
  const refused = await invoke(); assert.equal(refused.readinessSnapshot.source, 'fresh');
  assert.equal((await invoke()).readinessSnapshot.source, 'fresh', 'blocked results are never cached');
});

test('a remote Story appearing during the preview cache window is refused by fresh Start checks', async t => {
  const f = await createStoryReadinessFixture({ files: 1 }); t.after(f.cleanup);
  await f.invoke(); await f.invoke();
  const cached = await f.invoke(); assert.equal(cached.metrics.snapshot, 'cache');
  f.git(f.source, 'push', '--quiet', 'origin', 'main:refs/heads/PERF-READY');
  const stillCached = await f.invoke(); assert.equal(stillCached.metrics.snapshot, 'cache', 'preview is explicitly historical');
  const started = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url)),
    'start', 'PERF-READY', '--from-branch', 'main', '--isolated-worktree', '--work-type', 'feature',
    '--title', 'Must not overwrite', '--description', 'Collision test', '--json',
    ...(cached.packet.preflight.intakeReceipt?.issued ? ['--intake-receipt', cached.packet.preflight.intakeReceipt.id] : [])], {
    cwd: f.original, env: f.env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.notEqual(started.status, 0);
  assert.match(started.stderr + started.stdout, /already exists|Resume|story.*exists/iu);
  const refreshed = f.invoke({}, ['--refresh-readiness']);
  await assert.rejects(refreshed, /already exists|Resume|story.*exists/iu);
  assert.equal(f.git(f.source, 'ls-remote', 'origin', 'refs/heads/PERF-READY').split(/\s/u)[0], f.git(f.source, 'rev-parse', 'HEAD'));
});
