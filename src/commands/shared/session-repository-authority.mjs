/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKFLOW_PATH } from '../../config.mjs';
import { CONFIGURATION_SOURCE_PATH, CONFIGURATION_BRANCH } from '../../configuration-branch.mjs';
import { sessionRepositoryRemotes } from './session-repository-remotes.mjs';
import { fileAtRef, refExists } from '../../git.mjs';
import { configuredRemoteIdentity, frozenRemoteTransport } from '../../git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from '../../git-execution.mjs';

/**
 * A production bootstrap keeps approved configuration on `sflow/config`, not application `main`.
 * Treat the exact remote authority (or the current Story carrying its pinned snapshot) as
 * proof that the checkout is governed; requiring a working-tree copy made every fresh clone look
 * uninitialised until somebody manually checked out the Story branch.
 */
export async function sessionRepositoryAuthority(root, { remoteProbe = true, storyRef = null } = {}) {
  if (!root) return null;
  const workingTreeDefinition = existsSync(path.join(root, WORKFLOW_PATH));
  // An active Story carries its own immutable configuration source. Application branches can
  // retain an old workflow file, but that file must not shadow a current approved sflow/config.
  if (workingTreeDefinition && existsSync(path.join(root, CONFIGURATION_SOURCE_PATH))) {
    return { source: 'working-tree', remote: null };
  }
  for (const remote of sessionRepositoryRemotes(root)) {
    const configurationRef = `refs/remotes/${remote}/${CONFIGURATION_BRANCH}`;
    if (refExists(root, configurationRef)) {
      return { source: 'configuration-branch', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
  }
  // A --single-branch clone may not have fetched the configuration namespace yet. The session
  // operation is remote-backed anyway, so prove the authority without changing the checkout.
  // `session context` reads only the local Story, so it does not pay for a network round trip.
  for (const remote of remoteProbe ? sessionRepositoryRemotes(root) : []) {
    const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
    if (!identity.configured || identity.ambiguous) continue;
    const transport = frozenRemoteTransport(identity.url);
    const available = await runRemoteGitAsync([
      'ls-remote', '--heads', '--', transport.remote, `refs/heads/${CONFIGURATION_BRANCH}`
    ], {
      // The frozen transport carries the URL; the clone itself may be unreadable (git-storage-availability.mjs).
      cwd: os.tmpdir(), operation: 'remote-probe', env: transport.env
    });
    if (available.status === 0 && available.stdout.trim()) {
      return { source: 'configuration-remote', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
  }
  if (workingTreeDefinition) return { source: 'working-tree', remote: null };
  // Re-entering a named Story while sflow/config and its state mirror are unavailable: the Story's
  // published branch carries its own pinned definition. Only that named ref is read, never a scan of
  // every branch (Story discovery has no fallback scan); 5be0d63e dropped this route entirely.
  const named = typeof storyRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(storyRef) ? storyRef : null;
  for (const remote of named ? sessionRepositoryRemotes(root) : []) {
    const ref = `${remote}/${named}`;
    if (refExists(root, `refs/remotes/${ref}`) && fileAtRef(root, ref, WORKFLOW_PATH) !== null) {
      return { source: 'lifecycle-branch', remote, ref };
    }
  }
  return null;
}
