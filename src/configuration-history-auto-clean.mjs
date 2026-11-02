/**
 * Automatic configuration history cleanup, run after a publication that retains a history branch.
 *
 * Each approved configuration commit is kept behind its own `sflow/config-history/<commit>` branch,
 * so the remote's branch list grows by one per approved change. After such a publication this runs
 * `configuration cleanup-history` for the person who published: its preview, then its apply with
 * that preview's own confirmation, unchanged (leased, atomic, every retired branch archived as its
 * exact tag; the current approved commit and the most recent are never touched). One bounded batch
 * per run; the next publication continues.
 *
 * It is never part of the publication. The publication has already landed when this starts, and
 * nothing here throws: a failure, a refusal or an unknown outcome is returned as a note naming the
 * manual command, and the next publication tries again. `ledger.configurationHistory.autoClear:
 * false` turns it off; `keepRecent` (1-100, default 10) is the count kept as branches.
 */
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { assertCredentialFreeRemote, configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import { run } from './util.mjs';

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** The ledger's history settings with their defaults; a malformed value keeps the defaults. */
export function configurationHistorySettings(ledger) {
  const value = ledger?.configurationHistory;
  const keepRecent = Number.isInteger(value?.keepRecent) && value.keepRecent >= 1 && value.keepRecent <= 100
    ? value.keepRecent : 10;
  return { autoClear: value?.autoClear !== false, keepRecent };
}

const manualCommand = (keepRecent) => `singularity-flow configuration cleanup-history --keep-recent ${keepRecent} --json`;

/**
 * Retire old history branches on the ledger's remote. Returns null when switched off, otherwise a
 * small note: `current` (nothing to retire), `cleaned`, or `not-cleaned`/`outcome-unknown`/`failed`
 * with the manual command. `remaining` counts eligible branches left for a later run.
 */
export async function autoCleanConfigurationHistory(root, ledger, {
  env = process.env, runRemoteCommand = null, endpoint = null
} = {}) {
  const { autoClear, keepRecent } = configurationHistorySettings(ledger);
  if (!autoClear) return null;
  const command = manualCommand(keepRecent);
  const remoteName = String(ledger?.remote ?? 'origin');
  try {
    // The push endpoint the history branch was retained through: the caller's own, else resolved
    // as retainStateConfigurationHistory resolves it.
    let remote = endpoint;
    if (!remote) {
      const configured = configuredRemoteIdentity(root, remoteName, { direction: 'push', env: enterpriseGitEnvironment(env) });
      if (configured.ambiguous) {
        return { status: 'failed', archived: 0, remaining: null, command,
          message: 'The configuration history remote has more than one push authority; history was not cleaned.' };
      }
      remote = configured.configured && configured.url ? configured.url : assertCredentialFreeRemote(remoteName);
    }
    const { cleanupConfigurationHistory } = await import('./configuration-history-cleanup.mjs');
    const options = { keep: keepRecent, env, remote, ...(runRemoteCommand ? { runRemoteCommand } : {}) };
    const preview = await cleanupConfigurationHistory(root, options);
    if (!preview.candidates.length) return { status: 'current', archived: 0, remaining: preview.remaining };
    const result = await cleanupConfigurationHistory(root, { ...options, apply: true, confirm: preview.confirmation });
    pruneArchivedTrackingRefs(root, remoteName, result.archived ?? [], env);
    const archived = (result.archived ?? []).length;
    if (result.status === 'cleaned') return { status: 'cleaned', archived, remaining: result.remaining };
    return { status: result.status, archived, remaining: result.remaining, command,
      message: result.failure?.message ?? 'Configuration history was not cleaned; the next publication tries again.' };
  } catch (error) {
    return { status: 'failed', archived: 0, remaining: null, command, code: error?.code ?? null,
      message: `Configuration history was not cleaned: ${error?.message ?? String(error)}` };
  }
}

/**
 * Drop this checkout's tracking refs for the branches just archived, only where each still names
 * the archived commit. Nothing else local is touched: no local branch, tag or other tracking ref.
 */
function pruneArchivedTrackingRefs(root, remoteName, archived, env) {
  if (!REMOTE_NAME.test(remoteName)) return;
  for (const item of archived) {
    if (!/^sflow\/config-history\/[0-9a-f]{40,64}$/u.test(item?.branch ?? '')) continue;
    // update-ref -d with an old value deletes only an exact match; a missing or moved ref stays.
    run('git', ['update-ref', '-d', `refs/remotes/${remoteName}/${item.branch}`, item.commit],
      { cwd: root, env, allowFailure: true });
  }
}
