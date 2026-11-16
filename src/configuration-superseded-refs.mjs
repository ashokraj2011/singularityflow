/**
 * The refs an upgrade supersedes, and their removal [owner, 2026-11-16].
 *
 * Once a repository's `sflow/config` holds this build's configuration, its `sflow/config-history/*` branches, the
 * archive tags history cleanup made of them, and its `sflow/config-refresh/*` review branches are superseded. Nothing
 * reads them: a Story reads its own pinned copy (singularity/configuration-source.json and the files it copied), and
 * every proof that once named a history ref fetches its commit by object instead. The upgrade deletes them on the
 * repository's remote, each under a lease on the exact commit it was seen at, so a ref that moved meanwhile stays.
 *
 * Nothing else is ever deleted: not `sflow/config`, not a `sflow/config-change/*` proposal (a person's own pending
 * edit), not the state branch, a Story branch or an application branch. The listing asks only for the three
 * namespaces above, and every name is checked against them again before it is pushed.
 *
 * Never part of the publication and never thrown: the configuration has already landed when this runs. A ref the
 * host refuses to delete (a deletion rule) is reported, holds up no other ref and no other repository, and is
 * harmless where it is.
 */
import { classifyGitHost } from './git-host.mjs';
import { frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, runRemoteGitAsync } from './git-execution.mjs';

export const CONFIGURATION_REF = 'refs/heads/sflow/config';
const NAMESPACES = Object.freeze([
  Object.freeze({ kind: 'history', prefix: 'refs/heads/sflow/config-history/' }),
  Object.freeze({ kind: 'archiveTags', prefix: 'refs/tags/sflow/config-history/' }),
  Object.freeze({ kind: 'reviews', prefix: 'refs/heads/sflow/config-refresh/' })
]);
export const SUPERSEDED_REF_PATTERNS = Object.freeze(NAMESPACES.map(({ prefix }) => `${prefix}*`));
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_REF = /^refs\/(?:heads|tags)\/sflow\/config-(?:history|refresh)\/[A-Za-z0-9._/-]+$/u;
// One push stays well inside a Windows command line (32,767 characters), as proposal fetches do (CH-F7).
const MAX_PUSH_ARGUMENT_CHARACTERS = 24 * 1024;
// A batch the host refuses as a whole is retried in halves to find the refs it would delete; a namespace-wide
// deletion rule refuses every half, so the retries stop here and the rest are reported refused.
const MAX_ISOLATING_PUSHES = 16;
const REFUSED_REASON = 'The host refused to delete it, most likely a deletion rule on this branch or tag name. '
  + 'It is harmless where it is: nothing reads it.';

/** Which superseded namespace a ref is in, or null for every other ref. */
export function supersededRefKind(ref) {
  const name = String(ref ?? '');
  if (!SAFE_REF.test(name) || name.includes('..') || name.includes('//') || name.endsWith('/')) return null;
  return NAMESPACES.find(({ prefix }) => name.startsWith(prefix) && name.length > prefix.length)?.kind ?? null;
}

function emptyCounts() {
  return { history: 0, archiveTags: 0, reviews: 0 };
}

function countByKind(refs) {
  const counts = emptyCounts();
  for (const ref of refs) counts[supersededRefKind(ref)] += 1;
  return counts;
}

/** Leased deletes in pushes that each fit a command line. */
function pushBatches(entries) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const entry of entries) {
    const cost = 2 * entry.ref.length + entry.commit.length + 40;
    if (current.length && size + cost > MAX_PUSH_ARGUMENT_CHARACTERS) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Delete every superseded configuration ref on `remote` once its `sflow/config` is `configurationCommit`.
 *
 * Returns `{ status, removed: { history, archiveTags, reviews }, refused: [{ ref, kind, reason }], remaining, found }`, where
 * `remaining` names the superseded refs the remote still holds afterwards (refused, or moved since they were listed), and
 * status is `current` (none were there), `removed`, `partial` (some refused), `skipped` (sflow/config is not the
 * expected commit: it moved, so nothing is superseded by this run) or `unavailable` (the remote could not be read).
 * `keep` names refs to leave even when they match, such as a review branch this run just opened.
 */
export async function removeSupersededConfigurationRefs(remote, {
  configurationCommit, cwd = undefined, env = process.env, keep = [],
  runRemoteCommand = runRemoteGitAsync
} = {}) {
  const base = { removed: emptyCounts(), refused: [], found: emptyCounts() };
  try {
    if (!OBJECT_ID.test(String(configurationCommit ?? ''))) return { status: 'skipped', reason: 'no-configuration-commit', ...base };
    const session = new GitRemoteSession({
      env, runAsyncCommand: (args, options) => runRemoteCommand(args, { ...options, ...(cwd ? { cwd } : {}) })
    });
    const listed = await session.observeAsync(remote, {
      refs: [CONFIGURATION_REF, ...SUPERSEDED_REF_PATTERNS], includeHead: false, refresh: true
    });
    if (!listed.ok) return { status: 'unavailable', reason: listed.failure?.advice ?? 'The remote could not be read.', ...base };
    if (listed.refs.get(CONFIGURATION_REF) !== configurationCommit) return { status: 'skipped', reason: 'configuration-moved', ...base };
    const kept = new Set(keep);
    const candidates = [...listed.refs]
      .filter(([ref, commit]) => supersededRefKind(ref) && !kept.has(ref) && OBJECT_ID.test(String(commit)))
      .map(([ref, commit]) => ({ ref, commit }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const found = countByKind(candidates.map((entry) => entry.ref));
    if (!candidates.length) return { status: 'current', ...base, remaining: [], found };

    const transport = frozenRemoteTransport(remote, { push: true, env });
    const moved = new Set();
    const remaining = async (entries) => {
      const observed = await session.observeAsync(remote, {
        refs: SUPERSEDED_REF_PATTERNS, includeHead: false, refresh: true
      });
      if (!observed.ok) return null;
      // A ref that moved after it was listed kept its lease: it is not this run's to delete, nor counted as removed.
      for (const entry of entries) {
        const now = observed.refs.get(entry.ref);
        if (now !== undefined && now !== entry.commit) moved.add(entry.ref);
      }
      return entries.filter((entry) => observed.refs.get(entry.ref) === entry.commit);
    };
    const push = (entries) => runRemoteCommand([
      'push', '--porcelain',
      ...entries.map((entry) => `--force-with-lease=${entry.ref}:${entry.commit}`),
      transport.remote, ...entries.map((entry) => `:${entry.ref}`)
    ], { ...(cwd ? { cwd } : {}), operation: 'remote-push', env: transport.env });

    let isolatingPushes = 0;
    const refused = [];
    const deleteBatch = async (entries) => {
      await push(entries);
      // The acknowledgement can be lost and a success can hide a refusal: read the refs back.
      const left = await remaining(entries);
      if (left == null) {
        refused.push(...entries.map((entry) => ({ ...entry, unknown: true })));
        return;
      }
      if (!left.length) return;
      // Some went: the host judged each ref on its own, and the ones left were each refused.
      if (left.length < entries.length || left.length === 1 || isolatingPushes + 2 > MAX_ISOLATING_PUSHES) {
        refused.push(...left);
        return;
      }
      // Refused whole: one ruleset or hook verdict can cover every ref of a push. Halve it, so a ref the host would
      // delete is not kept for another's refusal.
      const middle = Math.ceil(left.length / 2);
      isolatingPushes += 2;
      await deleteBatch(left.slice(0, middle));
      await deleteBatch(left.slice(middle));
    };
    // One namespace per push: a deletion rule usually covers one name pattern, and holds up only that one.
    for (const { kind } of NAMESPACES) {
      for (const batch of pushBatches(candidates.filter((entry) => supersededRefKind(entry.ref) === kind))) {
        await deleteBatch(batch);
      }
    }

    const refusedRefs = new Set(refused.map((entry) => entry.ref));
    const removed = countByKind(candidates.filter((entry) => !refusedRefs.has(entry.ref) && !moved.has(entry.ref))
      .map((entry) => entry.ref));
    return {
      status: refused.length ? 'partial' : 'removed',
      removed,
      remaining: [...new Set([...refusedRefs, ...moved])].sort(),
      refused: refused.map((entry) => ({
        ref: entry.ref, kind: supersededRefKind(entry.ref),
        reason: entry.unknown ? 'Whether it was deleted could not be read back; the next upgrade tries again.' : REFUSED_REASON
      })),
      found
    };
  } catch (error) {
    return { status: 'unavailable', reason: String(error?.message ?? error).slice(0, 300), ...base };
  }
}

/** Total refs removed, and the words for them: "N old history and review branches" and any archive tags. */
export function removedRefsSummary(removed) {
  const branches = Number(removed?.history ?? 0) + Number(removed?.reviews ?? 0);
  const tags = Number(removed?.archiveTags ?? 0);
  const parts = [];
  if (branches) parts.push(`${branches} old history and review branch${branches === 1 ? '' : 'es'}`);
  if (tags) parts.push(`${tags} history archive tag${tags === 1 ? '' : 's'}`);
  return { total: branches + tags, text: parts.join(' and ') };
}

/**
 * A link that opens the host's compare view of `head` against `base`, where the host is one whose compare URL is
 * known (GitHub and GitHub Enterprise); null otherwise. Read from the URL alone; nothing is fetched.
 */
export function compareLink(remote, base, head) {
  const value = String(remote ?? '').trim();
  const { provider, host } = classifyGitHost(value);
  if (provider !== 'github' || !host) return null;
  const scp = /^(?:[^@/\s:]+@)?[^:/\s]+:(?!\/\/)(.+)$/u.exec(value);
  let repositoryPath = null;
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) repositoryPath = scp[1];
  else {
    try { repositoryPath = new URL(value).pathname; } catch { return null; }
  }
  const pieces = String(repositoryPath).replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '').split('/');
  if (pieces.length !== 2 || pieces.some((piece) => !/^[A-Za-z0-9._-]{1,100}$/u.test(piece))) return null;
  return `https://${host}/${pieces[0]}/${pieces[1]}/compare/${encodeURI(base)}...${encodeURI(head)}?expand=1`;
}
