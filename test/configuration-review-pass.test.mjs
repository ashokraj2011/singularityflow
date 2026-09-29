/**
 * A new build proposes its packaged configuration as reviews from the terminal too, in the
 * background, once per build. Every refresh here is a recorded fake; nothing is pushed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { productMachineRecords, productReviews } from '../src/commands/product.mjs';
import { firstRunPass } from '../src/first-run-pass.mjs';
import { versionLine } from '../src/build-info.mjs';
import { acquireFileLease } from '../src/file-lease.mjs';
import { configurationReviewRetryDue } from '../src/product-alignment-gate.mjs';

import {
  CONFIGURATION_REVIEW_RETRY_MS, CONFIGURATION_REVIEW_RUNNING_STALE_MS, openConfigurationReviews,
  recordedConfigurationReviews, runConfigurationReviewPass, runConfigurationReviewWorker, startConfigurationReviews
} from '../src/configuration-review-pass.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
const STAMP = Object.freeze({ commit: 'c'.repeat(40), sourceSha256: null, branch: null, dirty: false, builtAt: '2026-09-28T20:00:00.000Z' });
const BUILD = versionLine(STAMP);
const HOUR = 60 * 60 * 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hold this machine's pass the way a running worker does. */
async function holdPass(home) {
  const directory = path.join(home, '.singularity-flow', 'installations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lease = await acquireFileLease(path.join(directory, 'configuration-reviews.lease'), { waitMs: 0 });
  assert.ok(lease, 'the test holds the pass');
  return lease;
}

async function machine(t, { workspaces = [{ id: 'alpha', path: '/work/alpha' }] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-config-reviews-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const registry = path.join(home, 'workspaces.json');
  if (workspaces) await writeFile(registry, `${JSON.stringify({ schemaVersion: 1, workspaces })}\n`);
  return { home, environment: { SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry }, registry };
}

function refreshes(responses) {
  const calls = [];
  const refresh = async (options) => {
    calls.push(options);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { calls, refresh };
}

test('a lagging repository gets one review-only proposal bound to exactly the repositories previewed', async () => {
  const { calls, refresh } = refreshes([
    { results: [
      { status: 'would-update', repository: 'app', configurationChanged: true },
      { status: 'would-update', repository: 'state-only', configurationChanged: false },
      { status: 'current', repository: 'lib' }
    ] },
    { planId: 'plan-1', results: [] },
    { results: [{ status: 'review-required', repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1-aaaa-bbbb' }] }
  ]);
  const result = await openConfigurationReviews({ registryFile: '/registry.json', refresh });
  assert.equal(result.outcome, 'reviews-opened');
  assert.deepEqual(result.reviews, [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1-aaaa-bbbb' }]);
  assert.deepEqual(calls, [
    { registryFile: '/registry.json', dryRun: true },
    { registryFile: '/registry.json', repositories: ['app'], dryRun: true },
    { registryFile: '/registry.json', repositories: ['app'], confirmPlan: 'plan-1', reviewOnly: true }
  ], 'the apply is review-only and bound to the plan previewed for exactly the lagging repository');

  const current = refreshes([{ results: [{ status: 'current', repository: 'app' }] }]);
  assert.equal((await openConfigurationReviews({ registryFile: '/registry.json', refresh: current.refresh })).outcome, 'current');
  assert.equal(current.calls.length, 1, 'nothing lags, so nothing is bound or applied');

  const unbound = refreshes([{ results: [{ status: 'would-update', repository: 'app', configurationChanged: true }] }, { results: [] }]);
  assert.equal((await openConfigurationReviews({ registryFile: '/registry.json', refresh: unbound.refresh })).outcome, 'unavailable');
});

test('a background pass starts unless the build recorded one or another process holds the pass', async (t) => {
  const item = await machine(t);
  const launched = [];
  const launch = (options) => { launched.push(options); return { pid: 4242 }; };
  const start = (overrides = {}) => startConfigurationReviews({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, launch, now: Date.now(), ...overrides
  });

  assert.deepEqual(await start(), { status: 'started', pid: 4242 });
  assert.equal(await recordedConfigurationReviews({ homeDirectory: item.home, runningBuild: BUILD }), null,
    'the parent claims nothing: the worker it starts claims the pass itself, so one that never starts leaves nothing stale');
  const held = await holdPass(item.home);
  assert.equal((await start()).status, 'already', 'a pass another process holds is not started beside it');
  await held.release();
  assert.equal((await start()).status, 'started');

  await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, open: async () => ({ outcome: 'current', reviews: [] })
  });
  assert.equal((await start()).status, 'already', 'a settled pass stands for its build');
  assert.equal((await start({ runningBuild: versionLine({ ...STAMP, builtAt: '2026-09-28T21:00:00.000Z' }) })).status, 'started',
    'another build has its own pass');
  assert.equal(launched.length, 3);

  assert.equal((await start({ environment: { ...item.environment, SINGULARITY_FLOW_CONFIGURATION_REVIEWS: 'off' } })).status, 'disabled');
  const empty = await machine(t, { workspaces: null });
  assert.equal((await startConfigurationReviews({
    runningBuild: BUILD, homeDirectory: empty.home, environment: empty.environment, launch
  })).status, 'no-workspaces', 'a machine without registered workspaces starts nothing');
  const failing = await machine(t);
  assert.equal((await startConfigurationReviews({
    runningBuild: BUILD, homeDirectory: failing.home, environment: failing.environment,
    launch: () => { throw new Error('spawn EAGAIN'); }
  })).status, 'failed', 'a worker that cannot start never fails the command');
  assert.equal(await recordedConfigurationReviews({ homeDirectory: failing.home, runningBuild: BUILD }), null,
    'and leaves no "running" record to block the next attempt');
});

test('the worker records what it opened, and a failure, without ever throwing', async (t) => {
  const item = await machine(t);
  const opened = await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment,
    open: async ({ registryFile }) => {
      assert.equal(registryFile, item.registry, 'the worker reads the registry the command used');
      return { outcome: 'reviews-opened', reviews: [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1' }] };
    }
  });
  assert.equal(opened.outcome, 'reviews-opened');
  const recorded = await recordedConfigurationReviews({ homeDirectory: item.home, runningBuild: BUILD });
  assert.equal(recorded.status, 'complete');
  assert.deepEqual(recorded.reviews, [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1' }]);

  const failed = await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment,
    open: async () => { throw Object.assign(new Error('Cannot read the authority.'), { code: 'REMOTE_UNKNOWN' }); }
  });
  assert.equal(failed.outcome, 'failed');
  const again = await recordedConfigurationReviews({ homeDirectory: item.home, runningBuild: BUILD });
  assert.deepEqual([again.status, again.outcome, again.code, again.reason], ['complete', 'failed', 'REMOTE_UNKNOWN', 'Cannot read the authority.']);
  const record = JSON.parse(await readFile(path.join(item.home, '.singularity-flow', 'installations', 'configuration-reviews.json'), 'utf8'));
  assert.equal(record.schemaVersion, 1);
});

test('product status shows the reviews this build opened and each repository\'s last requirement verdict', async (t) => {
  const item = await machine(t);
  await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment,
    open: async () => ({ outcome: 'reviews-opened', reviews: [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1' }] })
  });
  const installations = path.join(item.home, '.singularity-flow', 'installations');
  await writeFile(path.join(installations, 'requirement-checks.json'), `${JSON.stringify({
    schemaVersion: 1,
    repositories: {
      '/work/app': { build: BUILD, checkedAt: '2026-09-28T10:00:00.000Z', verdict: 'failed', required: '2026-09-29T00:00:00.000Z',
        code: 'PRODUCT_RELEASE_BELOW_REQUIREMENT', reason: 'The release does not meet the required build.' },
      '/work/lib': { build: BUILD, checkedAt: '2026-09-28T09:00:00.000Z', verdict: 'none' }
    }
  })}\n`);

  const records = await productMachineRecords({ homeDirectory: item.home, runningBuild: BUILD });
  assert.equal(records.configurationReviews.outcome, 'reviews-opened');
  assert.deepEqual(records.configurationReviews.reviews.map((entry) => entry.proposalBranch), ['sflow/config-refresh/r1']);
  assert.deepEqual(records.requirements.map((entry) => [entry.repository, entry.verdict, entry.code]), [
    ['/work/app', 'failed', 'PRODUCT_RELEASE_BELOW_REQUIREMENT']
  ], 'a repository without a requirement is not listed');

  // Through the command itself: a machine-level read that inventories nothing without a receipt.
  const result = spawnSync(process.execPath, [cli, 'product', 'status', '--json'], {
    cwd: item.home, encoding: 'utf8',
    env: { ...process.env, HOME: item.home, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.verdict, 'no-receipt');
  assert.deepEqual(data.requirements.map((entry) => [entry.verdict, entry.reason]), [
    ['failed', 'The release does not meet the required build.']
  ]);
  assert.equal(data.configurationReviews, null, 'a development checkout records no build of its own');
});

test('the foreground pass shares the per-build record and the one claim: it runs once, never twice at once, and retries a failure', async (t) => {
  const item = await machine(t);
  let opens = 0;
  const open = async () => {
    opens += 1;
    await delay(150);
    return { outcome: 'reviews-opened', reviews: [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1' }] };
  };
  const pass = (home = item.home, overrides = {}) => runConfigurationReviewPass({
    runningBuild: BUILD, homeDirectory: home, environment: item.environment, open, ...overrides
  });
  const first = await pass();
  assert.deepEqual([first.status, first.outcome, opens], ['ran', 'reviews-opened', 1]);
  const again = await pass();
  assert.deepEqual([again.status, again.outcome, again.reviews.length, opens], ['recorded', 'reviews-opened', 1, 1],
    'a recorded pass is reported without reaching any repository');
  assert.equal((await startConfigurationReviews({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, launch: () => { throw new Error('not expected'); }
  })).status, 'already', 'a terminal does not start a pass the window already ran');

  const busy = await machine(t);
  const held = await holdPass(busy.home);
  assert.equal((await pass(busy.home)).status, 'running', 'a pass another process holds is never joined by a second refresh');
  await held.release();
  assert.equal(opens, 1);

  // A window and a terminal starting the same build's pass at once: exactly one refreshes.
  const race = await machine(t);
  const results = await Promise.all([pass(race.home), pass(race.home)]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['ran', 'running']);
  assert.equal(opens, 2, 'the second never ran its own refresh');

  const flaky = await machine(t);
  const failing = async () => { throw Object.assign(new Error('offline'), { code: 'REMOTE_UNKNOWN' }); };
  const failed = await pass(flaky.home, { open: failing });
  assert.deepEqual([failed.status, failed.outcome], ['ran', 'failed']);
  const soon = await pass(flaky.home);
  assert.deepEqual([soon.status, soon.outcome], ['recorded', 'failed'], 'a failure stands for an hour');
  const later = await pass(flaky.home, { now: Date.now() + HOUR + 60_000 });
  assert.deepEqual([later.status, later.outcome], ['ran', 'reviews-opened'], 'and is then tried again');
});

test('one unreachable repository no longer hides the others, and keeps the pass open for a retry', async (t) => {
  const { calls, refresh } = refreshes([
    { status: 'blocked', results: [
      { status: 'failed', repository: 'old-service', error: 'Cannot read the remote.' },
      { status: 'preflight-passed', repository: 'app', error: null }
    ] },
    { results: [{ status: 'would-update', repository: 'app', configurationChanged: true }] },
    { planId: 'plan-2', results: [] },
    { results: [{ status: 'review-required', repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/aaaaaaaa-bbbbbbbbbbbb' }] }
  ]);
  const result = await openConfigurationReviews({ registryFile: '/r.json', refresh });
  assert.equal(result.outcome, 'reviews-opened');
  assert.deepEqual(result.unfinished, [{ repository: 'old-service', reason: 'Cannot read the remote.' }]);
  assert.deepEqual(calls[1], { registryFile: '/r.json', repositories: ['app'], dryRun: true },
    'the reachable repositories are compared on their own');

  const offline = refreshes([{ status: 'blocked', results: [{ status: 'failed', repository: 'app', error: 'offline' }] }]);
  const none = await openConfigurationReviews({ registryFile: '/r.json', refresh: offline.refresh });
  assert.deepEqual([none.outcome, none.unfinished.length, offline.calls.length], ['unavailable', 1, 1],
    'nothing reachable is "unavailable", never "current"');

  const item = await machine(t);
  let runs = 0;
  const open = async () => { runs += 1; return result; };
  const pass = (overrides = {}) => runConfigurationReviewPass({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, open, ...overrides
  });
  assert.equal((await pass()).status, 'ran');
  assert.equal((await pass()).status, 'recorded', 'within the hour the incomplete pass is reported');
  assert.equal((await pass({ now: Date.now() + HOUR + 60_000 })).status, 'ran', 'after it, the unchecked repositories are tried again');
  assert.equal(runs, 2);
});

test('a later mutation retries a pass that failed, left repositories unchecked, or lost its worker', async (t) => {
  const item = await machine(t);
  const due = (overrides = {}) => configurationReviewRetryDue({
    command: 'next', classification: 'mutation', homeDirectory: item.home, environment: {}, info: STAMP, ...overrides
  });
  const later = Date.now() + HOUR + 60_000;
  assert.equal(await due(), null, 'nothing recorded: the first-run pass starts a build\'s first pass');
  await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, open: async () => ({ outcome: 'current', reviews: [] })
  });
  assert.equal(await due({ now: later }), null, 'a settled pass stands');
  await runConfigurationReviewWorker({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment,
    open: async () => ({ outcome: 'current', reviews: [], unfinished: [{ repository: 'old-service', reason: 'offline' }] })
  });
  assert.equal(await due(), null, 'within the hour');
  assert.equal(await due({ now: later }), BUILD, 'an incomplete pass is due again after the hour');
  assert.equal(await due({ now: later, classification: 'read' }), null, 'reads never start one');
  assert.equal(await due({ now: later, command: 'workspace', subcommand: 'refresh-configuration' }), null,
    'a foreground refresh is its own pass');
  assert.equal(await due({ now: later, environment: { SINGULARITY_FLOW_CONFIGURATION_REVIEWS: 'off' } }), null);

  const record = path.join(item.home, '.singularity-flow', 'installations', 'configuration-reviews.json');
  const startedAt = Date.parse('2026-09-28T12:00:00.000Z');
  await writeFile(record, `${JSON.stringify({ schemaVersion: 1, builds: { [BUILD]: { status: 'running', startedAt: new Date(startedAt).toISOString() } } })}\n`);
  assert.equal(await due({ now: startedAt + 60_000 }), null, 'a live worker is left to finish');
  assert.equal(await due({ now: startedAt + 31 * 60_000 }), BUILD, 'a worker that died long ago is replaced');
});

test('product reviews reports the shared pass, and fails only for a pass that failed just now', async (t) => {
  const item = await machine(t);
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const log = console.log;
  const lines = [];
  console.log = (...parts) => { lines.push(parts.join(' ')); };
  try {
    const ran = await productReviews({ json: false, runningBuild: BUILD, pass: async () => ({
      status: 'ran', outcome: 'reviews-opened', reviews: [{ repository: 'app', proposalBranch: 'sflow/config-refresh/r1' }]
    }) });
    assert.deepEqual([ran.resultType, ran.status, ran.reviews.length], ['product-configuration-reviews', 'ran', 1]);
    process.exitCode = undefined;
    await productReviews({ json: false, runningBuild: BUILD, pass: async () => ({ status: 'recorded', outcome: 'failed', reviews: [], reason: 'offline' }) });
    assert.equal(process.exitCode, undefined, 'an earlier recorded failure is only reported');
    await productReviews({ json: false, runningBuild: BUILD, pass: async () => ({ status: 'ran', outcome: 'failed', reviews: [], reason: 'offline' }) });
    assert.equal(process.exitCode, 1, 'a pass that failed just now fails the command');
    process.exitCode = undefined;
    lines.length = 0;
    await productReviews({ json: false, runningBuild: BUILD, pass: async () => ({ status: 'ran', reviews: [] }) });
    assert.equal(process.exitCode, 1, 'a pass whose outcome was lost failed');
    assert.equal(lines.some((line) => /Opened 0/u.test(line)), false, 'it never reports "opened 0"');
    assert.ok(lines.some((line) => /could not be opened: the pass recorded no outcome/u.test(line)));
    process.exitCode = undefined;
    lines.length = 0;
    const unreachable = await productReviews({ json: false, runningBuild: BUILD, pass: async () => ({
      status: 'ran', outcome: 'unavailable', reviews: [], unfinished: [{ repository: 'app', reason: 'offline' }]
    }) });
    assert.equal(process.exitCode, undefined, 'repositories not reachable yet are no failure: they are tried again');
    assert.deepEqual(unreachable.unfinished, [{ repository: 'app', reason: 'offline' }]);
    assert.ok(lines.some((line) => /- app: offline/u.test(line)), 'the unchecked repositories are listed');
    const development = await productReviews({ json: false, runningBuild: null, pass: async () => { throw new Error('not expected'); } });
    assert.equal(development.status, 'development');
  } finally {
    console.log = log;
  }
  const result = spawnSync(process.execPath, [cli, 'product', 'reviews', '--json'], {
    cwd: item.home, encoding: 'utf8',
    env: { ...process.env, HOME: item.home, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.status, 'development', 'a development checkout proposes nothing of its own');
});

test('a foreground configuration refresh is its build\'s pass; no background refresh is started beside it', async (t) => {
  const item = await machine(t);
  const started = [];
  const pass = (argv) => firstRunPass({
    runningBuild: BUILD, argv, homeDirectory: item.home, environment: item.environment,
    execute: () => { throw new Error('no subprocess is expected'); }, exists: () => false, write: () => {},
    repairLocal: async () => [], startReviews: async (options) => { started.push(options.runningBuild); return { status: 'started' }; }
  });
  assert.equal((await pass(['workspace', 'refresh-configuration', '--confirm-plan', 'p', '--review-only', '--json'])).configurationReviews,
    'foreground-refresh');
  assert.equal((await pass(['--no-model', 'workspace', 'reinitialize'])).configurationReviews, 'foreground-refresh');
  assert.deepEqual(started, []);
  assert.equal((await pass(['next'])).configurationReviews, 'started');
  assert.deepEqual(started, [BUILD]);
});
