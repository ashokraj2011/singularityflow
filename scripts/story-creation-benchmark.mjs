#!/usr/bin/env node
/** Local-only creation profile. Includes fresh checks and synchronous exact-tip publication. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliBundle } from './build-cli-bundle.mjs';
import { createWarmReadFixture } from './warm-read-fixture.mjs';
import { buildCreationBenchmarkControl } from './creation-benchmark-control.mjs';
import { seedBenchmarkRepository } from './benchmark-git-seed.mjs';

const option = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const samples = Number(option('samples', '3')), files = Number(option('files', '1000'));
const controlRef = option('control-ref', null), workType = option('work-type', 'feature');
const selectedMode = option('mode', 'both');
const fresh = option('fresh', 'false'), configuration = option('configuration', 'legacy');
const prewarm = option('prewarm', 'none');
const prepareWorktree = option('prepare-worktree', 'none');
const outputFile = option('out', null);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20
    || !Number.isSafeInteger(files) || files < 0 || files > 20000
    || !/^[a-z0-9-]{1,64}$/.test(workType) || !['both', 'isolated', 'working'].includes(selectedMode)
    || !['true', 'false'].includes(fresh) || !['legacy', 'approved'].includes(configuration)
    || !['none', 'candidate', 'all'].includes(prewarm)
    || !['none', 'candidate'].includes(prepareWorktree)
    || (prepareWorktree !== 'none' && (configuration !== 'approved' || selectedMode !== 'isolated'))
    || (controlRef && !/^[a-f0-9]{40}$/.test(controlRef))) throw new Error('Invalid benchmark bounds.');
const summary = values => ({ medianMs: [...values].sort((a,b) => a-b)[Math.floor(values.length/2)],
  minMs: Math.min(...values), maxMs: Math.max(...values) });
const fixture = await createWarmReadFixture({ files });
let failure = null;
try {
  const outdir = path.join(fixture.engine, 'bundle');
  const sourceMode = option('layout', 'cold') === 'source';
  if (sourceMode && controlRef) throw new Error('Paired comparison requires installed bundles.');
  if (!sourceMode) await buildCliBundle({ root: fixture.engine, outdir });
  const variants = { candidate: outdir };
  const variantClis = { candidate: fixture.cli };
  let controlModules = [];
  let candidateOnlyModules = [];
  if (controlRef) {
    const source = fileURLToPath(new URL('..', import.meta.url));
    const control = await buildCreationBenchmarkControl(fixture, source, controlRef);
    controlModules = control.modules;
    candidateOnlyModules = control.candidateOnlyModules;
    variants.control = control.outdir;
    variantClis.control = path.join(control.root, 'bin', 'singularity-flow.mjs');
  }
  const env = { ...fixture.env, SINGULARITY_FLOW_BUNDLE: sourceMode ? 'off' : 'on', SINGULARITY_FLOW_BUNDLE_DIR: outdir,
    NODE_COMPILE_CACHE: path.join(fixture.directory, 'code-cache'), SINGULARITY_FLOW_PROGRESS: 'stderr-v1' };
  env.SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE = path.join(fixture.directory, 'configuration-objects');
  delete env.NODE_DISABLE_COMPILE_CACHE;
  const invoke = (args, cwd, extraEnv = {}, cli = fixture.cli) => {
    const started = performance.now();
    const result = spawnSync(process.execPath, ['--import', new URL('./benchmark-git-probe.mjs', import.meta.url).href, cli, ...args], { cwd, env: { ...env, ...extraEnv },
      encoding: 'utf8', timeout: 120000, maxBuffer: 40 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
    return { durationMs: Math.round(performance.now() - started), stderr: result.stderr,
      value: args.includes('--json') ? JSON.parse(result.stdout) : result.stdout };
  };
  const results = {};
  for (const isolated of [false, true]) {
    if ((selectedMode === 'isolated' && !isolated) || (selectedMode === 'working' && isolated)) continue;
    const mode = isolated ? 'isolatedWorktree' : 'workingCheckout';
    const createRepository = async suffix => {
      const repository = path.join(fixture.directory, `${mode}${suffix}`);
      const remote = `${repository}.git`;
      await mkdir(repository);
      await cp(path.join(fixture.repository, 'src'), path.join(repository, 'src'), { recursive: true });
      const git = (args, options = {}) => fixture.git(args, { ...options, cwd: repository });
      git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Creation Tester']);
      git(['config', 'user.email', 'creation@example.invalid']);
      invoke(['init'], repository);
      await seedBenchmarkRepository(repository, git, 'creation fixture');
      git(['init', '--bare', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
      if (configuration === 'approved') {
        git(['branch', 'sflow/config']); git(['push', 'origin', 'sflow/config']);
      }
      return { repository, git };
    };
    const shared = fresh === 'true' ? null : await createRepository('');
    const measured = Object.fromEntries(Object.keys(variants).map(variant => [variant, []]));
    for (let index=0;index<samples;index++) {
      for (const variant of index % 2 ? Object.keys(variants).reverse() : Object.keys(variants)) {
      const { repository, git } = shared ?? await createRepository(`-${variant}-${index}`);
      git(['switch', '-q', 'main']);
      const id = `CREATE-${variant.toUpperCase()}-${isolated ? 'ISO' : 'LOCAL'}-${index}`;
      const traceFile = path.join(fixture.directory, `${id}.jsonl`);
      const countsFile = path.join(fixture.directory, `${id}-counts.jsonl`);
      const variantEnv = { SINGULARITY_FLOW_BUNDLE_DIR: variants[variant],
        NODE_COMPILE_CACHE: path.join(fixture.directory, 'code-cache', variant, ...(fresh === 'true' ? [String(index)] : [])) };
      let preparation = null;
      if (prewarm === 'all' || (prewarm === 'candidate' && variant === 'candidate')) {
        const prepared = invoke(['--warm-runtime'], fixture.directory, variantEnv, variantClis[variant]);
        preparation = { durationMs: prepared.durationMs, prepared: JSON.parse(prepared.value).prepared === true };
      }
      let intakePreview = null, worktreePreparation = null, intakeArgs = [];
      if (prepareWorktree !== 'none') {
        const preview = invoke(['workspace', 'branches', '--json', '--intake', '--preflight-story', id,
          '--from-branch', 'main', '--work-type', workType, '--selected-base-only', '--isolated-worktree',
          '--mint-intake-receipt'], repository, variantEnv, variantClis[variant]);
        const receipt = preview.value.preflight?.intakeReceipt;
        // Old Windows builds can legitimately decline their optimization because the ACL helper
        // inherited Core-only modules. Keep that baseline on its real full-validation path; never
        // pretend it had a receipt. A candidate must demonstrate actual preparation, not fallback.
        if (!receipt?.issued && !(variant === 'control' && process.platform === 'win32'
            && receipt?.reason === 'storage' && preview.value.preflight?.passed === true)) {
          throw new Error(`A matched intake preview did not issue its receipt (${receipt?.reason ?? 'missing'}).`);
        }
        intakePreview = { durationMs: preview.durationMs, receiptIssued: receipt?.issued === true,
          ...(receipt?.issued ? {} : { receiptDeclined: receipt?.reason }) };
        intakeArgs = receipt?.issued ? ['--intake-receipt', receipt.id] : [];
        if (variant === 'candidate') {
          const result = invoke(['story', 'prepare-worktree', '--work-id', id, '--json', '--isolated-worktree', '--from-branch', 'main',
            '--work-type', workType, ...intakeArgs], repository, variantEnv);
          if (result.value.preparation?.status !== 'prepared') throw new Error('Worktree preparation was unavailable.');
          worktreePreparation = { durationMs: result.durationMs };
          intakeArgs.push('--prepared-base', result.value.preparation.baseCommit);
        }
      }
      const result = invoke(['start', id, '--from-branch', 'main', '--work-type', workType,
        '--title', 'Creation performance qualification', '--json', '--timings', ...intakeArgs,
        ...(isolated ? ['--isolated-worktree'] : [])], repository, { GIT_TRACE2_EVENT: traceFile,
          ...variantEnv, SFLOW_BENCHMARK_GIT_COUNTS: countsFile,
          ...(process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE ? { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' } : {}) }, variantClis[variant]);
      if (process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE) process.stderr.write(result.stderr);
      const publishedTip = git(['ls-remote', '--heads', 'origin', `refs/heads/${id}`]).split(/\s/)[0];
      if (!/^[a-f0-9]{40}$/.test(publishedTip)) throw new Error('Story was not published.');
      const branchTip = git(['rev-parse', `refs/heads/${id}`]);
      if (branchTip !== publishedTip) throw new Error('Publication does not match the exact local tip.');
      const timingLine = result.stderr.split('\n').find(line => line.startsWith('[sflow timing] start'));
      if (!timingLine) throw new Error('Creation timing is missing.');
      const timings = Object.fromEntries([...timingLine.matchAll(/([a-z][a-z.-]+)=([0-9.]+)ms/g)]
        .map(match => [match[1], Number(match[2])]));
      const counters = Object.fromEntries([...timingLine.matchAll(/([a-z][a-z.-]+)=([0-9.]+)(?= |$)/g)]
        .map(match => [match[1], Number(match[2])]));
      const commands = {}, commandTimes = {}, startedGit = new Map();
      const trace = (await readFile(traceFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      for (const entry of trace.filter(event => event.event === 'start')) {
        const argv = entry.argv ?? [];
        // Only fixture-owned arguments are observed. Retain operation names, never paths/URLs.
        const command = argv.slice(1).find(arg => /^[a-z][a-z-]+$/.test(arg)) ?? 'other';
        commands[command] = (commands[command] ?? 0) + 1;
        startedGit.set(entry.sid, command);
      }
      for (const entry of trace.filter(event => event.event === 'exit')) {
        const command = startedGit.get(entry.sid);
        if (command && Number.isFinite(entry.t_abs)) {
          commandTimes[command] = (commandTimes[command] ?? 0) + entry.t_abs * 1000;
        }
      }
      measured[variant].push({ durationMs: result.durationMs, preparation, intakePreview, worktreePreparation,
        nodeLaunchedGit: JSON.parse((await readFile(countsFile, 'utf8')).trim()),
        totalWithPreparationMs: result.durationMs + (preparation?.durationMs ?? 0)
          + (intakePreview?.durationMs ?? 0) + (worktreePreparation?.durationMs ?? 0),
        timings, counters, localTraceGitProcessCounts: commands,
        localTraceGitElapsedMs: Object.fromEntries(Object.entries(commandTimes)
          .map(([command, duration]) => [command, Math.round(duration)])),
        localTraceGitProcesses: Object.values(commands).reduce((a,b) => a+b, 0), exactRemoteTip: true });
      }
    }
    results[mode] = Object.fromEntries(Object.entries(measured).map(([variant, runs]) =>
      [variant, { ...summary(runs.map(run => run.durationMs)), runs }]));
  }
  const report = { schemaVersion: 1,
    runtime: { platform: process.platform, arch: process.arch, node: process.version,
      git: fixture.git(['--version']) },
    protocol: { samples, files, workType, mode: selectedMode, configuration, freshRepositoryPerSample: fresh === 'true',
      prewarm, prepareWorktree, remote: 'local bare only', modelCalls: 0,
      controlRef, controlModules, candidateOnlyModules, comparison: 'same packaging and fixtures; alternating candidate/control samples',
      compileCache: fresh === 'true' ? 'fresh private directory for every sample' : 'separate per variant, initially empty; shared across samples',
      osFileCache: 'not flushed',
      publication: 'fresh validation and exact remote tip asserted for every sample' }, results,
    limitations: ['Windows latency is unmeasured unless runtime.platform is win32.',
      'Git elapsed totals are inclusive per process; parent/child times overlap. Isolated remote transports may omit trace events.',
      'No native Copilot tool, enterprise network or antivirus timings are included.'] };
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (outputFile) await writeFile(path.resolve(outputFile), serialized, { mode: 0o600 });
  process.stdout.write(serialized);
} catch (error) { failure = error; throw error; }
finally {
  try { await fixture.cleanup(); }
  catch (cleanup) {
    if (!failure) throw cleanup;
    console.warn(`Qualification cleanup failed after the primary error: ${cleanup.code ?? cleanup.message}`);
  }
}
