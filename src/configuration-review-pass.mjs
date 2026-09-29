/**
 * A new build proposes its packaged configuration as reviews, once per build, from every surface.
 *
 * VS Code opens them after a new build loads. A terminal has no window to wait in, so a new build's
 * first mutation starts this pass as a detached worker instead: it runs the same review-only refresh
 * over every registered repository, and records what it opened for `singularity-flow product status`.
 * Nothing is applied. A person merges each review, and every machine on the same build joins the one
 * review already open.
 *
 * One pass runs on a machine at a time: the process doing the work holds an exclusive lease for as
 * long as it runs. A pass that failed, or could not check every repository, is tried again an hour
 * later by the next window or mutation.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireFileLease, inspectFileLease, withRegistryFileLease } from './file-lease.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  CONFIGURATION_REVIEW_RETRY_MS, CONFIGURATION_REVIEW_RUNNING_STALE_MS, CONFIGURATION_REVIEWS_SWITCH,
  configurationReviewRetryable, configurationReviewsDisabled, PRODUCT_ALIGNMENT_SWITCH
} from './product-alignment-gate.mjs';
import { PRODUCT_UPDATE_SWITCH } from './product-requirement-gate.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';

export {
  CONFIGURATION_REVIEW_RETRY_MS, CONFIGURATION_REVIEW_RUNNING_STALE_MS, CONFIGURATION_REVIEWS_SWITCH,
  configurationReviewsDisabled
};
export const CONFIGURATION_REVIEWS_RECORD = 'configuration-reviews.json';
const CONFIGURATION_REVIEWS_LEASE = 'configuration-reviews.lease';
const WORKER = path.join(PACKAGE_ROOT, 'bin', 'configuration-review-worker.mjs');
const RECORDED_BUILDS = 8;

function installationsDirectory(homeDirectory) {
  return path.join(homeDirectory, '.singularity-flow', 'installations');
}

function recordFile(homeDirectory) {
  return path.join(installationsDirectory(homeDirectory), CONFIGURATION_REVIEWS_RECORD);
}

function leaseFile(homeDirectory) {
  return path.join(installationsDirectory(homeDirectory), CONFIGURATION_REVIEWS_LEASE);
}

function bounded(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** A recorded pass stands for its build, unless it needs running again and its hour is up. */
function settled(entry, now) {
  if (entry?.status !== 'complete') return false;
  if (!configurationReviewRetryable(entry)) return true;
  return now - Date.parse(entry.completedAt ?? '') < CONFIGURATION_REVIEW_RETRY_MS;
}

async function readReviewRecord(homeDirectory) {
  let bytes;
  try { bytes = await readFile(recordFile(homeDirectory)); } catch { return null; }
  try { return readRecord('product-configuration-reviews', bytes).record; } catch { return null; }
}

/** What the configuration-review pass of one build recorded on this machine, or null. */
export async function recordedConfigurationReviews({ homeDirectory = os.homedir(), runningBuild } = {}) {
  return (await readReviewRecord(homeDirectory))?.builds?.[runningBuild] ?? null;
}

/** Merge one build's entry into the record. Writers are serialized, so no build's entry is lost. */
async function writeReviewEntry(homeDirectory, runningBuild, entry) {
  const file = recordFile(homeDirectory);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withRegistryFileLease(file, async () => {
    const prior = await readReviewRecord(homeDirectory);
    const others = Object.entries(prior?.builds ?? {})
      .filter(([line]) => line !== runningBuild)
      .sort(([, left], [, right]) => String(right?.at ?? '').localeCompare(String(left?.at ?? '')))
      .slice(0, RECORDED_BUILDS - 1);
    const record = {
      schemaVersion: currentSchemaVersion('product-configuration-reviews'),
      builds: Object.fromEntries([[runningBuild, { at: new Date().toISOString(), ...entry }], ...others])
    };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    await chmod(file, 0o600);
  });
}

/** The exclusive claim on this machine's pass, or null while another process holds it. */
async function claimPass(homeDirectory) {
  const file = leaseFile(homeDirectory);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return acquireFileLease(file, { waitMs: 0, staleMs: CONFIGURATION_REVIEW_RUNNING_STALE_MS });
}

async function passBusy(homeDirectory) {
  try { return (await inspectFileLease(leaseFile(homeDirectory))).state === 'busy'; }
  catch { return false; }
}

async function defaultRefresh(options) {
  const { refreshWorkspaceConfigurations } = await import('./workspace-configuration-refresh.mjs');
  return refreshWorkspaceConfigurations(options);
}

/** Repositories a refresh result could not check or propose, with why. */
function troubled(result) {
  return (result?.results ?? [])
    .filter((entry) => entry.error || entry.status === 'failed' || entry.status === 'stale-plan')
    .map((entry) => Object.freeze({
      repository: entry.repository,
      reason: bounded(entry.error?.message ?? entry.error ?? entry.status)
    }));
}

function passResult(outcome, reviews = [], unfinished = [], reason = null) {
  const why = reason ?? (unfinished.length
    ? unfinished.map((entry) => `${entry.repository}: ${entry.reason}`).join('; ') : null);
  return Object.freeze({
    outcome,
    reviews: Object.freeze([...reviews]),
    ...(unfinished.length ? { unfinished: Object.freeze([...unfinished]) } : {}),
    ...(why ? { reason: bounded(why) } : {})
  });
}

/**
 * Open a review for each registered repository whose approved configuration lags this build's
 * packaged configuration: preview, bind the plan to exactly the lagging repositories, then apply it
 * review-only. The same three steps the VS Code check runs through the CLI.
 *
 * One unreachable repository stops the refresh's preview before any repository is compared, so the
 * reachable ones are compared on their own; the ones left unchecked keep the pass open for a retry.
 */
export async function openConfigurationReviews({ registryFile, refresh = defaultRefresh } = {}) {
  let preview = await refresh({ registryFile, dryRun: true });
  const unreachable = troubled(preview);
  if (unreachable.length) {
    const reachable = (preview?.results ?? [])
      .filter((entry) => !(entry.error || entry.status === 'failed'))
      .map((entry) => entry.repository);
    if (!reachable.length) return passResult('unavailable', [], unreachable);
    preview = await refresh({ registryFile, repositories: reachable, dryRun: true });
    const again = troubled(preview);
    if (again.length) return passResult('unavailable', [], [...unreachable, ...again]);
  }
  const lagging = (preview?.results ?? [])
    .filter((entry) => entry.status === 'would-update' && entry.configurationChanged)
    .map((entry) => entry.repository);
  if (!lagging.length) return passResult('current', [], unreachable);
  const bound = await refresh({ registryFile, repositories: lagging, dryRun: true });
  if (!bound?.planId || troubled(bound).length) {
    return passResult('unavailable', [], [...unreachable, ...troubled(bound)],
      bound?.planId ? null : 'The bound preview returned no plan.');
  }
  const opened = await refresh({ registryFile, repositories: lagging, confirmPlan: bound.planId, reviewOnly: true });
  const reviews = (opened?.results ?? [])
    .filter((entry) => entry.status === 'review-required' && entry.proposalBranch)
    .map(({ repository, remote = null, proposalBranch }) => Object.freeze({ repository, remote, proposalBranch }));
  const failed = troubled(opened);
  return passResult(reviews.length ? 'reviews-opened' : failed.length ? 'failed' : 'current',
    reviews, [...unreachable, ...failed]);
}

/**
 * Run this build's pass while holding the machine's exclusive claim, and record it. Returns the
 * pass as it ran (`status: 'ran'`), or `status: 'running'` when another process holds the claim.
 * Never throws; a record that cannot be written still leaves the outcome in the returned value.
 */
export async function runConfigurationReviewWorker({
  runningBuild,
  homeDirectory = os.homedir(),
  environment = process.env,
  open = openConfigurationReviews,
  claim = claimPass
} = {}) {
  let lease;
  try {
    lease = await claim(homeDirectory);
  } catch (error) {
    return Object.freeze({
      status: 'ran', outcome: 'failed', reviews: Object.freeze([]),
      reason: bounded(`The pass could not claim this machine: ${error?.message ?? error}`)
    });
  }
  if (!lease) return Object.freeze({ status: 'running', reviews: Object.freeze([]) });
  try {
    await writeReviewEntry(homeDirectory, runningBuild, {
      status: 'running', startedAt: new Date().toISOString(), pid: process.pid
    }).catch(() => undefined);
    let result;
    try {
      result = await open({ registryFile: workspaceRegistryFile(environment, homeDirectory) });
    } catch (error) {
      result = { outcome: 'failed', reviews: [], code: error?.code ?? null, reason: bounded(error?.message ?? error) };
    }
    const entry = {
      status: 'complete', completedAt: new Date().toISOString(),
      outcome: result.outcome, reviews: [...(result.reviews ?? [])].map((review) => ({ ...review })),
      ...(result.unfinished?.length ? { unfinished: result.unfinished.map((item) => ({ ...item })) } : {}),
      ...(result.reason ? { reason: result.reason } : {}), ...(result.code ? { code: result.code } : {})
    };
    await writeReviewEntry(homeDirectory, runningBuild, entry).catch(() => undefined);
    return Object.freeze({ ...entry, status: 'ran' });
  } finally {
    await lease.release().catch(() => undefined);
  }
}

/**
 * Run this build's pass in the foreground, sharing the one per-build record and the one claim with
 * the background worker: a pass already recorded is reported as it is, without reaching any
 * repository, and a pass another process is running is left to it. VS Code runs this through
 * `singularity-flow product reviews`, so a window and a terminal never refresh the same
 * configuration at once.
 */
export async function runConfigurationReviewPass({
  runningBuild,
  homeDirectory = os.homedir(),
  environment = process.env,
  open = openConfigurationReviews,
  claim = claimPass,
  now = Date.now()
} = {}) {
  const prior = await recordedConfigurationReviews({ homeDirectory, runningBuild });
  if (settled(prior, now)) return Object.freeze({ ...prior, status: 'recorded' });
  const result = await runConfigurationReviewWorker({ runningBuild, homeDirectory, environment, open, claim });
  if (result.status !== 'running') return result;
  const current = await recordedConfigurationReviews({ homeDirectory, runningBuild });
  return Object.freeze({ status: 'running', startedAt: current?.startedAt ?? null, reviews: Object.freeze([]) });
}

function launchWorker({ environment, homeDirectory }) {
  // The worker claims the pass itself, so a worker that never starts leaves nothing to go stale. It
  // never starts another pass, alignment or update of its own.
  const child = spawn(process.execPath, [WORKER], {
    cwd: homeDirectory,
    env: {
      ...environment,
      [PRODUCT_ALIGNMENT_SWITCH]: 'off', [PRODUCT_UPDATE_SWITCH]: 'off', [CONFIGURATION_REVIEWS_SWITCH]: 'off'
    },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  });
  child.once('error', () => {});
  child.unref();
  return { pid: child.pid ?? null };
}

async function registeredWorkspaceCount(registryFile) {
  try {
    const registry = JSON.parse(await readFile(registryFile, 'utf8'));
    return (registry?.workspaces ?? []).filter((entry) => !entry?.archivedAt).length;
  } catch {
    return 0;
  }
}

/**
 * Start this build's configuration-review pass in the background, unless it is recorded or another
 * process is running it. It never waits for the worker and never throws: a machine without
 * registered workspaces, or with the pass switched off, starts nothing.
 */
export async function startConfigurationReviews({
  runningBuild,
  homeDirectory = os.homedir(),
  environment = process.env,
  launch = launchWorker,
  now = Date.now()
} = {}) {
  try {
    if (!runningBuild || configurationReviewsDisabled(environment)) return Object.freeze({ status: 'disabled' });
    if (!(await registeredWorkspaceCount(workspaceRegistryFile(environment, homeDirectory)))) {
      return Object.freeze({ status: 'no-workspaces' });
    }
    const prior = await recordedConfigurationReviews({ homeDirectory, runningBuild });
    if (settled(prior, now)) return Object.freeze({ status: 'already', outcome: prior.outcome ?? null });
    if (await passBusy(homeDirectory)) return Object.freeze({ status: 'already', outcome: null });
    const launched = launch({ environment, homeDirectory });
    return Object.freeze({ status: 'started', pid: launched?.pid ?? null });
  } catch (error) {
    return Object.freeze({ status: 'failed', reason: bounded(error?.message ?? error) });
  }
}
