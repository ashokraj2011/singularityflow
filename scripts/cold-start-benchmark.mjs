#!/usr/bin/env node
/** Paired installed layouts, isolated V8 caches and complete local-bare-remote intake. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildCliBundle } from './build-cli-bundle.mjs';
import { createWarmReadFixture } from './warm-read-fixture.mjs';

const option = (key, fallback) => process.argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const samples = Number(option('samples', '5')), files = Number(option('files', '1000'));
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 20
    || !Number.isSafeInteger(files) || files < 0 || files > 20000) throw new Error('Invalid benchmark bounds.');
const summary = values => ({ samples: values.length,
  medianMs: [...values].sort((a,b) => a-b)[Math.floor(values.length/2)], minMs: Math.min(...values), maxMs: Math.max(...values) });
const timed = fn => { const start = performance.now(); fn(); return Math.round(performance.now() - start); };
const f = await createWarmReadFixture({ files, branches: 20 });
try {
  const layouts = {};
  for (const layout of ['monolithic', 'cold']) {
    const outdir = path.join(f.engine, `bundle-${layout}`);
    const { manifest } = await buildCliBundle({ root: f.engine, outdir, layout });
    layouts[layout] = { outdir, manifest };
  }
  const cacheEnv = (layout, name) => {
    const env = { ...f.env, SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_BUNDLE_DIR: layouts[layout].outdir,
      NODE_COMPILE_CACHE: path.join(f.directory, 'code-cache', layout, name) };
    delete env.NODE_DISABLE_COMPILE_CACHE; // Even an empty value disables Node's cache.
    return env;
  };
  const invoke = (args, { env, cwd = f.repository, hook = null } = {}) => {
    const command = hook ? [path.join(f.engine, 'plugin/hook-launcher.mjs'), hook, f.cli] : [f.cli, ...args];
    const result = spawnSync(process.execPath, command, { cwd, env, encoding: 'utf8', timeout: 90000,
      maxBuffer: 40 * 1024 * 1024, input: hook ? '{}' : undefined });
    if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}\n${result.stdout}`);
    return result.stdout;
  };
  const cases = { version: ['--version'], pause: ['pause', 'status', '--json'],
    repository: ['snapshot', '--include', 'repository', '--json'], status: ['status', 'PERF-001', '--json'],
    nextsteps: ['nextsteps', 'PERF-001', '--json'] };
  const results = {};
  for (const [name, args] of Object.entries(cases)) {
    results[name] = {};
    const measured = Object.fromEntries(Object.keys(layouts).map(layout => [layout, { first: [], cached: [] }]));
    for (let n=0; n<samples; n++) {
      for (const layout of n % 2 ? ['cold', 'monolithic'] : ['monolithic', 'cold']) {
        const env = cacheEnv(layout, `${name}-${n}`);
        measured[layout].first.push(timed(() => invoke(args, { env })));
        measured[layout].cached.push(timed(() => invoke(args, { env })));
      }
    }
    for (const layout of Object.keys(layouts)) results[name][layout] = {
      emptyCompileCache: summary(measured[layout].first), subsequentProcess: summary(measured[layout].cached) };
  }
  results.hook = {};
  for (const layout of Object.keys(layouts)) {
    const values = [];
    for (let n=0;n<samples;n++) values.push(timed(() => invoke([], { env: cacheEnv(layout, `hook-${n}`), hook: 'boundary-guard' })));
    results.hook[layout] = { emptyCompileCache: summary(values) };
  }
  const repository = path.join(f.directory, 'intake'), remote = path.join(f.directory, 'remote.git');
  await mkdir(repository);
  await cp(path.join(f.repository, 'src'), path.join(repository, 'src'), { recursive: true });
  const git = args => f.git(args, { cwd: repository });
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Cold Startup Tester']);
  git(['config', 'user.email', 'cold@example.invalid']);
  invoke(['init'], { env: cacheEnv('cold', 'setup'), cwd: repository });
  git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'intake fixture']);
  git(['init', '--bare', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-u', 'origin', 'main']);
  results.intakeEntry = {}; results.completeStoryCreation = {}; results.sessionCurrent = {};
  const intakeSamples = Object.fromEntries(Object.keys(layouts).map(layout => [layout, { initial: [], complete: [], session: [] }]));
  for (let n=0;n<samples;n++) {
    for (const layout of n % 2 ? ['cold', 'monolithic'] : ['monolithic', 'cold']) {
      const { initial, complete, session } = intakeSamples[layout];
      git(['switch', '-q', 'main']);
      const id = `COLD-${layout.toUpperCase()}-${n}`, env = cacheEnv(layout, `intake-${n}`);
      initial.push(timed(() => {
        if (layout === 'monolithic') {
          for (const args of [['pause', 'status', '--json'], ['workspace', 'current', '--json'], ['--version']]) invoke(args, { env, cwd: repository });
          git(['status', '--short']);
          invoke(['workspace', 'branches', '--intake', '--work-id', id, '--json'], { env, cwd: repository });
        } else {
          const packet = JSON.parse(invoke(['workspace', 'branches', '--entry', '--intake', '--work-id', id, '--json'], { env, cwd: repository }));
          if (!packet.ready || packet.creationAuthorized !== false) throw new Error('Intake preview violated its advisory contract.');
        }
      }));
      complete.push(timed(() => invoke(['start', id, '--from-branch', 'main', '--work-type', 'chore',
        '--title', 'Cold startup qualification', '--json'], { env, cwd: repository })));
      const tip = git(['rev-parse', 'HEAD']);
      if (!git(['ls-remote', '--heads', 'origin', `refs/heads/${id}`]).startsWith(tip)) throw new Error('Exact Story publication missing.');
      session.push(timed(() => invoke(['session', 'current', '--json'], { cwd: repository,
        env: cacheEnv(layout, `session-${n}`) })));
    }
  }
  for (const [layout, measured] of Object.entries(intakeSamples)) {
    results.intakeEntry[layout] = summary(measured.initial);
    results.completeStoryCreation[layout] = summary(measured.complete);
    results.sessionCurrent[layout] = { emptyCompileCache: summary(measured.session) };
  }
  console.log(JSON.stringify({ schemaVersion: 1, runtime: { platform: process.platform, arch: process.arch, node: process.version },
    protocol: { samples, files, unrelatedBranches: 20, modelCalls: 0, remote: 'local bare repository only',
      osFileCache: 'not flushed', compileCache: 'fresh private directory per first sample',
      layouts: 'same source and policies; monolithic is the packaging control',
      order: 'alternating paired layouts for CLI and intake samples',
      intakeEntry: 'four prior CLI launches and one Git status versus one composed CLI launch' },
    layouts: Object.fromEntries(Object.entries(layouts).map(([id, value]) => [id, value.manifest])), results,
    limitations: ['Native Copilot tool latency and PowerShell startup are not included.',
      'Native Windows performance is unqualified unless runtime.platform is win32.',
      'Creation still performs live mutation-bound validation and exact publication.'] }, null, 2));
} finally { await f.cleanup(); }
