/** Native disposable qualification. Local bare remote; fresh CLI processes, not flushed OS caches. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoryReadinessFixture } from './story-readiness-benchmark.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function benchmarkDirectStoryWorktree({ files = 10000, cliRoot = packageRoot } = {}) {
  const f = await createStoryReadinessFixture({ files, cliRoot });
  try {
    f.git(f.original, 'config', 'user.name', 'Fixture');
    f.git(f.original, 'config', 'user.email', 'readiness@example.invalid');
    await writeFile(path.join(f.original, 'operator-draft.txt'), 'retain unrelated local work\n');
    const head = f.git(f.original, 'rev-parse', 'HEAD'), branch = f.git(f.original, 'branch', '--show-current');
    const rows = [];
    const invoke = async (name, args) => {
      // Keep environment identity stable between calls; a different GIT_TRACE path changes the
      // advisory cache key and would turn the supposed cache-hit measurement into another miss.
      const trace = path.join(f.directory, 'commands.trace.jsonl');
      const counts = path.join(f.directory, 'process-counts.jsonl');
      await writeFile(trace, '');
      await writeFile(counts, '');
      const began = performance.now();
      const result = spawnSync(process.execPath, ['--import', new URL('./benchmark-git-probe.mjs', import.meta.url).href,
        path.join(cliRoot, 'bin/singularity-flow.mjs'), ...args, '--json', '--timings'], {
        cwd: f.original, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024,
        env: { ...f.env, SINGULARITY_FLOW_TEST_IDENTITY: 'Fixture', GIT_TRACE2_EVENT: trace.replaceAll('\\', '/'),
          SFLOW_BENCHMARK_GIT_COUNTS: counts, SINGULARITY_FLOW_PERF_TRACE: '1',
          SINGULARITY_FLOW_PROGRESS: 'stderr-v1' }
      });
      const ms = Math.round(performance.now() - began);
      assert.equal(result.status, 0, `${name}\n${result.stderr}\n${result.stdout}`);
      const packet = JSON.parse(result.stdout);
      const starts = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.event === 'start');
      const verbs = ['clone', 'fetch', 'worktree', 'checkout', 'ls-remote', 'push', 'status'];
      const commands = Object.fromEntries(verbs.map(verb => [verb, starts.filter(event => event.argv?.includes(verb)).length]));
      // Remote execution deliberately strips Git trace variables. Use SFlow's own counters for
      // those commands rather than reporting misleading zero network/clone counts from trace2.
      const timing = result.stderr.split('\n').find(line => line.startsWith('[sflow timing]')) ?? '';
      const counter = key => Number(new RegExp(`(?:^| )${key.replaceAll('.', '\\.') }=(\\d+)(?: |$)`, 'u').exec(timing)?.[1] ?? 0);
      for (const verb of ['clone', 'fetch', 'ls-remote', 'push']) commands[verb] = Math.max(commands[verb], counter(`git.remote.command.${verb}`));
      const payload = packet.data ?? packet;
      const dx = path.join(f.original, '.git/singularity-flow/dx');
      const events = (await readFile(path.join(dx, 'timings.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      const detail = events.findLast(event => event.event === 'dx.command-timing' && event.command === args[0]);
      assert.ok(detail?.telemetryComplete, 'retain the complete command stage timings, not only totals');
      const processes = (await readFile(counts, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
      const remoteCommands = Object.fromEntries(['clone', 'fetch', 'ls-remote', 'push'].map(verb =>
        [verb, counter(`git.remote.command.${verb}`)]));
      for (const verb of verbs) commands[verb] = Math.max(commands[verb],
        processes.reduce((sum, entry) => sum + (entry.counts?.[verb] ?? 0), 0));
      const performanceDirectory = path.join(dx, 'performance');
      const performanceFiles = await readdir(performanceDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const performanceFile = performanceFiles.find(file => file === `${detail.invocationId}.json`);
      const performanceTrace = performanceFile
        ? JSON.parse(await readFile(path.join(performanceDirectory, performanceFile), 'utf8')) : null;
      const sharesWorkspaceObjects = name.startsWith('start')
        ? await realpath(f.git(payload.repositoryPath, 'rev-parse', '--git-common-dir')) === await realpath(path.join(f.original, '.git')) : null;
      rows.push({ name, ms, gitProcesses: counter('git.spawns'), tracedGitProcessesIncludingChildren: starts.length, commands,
        nodeGitProcesses: processes.reduce((sum, entry) => sum + Object.values(entry.counts ?? {}).reduce((a, b) => a + b, 0), 0),
        workspaceBranchClones: /workspace\.(?:repositories-reused|branch-clones)=/u.test(timing) ? counter('workspace.branch-clones') : null,
        preflightApplicationFetches: counter('git.remote-fetch'), sharesWorkspaceObjects,
        cache: packet.readinessSnapshot?.source ?? null,
        timing: detail, processes, remoteCommands, performanceTrace, hostOutsideCommandMs: Math.max(0, ms - detail.durationMs) });
      return packet;
    };
    await invoke('catalog-cold', ['workspace', 'branches', '--intake']);
    const preview = id => ['workspace', 'branches', '--intake', '--preflight-story', id, '--from-branch', 'main',
      '--work-type', 'feature', '--selected-base-only', '--mint-intake-receipt'];
    const start = (id, packet) => ['start', id, '--from-branch', 'main', '--isolated-worktree', '--work-type', 'feature',
      '--title', 'Direct worktree qualification', '--description', 'Verify object reuse without changing the launch checkout',
      ...(packet.preflight?.intakeReceipt?.issued ? ['--intake-receipt', packet.preflight.intakeReceipt.id] : [])];
    await invoke('preview-cold', preview('PERF-READY'));
    const cold = await invoke('preview-cache', preview('PERF-READY'));
    await invoke('start-cold', start('PERF-READY', cold));
    const warm = await invoke('preview-next-story', preview('PERF-WARM'));
    await invoke('start-warm', start('PERF-WARM', warm));
    assert.equal(f.git(f.original, 'rev-parse', 'HEAD'), head);
    assert.equal(f.git(f.original, 'branch', '--show-current'), branch);
    assert.equal(await readFile(path.join(f.original, 'operator-draft.txt'), 'utf8'), 'retain unrelated local work\n');
    return { platform: process.platform, node: process.version, files,
      scope: 'Disposable local bare Git remote; fresh Node processes. Cold = first SFlow invocation/action, not flushed OS or network caches. Git counts include child processes and configuration/ledger operations.',
      originalPreserved: true, rows };
  } finally { await f.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = key => { const index = process.argv.indexOf(key); return index < 0 ? undefined : process.argv[index + 1]; };
  const result = await benchmarkDirectStoryWorktree({ files: Number(value('--files') ?? 10000), cliRoot: value('--cli-root') ?? packageRoot });
  if (value('--output')) await writeFile(path.resolve(value('--output')), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(value('--output') ? { ...result, rows: result.rows.map(
    ({ timing, processes, performanceTrace, ...row }) => ({ ...row,
      stages: timing.stages, spans: timing.spans, gitCounts: processes.map(process => process.counts) })) } : result, null, 2));
}
