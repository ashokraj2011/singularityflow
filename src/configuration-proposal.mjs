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
  CONFIGURATION_BRANCH, CONFIGURATION_SOURCE_PATH, resolveConfigurationRemote,
  STATE_CONFIGURATION_BRANCH
} from './configuration-branch.mjs';
import { validateDefinition } from './config.mjs';
import { isConfigurationReadPath } from './configuration-read-scope.mjs';
import { createGitRuntime } from './git-access.mjs';
import {
  enterpriseGitEnvironment, withoutGitProcessOverrides
} from './git-enterprise-environment.mjs';
import { gitCommitIdentity } from './git.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, configuredRemoteIdentity,
  frozenRemoteTransport, redactDiagnosticText, remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGitAsync
} from './git-execution.mjs';
import { executeGitQuery } from './git-query.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const REVIEW_PREFIX = 'sflow/config-change/workflow/';

function expectedAuthorityIdentity(value) {
  if (value == null) return null;
  const identity = {
    kind: String(value.kind ?? '').trim() || null,
    commit: String(value.commit ?? '').trim() || null,
    remoteFingerprint: String(value.remoteFingerprint ?? '').trim() || null,
    sourceCommit: String(value.sourceCommit ?? '').trim() || null
  };
  for (const field of ['commit', 'sourceCommit']) {
    if (identity[field] != null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(identity[field])) {
      throw new SingularityFlowError(`Expected configuration authority ${field} is not an exact Git object ID.`, {
        code: 'CONFIGURATION_PROPOSAL_AUTHORITY_EXPECTATION_INVALID'
      });
    }
  }
  if (identity.remoteFingerprint != null && !/^[0-9a-f]{64}$/u.test(identity.remoteFingerprint)) {
    throw new SingularityFlowError('Expected configuration authority remote fingerprint is invalid.', {
      code: 'CONFIGURATION_PROPOSAL_AUTHORITY_EXPECTATION_INVALID'
    });
  }
  if (identity.kind != null && !['approved-configuration-ref', 'verified-state-mirror'].includes(identity.kind)) {
    throw new SingularityFlowError(`Expected configuration authority kind '${identity.kind}' is unsupported.`, {
      code: 'CONFIGURATION_PROPOSAL_AUTHORITY_EXPECTATION_INVALID'
    });
  }
  return identity;
}

function authorityChanged(message, expected, actual) {
  throw new SingularityFlowError(
    `${message} Reload the approved configuration and review the newer authority before saving again; nothing was changed.`, {
      code: 'CONFIGURATION_PROPOSAL_AUTHORITY_CHANGED', details: { expected, actual }
    }
  );
}

function configurationRepositoryHead(root, env = process.env) {
  const commit = executeGitQuery(root, 'repository.head', {}, { env });
  if (commit) return commit;
  throw new SingularityFlowError('The configuration proposal repository has no readable HEAD.', {
    code: 'CONFIGURATION_PROPOSAL_HEAD_UNAVAILABLE'
  });
}

async function observedProposalRetention(invocation, ref) {
  const observed = await invocation.refs({ prefix: ref });
  if (!observed.ok) return { kind: 'unknown', code: observed.code };
  const entries = observed.value.entries;
  if (entries.length === 0) return { kind: 'absent' };
  if (entries.length !== 1 || entries[0].ref !== ref
      || entries[0].objectType !== 'commit') return { kind: 'unknown' };
  if (entries[0].symbolicRef) return { kind: 'symbolic' };
  return { kind: 'direct', commit: entries[0].oid };
}

async function retainConfigurationProposalCommit(root, commit, env) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit)) {
    throw new SingularityFlowError('The configuration proposal commit is not an exact Git object ID.', {
      code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED'
    });
  }
  const ref = `refs/singularity/transport/configuration-proposals/${commit}`;
  const runtimeResult = await createGitRuntime({ trustedEnvironment: env });
  if (!runtimeResult.ok) {
    throw new SingularityFlowError('The configuration proposal retention repository cannot be opened safely.', {
      code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED',
      details: { gitAccessCode: runtimeResult.code }
    });
  }
  const runtime = runtimeResult.value;
  try {
    const repositoryResult = await runtime.openRepository(path.resolve(root));
    if (!repositoryResult.ok) {
      throw new SingularityFlowError('The configuration proposal retention repository cannot be opened safely.', {
        code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED',
        details: { gitAccessCode: repositoryResult.code }
      });
    }
    const repository = repositoryResult.value;
    const invocation = repository.beginInvocation();
    try {
      const before = await observedProposalRetention(invocation, ref);
      if (before.kind === 'direct' && before.commit === commit) return ref;
      if (before.kind === 'direct' || before.kind === 'symbolic') {
        throw new SingularityFlowError('The configuration proposal retention ref is already occupied.', {
          code: 'CONFIGURATION_PROPOSAL_RETENTION_COLLISION'
        });
      }
      if (before.kind !== 'absent') {
        throw new SingularityFlowError('The configuration proposal retention ref cannot be inspected safely.', {
          code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED',
          details: { gitAccessCode: before.code ?? null }
        });
      }
      const installed = run(runtime.identity.path, [
        'update-ref', '--no-deref', ref, commit, '0'.repeat(commit.length)
      ], { cwd: path.resolve(root), env, allowFailure: true });
      if (installed.status === 0 && !installed.error && !installed.timedOut
          && !installed.outputOverflow) return ref;
      const after = await observedProposalRetention(invocation, ref);
      if (after.kind === 'direct' && after.commit === commit) return ref;
      if (after.kind === 'direct' || after.kind === 'symbolic') {
        throw new SingularityFlowError('The configuration proposal retention ref is already occupied.', {
          code: 'CONFIGURATION_PROPOSAL_RETENTION_COLLISION'
        });
      }
      throw new SingularityFlowError('The configuration proposal commit could not be retained safely.', {
        code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED',
        details: { gitAccessCode: after.code ?? null }
      });
    } finally {
      await invocation.dispose();
      await repository.dispose();
    }
  } finally {
    await runtime.dispose();
  }
}

function quoted(value, fallback = '<VALUE>') {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9][A-Za-z0-9._/@:=,+-]*$/.test(text)) return text;
  return fallback;
}

function workflowProposalCommand(action, branch, commit = null, acknowledge = false) {
  const args = ['singularity-flow', 'workflow', action];
  if (branch) args.push(quoted(branch, '<PROPOSAL-BRANCH>'));
  if (commit) args.push('--confirm', quoted(commit, '<COMMIT-SHA>'));
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

function advertisedWorkflowProposalBranch(ref) {
  const prefix = 'refs/heads/';
  try {
    if (typeof ref !== 'string' || !ref.startsWith(prefix)) throw new Error('not a branch ref');
    return workflowProposalBranch(ref.slice(prefix.length));
  } catch {
    throw new SingularityFlowError(
      'Git returned an invalid workflow-proposal ref advertisement.', {
        code: 'REMOTE_PROTOCOL_INVALID'
      }
    );
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function stable(value) { return JSON.stringify(canonical(value)); }

function yamlAtRef(root, ref, relative, env) {
  const shown = run('git', ['show', `${ref}:${relative}`], {
    cwd: root, env, allowFailure: true
  });
  if (shown.status !== 0) return {};
  return YAML.parse(shown.stdout) ?? {};
}

function workflowChanges(root, base, proposal, env) {
  const baseDefinition = yamlAtRef(root, base, 'singularity/workflow.yml', env);
  const proposedDefinition = yamlAtRef(root, proposal, 'singularity/workflow.yml', env);
  const basePortfolio = yamlAtRef(root, base, 'singularity/portfolio.yml', env);
  const proposedPortfolio = yamlAtRef(root, proposal, 'singularity/portfolio.yml', env);
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

function changedConfigurationFiles(root, base, proposal, env) {
  const names = run('git', ['diff', '--name-only', `${base}..${proposal}`], { cwd: root, env })
    .stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const statuses = run('git', ['diff', '--name-status', `${base}..${proposal}`], { cwd: root, env })
    .stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [status, ...paths] = entry.split('\t');
      return { status, paths };
    });
  return { names, statuses };
}

function inspectWorkflowProposalCheckout(root, remote, branch, ref, {
  includeDiff = true, env = process.env
} = {}) {
  const targetCommit = configurationRepositoryHead(root, env);
  const proposalCommit = run('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
    cwd: root, env
  }).stdout.trim();
  const proposalBase = run('git', ['rev-parse', '--verify', `${ref}^`], {
    cwd: root, env
  }).stdout.trim();
  const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], {
    cwd: root, env, allowFailure: true
  });
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    throw new SingularityFlowError(
      `Workflow proposal '${branch}' does not share history with '${CONFIGURATION_BRANCH}'.`,
      { code: 'WORKFLOW_PROPOSAL_HISTORY_INVALID' }
    );
  }
  const mergeBase = mergeBaseResult.stdout.trim();
  const merged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
    cwd: root, env, allowFailure: true
  }).status === 0;
  const reviewBase = merged ? proposalBase : mergeBase;
  const changed = changedConfigurationFiles(root, reviewBase, ref, env);
  const invalidFiles = changed.names.filter((file) => !isConfigurationReadPath(file));
  const diff = includeDiff
    ? run('git', ['diff', '--no-ext-diff', '--unified=3', `${reviewBase}..${ref}`], {
      cwd: root, env
    }).stdout
    : null;
  return {
    remote: sanitizeRemote(remote), branch, targetBranch: CONFIGURATION_BRANCH,
    targetCommit, proposalCommit, proposalBase, mergeBase, merged,
    valid: changed.names.length > 0 && invalidFiles.length === 0,
    invalidFiles, changedFiles: changed.statuses,
    workflows: workflowChanges(root, reviewBase, ref, env),
    diff: diff == null ? null
      : diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated …\n` : diff,
    diffDeferred: diff == null
  };
}

async function proposalRemote(root, session) {
  const remote = await resolveConfigurationRemote(root, 'origin', { session });
  if (!remote) {
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' authority is available. Refresh workspace configuration first.`,
      { code: 'WORKFLOW_PROPOSAL_AUTHORITY_MISSING' }
    );
  }
  return remote;
}

async function withWorkflowProposalCheckout(root, requestedBranch, operation, {
  env = process.env, session = null
} = {}) {
  const branch = workflowProposalBranch(requestedBranch);
  const identityEnv = withoutGitProcessOverrides(env);
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-review-'));
  try {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    const fetched = await runRemoteGitAsync([
      'fetch', '--quiet', '--no-tags', '--', transport.remote,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    if (fetched.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read workflow proposal '${branch}'. ${fetched.failure?.advice ?? 'Git fetch failed.'}`,
        { code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_UNAVAILABLE' }
      );
    }
    return await operation(
      scratch, remote, branch, `refs/remotes/origin/${branch}`,
      {
        env: transport.env, identityEnv, remote: transport.remote, session: remoteSession
      }
    );
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** List durable workflow-review branches without changing the selected Story checkout. */
export async function listWorkflowConfigurationProposals(root, {
  includeMerged = false, includeDiff = false, env = process.env, session = null
} = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const authorityRef = `refs/heads/${CONFIGURATION_BRANCH}`;
  const reviewPattern = `refs/heads/${REVIEW_PREFIX}*`;
  const advertised = await remoteSession.observeAsync(remote, {
    refs: [authorityRef, reviewPattern], includeHead: false, refresh: true
  });
  requireRemoteObservation(advertised, 'workflow proposal authority');
  const branches = [...advertised.refs]
    .filter(([ref]) => ref.startsWith(`refs/heads/${REVIEW_PREFIX}`))
    .map(([ref, proposalCommit]) => ({
      proposalCommit,
      branch: advertisedWorkflowProposalBranch(ref)
    }))
    .sort((left, right) => left.branch.localeCompare(right.branch));
  if (!branches.length) return [];
  const transport = frozenRemoteTransport(remote, { env: gitEnv });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposals-'));
  try {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--no-checkout',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) throw new SingularityFlowError(cloned.failure?.advice ?? 'Workflow authority clone failed.');
    const fetched = await runRemoteGitAsync([
      'fetch', '--quiet', '--no-tags', '--', transport.remote,
      `+refs/heads/${REVIEW_PREFIX}*:refs/remotes/origin/${REVIEW_PREFIX}*`
    ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    if (fetched.status !== 0) throw new SingularityFlowError(fetched.failure?.advice ?? 'Workflow proposals could not be fetched.');
    const proposals = [];
    for (const entry of branches) {
      const ref = `refs/remotes/origin/${entry.branch}`;
      if (!includeMerged && run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
        cwd: scratch, env: transport.env, allowFailure: true
      }).status === 0) continue;
      try {
        proposals.push(inspectWorkflowProposalCheckout(
          scratch, remote, entry.branch, ref, { includeDiff, env: transport.env }
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
  return withWorkflowProposalCheckout(root, branch, (
    scratch, remote, proposalBranch, ref, transport
  ) => inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref, {
    env: transport.env
  }));
}

/**
 * Prove whether one exact proposal commit reached the approved authority, even when the review
 * platform deleted its source branch after merge. This is deliberately a fresh remote read: an
 * authority SHA advance alone is not merge evidence, and a missing branch can also mean discard.
 */
export async function configurationProposalCommitStatus(root, requestedBranch, requestedCommit, {
  env = process.env, session = null
} = {}) {
  const branch = workflowProposalBranch(requestedBranch);
  const proposalCommit = String(requestedCommit ?? '').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(proposalCommit)) {
    throw new SingularityFlowError('Configuration proposal status requires an exact proposal commit.', {
      code: 'CONFIGURATION_PROPOSAL_COMMIT_INVALID'
    });
  }
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const transport = frozenRemoteTransport(remote, { env: gitEnv });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-status-'));
  try {
    // Full approved history is required: a post-merge branch deletion removes the review ref, but
    // the exact proposal commit remains reachable through the merge/fast-forward ancestry.
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    const targetCommit = configurationRepositoryHead(scratch, transport.env);
    const merged = run('git', ['merge-base', '--is-ancestor', proposalCommit, 'HEAD'], {
      cwd: scratch, env: transport.env, allowFailure: true
    }).status === 0;
    const proposalRef = `refs/heads/${branch}`;
    const observed = await remoteSession.observeAsync(remote, {
      refs: [proposalRef], includeHead: false, refresh: true
    });
    requireRemoteObservation(observed, `configuration proposal '${branch}'`);
    const branchCommit = observed.refs.get(proposalRef) ?? null;
    return {
      branch,
      proposalCommit,
      targetBranch: CONFIGURATION_BRANCH,
      targetCommit,
      merged,
      branchStatus: branchCommit == null ? 'absent'
        : branchCommit === proposalCommit ? 'matching' : 'replaced',
      branchCommit
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/**
 * Activate one exact reviewed workflow proposal using an exact compare-and-swap update.
 * Protected branches remain under their repository review controls; an unprotected direct update
 * requires a separate explicit acknowledgement.
 */
export async function activateWorkflowConfigurationProposal(root, branch, {
  confirm = null, acknowledgeUnprotected = false
} = {}) {
  return withWorkflowProposalCheckout(root, branch, async (
    scratch, remote, proposalBranch, ref, transport
  ) => {
    const reviewed = inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref, {
      env: transport.env
    });
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
      const actor = gitCommitIdentity(root, { env: transport.identityEnv });
      const merged = run('git', [
        '-c', `user.name=${actor.name || 'Singularity Flow contributor'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'merge', '--no-ff', '--no-edit', ref
      ], { cwd: scratch, env: transport.env, allowFailure: true });
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
      yamlAtRef(scratch, reviewed.targetCommit, 'singularity/workflow.yml', transport.env)
    );
    await import('./editor.mjs').then(({ validateEditorConfiguration }) =>
      validateEditorConfiguration(scratch, { baselineDefinition }));
    const targetCommit = configurationRepositoryHead(scratch, transport.env);
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
      let pushed = await runRemoteGitAsync([
        'push', '--porcelain',
        `--force-with-lease=${targetRef}:${reviewed.targetCommit}`,
        '--', transport.remote, `HEAD:${targetRef}`
      ], { cwd: scratch, operation: 'remote-push', env: transport.env });
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
        const authority = await transport.session.observeAsync(remote, {
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
        const failure = pushed.failure ?? classifyGitRemoteFailure(pushed);
        const diagnostic = `${pushed.stderr ?? ''}\n${pushed.stdout ?? ''}`;
        // A receive hook is classified as policy-rejected by the shared Git boundary. Keep a
        // generic hook refusal pending, but recognize explicit protected-branch/review language as
        // evidence that the repository's normal review path is the required recovery action.
        const reviewRequired = ['authorization-denied', 'policy-rejected', 'unknown']
          .includes(failure.classification)
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

function matchingRemote(root, remoteUrl, env) {
  const authority = assertCredentialFreeRemote(remoteUrl);
  const names = executeGitQuery(root, 'repository.remotes', {}, { env });
  const identity = (name) => configuredRemoteIdentity(root, name, {
    direction: 'fetch', env
  });
  const match = names.find((name) => {
    const candidate = identity(name);
    return candidate.configured && !candidate.ambiguous && candidate.url === authority;
  });
  if (match) return match;

  const preferred = 'sflow-configuration';
  const existing = names.includes(preferred) ? identity(preferred) : null;
  if (existing && (existing.ambiguous || existing.url !== authority)) {
    const suffix = createHash('sha256').update(authority).digest('hex').slice(0, 8);
    const alternate = `${preferred}-${suffix}`;
    const alternateIdentity = names.includes(alternate) ? identity(alternate) : null;
    if (alternateIdentity
        && (alternateIdentity.ambiguous || alternateIdentity.url !== authority)) {
      throw new SingularityFlowError(`Git remote '${alternate}' points somewhere other than the approved configuration authority.`, {
        code: 'CONFIGURATION_PROPOSAL_REMOTE_CONFLICT'
      });
    }
    if (!alternateIdentity) run('git', ['remote', 'add', alternate, authority], {
      cwd: root, env
    });
    return alternate;
  }
  if (!existing) run('git', ['remote', 'add', preferred, authority], { cwd: root, env });
  return preferred;
}

async function existingProposalCommit(remote, branch, session) {
  const ref = `refs/heads/${workflowProposalBranch(branch)}`;
  const observed = await session.observeAsync(remote, {
    refs: [ref], includeHead: false, refresh: true
  });
  requireRemoteObservation(observed, `configuration proposal '${branch}'`);
  return observed.refs.get(ref) ?? null;
}

/**
 * Refuse the legacy local edit path when the checkout contains an immutable Story snapshot.
 * Dedicated configuration review branches and initial, unpinned repositories keep their existing
 * local authoring behavior; the shared `--propose` route is available from either context.
 */
export function assertLocalConfigurationAuthoringAllowed(root) {
  if (!existsSync(path.join(root, CONFIGURATION_SOURCE_PATH))) return;
  const current = executeGitQuery(root, 'repository.branch') ?? '';
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
  operation, subject, message, mutate, expectedAuthority = null
}, { transport = {}, env = transport.env ?? process.env, session = null } = {}) {
  if (typeof mutate !== 'function') {
    throw new SingularityFlowError('A configuration proposal needs a mutation.', {
      code: 'CONFIGURATION_PROPOSAL_MUTATION_REQUIRED'
    });
  }
  const operationId = safeSlug(operation);
  const subjectId = safeSlug(subject);
  const identityEnv = withoutGitProcessOverrides(env);
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const expected = expectedAuthorityIdentity(expectedAuthority);
  const remoteUrl = await resolveConfigurationRemote(root, 'origin', { session: remoteSession });
  if (!remoteUrl) {
    // A local FOS bootstrap is intentionally not a remote proposal authority. Do not suggest a
    // workspace refresh that cannot create one, and do not reinterpret local mode as permission
    // to edit a pinned Story snapshot or push an unreviewed configuration branch.
    const { readFosAttachment } = await import('./onboard.mjs');
    const attachment = await readFosAttachment(root).catch(() => null);
    if (attachment?.descriptor?.route?.kind === 'local') {
      throw new SingularityFlowError(
        `This repository uses a local '${CONFIGURATION_BRANCH}' authority. --propose requires `
        + 'a remote lead repository and is unavailable here. Author in a dedicated local '
        + 'configuration checkout on sflow/config without --propose, validate the change, '
        + 'then commit it through the normal local configuration-publication path. '
        + 'Do not edit a pinned Story worktree.', {
          code: 'CONFIGURATION_PROPOSAL_LOCAL_AUTHORITY'
        }
      );
    }
    throw new SingularityFlowError(
      `No approved '${CONFIGURATION_BRANCH}' authority is available. Refresh the workspace configuration, then retry.`, {
        code: 'CONFIGURATION_PROPOSAL_AUTHORITY_MISSING'
      }
    );
  }

  const actualRemoteFingerprint = remoteFingerprint(remoteUrl);
  if (expected?.remoteFingerprint && expected.remoteFingerprint !== actualRemoteFingerprint) {
    authorityChanged('The approved configuration remote changed after this editor loaded.', {
      remoteFingerprint: expected.remoteFingerprint
    }, { remoteFingerprint: actualRemoteFingerprint });
  }

  const authorityTransport = frozenRemoteTransport(remoteUrl, { push: true, env: gitEnv });
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  try {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--branch', CONFIGURATION_BRANCH, authorityTransport.remote, scratch
    ], { operation: 'remote-configuration', env: authorityTransport.env });
    if (cloned.status !== 0) {
      const advice = cloned.failure?.advice
        ?? 'Inspect the approved Git credential, proxy, and certificate configuration.';
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remoteUrl)}': `
        + advice, {
          code: 'CONFIGURATION_PROPOSAL_AUTHORITY_UNAVAILABLE',
          details: {
            classification: cloned.failure?.classification ?? 'unknown',
            evidence: cloned.failure?.evidence ?? null
          }
        }
      );
    }

    const baseCommit = configurationRepositoryHead(scratch, authorityTransport.env);
    const expectedSourceCommit = expected?.sourceCommit
      ?? (expected?.kind === 'verified-state-mirror' ? null : expected?.commit);
    if (expectedSourceCommit && expectedSourceCommit !== baseCommit) {
      authorityChanged('The approved sflow/config commit changed after this editor loaded.', {
        sourceCommit: expectedSourceCommit
      }, { sourceCommit: baseCommit });
    }
    if (expected?.kind === 'verified-state-mirror' && expected.commit) {
      const stateRef = `refs/heads/${STATE_CONFIGURATION_BRANCH}`;
      const observed = await remoteSession.observeAsync(remoteUrl, {
        refs: [stateRef], includeHead: false, refresh: true
      });
      requireRemoteObservation(observed, 'configuration proposal authority');
      const actualStateCommit = observed.refs.get(stateRef) ?? null;
      if (actualStateCommit !== expected.commit) {
        authorityChanged('The verified state configuration mirror changed after this editor loaded.', {
          commit: expected.commit
        }, { commit: actualStateCommit });
      }
    } else if (expected?.commit && expected.commit !== baseCommit) {
      authorityChanged('The approved configuration commit changed after this editor loaded.', {
        commit: expected.commit
      }, { commit: baseCommit });
    }
    const result = await mutate(scratch);
    run('git', ['add', '-A'], { cwd: scratch, env: authorityTransport.env });
    const files = run('git', ['diff', '--cached', '--name-only'], {
      cwd: scratch, env: authorityTransport.env
    }).stdout
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
    const existingCommit = await existingProposalCommit(remoteUrl, reviewBranch, remoteSession);
    if (existingCommit) {
      const remoteProposalRef = `refs/heads/${reviewBranch}`;
      const localProposalRef = `refs/remotes/sflow-existing/${reviewBranch}`;
      const fetched = await runRemoteGitAsync([
        'fetch', '--quiet', '--no-tags', '--', authorityTransport.remote,
        `+${remoteProposalRef}:${localProposalRef}`
      ], {
        cwd: scratch, operation: 'remote-configuration', env: authorityTransport.env
      });
      const fetchedCommit = fetched.status === 0
        ? run('git', ['rev-parse', '--verify', `${localProposalRef}^{commit}`], {
          cwd: scratch, env: authorityTransport.env, allowFailure: true
        }).stdout.trim()
        : null;
      const existingTree = fetchedCommit === existingCommit
        ? run('git', ['rev-parse', '--verify', `${localProposalRef}^{tree}`], {
          cwd: scratch, env: authorityTransport.env, allowFailure: true
        }).stdout.trim()
        : null;
      const existingParent = fetchedCommit === existingCommit
        ? run('git', ['rev-parse', '--verify', `${localProposalRef}^`], {
          cwd: scratch, env: authorityTransport.env, allowFailure: true
        }).stdout.trim()
        : null;
      const proposedTree = run('git', ['write-tree'], {
        cwd: scratch, env: authorityTransport.env
      }).stdout.trim();
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

    run('git', ['switch', '--quiet', '-c', reviewBranch], {
      cwd: scratch, env: authorityTransport.env
    });
    const actor = gitCommitIdentity(root, { env: identityEnv });
    run('git', [
      '-c', `user.name=${actor.name || 'Singularity Flow contributor'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', String(message ?? '').trim() || `[configuration] ${operationId} ${subjectId}`
    ], { cwd: scratch, env: authorityTransport.env });
    const commit = configurationRepositoryHead(scratch, authorityTransport.env);

    const retentionTransport = frozenRemoteTransport(scratch, { env: gitEnv });
    const retained = await runRemoteGitAsync([
      'fetch', '--no-tags', '--', retentionTransport.remote, commit
    ], {
      cwd: root, operation: 'remote-configuration', env: retentionTransport.env
    });
    if (retained.status !== 0) {
      throw new SingularityFlowError('The workflow proposal commit could not be retained for recoverable publication.', {
        code: 'CONFIGURATION_PROPOSAL_RETENTION_FAILED'
      });
    }
    await retainConfigurationProposalCommit(root, commit, gitEnv);
    const remote = matchingRemote(root, remoteUrl, gitEnv);
    const publication = await createAndPushTransportIntent({
      repositoryRoot: root,
      remote,
      expectedRemoteUrl: remoteUrl,
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
    }, { ...transport, env: gitEnv });
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
