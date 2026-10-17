#!/usr/bin/env node
/** Disposable, installed-bundle utility qualification. No provider, user Story or remote writes. */
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { buildCliBundle } from './build-cli-bundle.mjs';

const arguments_ = process.argv.slice(2);
const combinedBaseline = arguments_.includes('--combined-baseline');
const prewarm = arguments_.includes('--prewarm');
const sampleOption = arguments_.find(value => value.startsWith('--samples='));
const outputOption = arguments_.find(value => value.startsWith('--agent-output='));
const outputMode = outputOption?.slice('--agent-output='.length) ?? 'full';
const samples = sampleOption ? Number(sampleOption.slice('--samples='.length)) : 1;
const positional = arguments_.filter(value => !value.startsWith('--'));
if (!Number.isInteger(samples) || samples < 1 || samples > 5 || positional.length > 2
    || !['full', 'bounded'].includes(outputMode)
    || arguments_.some(value => value.startsWith('--') && !['--combined-baseline', '--prewarm', sampleOption, outputOption].includes(value))) {
  throw new Error('Unsupported benchmark option or sample count (1–5).');
}
const baselineRoot = positional[0] && path.resolve(positional[0]);
if (!baselineRoot) throw new Error('Usage: node scripts/bench-utility-entry.mjs <BASELINE-CHECKOUT> [RESULT.json] [--combined-baseline] [--prewarm] [--samples=3] [--agent-output=full|bounded]');
const fixture = await createWarmReadFixture({ files: 1000, branches: 20 });
const report = { schemaVersion: 1, platform: process.platform, node: process.version,
  fixture: { files: 1000, branches: 20, catalogs: 'full installed seeded defaults',
    runtime: 'stamped installed cold bundle', cache: 'empty private V8 cache per variant, then three fresh processes; OS cache not flushed',
    modelCalls: 0, configuredRemotes: 0, baselineEntry: combinedBaseline ? 'combined utility read' : 'pause plus utility read',
    samples, output: outputMode, listingTask: 'Read all catalog IDs/names; required expansion files are read and counted, not modeled as native Copilot tool latency.',
    variantOrder: 'alternating before/after order per sample',
    prewarm: prewarm ? 'both variants prepared before timing; warmup reported separately' : 'none',
    note: 'Synthetic CLI benchmark, not a native Copilot conversation.' }, commands: [] };
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
  for (const variant of variants) {
    const built = await buildCliBundle({ root: variant.root });
    variant.bundle = built.outdir;
    report[variant.id + 'Bundle'] = built.manifest.outputs;
  }
  const catalog = path.join(fixture.directory, 'seeded');
  await mkdir(catalog);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Utility Tester'],
    ['config', 'user.email', 'utility@example.invalid']]) fixture.git(args, { cwd: catalog });
  const common = { ...fixture.env, SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '0',
    SINGULARITY_FLOW_AGENT_OUTPUT: outputMode, SINGULARITY_FLOW_AGENT_OUTPUT_BYTES: '7500' };
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
    const rows = new Map(variants.map(variant => [variant.id, { name, variant: variant.id, runs: [], warmups: [] }]));
    for (let sample = 0; sample < samples; sample++) {
      for (const variant of sample % 2 ? [...variants].reverse() : variants) {
        const cache = path.join(fixture.directory, 'cache', name, variant.id, String(sample));
        const row = rows.get(variant.id);
        if (prewarm) {
          const warmed = run(variant, ['--warm-runtime'], fixture.directory, cache);
          if (!JSON.parse(warmed.stdout).prepared) throw new Error('Prewarm unavailable: do not label this sample as prewarmed.');
          row.warmups.push({ sample, ms: warmed.ms });
        }
        for (let iteration = 0; iteration < 4; iteration++) {
          const combined = combinedBaseline || variant.id === 'after';
          const pause = combined ? null : run(variant, ['pause', 'status', '--json'], cwd, cache);
          const read = run(variant, [...args, ...(combined ? ['--utility-entry'] : []), '--for-agent', '--json'], cwd, cache);
          let value;
          try { value = JSON.parse(read.stdout); } catch { /* Legacy agents list is text even with --json. */ }
          if (combined && (value?.resultType !== 'sflow-utility-entry' || !value.readCompleted)) {
            throw new Error(`${name} did not return a completed utility read`);
          }
          let listingTask = null;
          if (name.endsWith('-list')) {
            const rowsOf = packet => {
              let data = packet?.data ?? packet;
              if (data?.resultType === 'sflow-result') data = data.data;
              return name === 'workflow-list' ? data : data?.agents ?? data?.skills ?? data?.instructions;
            };
            const inline = rowsOf(value);
            listingTask = { inlineRows: Array.isArray(inline) ? inline.length : 0, fileReads: 0, bytesRead: read.bytes };
            if ((!Array.isArray(inline) || value?.catalogView?.more) && value?.agentOutput?.path) {
              const full = await readFile(value.agentOutput.path, 'utf8');
              listingTask.fileReads++;
              listingTask.bytesRead += Buffer.byteLength(full);
              listingTask.totalRows = rowsOf(JSON.parse(full))?.length ?? null;
            } else listingTask.totalRows = Array.isArray(inline) ? inline.length : null;
          }
          let timing = null;
          try {
            const lines = (await readFile(path.join(cwd, '.git/singularity-flow/dx/timings.jsonl'), 'utf8')).trim().split('\n');
            timing = lines.map(line => JSON.parse(line)).findLast(item => item.event === 'dx.command-timing' && item.command === args[0]);
          } catch { /* Timing absence remains unavailable. */ }
          row.runs.push({ sample, iteration, totalMs: read.ms + (pause?.ms ?? 0), readMs: read.ms,
            pauseMs: pause?.ms ?? 0, bytes: read.bytes, counters: timing?.counters ?? null,
            stages: timing?.stages ?? null, listingTask });
        }
      }
    }
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const row of rows.values()) {
      row.first = row.runs[0];
      row.firstMedianMs = median(row.runs.filter(item => item.iteration === 0).map(item => item.totalMs));
      row.subsequentMedianMs = median(row.runs.filter(item => item.iteration > 0).map(item => item.totalMs));
      report.commands.push(row);
      console.error(JSON.stringify({ name, variant: row.variant, firstMs: row.firstMedianMs, subsequentMedianMs: row.subsequentMedianMs }));
    }
  }
  const rendered = JSON.stringify(report, null, 2) + '\n';
  if (positional[1]) await writeFile(path.resolve(positional[1]), rendered);
  else process.stdout.write(rendered);
} finally { await fixture.cleanup(); }
