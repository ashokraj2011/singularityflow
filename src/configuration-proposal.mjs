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
import YAML from 'yaml';

import {
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, resolveConfigurationRemote
} from './configuration-branch.mjs';
import { validateDefinition } from './config.mjs';
import { isConfigurationReadPath } from './configuration-read-scope.mjs';
import { gitCommitIdentity } from './git.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, redactDiagnosticText, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { GitRemoteSession, runRemoteGit } from './git-execution.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const REVIEW_PREFIX = 'sflow/config-change/workflow/';

function quoted(value) { return JSON.stringify(String(value ?? '')); }

function workflowProposalCommand(action, branch, commit = null, acknowledge = false) {
  const args = ['singularity-flow', 'workflow', action];
  if (branch) args.push(quoted(branch));
  if (commit) args.push('--confirm', quoted(commit));
  if (acknowledge) args.push('--acknowledge-unprotected');
  args.push('--json');
  return args.join(' ');
}

function workflowProposalBranch(value) {
  const branch = String(value ?? '').trim();
  if (!branch.startsWith(REVIEW_PREFIX)
      || !/^sflow\/config-change\/workflow\/[a-z0-9._/-]+$/.test(branch)
      || branch.includes('..') || branch.includes('//') || branch.endsWith('/')) {
    throw new SingularityFlowError(
      `Workflow proposal must be a branch beneath '${REVIEW_PREFIX}'.`,
      { code: 'WORKFLOW_PROPOSAL_BRANCH_INVALID' }
    );
  }
  return branch;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stable(value) { return JSON.stringify(canonical(value)); }

function yamlAtRef(root, ref, relative) {
  const shown = run('git', ['show', `${ref}:${relative}`], { cwd: root, allowFailure: true });
  if (shown.status !== 0) return {};
  return YAML.parse(shown.stdout) ?? {};
}

function workflowChanges(root, base, proposal) {
  const baseDefinition = yamlAtRef(root, base, 'singularity/workflow.yml');
  const proposedDefinition = yamlAtRef(root, proposal, 'singularity/workflow.yml');
  const basePortfolio = yamlAtRef(root, base, 'singularity/portfolio.yml');
  const proposedPortfolio = yamlAtRef(root, proposal, 'singularity/portfolio.yml');
  const rows = [];
  for (const [governs, before, after] of [
    ['story', baseDefinition.workTypes ?? {}, proposedDefinition.workTypes ?? {}],
    ['initiative', basePortfolio.initiativeProfiles ?? {}, proposedPortfolio.initiativeProfiles ?? {}]
  ]) {
    for (const id of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (stable(before[id]) === stable(after[id])) continue;
      const profile = after[id] ?? before[id] ?? {};
      rows.push({
        id,
        governs,
        change: !Object.hasOwn(before, id) ? 'added' : !Object.hasOwn(after, id) ? 'removed' : 'modified',
        label: profile.label ?? id,
        phases: profile.phases ?? []
      });
    }
  }
  return rows;
}

function changedConfigurationFiles(root, base, proposal) {
  const names = run('git', ['diff', '--name-only', `${base}..${proposal}`], { cwd: root })
    .stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const statuses = run('git', ['diff', '--name-status', `${base}..${proposal}`], { cwd: root })
    .stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [status, ...paths] = entry.split('\t');
      return { status, paths };
    });
  return { names, statuses };
}

function inspectWorkflowProposalCheckout(root, remote, branch, ref, { includeDiff = true } = {}) {
  const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const proposalCommit = run('git', ['rev-parse', ref], { cwd: root }).stdout.trim();
  const proposalBase = run('git', ['rev-parse', `${ref}^`], { cwd: root }).stdout.trim();
  const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], { cwd: root, allowFailure: true });
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    throw new SingularityFlowError(
      `Workflow proposal '${branch}' does not share history with '${CONFIGURATION_BRANCH}'.`,
      { code: 'WORKFLOW_PROPOSAL_HISTORY_INVALID' }
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const merged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
    cwd: root, allowFailure: true
  }).status === 0;
  const reviewBase = merged ? proposalBase : mergeBase;
  const changed = changedConfigurationFiles(root, reviewBase, ref);
  const invalidFiles = changed.names.filter((file) => !isConfigurationReadPath(file));
  const diff = includeDiff
    ? run('git', ['diff', '--no-ext-diff', '--unified=3', `${reviewBase}..${ref}`], { cwd: root }).stdout
    : null;
  return {
    remote: sanitizeRemote(remote), branch, targetBranch: CONFIGURATION_BRANCH,
    targetCommit, proposalCommit, proposalBase, mergeBase, merged,
    valid: changed.names.length > 0 && invalidFiles.length === 0,
    invalidFiles, changedFiles: changed.statuses,
    workflows: workflowChanges(root, reviewBase, ref),
    diff: diff == null ? null
      : diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated …\n` : diff,
    diffDeferred: diff == null
  };
}

async function proposalRemote(root) {
  const remote = await resolveConfigurationRemote(root);
  if (!remote) {
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' authority is available. Refresh workspace configuration first.`,
      { code: 'WORKFLOW_PROPOSAL_AUTHORITY_MISSING' }
    );
  }
  return remote;
}

async function withWorkflowProposalCheckout(root, requestedBranch, operation) {
  const branch = workflowProposalBranch(requestedBranch);
  const remote = await proposalRemote(root);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-review-'));
  try {
    const cloned = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, remote, scratch
    ], { operation: 'remote-configuration' });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    const fetched = runRemoteGit([
      'fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    ], { cwd: scratch, operation: 'remote-configuration' });
    if (fetched.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read workflow proposal '${branch}'. ${fetched.failure?.advice ?? 'Git fetch failed.'}`,
        { code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_UNAVAILABLE' }
      );
    }
    return await operation(scratch, remote, branch, `refs/remotes/origin/${branch}`);
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** List durable workflow-review branches without changing the selected Story checkout. */
export async function listWorkflowConfigurationProposals(root, {
  includeMerged = false, includeDiff = false
} = {}) {
  const remote = await proposalRemote(root);
  const advertised = runRemoteGit([
    'ls-remote', '--heads', '--', remote,
    `refs/heads/${CONFIGURATION_BRANCH}`, `refs/heads/${REVIEW_PREFIX}*`
  ], { operation: 'remote-probe' });
  if (advertised.status !== 0) {
    throw new SingularityFlowError(
      `Cannot list workflow proposals on '${sanitizeRemote(remote)}'. ${advertised.failure?.advice ?? 'Git remote is unavailable.'}`,
      { code: advertised.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
    );
  }
  const branches = advertised.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
    .filter(([, ref]) => ref?.startsWith(`refs/heads/${REVIEW_PREFIX}`))
    .map(([proposalCommit, ref]) => ({ proposalCommit, branch: ref.replace(/^refs\/heads\//, '') }))
    .sort((left, right) => left.branch.localeCompare(right.branch));
  if (!branches.length) return [];
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposals-'));
  try {
    const cloned = runRemoteGit([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, remote, scratch
    ], { operation: 'remote-configuration' });
    if (cloned.status !== 0) throw new SingularityFlowError(cloned.failure?.advice ?? 'Workflow authority clone failed.');
    const fetched = runRemoteGit([
      'fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
      `+refs/heads/${REVIEW_PREFIX}*:refs/remotes/origin/${REVIEW_PREFIX}*`
    ], { cwd: scratch, operation: 'remote-configuration' });
    if (fetched.status !== 0) throw new SingularityFlowError(fetched.failure?.advice ?? 'Workflow proposals could not be fetched.');
    const proposals = [];
    for (const entry of branches) {
      const ref = `refs/remotes/origin/${entry.branch}`;
      if (!includeMerged && run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
        cwd: scratch, allowFailure: true
      }).status === 0) continue;
      try {
        proposals.push(inspectWorkflowProposalCheckout(
          scratch, remote, entry.branch, ref, { includeDiff }
        ));
      } catch (error) {
        proposals.push({
          remote: sanitizeRemote(remote), branch: entry.branch, targetBranch: CONFIGURATION_BRANCH,
          targetCommit: null, proposalCommit: entry.proposalCommit, merged: false, valid: false,
          invalidFiles: [], changedFiles: [], workflows: [], diff: null, diffDeferred: true,
          status: 'unreadable', failure: { code: error.code ?? 'WORKFLOW_PROPOSAL_UNREADABLE', message: error.message }
        });
      }
    }
    return proposals;
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Exact commits, changed files, affected workflows, and diff for one review proposal. */
export async function inspectWorkflowConfigurationProposal(root, branch) {
  return withWorkflowProposalCheckout(root, branch, (scratch, remote, proposalBranch, ref) =>
    inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref));
}

/**
 * Activate one exact reviewed workflow proposal using an exact compare-and-swap update.
 * Protected branches remain under their repository review controls; an unprotected direct update
 * requires a separate explicit acknowledgement.
 */
export async function activateWorkflowConfigurationProposal(root, branch, {
  confirm = null, acknowledgeUnprotected = false
} = {}) {
  return withWorkflowProposalCheckout(root, branch, async (scratch, remote, proposalBranch, ref) => {
    const reviewed = inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref);
    if (String(confirm ?? '').trim() !== reviewed.proposalCommit) {
      const nextAction = workflowProposalCommand('activate', proposalBranch, reviewed.proposalCommit);
      throw new SingularityFlowError(
        `Confirmation must be the exact workflow proposal commit '${reviewed.proposalCommit}'. Nothing was changed. Re-run: ${nextAction}`,
        { code: 'WORKFLOW_PROPOSAL_CONFIRMATION_MISMATCH', details: { nextAction } }
      );
    }
    if (!reviewed.valid) {
      throw new SingularityFlowError(
        `Workflow proposal '${proposalBranch}' is not valid configuration-only work. Nothing was changed.`,
        { code: 'WORKFLOW_PROPOSAL_INVALID' }
      );
    }
    let alreadyMerged = reviewed.merged;
    let mergeEvidence = alreadyMerged ? 'existing-ancestor' : null;
    let protection = {
      enforced: null,
      detail: alreadyMerged
        ? 'the reviewed proposal is already present in approved configuration'
        : 'repository enforcement has not been observed'
    };
    if (!alreadyMerged) {
      const actor = gitCommitIdentity(root);
      const merged = run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow contributor'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'merge', '--no-ff', '--no-edit', ref
      ], { cwd: scratch, allowFailure: true });
      if (merged.status !== 0) {
        throw new SingularityFlowError(
          `Workflow proposal '${proposalBranch}' no longer merges cleanly into '${CONFIGURATION_BRANCH}'. `
          + 'The proposal was preserved; rebase or recreate it against current approved configuration.',
          { code: 'WORKFLOW_PROPOSAL_CONFLICT' }
        );
      }
    }

    // Validate the complete merged configuration, including agents and routing, before a ref can
    // move. This is the same read-only validator used by Configuration Center.
    const baselineDefinition = validateDefinition(
      yamlAtRef(scratch, reviewed.targetCommit, 'singularity/workflow.yml')
    );
    await import('./editor.mjs').then(({ validateEditorConfiguration }) =>
      validateEditorConfiguration(scratch, { baselineDefinition }));
    const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    if (!alreadyMerged) {
      if (!acknowledgeUnprotected) {
        const nextAction = workflowProposalCommand(
          'activate', proposalBranch, reviewed.proposalCommit, true
        );
        throw new SingularityFlowError(
          `Git cannot prove whether '${CONFIGURATION_BRANCH}' on '${sanitizeRemote(remote)}' is protected without `
          + 'attempting the real update. Nothing was changed. Review and merge the proposal externally, '
          + `or explicitly acknowledge a direct-push attempt. Re-run: ${nextAction}`,
          { code: 'WORKFLOW_CONFIGURATION_UNPROTECTED', details: { nextAction } }
        );
      }
      const targetRef = `refs/heads/${CONFIGURATION_BRANCH}`;
      let pushed = runRemoteGit([
        'push', '--porcelain',
        `--force-with-lease=${targetRef}:${reviewed.targetCommit}`,
        'origin', `HEAD:${targetRef}`
      ], { cwd: scratch, operation: 'remote-push' });
      const transition = pushed.status === 0
        ? pushed.stdout.split(/\r?\n/).map((line) => {
          const [flag, refspec] = line.split('\t');
          return refspec?.endsWith(`:${targetRef}`) ? flag : null;
        }).find((flag) => flag !== null)
        : null;
      const acquired = transition === ' ' || transition === '+';
      if (pushed.status !== 0 || !acquired) {
        // A successful no-op (`=`) is not proof that this invocation acquired the leased
        // transition. Re-read the exact authority: identical bytes mean a concurrent external
        // action installed the reviewed commit, while any other tip remains a recoverable refusal.
        const authority = new GitRemoteSession().observe(remote, {
          includeHead: false, refs: [targetRef], refresh: true
        });
        if (authority.ok && authority.refs.get(targetRef) === targetCommit) {
          alreadyMerged = true;
          mergeEvidence = pushed.status === 0
            ? 'concurrent-identical-commit'
            : 'remote-exact-after-push-failure';
          protection = {
            enforced: null,
            detail: 'matching workflow configuration was installed by a concurrent or indeterminate action'
          };
          pushed = { ...pushed, status: 0 };
        } else if (pushed.status === 0) {
          pushed = {
            ...pushed,
            status: 1,
            stderr: `stale info: '${CONFIGURATION_BRANCH}' did not perform the explicitly leased transition`
          };
        }
      }
      if (pushed.status !== 0) {
        const failure = classifyGitRemoteFailure(pushed);
        const diagnostic = `${pushed.stderr ?? ''}\n${pushed.stdout ?? ''}`;
        const reviewRequired = ['authorization-denied', 'unknown'].includes(failure.classification)
          && /protected branch|branch protection|review required|pull request|required reviews?/i
            .test(diagnostic);
        protection = reviewRequired
          ? { enforced: true, detail: 'the real exact update was refused by repository review controls' }
          : { enforced: null, detail: 'the real exact update failed without review-control evidence' };
        return {
          status: reviewRequired ? 'review-required' : 'activation-pending', activated: false,
          remote: sanitizeRemote(remote), branch: proposalBranch,
          proposalCommit: reviewed.proposalCommit, targetBranch: CONFIGURATION_BRANCH,
          targetCommit: reviewed.targetCommit, proposedMergeCommit: targetCommit,
          changedFiles: reviewed.changedFiles, workflows: reviewed.workflows, protection,
          failure: {
            code: reviewRequired ? 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED' : failure.code,
            classification: failure.classification,
            retryable: failure.retryable,
            message: reviewRequired
              ? `Merge '${proposalBranch}' into '${CONFIGURATION_BRANCH}' through the repository review controls.`
              : failure.advice,
            diagnostic: redactDiagnosticText(diagnostic).trim().slice(0, 4_096) || null
          },
          externalAction: reviewRequired ? {
            action: 'merge-proposal', sourceBranch: proposalBranch,
            targetBranch: CONFIGURATION_BRANCH, proposalCommit: reviewed.proposalCommit
          } : null,
          nextAction: workflowProposalCommand(
            'activate', proposalBranch, reviewed.proposalCommit, !reviewRequired
          )
        };
      }
      if (!mergeEvidence) {
        mergeEvidence = 'direct-exact-lease';
        protection = {
          enforced: false,
          detail: 'the real exact leased update was accepted for this actor'
        };
      }
    }
    return {
      status: 'activated', activated: true, alreadyMerged,
      remote: sanitizeRemote(remote), branch: proposalBranch,
      proposalCommit: reviewed.proposalCommit, targetBranch: CONFIGURATION_BRANCH,
      targetCommit, changedFiles: reviewed.changedFiles, workflows: reviewed.workflows,
      mergeEvidence, protection,
      nextAction: 'singularity-flow workspace refresh-configuration'
    };
  });
}

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
  const authority = assertCredentialFreeRemote(remoteUrl);
  const identity = (value) => {
    try {
      return value ? assertCredentialFreeRemote(value) : null;
    } catch {
      return null;
    }
  };
  const names = run('git', ['remote'], { cwd: root, allowFailure: true }).stdout
    .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const match = names.find((name) => {
    const candidate = run('git', ['remote', 'get-url', name], { cwd: root, allowFailure: true }).stdout.trim();
    return identity(candidate) === authority;
  });
  if (match) return match;

  const preferred = 'sflow-configuration';
  const existing = run('git', ['remote', 'get-url', preferred], { cwd: root, allowFailure: true }).stdout.trim();
  if (existing && identity(existing) !== authority) {
    const suffix = createHash('sha256').update(authority).digest('hex').slice(0, 8);
    const alternate = `${preferred}-${suffix}`;
    const alternateUrl = run('git', ['remote', 'get-url', alternate], { cwd: root, allowFailure: true }).stdout.trim();
    if (alternateUrl && identity(alternateUrl) !== authority) {
      throw new SingularityFlowError(`Git remote '${alternate}' points somewhere other than the approved configuration authority.`, {
        code: 'CONFIGURATION_PROPOSAL_REMOTE_CONFLICT'
      });
    }
    if (!alternateUrl) run('git', ['remote', 'add', alternate, authority], { cwd: root });
    return alternate;
  }
  if (!existing) run('git', ['remote', 'add', preferred, authority], { cwd: root });
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

    const retained = runRemoteGit(['fetch', '--no-tags', '--', scratch, commit], {
      cwd: root, operation: 'remote-configuration'
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
