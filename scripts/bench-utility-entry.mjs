#!/usr/bin/env node
/** Disposable, installed-bundle utility qualification. No provider, user Story or remote writes. */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { buildCliBundle } from './build-cli-bundle.mjs';

const baselineRoot = process.argv[2] && path.resolve(process.argv[2]);
if (!baselineRoot) throw new Error('Usage: node scripts/bench-utility-entry.mjs <BASELINE-CHECKOUT> [RESULT.json]');
const fixture = await createWarmReadFixture({ files: 1000, branches: 20 });
const report = { schemaVersion: 1, platform: process.platform, node: process.version,
  fixture: { files: 1000, branches: 20, catalogs: 'full installed seeded defaults',
    runtime: 'stamped installed cold bundle', cache: 'empty private V8 cache per variant, then three fresh processes; OS cache not flushed',
    modelCalls: 0, configuredRemotes: 0, note: 'Synthetic CLI benchmark, not a native Copilot conversation.' }, commands: [] };
const variants = [{ id: 'before', root: path.join(fixture.directory, 'baseline') }, { id: 'after', root: fixture.engine }];
const cases = [
  ['status', ['status', 'PERF-001']], ['progress', ['progress', 'PERF-001']],
  ['nextsteps', ['nextsteps', 'PERF-001']],
  ['phase-show', ['phase', 'show', 'intake']],
  ['inputs-preview', ['inputs', 'intake', '--dry-run']], ['report', ['report', 'PERF-001', '--format', 'json']],
  ['workflow-list', ['workflow', 'list']], ['agents-list', ['agents', 'list']],
  ['skill-list', ['skill', 'list']], ['instruction-list', ['instruction', 'list']]
];
try {
  await mkdir(variants[0].root);
  for (const name of ['src', 'bin', 'templates', 'plugin', 'schemas', 'package.json', 'scripts',
    'distribution', 'docs', 'revision-trace-manifest.json']) {
    await cp(path.join(baselineRoot, name), path.join(variants[0].root, name), { recursive: true });
  }
  await symlink(path.join(fixture.engine, 'node_modules'), path.join(variants[0].root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const stamp = path.join(variants[0].root, 'src/build-info.mjs');
  await writeFile(stamp, (await readFile(stamp, 'utf8')).replace('commit: null', `commit: '${'2'.repeat(40)}'`));
  for (const variant of variants) variant.bundle = (await buildCliBundle({ root: variant.root })).outdir;
  const catalog = path.join(fixture.directory, 'seeded');
  await mkdir(catalog);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Utility Tester'],
    ['config', 'user.email', 'utility@example.invalid']]) fixture.git(args, { cwd: catalog });
  const common = { ...fixture.env, SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full' };
  delete common.NODE_DISABLE_COMPILE_CACHE;
  delete common.SINGULARITY_FLOW_GIT_FACT_STORE;
  function run(variant, args, cwd, cache) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [path.join(variant.root, 'bin/singularity-flow.mjs'), ...args], {
      cwd, env: { ...common, SINGULARITY_FLOW_BUNDLE_DIR: variant.bundle, NODE_COMPILE_CACHE: cache },
      encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(`${variant.id} ${args.join(' ')}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    return { ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(result.stdout),
      stdout: result.stdout };
  }
  run(variants[0], ['init'], catalog, path.join(fixture.directory, 'init-cache'));
  fixture.git(['add', '.'], { cwd: catalog });
  fixture.git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'seeded catalog'], { cwd: catalog });
  for (const [name, args] of cases) {
    const cwd = name.endsWith('list') ? catalog : fixture.repository;
    for (const variant of variants) {
      const cache = path.join(fixture.directory, 'cache', name, variant.id);
      const runs = [];
      for (let iteration = 0; iteration < 4; iteration++) {
        const pause = variant.id === 'before' ? run(variant, ['pause', 'status', '--json'], cwd, cache) : null;
        const read = run(variant, [...args, ...(variant.id === 'after' ? ['--utility-entry'] : []), '--for-agent', '--json'], cwd, cache);
        let value;
        try { value = JSON.parse(read.stdout); } catch { /* Legacy agents list is text even with --json. */ }
        if (variant.id === 'after' && (value?.resultType !== 'sflow-utility-entry' || !value.readCompleted)) {
          throw new Error(`${name} did not return a completed utility read`);
        }
        let timing = null;
        try {
          const lines = (await readFile(path.join(cwd, '.git/singularity-flow/dx/timings.jsonl'), 'utf8')).trim().split('\n');
          timing = lines.map(line => JSON.parse(line)).findLast(item => item.event === 'dx.command-timing' && item.command === args[0]);
        } catch { /* Timing absence remains unavailable. */ }
        runs.push({ iteration, totalMs: read.ms + (pause?.ms ?? 0), readMs: read.ms,
          pauseMs: pause?.ms ?? 0, bytes: read.bytes, counters: timing?.counters ?? null,
          stages: timing?.stages ?? null });
      }
      const row = { name, variant: variant.id, first: runs[0],
        subsequentMedianMs: runs.slice(1).map(item => item.totalMs).sort((a, b) => a - b)[1], runs };
      report.commands.push(row);
      console.error(JSON.stringify({ name, variant: variant.id, firstMs: row.first.totalMs, subsequentMedianMs: row.subsequentMedianMs }));
    }
  }
  const rendered = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[3]) await writeFile(path.resolve(process.argv[3]), rendered);
  else process.stdout.write(rendered);
} finally { await fixture.cleanup(); }
