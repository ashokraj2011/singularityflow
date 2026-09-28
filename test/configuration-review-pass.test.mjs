/**
 * A new build proposes its packaged configuration as reviews from the terminal too, in the
 * background, once per build. Every refresh here is a recorded fake; nothing is pushed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { productMachineRecords, productReviews } from '../src/commands/product.mjs';
import { firstRunPass } from '../src/first-run-pass.mjs';

import {
  CONFIGURATION_REVIEW_RETRY_MS, CONFIGURATION_REVIEW_RUNNING_STALE_MS, openConfigurationReviews,
  recordedConfigurationReviews, runConfigurationReviewPass, runConfigurationReviewWorker, startConfigurationReviews
} from '../src/configuration-review-pass.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
const BUILD = '0.9.0 (cccccccccccccccccccccccccccccccccccccccc · built 2026-09-28T20:00:00.000Z)';

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

test('a build starts its background pass once, and a dead worker is started again', async (t) => {
  const item = await machine(t);
  const launched = [];
  const launch = (options) => { launched.push(options); return { pid: 4242 }; };
  const start = (overrides = {}) => startConfigurationReviews({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, launch, now: Date.now(), ...overrides
  });

  assert.deepEqual(await start(), { status: 'started', pid: 4242 });
  assert.equal(launched.length, 1);
  assert.equal((await recordedConfigurationReviews({ homeDirectory: item.home, runningBuild: BUILD })).status, 'running');
  assert.equal((await start()).status, 'already', 'the running pass is not started twice');
  assert.equal((await start({ runningBuild: BUILD.replace('20:00', '21:00') })).status, 'started', 'another build has its own pass');

  const stale = await start({ now: Date.now() + CONFIGURATION_REVIEW_RUNNING_STALE_MS + 60_000 });
  assert.equal(stale.status, 'started', 'a worker still "running" after the stale bound died, so the pass starts again');
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
  assert.equal(launched.length, 3);
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

test('the foreground pass shares the per-build record: it runs once, never beside a live worker, and retries a failure', async (t) => {
  const item = await machine(t);
  let opens = 0;
  const open = async () => {
    opens += 1;
    return { outcome: 'reviews-opened', reviews: [{ repository: 'app', remote: 'origin', proposalBranch: 'sflow/config-refresh/r1' }] };
  };
  const pass = (overrides = {}) => runConfigurationReviewPass({
    runningBuild: BUILD, homeDirectory: item.home, environment: item.environment, open, ...overrides
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
  await startConfigurationReviews({ runningBuild: BUILD, homeDirectory: busy.home, environment: busy.environment, launch: () => ({ pid: 1 }) });
  const beside = await runConfigurationReviewPass({ runningBuild: BUILD, homeDirectory: busy.home, environment: busy.environment, open });
  assert.equal(beside.status, 'running', 'a live background worker is never joined by a second refresh');
  assert.equal(opens, 1);

  const flaky = await machine(t);
  const failing = async () => { throw Object.assign(new Error('offline'), { code: 'REMOTE_UNKNOWN' }); };
  const failed = await runConfigurationReviewPass({ runningBuild: BUILD, homeDirectory: flaky.home, environment: flaky.environment, open: failing });
  assert.deepEqual([failed.status, failed.outcome], ['ran', 'failed']);
  const soon = await runConfigurationReviewPass({ runningBuild: BUILD, homeDirectory: flaky.home, environment: flaky.environment, open });
  assert.deepEqual([soon.status, soon.outcome], ['recorded', 'failed'], 'a failure stands for an hour');
  const later = await runConfigurationReviewPass({
    runningBuild: BUILD, homeDirectory: flaky.home, environment: flaky.environment, open,
    now: Date.now() + CONFIGURATION_REVIEW_RETRY_MS + 60_000
  });
  assert.deepEqual([later.status, later.outcome], ['ran', 'reviews-opened'], 'and is then tried again');
});

test('product reviews reports the shared pass, and fails only for a pass that failed just now', async (t) => {
  const item = await machine(t);
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const log = console.log;
  console.log = () => {};
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
