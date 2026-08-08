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
  assert.deepEqual(Object.keys(report.commands), ['about', 'status', 'nextsteps', 'snapshot']);
  for (const result of Object.values(report.commands)) {
    assert.equal(result.samples, 3);
    assert.ok(result.p50Ms > 0);
    assert.ok(result.p95Ms >= result.p50Ms);
  }
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
