#!/usr/bin/env node
/** Paired native-process/owned-worker qualification. No models, user Stories or remote writes. */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWarmReadFixture } from './warm-read-fixture.mjs';

const baseline = path.resolve(process.argv[2]), output = process.argv[3];
const storyMode = process.argv.find(arg => arg.startsWith('--story-mode='))?.split('=')[1] ?? 'legacy';
const samples = Number(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] ?? 3);
const historyCommits = Number(process.argv.find(arg => arg.startsWith('--history-commits='))?.split('=')[1] ?? 0);
const artifacts = Number(process.argv.find(arg => arg.startsWith('--artifacts='))?.split('=')[1] ?? 0);
if (!process.argv[2] || !output || !['legacy', 'pinned', 'amended'].includes(storyMode)
    || !Number.isSafeInteger(samples) || samples < 1 || samples > 5) throw new Error('Use <BASELINE> <RESULT.json> [--story-mode=legacy|pinned] [--samples=3].');
const f = await createWarmReadFixture({ files: 1000, branches: 20, storyMode, historyCommits, artifacts });
const variants = [{ id: 'before', root: path.join(f.directory, 'baseline') }, { id: 'after', root: f.engine }];
const cases = { status: ['status', f.workId, '--json'], progress: ['progress', f.workId, '--json'],
  report: ['report', f.workId, '--format', 'json', '--json'], nextsteps: ['nextsteps', f.workId, '--json'] };
const elapsed = async fn => { const started = performance.now(); const value = await fn(); return { ms: Math.round(performance.now() - started), value }; };
const comparable = value => { const copy = structuredClone(value); delete copy.generatedAt; return copy; };
const report = { schemaVersion: 1, platform: process.platform, node: process.version,
  protocol: { samples, files: 1000, unrelatedBranches: 20, storyMode, pinnedVerification: f.pinnedVerification,
    historyCommits, totalCommits: f.totalCommits, extraArtifacts: artifacts,
    output: 'full canonical JSON; no presentation cache', first: 'fresh worker and private bytecode cache',
    prepared: 'both builds get bytecode warmup; an available definition-only worker-preparation API is invoked before timing',
    cache: 'Git fact persistence disabled; OS cache not flushed', modelCalls: 0, configuredRemotes: 0,
    limitations: 'Direct owned-adapter invocation, not native Copilot hooks, PowerShell/.cmd or full VS Code activation.' }, rows: [] };
try {
  await mkdir(variants[0].root);
  for (const name of ['src', 'bin', 'templates', 'plugin', 'schemas', 'package.json', 'scripts', 'distribution', 'docs', 'revision-trace-manifest.json']) {
    await cp(path.join(baseline, name), path.join(variants[0].root, name), { recursive: true });
  }
  await symlink(path.join(f.engine, 'node_modules'), path.join(variants[0].root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const stamp = path.join(variants[0].root, 'src/build-info.mjs');
  await writeFile(stamp, (await readFile(stamp, 'utf8')).replace('commit: null', `commit: '${'2'.repeat(40)}'`));
  for (const variant of variants) {
    const { buildCliBundle } = await import(pathToFileURL(path.join(variant.root, 'scripts/build-cli-bundle.mjs')).href);
    const built = await buildCliBundle({ root: variant.root });
    report[variant.id + 'Bundle'] = built.manifest.outputs;
    report[variant.id + 'PartitionerSha256'] = createHash('sha256')
      .update(await readFile(path.join(variant.root, 'scripts/build-cold-cli-bundle.mjs'))).digest('hex');
    variant.cli = path.join(variant.root, 'bin/singularity-flow.mjs');
    variant.adapter = await import(pathToFileURL(path.join(variant.root, 'src/read-worker-client.mjs')));
  }
  function cli(variant, args, env, cwd = f.repository) {
    const result = spawnSync(process.execPath, [variant.cli, ...args], { cwd, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${variant.id}: ${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  }
  for (const [name, args] of Object.entries(cases)) for (const prepared of [false, true]) for (let sample = 0; sample < samples; sample++) {
    let expected = null;
    for (const variant of sample % 2 ? [...variants].reverse() : variants) {
      variant.adapter.disposeReadWorkers();
      const env = { ...f.env, SINGULARITY_FLOW_BUNDLE: 'on',
        NODE_COMPILE_CACHE: path.join(f.directory, 'cache', name, String(prepared), String(sample), variant.id) };
      delete env.NODE_DISABLE_COMPILE_CACHE;
      const options = { executable: process.execPath, cli: variant.cli, repository: f.repository, env };
      let bytecodeWarmupMs = null, workerWarmupMs = null, preparation = 'none';
      if (prepared) {
        const warm = await elapsed(() => cli(variant, ['--warm-runtime'], env, f.directory));
        if (!warm.value.prepared) throw new Error('Bytecode preparation unavailable.');
        bytecodeWarmupMs = warm.ms; preparation = 'bytecode-only';
        if (variant.adapter.prewarmReadWorker) {
          const owned = await elapsed(() => variant.adapter.prewarmReadWorker(options));
          if (owned.value.status !== 'prepared') throw new Error('Worker preparation unavailable.');
          workerWarmupMs = owned.ms; preparation = 'bytecode-and-owned-definitions';
        }
      }
      const invoke = async () => {
        const worker = await variant.adapter.readWithWorker({ ...options, args });
        return worker ?? { kind: 'value', value: cli(variant, args, env), transport: 'cli-fallback' };
      };
      const first = await elapsed(invoke), repeats = [];
      if (expected == null) expected = comparable(first.value.value);
      else if (!isDeepStrictEqual(expected, comparable(first.value.value))) throw new Error(`${name}: before/after canonical values differ.`);
      for (let index = 0; index < 3; index++) {
        const repeated = await elapsed(invoke);
        if (!isDeepStrictEqual(expected, comparable(repeated.value.value))) throw new Error(`${name}: repeat value changed.`);
        repeats.push({ ms: repeated.ms, transport: repeated.value.transport });
      }
      report.rows.push({ name, variant: variant.id, prepared, sample, preparation, bytecodeWarmupMs, workerWarmupMs,
        firstMs: first.ms, firstTransport: first.value.transport, repeats });
      variant.adapter.disposeReadWorkers();
    }
  }
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ platform: process.platform, storyMode, rows: report.rows.length, output }));
} finally { for (const variant of variants) variant.adapter?.disposeReadWorkers(); await f.cleanup(); }
