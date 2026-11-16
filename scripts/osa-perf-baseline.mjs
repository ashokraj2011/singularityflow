#!/usr/bin/env node
/**
 * SPEC-OSA v1.1 Stage 0 performance baseline (AC-022; docs/osa/perf-baseline.md). Local qualification only: never
 * imported by product commands, never run against a person's Story, home or Copilot folder.
 *
 * It builds one isolated Story with the journey tests' own fixture (test/helpers/route-follower.mjs
 * journeyRepository: its own HOME, Git configuration, bare remote and every machine-wide SFlow location under one
 * folder), then measures the three requests every OSA stage changes:
 *   - guard: the Copilot pre-tool hook for an edit of the step's own file (plugin/hook-launcher.mjs boundary-guard,
 *     after a boundary-turn prompt of the step's work command), as cli-bundle.test.mjs runs it; and guard-other-file,
 *     the same hook for a file the step may not edit (application code in a document step, an approved step's document
 *     in a code step);
 *   - entry: `phase enter --compose --for-agent --json`;
 *   - next: `nextsteps --json`;
 * in two Story states (a document step's version 1 being written, a code step's version 1 open after `phase begin`)
 * and two engine layouts (source: SINGULARITY_FLOW_BUNDLE=off; bundle: the cold coarse-ESM bundle built into the
 * harness and forced with SINGULARITY_FLOW_BUNDLE_DIR, as an installed build runs).
 *
 * Cold is a process with an empty V8 compile cache (NODE_COMPILE_CACHE, a new folder per sample); warm is a later
 * process with the cache the first one wrote. SFlow's own caches are what the Story's earlier commands left in both.
 * Timed samples run without instrumentation. One cold and one warm sample per row run again with a counting preload
 * (--import): file: modules loaded (a module.register load hook), Git and other child processes started
 * (node:child_process wrapped), and file, directory and stat reads (node:fs and node:fs/promises wrapped, nested calls
 * counted once). Children are counted, not instrumented.
 *
 *   node scripts/osa-perf-baseline.mjs --root=<absolute new or empty folder> [--samples=5] [--modes=source,bundle]
 *     [--output=FILE] [--keep]
 *
 * The folder holds a copy of this checkout's engine (the requests run from it, so the bundle finds its live sources
 * beside it), the fixture, the bundle, the caches and the counting logs; the fixture is removed at the end unless --keep.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { cp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback = null) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const given = option('root');
const samples = Number(option('samples', '5'));
const modes = option('modes', 'source,bundle').split(',');
const output = option('output');
const keep = process.argv.includes('--keep');
if (!given || !path.isAbsolute(given) || !Number.isSafeInteger(samples) || samples < 1 || samples > 20
    || modes.some((mode) => !['source', 'bundle'].includes(mode)) || new Set(modes).size !== modes.length) {
  console.error('Use --root=<absolute new or empty folder> [--samples=1..20] [--modes=source,bundle] [--output=FILE] [--keep].');
  process.exit(2);
}
const realHome = path.resolve(os.homedir());
if (path.resolve(given) === realHome || path.resolve(given).startsWith(`${realHome}${path.sep}`)) {
  console.error('osa-perf-baseline: the harness must not be inside the real home folder.');
  process.exit(2);
}
if (existsSync(given) && readdirSync(given).length) {
  console.error(`osa-perf-baseline: ${given} is not empty; give a new folder.`);
  process.exit(2);
}
mkdirSync(path.join(given, 'tmp'), { recursive: true });
// The fixture's own paths are real paths (/tmp is /private/tmp on macOS); compare like with like.
const root = realpathSync(given);
// The journey fixture makes its folders under os.tmpdir(): inside the harness, with everything it starts.
process.env.TMPDIR = path.join(root, 'tmp');

const { journeyRepository, startStory } = await import(pathToFileURL(path.join(packageRoot, 'test/helpers/route-follower.mjs')).href);
const { quickFixIntake } = await import(pathToFileURL(path.join(packageRoot, 'test/helpers/journey-scripts.mjs')).href);
const { reviewStep } = await import(pathToFileURL(path.join(packageRoot, 'test/helpers/step-review.mjs')).href);
const { MACHINE_STATE_LOCATIONS } = await import(pathToFileURL(path.join(packageRoot, 'src/machine-state-locations.mjs')).href);

// The measured requests run from a copy of this checkout inside the harness, because the cold bundle reads its live
// sources (src/build-info.mjs, src/version.mjs …) from the folder beside it (scripts/build-cold-cli-bundle.mjs).
const engine = path.join(root, 'engine');
for (const name of ['src', 'bin', 'templates', 'plugin', 'schemas', 'package.json', 'scripts', 'distribution', 'runtime', 'docs',
  'revision-trace-manifest.json']) await cp(path.join(packageRoot, name), path.join(engine, name), { recursive: true });
await symlink(realpathSync(path.join(packageRoot, 'node_modules')), path.join(engine, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
const ENGINE_CLI = path.join(engine, 'bin/singularity-flow.mjs');
const HOOK_LAUNCHER = path.join(engine, 'plugin/hook-launcher.mjs');
const BUNDLE = path.join(engine, 'bundle-cold');
const instrument = path.join(root, 'instrument');
mkdirSync(instrument, { recursive: true });
writeFileSync(path.join(instrument, 'loader-hooks.mjs'), `import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:') && process.env.OSA_PERF_MODULE_LOG) appendFileSync(process.env.OSA_PERF_MODULE_LOG, url + '\\n');
  return result;
}
`);
writeFileSync(path.join(instrument, 'preload.mjs'), `import { register, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import childProcess from 'node:child_process';
import path from 'node:path';
register(new URL('./loader-hooks.mjs', import.meta.url));
const counts = { fileReads: {}, directoryReads: 0, stats: 0, processes: 0, nodeProcesses: 0, gitProcesses: 0, git: {} };
const write = fs.writeFileSync;
let depth = 0;
const wrap = (object, name, count) => {
  const original = object[name];
  if (typeof original !== 'function') return;
  object[name] = function counted(...args) {
    if (depth === 0) count(args);
    depth += 1;
    try { return original.apply(this, args); } finally { depth -= 1; }
  };
};
const readFlag = (flags) => flags === undefined || flags === null || flags === fs.constants.O_RDONLY || (typeof flags === 'string' && flags.startsWith('r') && !flags.includes('+'));
const read = (name) => () => { counts.fileReads[name] = (counts.fileReads[name] ?? 0) + 1; };
for (const name of ['readFileSync', 'readFile', 'createReadStream']) wrap(fs, name, read(name));
for (const name of ['openSync', 'open']) wrap(fs, name, (args) => { if (readFlag(args[1])) read(name)(); });
wrap(fsp, 'readFile', read('promises.readFile'));
wrap(fsp, 'open', (args) => { if (readFlag(args[1])) read('promises.open')(); });
for (const name of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, name, () => { counts.directoryReads += 1; });
for (const name of ['readdir', 'opendir']) wrap(fsp, name, () => { counts.directoryReads += 1; });
for (const name of ['statSync', 'lstatSync', 'existsSync', 'accessSync', 'stat', 'lstat', 'access']) wrap(fs, name, () => { counts.stats += 1; });
for (const name of ['stat', 'lstat', 'access']) wrap(fsp, name, () => { counts.stats += 1; });
const verb = (args) => {
  const words = Array.isArray(args) ? args.map(String) : [];
  let index = 0;
  while (index < words.length && words[index].startsWith('-')) index += ['-c', '-C', '--git-dir', '--work-tree'].includes(words[index]) ? 2 : 1;
  return words[index] ?? 'unknown';
};
const started = (command, args) => {
  counts.processes += 1;
  const text = String(command ?? '');
  const base = path.basename(text.split(' ')[0]).toLowerCase();
  if (base === 'git' || base === 'git.exe') {
    counts.gitProcesses += 1;
    const name = Array.isArray(args) ? verb(args) : verb(text.split(' ').slice(1));
    counts.git[name] = (counts.git[name] ?? 0) + 1;
  } else if (text === process.execPath || base === 'node') counts.nodeProcesses += 1;
};
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) wrap(childProcess, name, (args) => started(args[0], args[1]));
for (const name of ['exec', 'execSync']) wrap(childProcess, name, (args) => started(args[0], null));
wrap(childProcess, 'fork', () => { counts.processes += 1; counts.nodeProcesses += 1; });
syncBuiltinESMExports();
process.on('exit', () => {
  if (process.env.OSA_PERF_COUNT_DIR) write(path.join(process.env.OSA_PERF_COUNT_DIR, process.pid + '.json'), JSON.stringify(counts));
});
`);

const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };
const step = (label) => process.stderr.write(`[osa-perf] ${label}\n`);

function identity() {
  const read = (args) => spawnSync('git', args, { cwd: packageRoot, encoding: 'utf8' }).stdout.trim();
  return { commit: read(['rev-parse', 'HEAD']), dirty: read(['status', '--porcelain=v1', '--untracked-files=no']).length > 0 };
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = (values) => ({ samples: values.length, medianMs: Math.round(median(values) * 10) / 10,
  minMs: Math.round(Math.min(...values) * 10) / 10, maxMs: Math.round(Math.max(...values) * 10) / 10 });

let cacheSerial = 0;
const newCache = () => path.join(root, 'compile-cache', String(cacheSerial += 1));

/** One request as a host makes it; `counted` adds the counting preload. */
function sample(story, request, { mode, cache, counted = false }) {
  const env = { ...story.env, NODE_COMPILE_CACHE: cache,
    ...(mode === 'bundle' ? { SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_BUNDLE_DIR: BUNDLE } : { SINGULARITY_FLOW_BUNDLE: 'off' }) };
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.NODE_OPTIONS;
  let logs = null;
  if (counted) {
    logs = path.join(root, 'counts', String(cacheSerial), `${request.name}-${mode}-${Date.now()}`);
    mkdirSync(logs, { recursive: true });
    Object.assign(env, { OSA_PERF_MODULE_LOG: path.join(logs, 'modules.log'), OSA_PERF_COUNT_DIR: logs });
  }
  const argv = [...(counted ? ['--import', pathToFileURL(path.join(instrument, 'preload.mjs')).href] : []), ...request.argv];
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, argv, { cwd: story.root, env, encoding: 'utf8', input: request.input ?? undefined,
    timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  const durationMs = performance.now() - startedAt;
  let value = null;
  try { value = JSON.parse(result.stdout); } catch { /* the outcome below says what came back */ }
  const outcome = { status: result.status, signal: result.signal, ...request.outcome(value), stdoutBytes: Buffer.byteLength(result.stdout ?? '') };
  if (result.status !== 0 && !request.allowFailure) {
    throw new Error(`${request.name} (${mode}) failed: ${result.status}\n${String(result.stderr).slice(-4000)}\n${String(result.stdout).slice(-2000)}`);
  }
  let counts = null;
  if (counted) {
    const modules = existsSync(path.join(logs, 'modules.log')) ? readFileSync(path.join(logs, 'modules.log'), 'utf8').split('\n').filter(Boolean) : [];
    const bundleDir = pathToFileURL(BUNDLE).href;
    const sourceDir = pathToFileURL(path.join(engine, 'src')).href;
    const records = readdirSync(logs).filter((name) => /^\d+\.json$/u.test(name)).map((name) => JSON.parse(readFileSync(path.join(logs, name), 'utf8')));
    const total = (key) => records.reduce((sum, record) => sum + (record[key] ?? 0), 0);
    const fileReads = {};
    for (const record of records) for (const [name, count] of Object.entries(record.fileReads ?? {})) fileReads[name] = (fileReads[name] ?? 0) + count;
    const git = {};
    for (const record of records) for (const [name, count] of Object.entries(record.git ?? {})) git[name] = (git[name] ?? 0) + count;
    counts = {
      instrumentedProcesses: records.length,
      modules: { total: modules.length, source: modules.filter((url) => url.startsWith(sourceDir)).length,
        bundleChunks: modules.filter((url) => url.startsWith(bundleDir)).length,
        dependencies: modules.filter((url) => url.includes('/node_modules/')).length },
      gitProcesses: total('gitProcesses'), git, otherProcesses: total('processes') - total('gitProcesses'),
      nodeProcesses: total('nodeProcesses'),
      fileReads: Object.values(fileReads).reduce((sum, count) => sum + count, 0), fileReadsBy: fileReads,
      directoryReads: total('directoryReads'), stats: total('stats')
    };
  }
  return { durationMs, outcome, counts };
}

/** A result kept in the report names no folder of this machine. */
let fixtureRoot = null;
const scrub = (text) => [[fixtureRoot, '<repository>'], [root, '<harness>'], [packageRoot, '<checkout>']]
  .reduce((value, [from, to]) => (from ? value.split(from).join(to) : value), text);

function hookRequest(story, sessionId, event, payload) {
  return { name: event === 'boundary-guard' ? 'guard' : event, argv: [HOOK_LAUNCHER, event, ENGINE_CLI],
    input: JSON.stringify({ cwd: story.root, sessionId, ...payload }),
    outcome: (value) => (event === 'boundary-guard' ? { decision: value?.permissionDecision ?? (value ? 'allow (no decision)' : 'unparsed'),
      reason: value?.permissionDecision === 'deny' ? scrub(String(value.permissionDecisionReason ?? '')).slice(0, 200) : undefined } : {}) };
}

const entryRequest = { name: 'entry', argv: [ENGINE_CLI, 'phase', 'enter', '--compose', '--for-agent', '--json'],
  outcome: (value) => ({ act: value?.act?.state ?? null, entryStatus: value?.status ?? value?.entry?.status ?? null,
    error: value?.error?.code ?? null }) };
const nextRequest = { name: 'next', argv: [ENGINE_CLI, 'nextsteps', '--json'],
  outcome: (value) => {
    const now = [...(value?.prerequisites ?? []), ...(value?.actions ?? []), ...(value?.steps ?? [])].find((item) => item?.timing === 'now') ?? null;
    return { now: now ? { command: now.command ?? null, skill: now.skill ?? null } : null, error: value?.error?.code ?? null };
  } };

function measure(story, state, { skill, editPath, deniedPath }) {
  const rows = [];
  for (const mode of modes) {
    const sessionId = `osa-perf-${state}-${mode}`;
    const prompt = hookRequest(story, sessionId, 'boundary-turn', { prompt: skill });
    const guard = hookRequest(story, sessionId, 'boundary-guard', { toolName: 'edit', toolArgs: { cwd: story.root, path: path.join(story.root, editPath) } });
    const denied = { ...hookRequest(story, sessionId, 'boundary-guard', { toolName: 'edit', toolArgs: { cwd: story.root, path: path.join(story.root, deniedPath) } }),
      name: 'guard-other-file' };
    for (const request of [guard, denied, entryRequest, nextRequest]) {
      step(`${state} ${mode} ${request.name}`);
      if (request === guard || request === denied) sample(story, prompt, { mode, cache: newCache() });
      const cold = [];
      let outcome = null;
      for (let index = 0; index < samples; index += 1) {
        const timed = sample(story, request, { mode, cache: newCache() });
        cold.push(timed.durationMs);
        outcome = timed.outcome;
      }
      const warmCache = newCache();
      sample(story, request, { mode, cache: warmCache });
      const warm = [];
      for (let index = 0; index < samples; index += 1) warm.push(sample(story, request, { mode, cache: warmCache }).durationMs);
      const countedCold = sample(story, request, { mode, cache: newCache(), counted: true }).counts;
      const countedWarm = sample(story, request, { mode, cache: warmCache, counted: true }).counts;
      rows.push({ state, mode, request: request.name, outcome, cold: summary(cold), warm: summary(warm), counts: { cold: countedCold, warm: countedWarm } });
    }
  }
  return rows;
}

const startedAt = new Date().toISOString();
const loadStart = os.loadavg();
let report = null;
try {
  step('fixture: an isolated quick-fix Story (journey helpers)');
  const story = await journeyRepository(t);
  fixtureRoot = story.root;
  const inside = (value) => typeof value === 'string' && path.resolve(value).startsWith(`${path.resolve(root)}${path.sep}`);
  const leaks = ['HOME', 'GIT_CONFIG_GLOBAL', ...Object.keys(MACHINE_STATE_LOCATIONS)].filter((name) => !inside(story.env[name]));
  if (leaks.length) throw new Error(`osa-perf-baseline: refusing, not isolated inside the harness: ${leaks.join(', ')}`);
  const W = 'OSA-PERF-1';
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  story.cli('prepare', 'intake');
  if (modes.includes('bundle')) {
    step('bundle: the cold coarse-ESM CLI bundle, built into the harness');
    const { buildCliBundle } = await import(pathToFileURL(path.join(packageRoot, 'scripts/build-cli-bundle.mjs')).href);
    await buildCliBundle({ root: engine, outdir: BUNDLE, esbuildRoot: packageRoot, layout: 'cold' });
  }
  const results = [];
  results.push(...measure(story, 'document-v1-being-written', { skill: '/sf-phase', editPath: `${story.item}/artifacts/intake/intake.md`,
    deniedPath: 'src/value.mjs' }));
  step('fixture: the intake written, published, reviewed, submitted and approved; the code step opened');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  const entered = story.raw(['phase', 'enter', '--compose', '--for-agent', '--json']);
  const begun = story.raw(['phase', 'begin', 'implement', '--json']);
  if (begun.status !== 0) throw new Error(`phase begin implement failed: ${begun.stdout.slice(-2000)}${begun.stderr.slice(-2000)}`);
  results.push(...measure(story, 'code-v1-open', { skill: '/sf-code', editPath: 'src/value.mjs',
    deniedPath: `${story.item}/artifacts/intake/intake.md` }));
  report = {
    schemaVersion: 1, specification: 'SPEC-OSA v1.1 Stage 0 performance baseline (AC-022)',
    method: { script: 'scripts/osa-perf-baseline.mjs', samples, modes, fixture: 'test/helpers/route-follower.mjs journeyRepository, quick-fix Story',
      cold: 'empty NODE_COMPILE_CACHE per sample', warm: 'the cache a priming run wrote', counted: 'one cold and one warm run with the counting preload',
      entryBeforeBegin: entered.status },
    source: identity(),
    machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 2 ** 30),
      node: process.version, loadavgStart: loadStart.map((value) => Math.round(value * 10) / 10), loadavgEnd: os.loadavg().map((value) => Math.round(value * 10) / 10) },
    startedAt, finishedAt: new Date().toISOString(), results
  };
} finally {
  if (!keep) for (const cleanup of cleanups.reverse()) await cleanup();
}
const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(output, text);
process.stdout.write(text);
