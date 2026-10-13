/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { WORKFLOW_PATH } from '../../config.mjs';
import { CONFIGURATION_SOURCE_PATH, CONFIGURATION_BRANCH } from '../../configuration-branch.mjs';
import { sessionRepositoryRemotes } from './session-repository-remotes.mjs';
import { refExists, remoteBranches, fileAtRef } from '../../git.mjs';
import { configuredRemoteIdentity, frozenRemoteTransport } from '../../git-remote-diagnostics.mjs';
import { runRemoteGitAsync } from '../../git-execution.mjs';

/**
 * A production bootstrap keeps approved configuration on `sflow/config`, not application `main`.
 * Treat the remote authority (or an already-published lifecycle branch carrying its snapshot) as
 * proof that the checkout is governed; requiring a working-tree copy made every fresh clone look
 * uninitialised until somebody manually checked out the Story branch.
 */
export async function sessionRepositoryAuthority(root, { remoteProbe = true } = {}) {
  if (!root) return null;
  const workingTreeDefinition = existsSync(path.join(root, WORKFLOW_PATH));
  // An active Story carries its own immutable configuration source. Application branches can
  // retain an old workflow file, but that file must not shadow a current approved sflow/config.
  if (workingTreeDefinition && existsSync(path.join(root, CONFIGURATION_SOURCE_PATH))) {
    return { source: 'working-tree', remote: null };
  }
  let localLifecycle = null;
  for (const remote of sessionRepositoryRemotes(root)) {
    const configurationRef = `refs/remotes/${remote}/${CONFIGURATION_BRANCH}`;
    if (refExists(root, configurationRef)) {
      return { source: 'configuration-branch', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
    const storyRef = remoteBranches(root, remote)
      .map((branchName) => `${remote}/${branchName}`)
      .find((ref) => fileAtRef(root, ref, WORKFLOW_PATH) !== null);
    if (storyRef && !localLifecycle) {
      localLifecycle = { source: 'lifecycle-branch', remote, ref: storyRef };
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
      cwd: root, operation: 'remote-probe', env: transport.env
    });
    if (available.status === 0 && available.stdout.trim()) {
      return { source: 'configuration-remote', remote, ref: `${remote}/${CONFIGURATION_BRANCH}` };
    }
  }
  return localLifecycle ?? (workingTreeDefinition ? { source: 'working-tree', remote: null } : null);
}
