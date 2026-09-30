/** Retire one completed configuration review ref without weakening its approved history. */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import {
  CONFIGURATION_BRANCH, stateConfigurationHistoryBranch
} from './configuration-branch.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import { frozenRemoteTransport } from './git-remote-diagnostics.mjs';
import { GitRemoteSession, runRemoteGitAsync } from './git-execution.mjs';
import { gitCommitObjectExists, gitIsAncestor } from './git-ancestry.mjs';
import { executeGitQuery } from './git-query.mjs';
import { removeTemporaryTree } from './util.mjs';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEW_BRANCH = /^sflow\/config-change\/(?:capability|onboarding|workflow)\/[a-z0-9._/-]+$/u;

/**
 * Cleanup is deliberately a separate, best-effort transaction after activation. The caller must
 * supply the exact approved commit it just established. Local ancestry proof against that commit
 * is repeated before deletion. The fresh target observation and no-op anchor refspec bind that
 * proof to the remote at the instant the exact proposal ref is deleted.
 */
export async function cleanupActivatedConfigurationProposal(remote, branch, proposalCommit,
  approvedCommit, {
    proofRoot = null, env = process.env,
    remoteSession = null, runRemoteCommand = runRemoteGitAsync
  } = {}) {
  const base = { branch, proposalCommit };
  const retained = (reason) => ({ ...base, status: 'retained', reason });
  if (!REVIEW_BRANCH.test(branch) || branch.includes('..') || branch.includes('//')
      || branch.endsWith('/') || !OBJECT_ID.test(proposalCommit)
      || !OBJECT_ID.test(approvedCommit)) return retained('invalid-cleanup-input');

  let temporaryProofRoot = null;
  try {
    const gitEnv = enterpriseGitEnvironment(env);
    const session = remoteSession ?? new GitRemoteSession({
      env: gitEnv, runAsyncCommand: runRemoteCommand
    });
    const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
    const proposalRef = `refs/heads/${branch}`;
    const approvedRef = `refs/heads/${CONFIGURATION_BRANCH}`;
    const historyRef = `refs/heads/${stateConfigurationHistoryBranch(approvedCommit)}`;
    session.invalidate(remote);
    const before = await session.observeAsync(remote, {
      refs: [proposalRef, approvedRef, historyRef], includeHead: false, refresh: true
    });
    if (!before.ok) return retained('remote-observation-unavailable');
    const currentProposal = before.refs.get(proposalRef) ?? null;
    const currentApproved = before.refs.get(approvedRef) ?? null;
    if (currentApproved !== approvedCommit) return retained('approved-configuration-moved');
    if (currentProposal == null) return { ...base, status: 'already-absent' };
    if (currentProposal !== proposalCommit) return retained('proposal-moved');

    let localRoot = proofRoot;
    if (!localRoot) {
      temporaryProofRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-cleanup-'));
      const cloned = await runRemoteCommand([
        'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
        '--branch', CONFIGURATION_BRANCH, transport.remote, temporaryProofRoot
      ], { operation: 'remote-configuration', env: transport.env });
      if (cloned.status !== 0) return retained('ancestry-unavailable');
      localRoot = temporaryProofRoot;
    }
    // The source commit must remain reachable through the approved commit after its branch is
    // removed. A content-equivalent squash is deliberately insufficient.
    try {
      if (!gitCommitObjectExists(localRoot, proposalCommit, { env: transport.env })
          || !gitCommitObjectExists(localRoot, approvedCommit, { env: transport.env })) {
        return retained('proposal-not-in-approved-ancestry');
      }
      if (!gitIsAncestor(localRoot, proposalCommit, approvedCommit, { env: transport.env })) {
        return retained('proposal-not-in-approved-ancestry');
      }
      if (temporaryProofRoot) {
        const localHead = executeGitQuery(localRoot, 'repository.head', {}, {
          env: transport.env
        });
        if (localHead !== approvedCommit) return retained('approved-configuration-moved');
      }
    } catch { return retained('ancestry-unavailable'); }

    // A matching immutable history ref can anchor the approved commit without asking a provider
    // to accept a no-op update to its protected sflow/config branch. Otherwise the exact approved
    // ref itself is the atomic no-op guard. In either case the source ref has its own exact lease.
    const anchored = before.refs.get(historyRef) === approvedCommit;
    const guardRef = anchored ? historyRef : approvedRef;

    const pushed = await runRemoteCommand([
      'push', '--porcelain', '--atomic',
      `--force-with-lease=${proposalRef}:${proposalCommit}`,
      `--force-with-lease=${guardRef}:${approvedCommit}`,
      transport.remote, `:${proposalRef}`, `${approvedCommit}:${guardRef}`
    ], { cwd: localRoot, operation: 'remote-push', env: transport.env });
    // A lost receive-pack acknowledgement is not evidence that deletion failed. Conversely, a
    // successful exit is not evidence that the ref disappeared. Reconcile the exact destination.
    session.invalidate(remote);
    const after = await session.observeAsync(remote, {
      refs: [proposalRef], includeHead: false, refresh: true
    });
    if (!after.ok) return retained('deletion-outcome-unknown');
    const remaining = after.refs.get(proposalRef) ?? null;
    if (remaining == null) return {
      ...base, status: 'deleted', reconciled: pushed.status !== 0,
      anchor: anchored ? 'approved-history' : 'approved-configuration'
    };
    return retained(remaining === proposalCommit ? 'deletion-refused' : 'proposal-moved');
  } catch {
    return retained('cleanup-unavailable');
  } finally {
    if (temporaryProofRoot) await removeTemporaryTree(temporaryProofRoot).catch(() => {});
  }
}
