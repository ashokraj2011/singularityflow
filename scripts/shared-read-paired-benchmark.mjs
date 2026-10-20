#!/usr/bin/env node
/** Alternating installed-engine comparison. Fixtures and local clones only; never a user Story. */
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliBundle } from './build-cli-bundle.mjs';
import { createWarmReadFixture } from './warm-read-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const samples = Number(option('samples', '4'));
const baseline = option('baseline-engine');
const profiles = option('profiles', 'legacy,pinned,amended').split(',');
const output = option('output');
if (!baseline || !path.isAbsolute(baseline) || !Number.isSafeInteger(samples) || samples < 2 || samples > 8 || samples % 2
    || profiles.some(value => !['legacy', 'pinned', 'amended'].includes(value)) || new Set(profiles).size !== profiles.length) {
  throw new Error('Use --baseline-engine=<absolute-checkout> --samples=<even 2..8> --profiles=legacy,pinned,amended.');
}
for (const source of [root, baseline]) {
  if (JSON.parse(await readFile(path.join(source, 'package.json'))).name !== 'singularity-flow') throw new Error('Expected an SFlow engine.');
}
const fixtures = [];
const keep = async options => { const f = await createWarmReadFixture(options); fixtures.push(f); return f; };
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const summary = values => ({ samples: values.length, medianMs: median(values), minMs: Math.min(...values), maxMs: Math.max(...values) });
function identity(source) {
  const invoke = args => spawnSync('git', args, { cwd: source, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const head = invoke(['rev-parse', 'HEAD']), status = invoke(['status', '--porcelain=v1', '--untracked-files=all']);
  if (head.status !== 0 || status.status !== 0) throw new Error('Cannot identify benchmark source.');
  return { commit: head.stdout.trim(), dirty: status.stdout.length > 0 };
}
function semantic(value) {
  return { ...Object.fromEntries(['resultType', 'ready', 'workId', 'phase', 'currentPhase', 'status', 'branch', 'head', 'activeAgent', 'selectionStatus']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]])),
    ...(value.work?.id ? { workId: value.work.id } : {}) };
}
function observation(cli, args, repository, env, cache, allowKnownRefusal = false) {
  const environment = { ...env, SINGULARITY_FLOW_BUNDLE: 'on', NODE_COMPILE_CACHE: cache,
    SINGULARITY_FLOW_AGENT_OUTPUT: 'raw', SINGULARITY_FLOW_PERF_TRACE: '0' };
  delete environment.NODE_DISABLE_COMPILE_CACHE;
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args, '--timings'], {
    cwd: repository, env: environment, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024
  });
  const durationMs = performance.now() - started;
  let value;
  try { value = JSON.parse(result.stdout); } catch { /* Preserve the bounded native diagnostic below. */ }
  const knownRefusal = allowKnownRefusal && result.status === 1 && value?.error?.code === 'AGENT_PHASE_UNKNOWN';
  if (result.error || result.status !== 0 && !knownRefusal || result.signal || !value) throw new Error(
    `Benchmark ${args[0]} failed: status=${result.status}, signal=${result.signal}, code=${result.error?.code ?? 'none'}\n${result.stderr.slice(-8000)}\n${result.stdout.slice(-8000)}`);
  const counters = Object.fromEntries([...result.stderr.matchAll(/(?:^|\s)([a-z][a-z.-]+)=(\d+)(?=\s|$)/gu)]
    .map(match => [match[1], Number(match[2])]));
  const stages = Object.fromEntries([...result.stderr.matchAll(/(?:^|\s)(root-dispatch|module-load|execute|total)=([\d.]+)ms/gu)]
    .map(match => [match[1], Number(match[2])]));
  return { durationMs: Math.round(durationMs * 100) / 100, counters, stages, responseBytes: Buffer.byteLength(result.stdout),
    outcome: knownRefusal ? 'refused' : 'success', errorCode: knownRefusal ? value.error.code : null,
    semantic: knownRefusal ? { errorCode: value.error.code } : semantic(value) };
}

try {
  const before = await keep({ engineSource: baseline });
  const after = await keep({});
  const engines = { baseline: before, candidate: after };
  for (const engine of Object.values(engines)) await buildCliBundle({ root: engine.engine });
  const rows = [];
  for (const profile of profiles) {
    const dimensions = profile === 'legacy' ? { files: 20 } : { files: 1000, historyCommits: 50, artifacts: 8 };
    const f = await keep({ storyMode: profile, ...dimensions });
    const cases = {
      current: ['session', 'current', '--json'],
      status: ['session', 'status', '--json'],
      context: ['session', 'context', '--work-id', f.workId, '--slice', 'brief', '--json'],
      nextsteps: ['nextsteps', f.workId, '--json'],
      phase: ['phase', 'enter', f.phaseId, '--for-agent', '--json']
    };
    for (const [name,args] of Object.entries(cases)) {
      const observations = { baseline: { cold: [], warm: [] }, candidate: { cold: [], warm: [] } };
      for (let sample = 0; sample < samples; sample++) {
        let expected;
        for (const engine of sample % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const checkout = path.join(f.directory, `paired-${name}-${sample}-${engine}`);
          f.git(['clone', '-q', '--no-hardlinks', '--single-branch', '--branch', f.workId, f.repository, checkout]);
          try {
            f.git(['remote', 'remove', 'origin'], { cwd: checkout });
            f.git(['config', 'user.name', 'Read Benchmark'], { cwd: checkout });
            f.git(['config', 'user.email', 'read.benchmark@example.invalid'], { cwd: checkout });
            const cache = path.join(f.directory, 'compile', name, String(sample), engine);
            const knownAmendedRead = profile === 'amended' && ['current', 'context'].includes(name);
            const cold = observation(engines[engine].cli, args, checkout, f.env, cache, engine === 'baseline' && knownAmendedRead);
            const warm = observation(engines[engine].cli, args, checkout, f.env, cache, engine === 'baseline' && knownAmendedRead);
            if (JSON.stringify(cold.semantic) !== JSON.stringify(warm.semantic)) throw new Error(`${profile}/${name} changed its semantic binding on repeat.`);
            if (cold.outcome !== 'refused') {
              if (knownAmendedRead && cold.semantic.workId !== f.workId) throw new Error('Amended projection returned another Story.');
              expected ??= cold.semantic;
              if (JSON.stringify(expected) !== JSON.stringify(cold.semantic)) throw new Error(`${profile}/${name} engines disagree on the returned binding.`);
            }
            observations[engine].cold.push(cold); observations[engine].warm.push(warm);
          } finally { await rm(checkout, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); }
        }
      }
      const row = { profile, command: name, dimensions, observations, summary: {} };
      for (const temperature of ['cold', 'warm']) {
        const a = summary(observations.baseline[temperature].map(value => value.durationMs));
        const b = summary(observations.candidate[temperature].map(value => value.durationMs));
        const baselineRefused = observations.baseline[temperature].some(value => value.outcome === 'refused');
        row.summary[temperature] = { baseline: a, candidate: b,
          outcome: baselineRefused ? 'baseline-refused-candidate-succeeded-not-a-speed-comparison' : 'both-succeeded',
          reductionPercent: baselineRefused ? null : Math.round(1000 * (a.medianMs - b.medianMs) / a.medianMs) / 10,
          gitSpawns: { baseline: median(observations.baseline[temperature].map(value => value.counters['git.spawns'] ?? 0)),
            candidate: median(observations.candidate[temperature].map(value => value.counters['git.spawns'] ?? 0)) } };
      }
      rows.push(row);
      console.error(`${profile}/${name}: ${JSON.stringify(row.summary)}`);
    }
  }
  const report = { schemaVersion: 1, resultType: 'sflow-shared-read-paired-benchmark', runtime: {
    platform: process.platform, architecture: process.arch, node: process.version, loadAverage: os.loadavg() },
    sources: { baseline: identity(baseline), candidate: identity(root) },
    protocol: { samples, profiles, order: 'alternating A/B and B/A', runtime: 'installed cold-layout bundles',
      cold: 'fresh Node process, empty private V8 cache, fresh local clone without advisory/provenance receipts',
      warm: 'immediate new Node process with the same code/provenance caches; not a persistent worker',
      filesystem: 'OS page cache is not flushed', network: 'none during measured reads', modelCalls: 0,
      setup: 'fixture creation, engine build and local cloning are excluded', fileCounters: 'secured configuration sources/catalogs only, not every filesystem operation' }, rows,
    limitations: ['Synthetic read projections, not complete Story authoring or native Copilot tool/LLM latency.',
      'A native Windows result requires runtime.platform=win32.', 'Four-pair medians are directional, not universal speed guarantees.'] };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(path.resolve(output), json); else console.log(json);
} finally {
  for (const fixture of fixtures.reverse()) await fixture.cleanup();
}
