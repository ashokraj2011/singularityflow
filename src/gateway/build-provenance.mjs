/**
 * Read-only build evidence, normalized, and what it may and may not be used to claim.
 * `[INT:IFC-041]` `[INT:CON-093]` `[INT:REQ-094]` `[INT:CON-094]` `[INT:REQ-153]`
 *
 * There were no build-provider adapters at all before this module. It supplies the provider-neutral
 * record every adapter normalizes into, one reference adapter (GitHub Actions, through `gh`'s own
 * authentication — D6), and the one rule that matters most: a build is said to *contain* a change
 * only when it is bound to an exact source commit and Git ancestry relates the two. A build with no
 * exact commit, or one related by nothing but time, is "observed near", a "candidate range" or
 * "mapping unavailable" — never "introduced in".
 *
 * Providers are configured, never discovered: an unconfigured repository has no build evidence, and
 * says so as a gap rather than guessing that a GitHub remote means GitHub Actions. The configuration
 * is machine-local and names a provider kind only; credentials stay in the provider's own store
 * `[INT:CON-132]`. Rerun, cancel, approve, deploy, promote and edit do not exist here.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { activeWorkspaceFile } from '../workspace-context.mjs';

export const BUILD_PROVIDERS = Object.freeze(['github-actions']);

/** The normalized fields every adapter returns, in this order `[INT:IFC-041]`. */
export const BUILD_RECORD_FIELDS = Object.freeze([
  'provider', 'pipeline', 'buildId', 'sourceCommit', 'branch', 'artifact', 'result',
  'startedAt', 'completedAt', 'providerReference', 'retrievedAt'
]);

/** How a build may be related to a commit. Only `built-from` and `contains` are claims of content. */
export const BUILD_RELATIONS = Object.freeze(['built-from', 'contains', 'does-not-contain', 'observed-near', 'mapping-unavailable']);

const EXACT_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/u;

export function buildProviderFile(env = process.env) {
  return path.join(path.dirname(activeWorkspaceFile(env)), 'build-providers.json');
}

/** The provider configured for a repository, or null. Keys are repository IDs or remote URLs. */
export async function configuredBuildProvider({ repositoryId = null, remote = null, env = process.env } = {}) {
  let configuration;
  try { configuration = JSON.parse(await readFile(buildProviderFile(env), 'utf8')); } catch { return null; }
  const entry = configuration?.repositories?.[repositoryId] ?? configuration?.repositories?.[remote] ?? null;
  if (!entry || !BUILD_PROVIDERS.includes(entry.kind)) return entry ? { kind: entry.kind, supported: false } : null;
  return { kind: entry.kind, supported: true, remote: entry.remote ?? remote };
}

/** One provider record in the neutral shape. An inexact commit is dropped, never shortened or guessed. */
export function normalizeBuild(provider, raw, retrievedAt) {
  if (provider === 'github-actions') {
    const commit = String(raw?.headSha ?? '').toLowerCase();
    return Object.freeze({
      provider,
      pipeline: raw?.workflowName ?? null,
      buildId: raw?.databaseId == null ? null : String(raw.databaseId),
      sourceCommit: EXACT_COMMIT.test(commit) ? commit : null,
      branch: raw?.headBranch ?? null,
      artifact: raw?.displayTitle ?? null,
      result: raw?.conclusion || raw?.status || null,
      startedAt: raw?.createdAt ?? null,
      completedAt: raw?.status === 'completed' ? raw?.updatedAt ?? null : null,
      providerReference: raw?.url ?? null,
      retrievedAt
    });
  }
  throw new TypeError(`'${provider}' has no adapter.`);
}

/**
 * What one build can be said to show about one commit. `isAncestor(older, newer)` is Git's answer:
 * true, false, or null when Git cannot say here (see `gitAncestry`).
 *
 * The language is part of the result, so no surface has to decide how strongly to phrase it.
 */
export function buildRelation(build, commit, { isAncestor }) {
  if (!build?.sourceCommit || !commit) {
    return { relation: build?.startedAt ? 'observed-near' : 'mapping-unavailable', language: build?.startedAt ? 'observed near' : 'mapping unavailable' };
  }
  if (build.sourceCommit === commit) return { relation: 'built-from', language: 'built from this commit' };
  const ancestor = isAncestor(commit, build.sourceCommit);
  if (ancestor == null) return { relation: 'mapping-unavailable', language: 'mapping unavailable (its commit is not in this clone)' };
  if (ancestor) return { relation: 'contains', language: 'contains this commit' };
  return { relation: 'does-not-contain', language: 'does not contain this commit' };
}

/**
 * Git's ancestry answer for build relations in one repository.
 *
 * A provider reports the commit it built, and nothing says this clone has it — a fork, a force-push,
 * a stale or shallow clone — and `merge-base` on a missing object fails outright, which took a whole
 * build.read, impact.quick or investigation down with one build. So each commit's presence is read
 * first, through the typed read that resolves any revision, and Git's answer for an absent one is
 * null: that build's mapping is unavailable, and every other build still relates.
 */
export async function gitAncestry(root) {
  const { typedMergeBase, typedRevision } = await import('../git-access.mjs');
  const present = new Map();
  const has = (commit) => {
    if (!present.has(commit)) present.set(commit, typedRevision(root, commit) === commit);
    return present.get(commit);
  };
  return (older, newer) => {
    if (!has(older) || !has(newer)) return null;
    try { return typedMergeBase(root, older, newer) === older; } catch { return null; }
  };
}

/**
 * The last passing and first failing build around a commit range, from exact provenance only.
 * Builds without an exact commit are listed and excluded from the boundary; a boundary drawn
 * through one would be the claim this module exists to stop.
 */
export function buildBoundary(builds) {
  const exact = builds.filter((build) => build.sourceCommit && build.completedAt)
    .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
  let lastGood = null;
  for (const build of exact) {
    if (build.result === 'success') lastGood = build;
    else if (['failure', 'timed_out', 'startup_failure'].includes(build.result) && lastGood) {
      return { lastGood, firstBad: build, language: 'candidate range' };
    }
  }
  return null;
}

/**
 * Read builds through the configured adapter, or say why there are none `[INT:REQ-153]`.
 * `githubActionsRuns` is the gh read in `github-evidence.mjs`; injectable so tests need no network.
 */
export async function readBuilds(root, { repositoryId = null, remote = null, branch = null, limit = 30, env = process.env,
  now = () => new Date(), runs = null } = {}) {
  const provider = await configuredBuildProvider({ repositoryId, remote, env });
  if (!provider) return { provider: null, builds: [], gap: 'build-provider-not-configured' };
  if (!provider.supported) return { provider: provider.kind, builds: [], gap: 'build-provider-unsupported' };
  const retrievedAt = now().toISOString();
  try {
    const read = runs ?? (await import('../github-evidence.mjs')).githubActionsRuns;
    const raw = await read(root, provider.remote, { branch, limit });
    return { provider: provider.kind, builds: (Array.isArray(raw) ? raw : []).map((entry) => normalizeBuild(provider.kind, entry, retrievedAt)), gap: null };
  } catch (error) {
    return { provider: provider.kind, builds: [], gap: 'build-provider-unavailable', detail: String(error?.message ?? error).slice(0, 200) };
  }
}
