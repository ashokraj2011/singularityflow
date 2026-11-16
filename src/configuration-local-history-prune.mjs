/**
 * The local half of the upgrade's removal of superseded configuration refs [owner, 2026-11-16].
 *
 * Once the upgrade deleted a repository's `sflow/config-history/*` branches, their archive tags and its
 * `sflow/config-refresh/*` review branches on the remote, every registered clone of that repository still holds its
 * copies: tracking refs a plain fetch never prunes (SFlow's pins refspec turns `fetch --prune` off) and the archive tags
 * a fetch brought in. This removes those copies, in each registered clone, and nothing else.
 *
 * Only refs are deleted, each with `update-ref -d` against the exact object it held: never a working tree, index or
 * file, so a dirty tree is safe. Only tracking refs of the remotes that are this repository, and only names the remote
 * no longer holds. Never a local branch, `sflow/config`, `sflow/config-change/*`, the state branch, a Story or an
 * application branch, and never a tag outside `refs/tags/sflow/config-history/`. Never thrown: the remote is already
 * clean, and a clone that cannot be read or changed is reported.
 *
 * The same pass removes what is left after it [SCF stage 4, finding CH-F9]: the private refs that kept a configuration
 * commit for a retryable upload (`refs/singularity/transport/configuration/*` and `.../configuration-proposals/*`) once
 * that commit is in the history of the `sflow/config` commit just published, so it can never be needed again. One whose
 * commit is not there, or cannot be checked here, stays.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { supersededRefKind } from './configuration-superseded-refs.mjs';
import { withoutGitProcessOverrides } from './git-enterprise-environment.mjs';
import { executeGitQuery } from './git-query.mjs';
import { sourceContains } from './source-inspection.mjs';
import { sameGitRepository } from './git-repository-identity.mjs';
import { run } from './util.mjs';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TRACKING = /^refs\/remotes\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(sflow\/config-(?:history|refresh)\/.+)$/u;

/** This repository's remote names in one clone: those whose repository-local URL is the same repository. */
function matchingRemotes(root, remote, env) {
  const names = new Set();
  for (const name of executeGitQuery(root, 'repository.remotes', {}, { env })) {
    try {
      const url = executeGitQuery(root, 'repository.remote-url', { remote: name }, { env });
      if (url && sameGitRepository(url, remote)) names.add(name);
    } catch { /* A remote with no single literal URL is not provably this repository: its refs stay. */ }
  }
  return names;
}

/** The superseded copies one clone holds that the remote no longer does. */
function staleCopies(root, remote, remaining, env) {
  const remotes = matchingRemotes(root, remote, env);
  const stale = [];
  for (const [ref, object, symref] of executeGitQuery(root, 'configuration.local-superseded-refs', {}, { env })) {
    const entry = { ref, object };
    if (symref || !OBJECT_ID.test(object ?? '')) continue;
    const tracking = TRACKING.exec(entry.ref);
    if (tracking) {
      const remoteRef = `refs/heads/${tracking[2]}`;
      if (remotes.has(tracking[1]) && supersededRefKind(remoteRef) && !remaining.has(remoteRef)) {
        stale.push({ ...entry, kind: 'trackingRefs' });
      }
    } else if (supersededRefKind(entry.ref) === 'archiveTags' && !remaining.has(entry.ref)) {
      stale.push({ ...entry, kind: 'tags' });
    }
  }
  return stale;
}

/** The upload retention refs one clone holds whose commit `configurationCommit` already contains. */
function landedRetentions(root, configurationCommit, env) {
  if (!OBJECT_ID.test(configurationCommit ?? '')) return [];
  return executeGitQuery(root, 'configuration.local-transport-refs', {}, { env })
    .filter(([, object]) => OBJECT_ID.test(object ?? ''))
    .filter(([, object]) => {
      const contained = sourceContains(root, object, configurationCommit, { env, offline: true });
      return contained.status === 'present' && contained.value === true;
    })
    .map(([ref, object]) => ({ ref, object, kind: 'transportRefs' }));
}

/**
 * Remove the stale superseded copies from each registered clone of `remote`. `remaining` names the superseded refs the
 * remote still holds (refused or moved), which stay. With `configurationCommit`, the `sflow/config` commit just
 * published, upload retention refs it contains go too. Returns `{ pruned: { trackingRefs, tags, transportRefs },
 * clones, failed }`.
 */
export function pruneLocalSupersededConfigurationRefs(checkouts, remote, { remaining = [], configurationCommit = null, env = process.env } = {}) {
  const gitEnv = withoutGitProcessOverrides(env);
  const kept = new Set(remaining);
  const pruned = { trackingRefs: 0, tags: 0, transportRefs: 0 };
  const failed = [];
  let clones = 0;
  for (const checkout of [...new Set((checkouts ?? []).filter(Boolean).map((entry) => path.resolve(entry)))]) {
    if (!existsSync(checkout)) continue;
    let stale;
    try { stale = [...staleCopies(checkout, remote, kept, gitEnv), ...landedRetentions(checkout, configurationCommit, gitEnv)]; }
    catch { failed.push({ checkout, reason: 'Its refs could not be read.' }); continue; }
    clones += 1;
    for (const entry of stale) {
      // The exact object it held: a ref that moved since it was listed stays.
      const deleted = run('git', ['update-ref', '-d', entry.ref, entry.object], { cwd: checkout, env: gitEnv, allowFailure: true });
      if (deleted.status === 0) pruned[entry.kind] += 1;
      else failed.push({ checkout, ref: entry.ref, reason: 'Git refused to delete it.' });
    }
  }
  return { clones, pruned, total: pruned.trackingRefs + pruned.tags + pruned.transportRefs, failed };
}
