/**
 * Author shared configuration without ever borrowing the caller's application checkout.
 *
 * A Workflow Designer can be opened while a Story worktree is selected.  That Story contains a
 * pinned copy of `singularity/`, so writing there changes neither the approved configuration nor
 * future Stories; it only makes the current Story fail its protected-path gate.  Configuration
 * proposals therefore borrow `sflow/config` in a disposable clone, validate the edit there, and
 * publish one exact review commit.  The caller's HEAD, index and working tree stay byte-identical.
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';

import {
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, resolveConfigurationRemote
} from './configuration-branch.mjs';
import { isConfigurationReadPath } from './configuration-read-scope.mjs';
import { gitCommitIdentity } from './git.mjs';
import { sanitizeRemote } from './git-remote-diagnostics.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const REVIEW_PREFIX = 'sflow/config-change/workflow/';

function safeSlug(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/+|\.+(?=\/|$)/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new SingularityFlowError('A configuration proposal needs a safe operation identifier.', {
      code: 'CONFIGURATION_PROPOSAL_ID_INVALID'
    });
  }
  return normalized;
}

function matchingRemote(root, remoteUrl) {
  const names = run('git', ['remote'], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const match = names.find((name) => {
    const candidate = run('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true }).stdout.trim();
    return candidate && sanitizeRemote(candidate) === sanitizeRemote(remoteUrl);
  });
  if (match) return match;

  const preferred = 'sflow-configuration';
  const existing = run('git', ['remote', 'get-url', preferred], { cwd: root, allowFailure: true }).stdout.trim();
  if (existing && sanitizeRemote(existing) !== sanitizeRemote(remoteUrl)) {
    const suffix = createHash('sha256').update(sanitizeRemote(remoteUrl)).digest('hex').slice(0, 8);
    const alternate = `${preferred}-${suffix}`;
    const alternateUrl = run('git', ['remote', 'get-url', alternate], { cwd: root, allowFailure: true }).stdout.trim();
    if (alternateUrl && sanitizeRemote(alternateUrl) !== sanitizeRemote(remoteUrl)) {
      throw new SingularityFlowError(`Git remote '${alternate}' points somewhere other than the approved configuration authority.`, {
        code: 'CONFIGURATION_PROPOSAL_REMOTE_CONFLICT'
      });
    }
    if (!alternateUrl) run('git', ['remote', 'add', alternate, remoteUrl], { cwd: root });
    return alternate;
  }
  if (!existing) run('git', ['remote', 'add', preferred, remoteUrl], { cwd: root });
  return preferred;
}

function existingProposalCommit(root, remote, branch) {
  const result = runRemoteGit(['ls-remote', '--heads', '--', remote, `refs/heads/${branch}`], {
    cwd: root, operation: 'remote-probe'
  });
  if (result.status !== 0) {
    throw new SingularityFlowError(
      `The approved configuration authority could not be checked before publishing '${branch}'.`, {
        code: 'CONFIGURATION_PROPOSAL_AUTHORITY_UNAVAILABLE'
      }
    );
  }
  return result.stdout.trim().split(/\s+/)[0] || null;
}

/**
 * Refuse the legacy local edit path when the checkout contains an immutable Story snapshot.
 * Dedicated configuration review branches and initial, unpinned repositories keep their existing
 * local authoring behavior; the shared `--propose` route is available from either context.
 */
export function assertLocalConfigurationAuthoringAllowed(root) {
  if (!existsSync(path.join(root, CONFIGURATION_SOURCE_PATH))) return;
  const current = run('git', ['branch', '--show-current'], { cwd: root, allowFailure: true }).stdout.trim();
  if (current === CONFIGURATION_BRANCH || current.startsWith('sflow/config-change/')) return;
  throw new SingularityFlowError(
    `Workflow configuration is pinned in this Story checkout on '${current || 'detached HEAD'}'. `
    + 'Re-run the command with --propose to create a review branch from the approved sflow/config authority; '
    + 'the Story worktree will not be changed.', {
      code: 'WORKFLOW_AUTHORING_STORY_SNAPSHOT_REFUSED',
      details: { branch: current || null, configurationSource: CONFIGURATION_SOURCE_PATH }
    }
  );
}

/**
 * Create and publish one recoverable review proposal against the approved configuration branch.
 *
 * `mutate` receives only the disposable configuration checkout.  It must use the normal validated
 * authoring functions; this wrapper additionally proves every staged path belongs to configuration
 * before the commit is retained and pushed.
 */
export async function proposeConfigurationChange(root, {
  operation, subject, message, mutate
}, { transport = {} } = {}) {
  if (typeof mutate !== 'function') {
    throw new SingularityFlowError('A configuration proposal needs a mutation.', {
      code: 'CONFIGURATION_PROPOSAL_MUTATION_REQUIRED'
    });
  }
  const operationId = safeSlug(operation);
  const subjectId = safeSlug(subject);
  const remoteUrl = await resolveConfigurationRemote(root);
  if (!remoteUrl) {
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' authority is available. Refresh the workspace configuration, then retry.`, {
        code: 'CONFIGURATION_PROPOSAL_AUTHORITY_MISSING'
      }
    );
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  try {
    const cloned = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--branch', CONFIGURATION_BRANCH, remoteUrl, scratch
    ], { operation: 'remote-configuration' });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remoteUrl)}': `
        + `${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`, {
          code: 'CONFIGURATION_PROPOSAL_AUTHORITY_UNAVAILABLE'
        }
      );
    }

    const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    const result = await mutate(scratch);
    run('git', ['add', '-A'], { cwd: scratch });
    const files = run('git', ['diff', '--cached', '--name-only'], { cwd: scratch }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (!files.length) {
      return {
        ...result, changed: false, pushed: false, reviewRequired: false,
        branch: null, baseBranch: CONFIGURATION_BRANCH, baseCommit, files: []
      };
    }
    const escaped = files.filter((file) => !isConfigurationReadPath(file));
    if (escaped.length) {
      throw new SingularityFlowError(
        `Configuration proposal attempted to change non-configuration paths: ${escaped.join(', ')}.`, {
          code: 'CONFIGURATION_PROPOSAL_SCOPE_INVALID', details: { files: escaped }
        }
      );
    }

    const reviewBranch = `${REVIEW_PREFIX}${operationId}-${subjectId}-${baseCommit.slice(0, 8)}`;
    const nextAction = `Merge ${reviewBranch} into ${CONFIGURATION_BRANCH}, then run singularity-flow workspace refresh-configuration.`;
    const remote = matchingRemote(root, remoteUrl);
    const existingCommit = existingProposalCommit(root, remote, reviewBranch);
    if (existingCommit) {
      const fetched = runRemoteGit(['fetch', '--quiet', '--no-tags', 'origin', existingCommit], {
        cwd: scratch, operation: 'remote-configuration'
      });
      const existingTree = fetched.status === 0
        ? run('git', ['rev-parse', `${existingCommit}^{tree}`], { cwd: scratch, allowFailure: true }).stdout.trim()
        : null;
      const existingParent = fetched.status === 0
        ? run('git', ['rev-parse', `${existingCommit}^`], { cwd: scratch, allowFailure: true }).stdout.trim()
        : null;
      const proposedTree = run('git', ['write-tree'], { cwd: scratch }).stdout.trim();
      if (existingTree && existingTree === proposedTree && existingParent === baseCommit) {
        return {
          ...result,
          changed: true,
          pushed: true,
          reviewRequired: true,
          branch: reviewBranch,
          baseBranch: CONFIGURATION_BRANCH,
          baseCommit,
          commit: existingCommit,
          files,
          transportIntent: null,
          transportStatus: 'succeeded-existing',
          nextAction
        };
      }
      throw new SingularityFlowError(
        `Workflow configuration proposal '${reviewBranch}' already exists with different content or ancestry. Review and merge that proposal, `
        + 'or close it before creating a replacement; the approved configuration and Story checkout were not changed.', {
          code: 'CONFIGURATION_PROPOSAL_ALREADY_EXISTS',
          details: { branch: reviewBranch, baseBranch: CONFIGURATION_BRANCH, baseCommit }
        }
      );
    }

    run('git', ['switch', '--quiet', '-c', reviewBranch], { cwd: scratch });
    const actor = gitCommitIdentity(root);
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow contributor'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', String(message ?? '').trim() || `[configuration] ${operationId} ${subjectId}`
    ], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();

    const retained = run('git', ['fetch', '--no-tags', '--', scratch, commit], {
      cwd: root, allowFailure: true
    });
    if (retained.status !== 0) {
      throw new SingularityFlowError('The workflow proposal commit could not be retained for recoverable publication.', {
        code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED'
      });
    }
    run('git', ['update-ref', `refs/singularity/transport/configuration-proposals/${commit}`, commit], { cwd: root });
    const publication = await createAndPushTransportIntent({
      repositoryRoot: root,
      remote,
      sourceCommit: commit,
      targetRef: `refs/heads/${reviewBranch}`,
      expectedRemote: null,
      scope: {
        operation: `sflow.configuration.workflow.${operationId}`,
        subject: subjectId,
        baseBranch: CONFIGURATION_BRANCH,
        baseCommit,
        files
      }
    }, transport);
    if (publication.status !== 'succeeded') {
      throw new SingularityFlowError(
        `Workflow proposal ${reviewBranch} was retained but publication is ${publication.status}. `
        + `Run singularity-flow push status ${publication.intentId}.`, {
          code: 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING',
          details: { branch: reviewBranch, commit, intentId: publication.intentId, status: publication.status }
        }
      );
    }
    return {
      ...result,
      changed: true,
      pushed: true,
      reviewRequired: true,
      branch: reviewBranch,
      baseBranch: CONFIGURATION_BRANCH,
      baseCommit,
      commit,
      files,
      transportIntent: publication.intentId,
      transportStatus: publication.status,
      nextAction
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}
