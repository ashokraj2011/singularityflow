/**
 * A new build proposes its packaged configuration as reviews, once per build, from every surface.
 *
 * VS Code opens them after a new build loads. A terminal has no window to wait in, so a new build's
 * first mutation starts this pass as a detached worker instead: it runs the same review-only refresh
 * over every registered repository, and records what it opened for `singularity-flow product status`.
 * Nothing is applied. A person merges each review, and every machine proposing the same change joins
 * the one review already open.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PACKAGE_ROOT } from './package-root.mjs';
import { PRODUCT_ALIGNMENT_SWITCH } from './product-alignment-gate.mjs';
import { PRODUCT_UPDATE_SWITCH } from './product-requirement-gate.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { workspaceRegistryFile } from './workspace-context.mjs';

export const CONFIGURATION_REVIEWS_RECORD = 'configuration-reviews.json';
export const CONFIGURATION_REVIEWS_SWITCH = 'SINGULARITY_FLOW_CONFIGURATION_REVIEWS';
const WORKER = path.join(PACKAGE_ROOT, 'bin', 'configuration-review-worker.mjs');
const RECORDED_BUILDS = 8;
/** A worker still "running" after this long died; the next pass of the same build starts another. */
export const CONFIGURATION_REVIEW_RUNNING_STALE_MS = 30 * 60 * 1000;

function recordFile(homeDirectory) {
  return path.join(homeDirectory, '.singularity-flow', 'installations', CONFIGURATION_REVIEWS_RECORD);
}

function bounded(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function configurationReviewsDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[CONFIGURATION_REVIEWS_SWITCH] ?? '').trim().toLowerCase());
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

async function writeReviewEntry(homeDirectory, runningBuild, entry) {
  const file = recordFile(homeDirectory);
  const prior = await readReviewRecord(homeDirectory);
  const others = Object.entries(prior?.builds ?? {})
    .filter(([line]) => line !== runningBuild)
    .sort(([, left], [, right]) => String(right?.at ?? '').localeCompare(String(left?.at ?? '')))
    .slice(0, RECORDED_BUILDS - 1);
  const record = {
    schemaVersion: currentSchemaVersion('product-configuration-reviews'),
    builds: Object.fromEntries([[runningBuild, { at: new Date().toISOString(), ...entry }], ...others])
  };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  await chmod(file, 0o600);
}

async function defaultRefresh(options) {
  const { refreshWorkspaceConfigurations } = await import('./workspace-configuration-refresh.mjs');
  return refreshWorkspaceConfigurations(options);
}

/**
 * Open a review for each registered repository whose approved configuration lags this build's
 * packaged configuration: preview, bind the plan to exactly the lagging repositories, then apply it
 * review-only. The same three steps the VS Code check runs through the CLI.
 */
export async function openConfigurationReviews({ registryFile, refresh = defaultRefresh } = {}) {
  const preview = await refresh({ registryFile, dryRun: true });
  const lagging = (preview?.results ?? [])
    .filter((entry) => entry.status === 'would-update' && entry.configurationChanged)
    .map((entry) => entry.repository);
  if (!lagging.length) return Object.freeze({ outcome: 'current', reviews: Object.freeze([]) });
  const bound = await refresh({ registryFile, repositories: lagging, dryRun: true });
  if (!bound?.planId) {
    return Object.freeze({ outcome: 'unavailable', reviews: Object.freeze([]), reason: 'The bound preview returned no plan.' });
  }
  const opened = await refresh({ registryFile, repositories: lagging, confirmPlan: bound.planId, reviewOnly: true });
  const reviews = (opened?.results ?? [])
    .filter((entry) => entry.status === 'review-required' && entry.proposalBranch)
    .map(({ repository, remote = null, proposalBranch }) => Object.freeze({ repository, remote, proposalBranch }));
  const failed = (opened?.results ?? []).filter((entry) => entry.error);
  return Object.freeze({
    outcome: reviews.length ? 'reviews-opened' : failed.length ? 'failed' : 'current',
    reviews: Object.freeze(reviews),
    ...(failed.length ? { reason: bounded(failed.map((entry) => `${entry.repository}: ${entry.error?.message ?? entry.error}`).join('; ')) } : {})
  });
}

/** The detached worker: run the pass for this build and record the outcome. Never throws. */
export async function runConfigurationReviewWorker({
  runningBuild,
  homeDirectory = os.homedir(),
  environment = process.env,
  open = openConfigurationReviews
} = {}) {
  let result;
  try {
    result = await open({ registryFile: workspaceRegistryFile(environment, homeDirectory) });
  } catch (error) {
    result = { outcome: 'failed', reviews: [], code: error?.code ?? null, reason: bounded(error?.message ?? error) };
  }
  await writeReviewEntry(homeDirectory, runningBuild, {
    status: 'complete', completedAt: new Date().toISOString(),
    outcome: result.outcome, reviews: [...(result.reviews ?? [])].map((entry) => ({ ...entry })),
    ...(result.reason ? { reason: result.reason } : {}), ...(result.code ? { code: result.code } : {})
  }).catch(() => undefined);
  return result;
}

function launchWorker({ environment, homeDirectory }) {
  // The worker never starts another pass, alignment or update of its own.
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
  // A worker that cannot start leaves its "running" entry to go stale; a later pass retries it.
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
 * Start this build's configuration-review pass in the background, once. It never waits for the
 * worker and never throws: a machine without registered workspaces, or with the pass switched off,
 * starts nothing.
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
    const stale = prior?.status === 'running'
      && !(now - Date.parse(prior.startedAt ?? '') < CONFIGURATION_REVIEW_RUNNING_STALE_MS);
    if (prior && !stale) return Object.freeze({ status: 'already', outcome: prior.outcome ?? null });
    await writeReviewEntry(homeDirectory, runningBuild, { status: 'running', startedAt: new Date(now).toISOString() });
    const launched = launch({ environment, homeDirectory });
    return Object.freeze({ status: 'started', pid: launched?.pid ?? null });
  } catch (error) {
    return Object.freeze({ status: 'failed', reason: bounded(error?.message ?? error) });
  }
}
