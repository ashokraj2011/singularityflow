#!/usr/bin/env node
/** Local-only cold/first/warm UI reads plus complete CLI Story intake. No model or public remote. */
import path from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { buildCliBundle } from './build-cli-bundle.mjs';

const number = (name, fallback, maximum) => {
  const value = Number(process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid --${name}.`);
  return value;
};
const samples = number('samples', 5, 30), files = number('files', 1000, 20000), branches = number('branches', 20, 200);
const summarize = values => ({ samples: values.length, medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)],
  minMs: Math.min(...values), maxMs: Math.max(...values) });
const elapsed = async fn => { const start = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - start) }; };
const f = await createWarmReadFixture({ files, branches });
let adapter;
try {
  await buildCliBundle({ root: f.engine });
  delete f.env.SINGULARITY_FLOW_BUNDLE; // Qualify the installed bundle, not an artificial source-only speedup.
  adapter = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')).href);
  const read = args => adapter.readWithWorker({ executable: process.execPath, cli: f.cli, repository: f.repository, env: f.env, args });
  const cases = {
    repository: ['snapshot', '--include', 'repository', '--json'],
    coreUi: ['snapshot', '--include', 'repository', '--include', 'lifecycle', '--include', 'capabilities', '--json'],
    status: ['status', 'PERF-001', '--json'], nextsteps: ['nextsteps', 'PERF-001', '--json']
  };
  const commands = {};
  for (const [name, args] of Object.entries(cases)) {
    adapter.disposeReadWorkers();
    const cold = [];
    for (let index = 0; index < samples; index++) cold.push((await elapsed(() => f.cold(args))).ms);
    const first = await elapsed(() => read(args));
    if (first.value?.transport !== 'worker-start') throw new Error(`${name} did not use the installed worker.`);
    const warm = [];
    for (let index = 0; index < samples; index++) {
      const sample = await elapsed(() => read(args));
      if (sample.value?.transport !== 'warm-worker') throw new Error(`${name} did not reuse its worker.`);
      warm.push(sample.ms);
    }
    const baseline = summarize(cold), optimized = summarize(warm);
    commands[name] = { cold: baseline, firstWorkerMs: first.ms, warm: optimized,
      medianReductionPercent: Math.round(100 * (baseline.medianMs - optimized.medianMs) / baseline.medianMs) };
  }
  adapter.disposeReadWorkers();
  // Mutations deliberately stay CLI-owned. Time the complete start, including its local bare push.
  const remote = path.join(f.directory, 'remote.git'), intakeRepository = path.join(f.directory, 'intake');
  await mkdir(intakeRepository);
  await cp(path.join(f.repository, 'src'), path.join(intakeRepository, 'src'), { recursive: true });
  const git = args => f.git(args, { cwd: intakeRepository });
  const cold = args => f.cold(args, { cwd: intakeRepository, json: false });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Warm Read Tester']); git(['config', 'user.email', 'warm@example.invalid']);
  cold(['init']); // Stock supported workflows, not the deliberately minimal UI read fixture.
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'intake fixture']);
  git(['init', '--bare', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
  const intake = [];
  for (let index = 0; index < samples; index++) {
    git(['switch', '-q', 'main']);
    const sample = await elapsed(() => cold(['start', `PERF-INTAKE-${index}`, '--from-branch', 'main',
      '--work-type', 'chore', '--title', 'Local performance qualification', '--json']));
    const created = JSON.parse(git(['show', `PERF-INTAKE-${index}:singularity/work-items/PERF-INTAKE-${index}/workflow.json`]));
    if (created.workItem.id !== `PERF-INTAKE-${index}`) throw new Error('Intake did not publish its exact Story.');
    if (!git(['ls-remote', '--heads', 'origin', `refs/heads/PERF-INTAKE-${index}`]).startsWith(git(['rev-parse', 'HEAD']))) {
      throw new Error('Intake did not synchronize its exact commit to the local bare remote.');
    }
    intake.push(sample.ms);
  }
  console.log(JSON.stringify({ schemaVersion: 1, runtime: { platform: process.platform, arch: process.arch, node: process.version },
    protocol: { files, unrelatedBranches: branches, samples, network: 'local bare remote only', modelCalls: 0,
      resultCache: false, build: 'stamped bundled fixture', firstWorkerIncludesStartup: true },
    commands, completeStoryIntake: { ...summarize(intake), optimizedByReadWorker: false },
    limitations: ['Synthetic local fixture, not a native Copilot conversation.', 'No native Windows timing was measured unless runtime.platform is win32.',
      'No change to publication, test, approval, remote fetch or push semantics.'] }, null, 2));
} finally { adapter?.disposeReadWorkers(); await f.cleanup(); }
