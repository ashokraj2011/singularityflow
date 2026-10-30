#!/usr/bin/env node
/**
 * SDA read and write baseline (docs/SPEC-SDA-STORAGE-INDEPENDENT-WORKFLOW-v1.md §17, §20 M0 and M6).
 *
 * What each advisory read costs, and whether it answers with the remote unreachable: the Story
 * list (session candidates), status and next steps, the intake catalog, the repository snapshot and
 * the explicit local check, all run from a Story's checkout. The fixture is a disposable workspace
 * with a local bare remote, the ledger on and Stories created by the product's own `start`. Every
 * process runs with the repository's isolated machine state and home (scripts/test-machine-state.mjs),
 * so a run never reads or writes the developer's own ~/.singularity-flow. No model, no real network.
 *
 * Each read runs as a fresh process in six conditions, online and with the remote unreachable:
 * - a fresh repository-check cache;
 * - an expired one: every record is aged past the fixture's 30-minute interval before each sample;
 * - a forced refresh (`always`), which recomputes whatever the cache holds.
 * M0 (`main@c6a65e33b`) had no expired condition: before last-known records, `always` was what an
 * expired cache cost. The background refresh an expired read starts is off, as in every test run.
 *
 * Two writes run the same way (M6):
 * - a configuration draft save from the Story checkout, online and offline, each sample a new draft
 *   after one unmeasured save;
 * - a takeover of the first Story by another laptop: a clone made before any Story existed, with its
 *   own machine state and home for each sample, so every sample is a first takeover and fetches it.
 *
 * Process counts come from the subprocess probe, which sees every child, including a step run as its
 * own CLI process. Remote Git operations are the larger of the command's --timings counter and the
 * probe's remote verbs; each row says which. Medians over --samples runs; OS caches are not flushed, so nothing here is disk-cold.
 * --cli-root measures another build of the CLI (a worktree of an older commit) with this same harness
 * and fixture, so two builds compare on one machine at one time.
 *
 *   node scripts/sda-read-baseline.mjs [--samples=5] [--files=100] [--stories=3] [--cli-root=DIR] [--output=FILE]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
const cliRoot = path.resolve(option('cli-root', packageRoot));
for (const [name, value, max] of [['samples', samples, 50], ['files', files, 20_000], ['stories', stories, 50]]) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`--${name} must be an integer from 1 to ${max}.`);
}
if (!existsSync(path.join(cliRoot, 'bin/singularity-flow.mjs'))) throw new Error(`--cli-root has no bin/singularity-flow.mjs: ${cliRoot}`);

// Isolate before any fixture captures process.env.
const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-baseline-'));
const isolated = isolatedTestEnvironment(stateRoot);
for (const name of Object.keys(process.env)) if (!(name in isolated)) delete process.env[name];
Object.assign(process.env, isolated, { SINGULARITY_FLOW_NO_MODEL: '1' });
const { createSessionListingFixture } = await import('./session-listing-benchmark.mjs');

const CONDITIONS = [
  { name: 'fresh-cache', mode: 'cached', offline: false },
  { name: 'expired', mode: 'cached', offline: false, expired: true },
  { name: 'forced-refresh', mode: 'always', offline: false },
  { name: 'offline-fresh-cache', mode: 'cached', offline: true },
  { name: 'offline-expired', mode: 'cached', offline: true, expired: true },
  { name: 'offline-forced-refresh', mode: 'always', offline: true }
];
// One minute past the fixture's 30-minute repository-check interval (session-listing-benchmark.mjs).
const EXPIRED_AGE_MS = 31 * 60_000;
const REMOTE_VERB = /\b(?:fetch|ls-remote|push|clone|pull)\b/u;

function probe(stderr) {
  const total = /^subprocesses: (\d+) calls/mu.exec(stderr);
  // The probe keys a call by its command and first two arguments (src/util.mjs), so a Git call that
  // starts with `-c` options shows no verb: remote counts prefer the command's --timings line.
  const rows = [...stderr.matchAll(/^\s+(\d+)x\s+\d+ ms\s+(.+)$/gmu)].map(([, calls, key]) => ({ calls: Number(calls), key: key.trim() }));
  const git = rows.filter((row) => row.key.startsWith('git '));
  return { rows, processes: total ? Number(total[1]) : null, git: git.reduce((sum, row) => sum + row.calls, 0),
    otherProcesses: rows.filter((row) => !row.key.startsWith('git ')).reduce((sum, row) => sum + row.calls, 0),
    remoteGit: git.filter((row) => REMOTE_VERB.test(row.key)).reduce((sum, row) => sum + row.calls, 0) };
}

const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };
const p95 = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]; };
const range = (runs, key) => ({ min: Math.min(...runs.map((run) => run[key] ?? Infinity)), max: Math.max(...runs.map((run) => run[key] ?? -1)) });
const summary = (runs) => ({ answered: runs.every((run) => run.exit === 0), outcome: runs.at(-1).code ?? 'ok',
  medianMs: median(runs.map((run) => run.ms)), p95Ms: p95(runs.map((run) => run.ms)),
  processes: range(runs, 'processes'), git: range(runs, 'git'), otherProcesses: range(runs, 'otherProcesses'),
  remoteGit: { ...range(runs, 'remoteGit'), source: runs.at(-1).remoteSource }, remoteGitSeenByProbe: range(runs, 'remoteGitProbe') });

const fixture = await createSessionListingFixture({ cliRoot, files });
const offlineRemote = `${fixture.remote}.offline`;
try {
  const workspace = path.join(fixture.directory, 'workspace');
  let checkout = fixture.original;
  const cli = (args, extra = {}, { cwd = checkout, env = fixture.env } = {}) => {
    const started = performance.now();
    const child = spawnSync(process.execPath, [path.join(cliRoot, 'bin/singularity-flow.mjs'), ...args], {
      cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 300_000, maxBuffer: 32 * 1024 * 1024
    });
    return { child, ms: Math.round(performance.now() - started) };
  };
  // The laptops that take a Story over (M6). Each is its own clone, with its own machine state and
  // home, sharing nothing with this laptop but the remote. Each clones before any Story exists, as a
  // laptop that had the repository already, so its takeover fetches the Story.
  const laptops = path.join(stateRoot, 'laptops');
  await mkdir(laptops);
  const clones = [];
  for (let index = 0; index < samples; index++) {
    const laptop = path.join(laptops, `laptop-${index + 1}`);
    await mkdir(laptop);
    fixture.git(laptop, 'clone', '--quiet', fixture.remote, path.join(laptop, 'checkout'));
    clones.push(laptop);
  }
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
  const gitDirectory = path.resolve(checkout, fixture.git(checkout, 'rev-parse', '--absolute-git-dir').trim());
  const timingsFile = path.join(commonDirectory, 'singularity-flow/dx/timings.jsonl');
  // Where the repository-check records live: this checkout's, and the machine's session listings.
  const recordDirectories = [path.join(gitDirectory, 'singularity-flow/cache/repository-checks'),
    path.join(path.dirname(fixture.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES), 'cache/session-listings')];
  const expire = async () => {
    for (const directory of recordDirectories) {
      for (const name of await readdir(directory).catch(() => [])) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        const file = path.join(directory, name);
        let stored; try { stored = JSON.parse(await readFile(file, 'utf8')); } catch { continue; }
        if (typeof stored?.checkedAt !== 'number') continue;
        stored.checkedAt = Date.now() - EXPIRED_AGE_MS;
        await writeFile(file, JSON.stringify(stored), { mode: 0o600 });
      }
    }
  };
  const reads = {
    'story-list': ['session', 'candidates', '--workspace', workspace, '--repository', 'app', '--diagnostics'],
    status: ['status', ids[0]],
    nextsteps: ['nextsteps', ids[0]],
    'intake-catalog': ['workspace', 'branches', '--intake'],
    'repository-snapshot': ['snapshot', '--include', 'repository'],
    check: ['check']
  };
  const timingLines = async (file) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  // Authoring commands take no --timings: their remote operations come from the probe alone.
  const measure = async (args, mode, { cwd = checkout, env = fixture.env, timings = timingsFile, flags = ['--json', '--timings'] } = {}) => {
    const before = (await timingLines(timings)).length;
    const { child, ms } = cli([...args, ...flags], { SINGULARITY_FLOW_REPOSITORY_CHECK_MODE: mode, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' }, { cwd, env });
    const lines = await timingLines(timings);
    let timing = null;
    if (lines.length > before) try { timing = JSON.parse(lines.at(-1)); } catch { /* an unreadable line records nothing */ }
    let packet = null;
    try { packet = JSON.parse(child.stdout); } catch { /* a refusal may print text */ }
    const code = child.status === 0 ? null : packet?.why?.[0]?.code ?? packet?.code ?? packet?.error?.code
      ?? /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/u.exec(`${child.stdout}\n${child.stderr}`)?.[0] ?? `exit-${child.status}`;
    const counted = probe(child.stderr);
    // The --timings line counts this process only; the probe also counts the steps it ran as their
    // own processes (src/cli-steps.mjs). The larger of the two is the command's remote work.
    const timed = timing ? timing.counters?.['git.remote.total'] ?? 0 : null;
    return { ms, exit: child.status, code, packet, ...counted, remoteGitProbe: counted.remoteGit,
      remoteGit: Math.max(timed ?? 0, counted.remoteGit), remoteSource: timed == null || counted.remoteGit > timed ? 'probe' : 'timings' };
  };
  let offline = false;
  const setOffline = async (wanted) => {
    if (wanted !== offline) await (wanted ? rename(fixture.remote, offlineRemote) : rename(offlineRemote, fixture.remote));
    offline = wanted;
  };
  const results = [];
  for (const condition of CONDITIONS) {
    for (const [read, args] of Object.entries(reads)) {
      // One unmeasured online run in the condition's own mode fills the record its rows use, right
      // before them: another read can invalidate it (`check` is an explicit refresh and clears the
      // intake catalog's), and a record is bound to the environment it was computed in, the mode too.
      await setOffline(false);
      await measure(args, condition.mode);
      await setOffline(condition.offline);
      const runs = [];
      for (let index = 0; index < samples; index++) {
        if (condition.expired) await expire();
        runs.push(await measure(args, condition.mode));
      }
      results.push({ read, condition: condition.name, mode: condition.mode, offline: condition.offline,
        freshness: runs.at(-1).packet?.freshness ?? runs.at(-1).packet?.listingSnapshot?.freshness
          ?? runs.at(-1).packet?.readinessSnapshot?.freshness ?? null, ...summary(runs) });
    }
  }
  await setOffline(false);

  // Writes (M6). A draft save is checked against the approved configuration this checkout holds; the
  // first save learns that the repository has one, so it runs once unmeasured.
  const writes = [];
  // No --operation-id: each draft is new by its name, and a build from before SDA M3 takes the same command.
  const draft = (number) => ['instruction', 'create', `baseline-${number}`, '--description', 'A baseline draft.',
    '--instructions', 'Measured by sda-read-baseline.'];
  let drafted = 0;
  await measure(draft(drafted++), 'cached', { flags: ['--json'] });
  for (const wanted of [false, true]) {
    await setOffline(wanted);
    const runs = [];
    for (let index = 0; index < samples; index++) runs.push(await measure(draft(drafted++), 'cached', { flags: ['--json'] }));
    writes.push({ write: 'draft-save', condition: wanted ? 'offline' : 'online', ...summary(runs), lastRun: runs.at(-1) });
  }
  await setOffline(false);
  // Takeover on another laptop: the Story's branch is on the remote (start may already have pushed it).
  fixture.git(checkout, 'push', '--quiet', 'origin', ids[0]);
  const takeovers = [];
  for (const laptop of clones) {
    const clone = path.join(laptop, 'checkout');
    const env = { ...fixture.env, ...isolatedTestEnvironment(path.join(laptop, 'machine')), SINGULARITY_FLOW_NO_MODEL: '1' };
    takeovers.push(await measure(['session', 'takeover', ids[0]], 'cached',
      { cwd: clone, env, timings: path.join(clone, '.git/singularity-flow/dx/timings.jsonl') }));
  }
  writes.push({ write: 'takeover', condition: 'another-laptop', ready: takeovers.at(-1).packet?.ready ?? null, ...summary(takeovers) });
  // What each write runs, from its last sample's probe, with this run's temporary paths removed.
  const anonymous = (key) => key.split(stateRoot).join('<state>').split(fixture.directory).join('<fixture>');
  for (const [entry, runs] of [[writes[0], null], [writes[1], null], [writes[2], takeovers]]) {
    const last = runs ? runs.at(-1) : entry.lastRun;
    entry.commands = (last?.rows ?? []).map((row) => ({ calls: row.calls, command: anonymous(row.key) }));
    delete entry.lastRun;
  }

  const row = (read, condition) => results.find((entry) => entry.read === read && entry.condition === condition);
  const write = (name, condition) => writes.find((entry) => entry.write === name && entry.condition === condition);
  const report = {
    schemaVersion: 2,
    specification: 'SDA-v1 read and write baseline (M0, M6)',
    engine: execFileSync('git', ['-C', cliRoot, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim(),
    harness: execFileSync('git', ['-C', packageRoot, 'rev-parse', '--short=9', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: { platform: process.platform, architecture: process.arch, node: process.version,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(), cpu: os.cpus()[0]?.model ?? null },
    fixture: { trackedFiles: files, stories, ledger: 'enabled', remote: 'local bare repository', checkout: `Story ${ids[0]}` },
    protocol: { samples, process: 'fresh CLI process per sample', osCachesFlushed: false, network: 'none (local bare remote)',
      model: 'none', offline: 'remote repository moved away for the offline conditions',
      expired: `every repository-check record aged ${EXPIRED_AGE_MS / 60_000} minutes before each sample; background refresh off`,
      fill: 'one unmeasured online run in the condition\'s own mode before each read\'s samples',
      takeover: 'a clone made before any Story existed, with its own machine state and home, per sample' },
    // The disposable fixture's own path says nothing about the run and stays out of the report.
    reads: Object.fromEntries(Object.entries(reads).map(([read, args]) => [read, args.map((word) => (word === workspace ? '<workspace>' : word))])),
    results,
    writes,
    // The Phase A budgets this baseline is measured against (SDA §17, SDA-AC-002, SDA-AC-021).
    gaps: {
      startsGitWithFreshCache: Object.keys(reads).filter((read) => row(read, 'fresh-cache').git.max > 0),
      contactsRemoteWithFreshCache: Object.keys(reads).filter((read) => row(read, 'fresh-cache').remoteGit.max > 0),
      waitsOnRemoteWhenExpired: Object.keys(reads).filter((read) => row(read, 'expired').remoteGit.max > 0),
      refusesOfflineAfterExpiry: Object.keys(reads).filter((read) => !row(read, 'offline-expired').answered)
        .map((read) => ({ read, outcome: row(read, 'offline-expired').outcome })),
      refusesOfflineWithFreshCache: Object.keys(reads).filter((read) => !row(read, 'offline-fresh-cache').answered)
        .map((read) => ({ read, outcome: row(read, 'offline-fresh-cache').outcome })),
      refusesOfflineOnForcedRefresh: Object.keys(reads).filter((read) => !row(read, 'offline-forced-refresh').answered)
        .map((read) => ({ read, outcome: row(read, 'offline-forced-refresh').outcome })),
      // §17: a local draft save starts zero Git, remote or model processes (restated by decision D2:
      // no remote or model process, and its local Git reads only fall).
      draftSave: { localGit: write('draft-save', 'online').git.max, otherProcesses: write('draft-save', 'online').otherProcesses.max,
        remoteGit: Math.max(write('draft-save', 'online').remoteGit.max, write('draft-save', 'offline').remoteGit.max),
        answersOffline: write('draft-save', 'offline').answered }
    }
  };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of [...results, ...writes]) {
    console.log([entry.condition.padEnd(23), (entry.read ?? entry.write).padEnd(20), String(entry.medianMs).padStart(6), 'ms',
      `git ${entry.git.min === entry.git.max ? entry.git.max : `${entry.git.min}-${entry.git.max}`}`.padEnd(9),
      `remote ${entry.remoteGit.max}`.padEnd(9), entry.freshness ?? '', entry.outcome].join(' '));
  }
  console.log(JSON.stringify(report.gaps, null, 2));
} finally {
  await rename(offlineRemote, fixture.remote).catch(() => {});
  await fixture.cleanup();
  await rm(stateRoot, { recursive: true, force: true });
}
