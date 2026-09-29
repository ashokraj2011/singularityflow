/**
 * Whether this build still owes the machine its one first-run pass: aligning the product surfaces
 * and repairing machine-local state.
 *
 * Checked before every mutation command, so it must stay cheap: no Git, no subprocess, and none of
 * the installer modules. It answers from one small file and the running build's own stamp. The
 * pass itself, with its full validation, loads only when this returns a build.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INFO, versionLine } from './build-info.mjs';

export const PRODUCT_ALIGNMENT_SWITCH = 'SINGULARITY_FLOW_PRODUCT_ALIGNMENT';

/** Commands that own the product surfaces themselves, or that alignment runs. */
export const PRODUCT_ALIGNMENT_EXEMPT_COMMANDS = Object.freeze(new Set([
  'product', 'plugin', 'reinstall', 'fresh-install', 'factory-reset', 'reset-all', 'local-reset'
]));

export function productAlignmentDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[PRODUCT_ALIGNMENT_SWITCH] ?? '').trim().toLowerCase());
}

/** The running build line when a pass is due, or null. Never throws. */
export async function firstRunPassDue({
  command,
  classification,
  homeDirectory = os.homedir(),
  environment = process.env,
  info = BUILD_INFO
} = {}) {
  try {
    if (classification !== 'mutation' || PRODUCT_ALIGNMENT_EXEMPT_COMMANDS.has(command)) return null;
    if (productAlignmentDisabled(environment)) return null;
    // A development checkout cannot be told apart from another one, and never replaces anything.
    if (!info?.commit && !info?.sourceSha256) return null;
    const running = versionLine(info);
    const installations = path.join(homeDirectory, '.singularity-flow', 'installations');
    try {
      const recorded = JSON.parse(await readFile(path.join(installations, 'alignment-current.json'), 'utf8'));
      if (recorded?.builds && Object.hasOwn(recorded.builds, running)) return null;
    } catch { /* No pass recorded yet. */ }
    return running;
  } catch {
    return null;
  }
}

export const CONFIGURATION_REVIEWS_SWITCH = 'SINGULARITY_FLOW_CONFIGURATION_REVIEWS';
/** A worker still "running" after this long died; its lease is reclaimable and the pass may run again. */
export const CONFIGURATION_REVIEW_RUNNING_STALE_MS = 30 * 60 * 1000;
/** A pass that failed, or could not check every repository, is tried again after this long. */
export const CONFIGURATION_REVIEW_RETRY_MS = 60 * 60 * 1000;
/** Commands that refresh configuration in the foreground and own the refresh cache while they do. */
const FOREGROUND_REFRESHES = new Set(['refresh-configuration', 'reinitialize']);

export function configurationReviewsDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[CONFIGURATION_REVIEWS_SWITCH] ?? '').trim().toLowerCase());
}

export function foregroundConfigurationRefresh(command, subcommand) {
  return command === 'workspace' && FOREGROUND_REFRESHES.has(subcommand);
}

/** Whether a recorded pass needs running again: it failed, or left repositories unchecked. */
export function configurationReviewRetryable(entry) {
  return ['failed', 'unavailable'].includes(entry?.outcome) || (entry?.unfinished?.length ?? 0) > 0;
}

/**
 * The running build line when this build's configuration-review pass is due again, or null.
 *
 * The first-run pass starts a build's first pass; a terminal has no other trigger, so a pass that
 * failed, left repositories unchecked, or whose worker died is retried from here by any later
 * mutation, at most hourly. One small file read; never throws.
 */
export async function configurationReviewRetryDue({
  command,
  subcommand = null,
  classification,
  homeDirectory = os.homedir(),
  environment = process.env,
  info = BUILD_INFO,
  now = Date.now()
} = {}) {
  try {
    if (classification !== 'mutation' || PRODUCT_ALIGNMENT_EXEMPT_COMMANDS.has(command)) return null;
    if (configurationReviewsDisabled(environment) || foregroundConfigurationRefresh(command, subcommand)) return null;
    if (!info?.commit && !info?.sourceSha256) return null;
    const running = versionLine(info);
    const file = path.join(homeDirectory, '.singularity-flow', 'installations', 'configuration-reviews.json');
    const entry = JSON.parse(await readFile(file, 'utf8'))?.builds?.[running];
    if (entry?.status === 'running') {
      return now - Date.parse(entry.startedAt ?? '') >= CONFIGURATION_REVIEW_RUNNING_STALE_MS ? running : null;
    }
    if (entry?.status !== 'complete' || !configurationReviewRetryable(entry)) return null;
    return now - Date.parse(entry.completedAt ?? '') >= CONFIGURATION_REVIEW_RETRY_MS ? running : null;
  } catch {
    return null;
  }
}
