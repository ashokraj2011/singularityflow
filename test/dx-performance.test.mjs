import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { evaluateLatency, summarizeSamples } from '../src/dx-performance.mjs';
import { commandTimer, commandTimingDirectory, recordCommandTiming } from '../src/dx-command-timing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'benchmarks/dx/reference-fixture.json'), 'utf8'));

test('DX benchmark protocol is reproducible and carries the release budgets', () => {
  assert.equal(manifest.protocol.warmupRuns, 1);
  assert.ok(manifest.protocol.samples >= 30);
  assert.equal(manifest.protocol.network, 'disabled');
  assert.equal(manifest.protocol.modelCalls, 'disabled');
  assert.deepEqual(manifest.budgets.snapshot, { p50Ms: 150, p95Ms: 250 });
  /**
   * A ceiling, not a target — and deliberately pinned so it can only be lowered on purpose.
   *
   * `snapshot --json` measured 667 ms p50 against the sliced read's 122 ms on the same fixture and
   * machine. That gap is the legacy module graph and the redundant preamble it re-runs, and closing
   * it is what lowers this number. Until then the budget records what is true rather than what
   * would be nice, because a budget nothing meets is a budget everyone learns to ignore.
   */
  assert.deepEqual(manifest.budgets.snapshotFull, { p50Ms: 850, p95Ms: 1100 });
  assert.equal(manifest.topology.trackedFiles, 500);
  assert.equal(manifest.topology.localSubjectIndex, 'absent');
});

test('latency summaries and the 20-percent baseline gate are deterministic', () => {
  const summary = summarizeSamples([10, 20, 30, 40, 50]);
  assert.equal(summary.p50Ms, 30);
  assert.equal(summary.p95Ms, 50);
  assert.deepEqual(evaluateLatency('about', summary, { p50Ms: 35 }, { p50Ms: 20 }), [
    'about p50 regressed by more than 20% from 20.0ms'
  ]);
});

test('latency-budgets-on-fixture', { timeout: 30_000 }, () => {
  // This test validates the real fixture and harness. Absolute latency enforcement is intentionally
  // a separate, serial benchmark job (`npm run benchmark:dx:enforce`): node:test executes files in
  // parallel, where unrelated CPU-heavy integration tests would turn scheduler contention into a
  // product regression.
  const run = spawnSync(process.execPath, ['scripts/dx-benchmark.mjs', '--samples=3', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.protocol.samples, 3);
  assert.equal(report.topology.trackedFiles, manifest.topology.trackedFiles);
  assert.deepEqual(Object.keys(report.commands), ['about', 'status', 'nextsteps', 'snapshot', 'snapshotFull']);
  for (const result of Object.values(report.commands)) {
    assert.equal(result.samples, 3);
    assert.ok(result.p50Ms > 0);
    assert.ok(result.p95Ms >= result.p50Ms);
  }
});

test('the benchmark measures the snapshot the extension actually asks for', async () => {
  /**
   * The benchmarked `snapshot` was `--include repository`, a shape nothing in the product sends.
   * The extension sends `snapshot --json`, which took a different and far slower route through
   * `src/cli.mjs`, and no budget covered it — so the fast path met its target while the real path
   * was free to drift. Both sides are asserted here, because a guard that watches only one of them
   * passes happily the day the other moves.
   */
  const client = await readFile(path.join(root, 'apps/vscode/src/cli/client.ts'), 'utf8');
  assert.match(client, /invoke<RepositorySnapshot>\(\['snapshot', '--json'\]/,
    'the extension no longer sends `snapshot --json`; update the benchmarked command to match it');

  const benchmark = await readFile(path.join(root, 'scripts/dx-benchmark.mjs'), 'utf8');
  assert.match(benchmark, /snapshotFull: \['snapshot', '--json'\]/,
    'the benchmark no longer measures the invocation the extension sends');

  // And the fixture has to be loadable by that invocation. A `version: 2` stub satisfies the sliced
  // read, which never parses the definition, and is refused by everything else.
  assert.match(benchmark, /workTypes:/, 'the reference fixture must carry a definition the engine will load');
});

test('fast commands do not statically import unrelated heavyweight domains', async () => {
  const forbidden = /(?:jira|visual|initiative|workspace|worldmodel|model-provider|storage-provider|sharepoint|agents)\.mjs$/;
  const entrypoints = ['src/commands/about.mjs', 'src/commands/status.mjs', 'src/commands/nextsteps.mjs'];
  const visited = new Set();
  async function walk(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    const source = await readFile(path.join(root, relative), 'utf8');
    const directory = path.posix.dirname(relative);
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) {
      const candidate = path.posix.normalize(path.posix.join(directory, match[1]));
      const dependency = path.posix.extname(candidate) ? candidate : `${candidate}.mjs`;
      assert.doesNotMatch(dependency, forbidden, `${relative} eagerly reaches ${dependency}`);
      await walk(dependency);
    }
  }
  for (const entrypoint of entrypoints) await walk(entrypoint);
});

test('--timings exposes root dispatch, module load, and execution without changing stdout', () => {
  const run = spawnSync(process.execPath, ['bin/singularity-flow.mjs', 'about', '--timings'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Singularity Flow 0\.9\.0/);
  assert.match(run.stderr, /root-dispatch=.*module-load=.*execute=/);
});

test('command timing events use the privacy-safe versioned envelope', () => {
  const timer = commandTimer('status', { commandClass: 'read' });
  timer.stage('resolve');
  const event = timer.finish({ outcome: 'cancelled', fallback: 'cached-snapshot' });
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.event, 'dx.command-timing');
  assert.equal(event.commandClass, 'read');
  assert.equal(event.command, 'status');
  assert.equal(event.outcome, 'cancelled');
  assert.equal(event.fallback, 'cached-snapshot');
  assert.equal(typeof event.stages.resolve, 'number');
  assert.ok(Date.parse(event.startedAt));
  assert.doesNotMatch(JSON.stringify(event), /argv|argument|token|password|secret/i);
});

test('machine-local timing logs rotate and use private permissions', async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-timing-'));
  const previous = process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES;
  const previousRetention = process.env.SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS;
  try {
    const initialized = spawnSync('git', ['init', '-q'], { cwd: repository, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES = '1';
    const event = commandTimer('about', { commandClass: 'read' }).finish();
    await recordCommandTiming(repository, event);
    await recordCommandTiming(repository, event);
    const directory = commandTimingDirectory(repository);
    const files = await readdir(directory);
    assert.ok(files.includes('timings.jsonl'));
    assert.ok(files.some((file) => /^timings-.*\.jsonl$/.test(file)), 'the full log was rotated');
    const mode = (await stat(path.join(directory, 'timings.jsonl'))).mode & 0o777;
    assert.equal(mode, 0o600);
    const stored = JSON.parse((await readFile(path.join(directory, 'timings.jsonl'), 'utf8')).trim());
    assert.equal(stored.event, 'dx.command-timing');

    const rotated = files.find((file) => /^timings-.*\.jsonl$/.test(file));
    const old = new Date(Date.now() - (3 * 24 * 60 * 60 * 1000));
    await utimes(path.join(directory, rotated), old, old);
    process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES = '999999';
    process.env.SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS = '1';
    await recordCommandTiming(repository, event);
    assert.equal((await readdir(directory)).includes(rotated), false, 'expired rotated logs are removed');
  } finally {
    if (previous == null) delete process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES;
    else process.env.SINGULARITY_FLOW_DX_TIMING_MAX_BYTES = previous;
    if (previousRetention == null) delete process.env.SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS;
    else process.env.SINGULARITY_FLOW_DX_TIMING_RETENTION_DAYS = previousRetention;
    await rm(repository, { recursive: true, force: true });
  }
});

test('an accepted baseline cannot be written from the wrong runtime', () => {
  const target = manifest.runtime;
  const matches = target.nodeMajor === Number(process.versions.node.split('.')[0])
    && target.platform === process.platform && target.architecture === process.arch;
  if (matches) return;
  const run = spawnSync(process.execPath, ['scripts/dx-benchmark.mjs', '--write-baseline'], {
    cwd: root, encoding: 'utf8'
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--write-baseline is restricted/);
});

test('baseline report import validates runtime, protocol, topology, and outcome', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-baseline-'));
  try {
    const candidate = path.join(directory, 'candidate.json');
    await writeFile(candidate, JSON.stringify({
      runtime: { nodeMajor: 99, platform: 'linux', architecture: 'x64' },
      protocol: manifest.protocol, topology: manifest.topology, commands: {}, failures: [], passed: true
    }));
    const run = spawnSync(process.execPath, ['scripts/dx-benchmark.mjs', `--accept-report=${candidate}`], {
      cwd: root, encoding: 'utf8'
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /nodeMajor is 99/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the read model does not shell out to the network, or ask git the same question twice', async () => {
  /**
   * `snapshot --json` is what the VS Code extension calls on every one of its 25 refresh triggers,
   * and it took **1.8 s**: 80 subprocesses, 1376 ms of them, on a three-file repository.
   *
   * Two findings, both invisible from the call sites:
   *
   * - 876 ms — 64% of all subprocess time — went on `gh auth status` and `gh api user`, two
   *   ~450 ms network calls resolving *the same GitHub username*. `identities.git.login` and
   *   `identities.github` were the same string, fetched twice.
   * - `git rev-parse` ran 30 times, 20 of them re-asking where the repository and its Git
   *   directory are — values that cannot change while a process runs.
   *
   * This asserts the shape of the fix rather than a duration, because a timing assertion on a
   * loaded CI box is a flake. `SINGULARITY_FLOW_SUBPROCESS_PROBE` (src/util.mjs) prints the real
   * per-command breakdown when a number is wanted.
   */
  const editor = await readFile(path.join(root, 'src/editor.mjs'), 'utf8');
  assert.doesNotMatch(editor, /'gh',\s*\[\s*'auth',\s*'status'/,
    'the read model resolves the GitHub login a second way; identity() already returns it');

  const git = await readFile(path.join(root, 'src/git.mjs'), 'utf8');
  assert.match(git, /repoRootCache\.has\(cwd\)/, 'repoRoot() re-asks git where the repository is');
  assert.match(git, /gitDirCache\.has\(root\)/, 'gitDir() re-asks git where the Git directory is');
  assert.match(git, /GITHUB_ACCOUNT_TTL_MS/, 'the gh account lookup is not cached across processes');

  /**
   * The two memos that must NOT exist, each guarding a correctness property rather than a
   * preference. `head` and `branch` change mid-process — the write paths read them before and
   * after committing — so caching either makes a publication report the commit it replaced.
   *
   * `identity()` is the sharper one. Memoizing it was tried, and two independent authorization
   * tests failed: one-time action authorization stopped detecting a transfer to a different local
   * identity, and an unauthorized Git email stopped being refused. A caching bug there is an
   * authorization bug. The expense was never the git-config reads; it was `gh`, cached above.
   */
  assert.doesNotMatch(git, /headCache|branchCache|identityCache/,
    'a value that changes mid-process is memoized; see the note in git.mjs on why that is unsafe');
});

test('a read may reuse one parsed definition; a write may never be handed a stale one', async () => {
  /**
   * `loadDefinition` runs a realpath walk, a YAML parse, three agent-directory scans and a sha256
   * of every agent file — and one `snapshot --json` called it **seven times** for the same
   * unchanged file. Inside `withDefinitionCache` it parses once.
   *
   * Opt-in is the whole design, and it is the same lesson as `identity()`: `bootstrap` self-heals a
   * repository by writing `workflow.yml` and reading it back, so a process-wide memo would hand the
   * repair its own pre-repair definition and make the fix look like it never happened. Writers do
   * not open the scope, so a cache they never entered cannot affect them.
   */
  const { loadDefinition, withDefinitionCache } = await import('../src/config.mjs');
  const { initializeDefinition } = await import('../src/config.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-defcache-'));
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: directory });
  await initializeDefinition(directory);

  // Inside the scope, the same object is handed back rather than re-parsed.
  const [first, second] = await withDefinitionCache(async () => [
    await loadDefinition(directory), await loadDefinition(directory)
  ]);
  assert.equal(first, second, 'the scope re-parsed a definition it had already read');

  // Outside it, every read is fresh — this is what keeps a writer honest.
  const third = await loadDefinition(directory);
  assert.notEqual(third, first, 'a definition was cached beyond the scope that opened it');

  // And a change made between two scopes is seen, which is the bootstrap self-heal case.
  const workflow = path.join(directory, 'singularity/workflow.yml');
  await writeFile(workflow, `${await readFile(workflow, 'utf8')}\n`);
  const reloaded = await withDefinitionCache(() => loadDefinition(directory));
  assert.notEqual(reloaded, first, 'a new scope reused a definition parsed before the file changed');

  await rm(directory, { recursive: true, force: true });
});

test('every test that loads TypeScript runs with type stripping, whatever suite it is in', async () => {
  /**
   * The runner used one string test — does the source contain `apps/vscode` — to answer both
   * "which suite is this?" and "does it need `--experimental-strip-types`?". Twenty files needed
   * the flag and only some of them said `apps/vscode`, because the rest build that path as
   * `path.join(root, 'apps', 'vscode', …)`. They ran without it and failed with
   * `ERR_UNKNOWN_FILE_EXTENSION`, so `npm run test:cli` was red on its own while `test:all` stayed
   * green — a *different* selected file happened to switch the flag on for the whole run.
   *
   * This asserts the runner still asks the two questions separately. It reads the script rather
   * than the behaviour because the failure is a coupling, and a coupling is visible in the source
   * and invisible in a passing run.
   */
  const runner = await readFile(path.join(root, 'scripts', 'run-test-suite.mjs'), 'utf8');
  assert.match(runner, /function needsTypeStripping\(source\)/,
    'the runner decides type stripping from what a file loads');
  assert.match(runner, /const stripping = needsTypeStripping\(source\);/,
    'and asks it of every selected file');
  assert.doesNotMatch(runner, /if \(kind === 'vscode'\) needsStripping = true;/,
    'the flag must not depend on which suite a file was sorted into');
});
