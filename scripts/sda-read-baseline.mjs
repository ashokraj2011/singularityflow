#!/usr/bin/env node
/**
 * SDA M0 read baseline (docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md §17, §20).
 *
 * What each advisory read costs today, and whether it answers with the remote unreachable: the Story
 * list (session candidates), status and next steps, the intake catalog, the repository snapshot and
 * the explicit local check, all run from a Story's checkout. The fixture is a disposable workspace
 * with a local bare remote, the ledger on and Stories created by the product's own `start`. Every
 * process runs with the repository's isolated machine state and home (scripts/test-machine-state.mjs),
 * so a run never reads or writes the developer's own ~/.singularity-flow. No model, no real network.
 *
 * Each read runs as a fresh process in four conditions: a fresh repository-check cache, a forced
 * refresh (`always`: what an expired cache costs), and both again with the remote unreachable.
 * Process counts come from the subprocess probe, which sees every child. Remote Git operations come
 * from the command's --timings line where it writes one, else from the probe's verbs; each row says
 * which. Medians over --samples runs; OS caches are not flushed, so nothing here is disk-cold.
 *
 *   node scripts/sda-read-baseline.mjs [--samples=5] [--files=100] [--stories=3] [--output=FILE]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedTestEnvironment } from './test-machine-state.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = (name, fallback) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const samples = Number(option('samples', 5));
const files = Number(option('files', 100));
const stories = Number(option('stories', 3));
const output = option('output', null);
for (const [name, value, max] of [['samples', samples, 50], ['files', files, 20_000], ['stories', stories, 50]]) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer from 1 to ${max}.`);
}

// Isolate before any fixture captures process.env.
const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-baseline-'));
const isolated = isolatedTestEnvironment(stateRoot);
for (const name of Object.keys(process.env)) if (!(name in isolated)) delete process.env[name];
Object.assign(process.env, isolated, { SINGULARITY_FLOW_NO_MODEL: '1' });
const { createSessionListingFixture } = await import('./session-listing-benchmark.mjs');

const CONDITIONS = [
  { name: 'fresh-cache', mode: 'cached', offline: false },
  { name: 'forced-refresh', mode: 'always', offline: false },
  { name: 'offline-fresh-cache', mode: 'cached', offline: true },
  { name: 'offline-forced-refresh', mode: 'always', offline: true }
];
const REMOTE_VERB = /\b(?:fetch|ls-remote|push|clone|pull)\b/u;

function probe(stderr) {
  const total = /^subprocesses: (\d+) calls/mu.exec(stderr);
  const rows = [...stderr.matchAll(/^\s+(\d+)x\s+\d+ ms\s+(.+)$/gmu)].map(([, calls, key]) => ({ calls: Number(calls), key: key.trim() }));
  const git = rows.filter((row) => row.key.startsWith('git '));
  return { processes: total ? Number(total[1]) : null, git: git.reduce((sum, row) => sum + row.calls, 0),
    remoteGit: git.filter((row) => REMOTE_VERB.test(row.key)).reduce((sum, row) => sum + row.calls, 0) };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
const p95 = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]; };

const fixture = await createSessionListingFixture({ files });
const offlineRemote = `${fixture.remote}.offline`;
try {
  const workspace = path.join(fixture.directory, 'workspace');
  let checkout = fixture.original;
  const cli = (args, extra = {}) => {
    const started = performance.now();
    const child = spawnSync(process.execPath, [path.join(packageRoot, 'bin/singularity-flow.mjs'), ...args], {
      cwd: checkout, env: { ...fixture.env, ...extra }, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024
    });
    return { child, ms: Math.round(performance.now() - started) };
  };
  const ids = Array.from({ length: stories }, (_, index) => `SDA-${String(index + 1).padStart(3, '0')}`);
  for (const id of ids) {
    if (fixture.git(fixture.original, 'branch', '--show-current').trim() !== 'main') fixture.git(fixture.original, 'switch', '-q', 'main');
    const { child } = cli(['start', id, '--from-branch', 'main', '--work-type', 'chore', '--title', 'SDA read baseline', '--json']);
    if (child.status !== 0) throw new Error(`start ${id} failed:\n${child.stdout.slice(-2000)}\n${child.stderr.slice(-2000)}`);
  }
  // A person works from a Story's checkout, wherever `start` put it: every read runs from the first Story's.
  const worktrees = fixture.git(fixture.original, 'worktree', 'list', '--porcelain').split('\n\n')
    .map((block) => ({ path: /^worktree (.+)$/mu.exec(block)?.[1], branch: /^branch (.+)$/mu.exec(block)?.[1] }));
  checkout = worktrees.find((entry) => entry.branch === `refs/heads/${ids[0]}`)?.path ?? checkout;
  if (checkout === fixture.original) fixture.git(fixture.original, 'switch', '-q', ids[0]);
  const commonDirectory = path.resolve(checkout, fixture.git(checkout, 'rev-parse', '--git-common-dir').trim());
  const timingsFile = path.join(commonDirectory, 'singularity-flow/dx/timings.jsonl');
  const reads = {
    'story-list': ['session', 'candidates', '--workspace', workspace, '--repository', 'app', '--diagnostics'],
    status: ['status', ids[0]],
    nextsteps: ['nextsteps', ids[0]],
    'intake-catalog': ['workspace', 'branches', '--intake'],
    'repository-snapshot': ['snapshot', '--include', 'repository'],
    check: ['check']
  };
  const timingLines = async () => (await readFile(timingsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const measure = async (args, mode) => {
    const before = (await timingLines()).length;
    const { child, ms } = cli([...args, '--json', '--timings'], { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: mode, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' });
    const lines = await timingLines();
    let timing = null;
    if (lines.length > before) try { timing = JSON.parse(lines.at(-1)); } catch { /* an unreadable line records nothing */ }
    let packet = null;
    try { packet = JSON.parse(child.stdout); } catch { /* a refusal may print text */ }
    const code = child.status === 0 ? null : packet?.why?.[0]?.code ?? packet?.code ?? packet?.error?.code
      ?? /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/u.exec(`${child.stdout}\n${child.stderr}`)?.[0] ?? `exit-${child.status}`;
    const counted = probe(child.stderr);
    return { ms, exit: child.status, code, ...counted,
      remoteGit: timing ? timing.counters?.['git.remote.total'] ?? 0 : counted.remoteGit, remoteSource: timing ? 'timings' : 'probe' };
  };
  let offline = false;
  const setOffline = async (wanted) => {
    if (wanted !== offline) await (wanted ? rename(fixture.remote, offlineRemote) : rename(offlineRemote, fixture.remote));
    offline = wanted;
  };
  const results = [];
  for (const condition of CONDITIONS) {
    for (const [read, args] of Object.entries(reads)) {
      // One unmeasured online run fills the cache this read's fresh-cache rows use, right before them:
      // another read can invalidate it (`check` is an explicit refresh and clears the intake catalog's).
      if (condition.mode === 'cached') {
        await setOffline(false);
        await measure(args, 'cached');
      }
      await setOffline(condition.offline);
      const runs = [];
      for (let index = 0; index < samples; index++) runs.push(await measure(args, condition.mode));
      const last = runs.at(-1);
      results.push({ read, condition: condition.name, mode: condition.mode, offline: condition.offline,
        answered: runs.every((run) => run.exit === 0), outcome: last.code ?? 'ok',
        medianMs: median(runs.map((run) => run.ms)), p95Ms: p95(runs.map((run) => run.ms)),
        processes: { min: Math.min(...runs.map((run) => run.processes ?? Infinity)), max: Math.max(...runs.map((run) => run.processes ?? -1)) },
        git: { min: Math.min(...runs.map((run) => run.git)), max: Math.max(...runs.map((run) => run.git)) },
        remoteGit: { min: Math.min(...runs.map((run) => run.remoteGit)), max: Math.max(...runs.map((run) => run.remoteGit)), source: last.remoteSource } });
    }
  }
  await setOffline(false);
  const row = (read, condition) => results.find((entry) => entry.read === read && entry.condition === condition);
  const report = {
    schemaVersion: 1,
    specification: 'SDA-v1 M0 read baseline',
    engine: execFileSync('git', ['-C', packageRoot, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: { platform: process.platform, architecture: process.arch, node: process.version,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), cpu: os.cpus()[0]?.model ?? null },
    fixture: { trackedFiles: files, stories, ledger: 'enabled', remote: 'local bare repository', checkout: `Story ${ids[0]}` },
    protocol: { samples, process: 'fresh CLI process per sample', osCachesFlushed: false, network: 'none (local bare remote)',
      model: 'none', offline: 'remote repository moved away for the offline conditions' },
    // The disposable fixture's own path says nothing about the run and stays out of the report.
    reads: Object.fromEntries(Object.entries(reads).map(([read, args]) => [read, args.map((word) => (word === workspace ? '<workspace>' : word))])),
    results,
    // The two Phase A budgets this baseline is measured against (SDA §17, SDA-AC-002, SDA-AC-021).
    gaps: {
      startsGitWithFreshCache: Object.keys(reads).filter((read) => row(read, 'fresh-cache').git.max > 0),
      contactsRemoteWithFreshCache: Object.keys(reads).filter((read) => row(read, 'fresh-cache').remoteGit.max > 0),
      refusesOfflineAfterExpiry: Object.keys(reads).filter((read) => !row(read, 'offline-forced-refresh').answered)
        .map((read) => ({ read, outcome: row(read, 'offline-forced-refresh').outcome })),
      refusesOfflineWithFreshCache: Object.keys(reads).filter((read) => !row(read, 'offline-fresh-cache').answered)
        .map((read) => ({ read, outcome: row(read, 'offline-fresh-cache').outcome }))
    }
  };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of results) {
    console.log([entry.condition.padEnd(23), entry.read.padEnd(20), String(entry.medianMs).padStart(6), 'ms',
      `git ${entry.git.min === entry.git.max ? entry.git.max : `${entry.git.min}-${entry.git.max}`}`.padEnd(9),
      `remote ${entry.remoteGit.max}`.padEnd(9), entry.outcome].join(' '));
  }
  console.log(JSON.stringify(report.gaps, null, 2));
} finally {
  await rename(offlineRemote, fixture.remote).catch(() => {});
  await fixture.cleanup();
  await rm(stateRoot, { recursive: true, force: true });
}
