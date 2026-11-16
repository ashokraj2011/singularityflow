import { repositoryCommitPolicyModule } from './util.mjs';
/**
 * Author shared configuration without ever borrowing the caller's application checkout.
 *
 * Workflow Studio can be opened while a Story worktree is selected.  That Story contains a
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
import { assertWorkflowReadinessChanges, validateDefinition } from './config.mjs';
import { isConfigurationReadPath } from './configuration-read-scope.mjs';
import { configurationAssetPolicy } from './configuration-assets.mjs';
import { createGitRuntime } from './git-access.mjs';
import {
  enterpriseGitEnvironment, withoutGitProcessOverrides
} from './git-enterprise-environment.mjs';
import { configurationCommitIdentity, exactConfigurationProposalGitTree } from './git.mjs';
import { normalizeApprovalSecurity } from './approval-authority.mjs';
import { gitCommitObjectExists, gitIsAncestor } from './git-ancestry.mjs';
import { cleanupActivatedConfigurationProposal } from './configuration-proposal-cleanup.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, configuredRemoteIdentity,
  frozenRemoteTransport, gitFailureDiagnostic, redactDiagnosticText, remoteFingerprint, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGitAsync
} from './git-execution.mjs';
import { executeGitQuery } from './git-query.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { prepareConfigurationObjectCheckout } from './configuration-object-store.mjs';
import { readGitNameStatusDiff } from './git-diff-name-status.mjs';
import { createAndPushTransportIntent, createTransportIntent, transportRetryAction } from './transport-intents.mjs';
import { openConfigurationStateService, readConfigurationTransactionJournals } from './configuration-state-service.mjs';
import { prepareConfigurationStateTransaction, materializeConfigurationSnapshot, readConfigurationSnapshot,
  hydrateConfigurationProposal, configurationStateAtRef, planConfigurationLanding, selfApproval,
  configurationApproveCommand, PACKAGE_BASELINE_PATH } from './configuration-state-git.mjs';
import { isConfigurationStatePath, configurationDigest, configurationProposalKind, configurationProposerKey,
  ENGINE_PROPOSAL_KINDS } from './configuration-state-contract.mjs';
import { syncConfigurationReferences } from './configuration-reference-sync.mjs';
import { gitReadOutput, removeTemporaryTree, run, SingularityFlowError } from './util.mjs';
import { canonicalJson } from './records.mjs';

const REVIEW_PREFIX = 'sflow/config-change/workflow/';
/** Where proposals of `kind` live: `sflow/config-change/<kind>/` [SCF:REQ-005]. */
const proposalPrefix = (kind = 'workflow') => `sflow/config-change/${kind}/`;

export { configurationProposerKey };

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

// A local persistence failure after transport must not hide an observed shared commit. The
// prepared operation is already durable; disclose the pending journal update and exact recovery.
async function retainConfigurationOutcome(service, id, state, reason = null, branch = null) {
  try { await service.mark(id, state, reason); return null; }
  catch (error) {
    return { code: error.code ?? 'CONFIGURATION_JOURNAL_WRITE_FAILED', nextAction: finishApprovalCommand(branch, id) };
  }
}

/**
 * The one route that finishes an approval an interruption left [SCF:REQ-009]: approving the same
 * proposal again. With no branch known, the retained transaction is named instead.
 */
function finishApprovalCommand(branch, id) {
  return branch ? `singularity-flow configuration approve ${quoted(branch, '<PROPOSAL-BRANCH>')}`
    : `singularity-flow configuration reconcile ${id} --json`;
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

/**
 * How a person activates a proposal that is valid and not merged: the exact line to type, and the
 * VS Code place that does the same. The line carries --acknowledge-unprotected because activation
 * refuses an unmerged proposal without it; the person still types it, so the acknowledgement stays
 * theirs. A proposal reviewed with only `workflow proposal` used to end with no way forward.
 */
export function workflowActivationRoute(branch, commit, clashes = []) {
  // A field both the proposal and sflow/config changed needs the approver's pick [SCF:REQ-007]. Approval is
  // the person's signed step, the same on every surface [SCF:REQ-010].
  const picks = clashes.map((clash) => ` --pick '${String(clash.key).replace(/'/gu, '')}=<proposal|current>'`).join('');
  return {
    command: `singularity-flow configuration approve ${quoted(branch, '<PROPOSAL-BRANCH>')} --confirm ${quoted(commit, '<COMMIT-SHA>')}${picks}`,
    acknowledgement: `Approving updates ${CONFIGURATION_BRANCH} with exactly this revision. `
      + `Where the server protects ${CONFIGURATION_BRANCH}, the update is refused, nothing changes, and the branch is merged through the repository's review instead.`,
    vscode: 'Workflow Studio → Changes → Review and approve'
  };
}

/** The approve command for one exact proposal revision [SCF:REQ-006]. */
function approveCommand(branch, commit) {
  return configurationApproveCommand(quoted(branch, '<PROPOSAL-BRANCH>'), quoted(commit, '<COMMIT-SHA>'));
}

/**
 * A proposal branch this engine inspects, lists and approves: a workflow, people or package change
 * beneath `sflow/config-change/<kind>/` [SCF:REQ-005].
 */
function workflowProposalBranch(value) {
  const branch = String(value ?? '').trim();
  if (!configurationProposalKind(branch)) {
    throw new SingularityFlowError(
      `A configuration proposal must be a branch beneath ${ENGINE_PROPOSAL_KINDS.map((kind) => `'${proposalPrefix(kind)}'`).join(', ')}.`,
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

function workflowChanges(reader, base, proposal) {
  // A side that is not valid YAML (a sflow/config an outside edit broke) reads as empty, so its repair still shows.
  const yaml = (commit, relative) => { try { return YAML.parse(reader.file(commit, relative)?.bytes.toString('utf8') ?? '{}') ?? {}; } catch { return {}; } };
  const baseDefinition = yaml(base, 'singularity/workflow.yml');
  const proposedDefinition = yaml(proposal, 'singularity/workflow.yml');
  const basePortfolio = yaml(base, 'singularity/portfolio.yml');
  const proposedPortfolio = yaml(proposal, 'singularity/portfolio.yml');
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

/**
 * How a proposal changes the repository's own test commands (`tests:`), or null [RTC:REQ-007]. They
 * belong to no workflow, so a proposal that changes only them reads as "Repository tests", never as
 * a change to each workflow that runs them.
 */
function repositoryTestsChange(reader, base, proposal) {
  const tests = (commit) => { try { return (YAML.parse(reader.file(commit, 'singularity/workflow.yml')?.bytes.toString('utf8') ?? '{}') ?? {}).tests; } catch { return undefined; } };
  const [before, after] = [tests(base), tests(proposal)];
  if (stable(before ?? null) === stable(after ?? null)) return null;
  const ids = (list) => (Array.isArray(list) ? list.map((entry) => entry?.id).filter((id) => typeof id === 'string') : []);
  return {
    label: 'Repository tests',
    change: before == null ? 'added' : after == null ? 'removed' : 'modified',
    added: ids(after).filter((id) => !ids(before).includes(id)),
    changed: ids(after).filter((id) => ids(before).includes(id)
      && stable(before.find((entry) => entry?.id === id)) !== stable(after.find((entry) => entry?.id === id))),
    removed: ids(before).filter((id) => !ids(after).includes(id))
  };
}

/**
 * Why activation would refuse this proposal's workflows, or null.
 *
 * Activation runs this gate against the approved configuration; the list runs it too, so a
 * proposal it would refuse is shown as blocked, with the reason, instead of as ready to activate.
 */
function workflowReadinessFailure(reader, base, proposal) {
  const yaml = (commit) => YAML.parse(reader.file(commit, 'singularity/workflow.yml')?.bytes.toString('utf8') ?? '{}') ?? {};
  // A base that does not load (an outside edit broke it) grants nothing to compare against: the candidate is checked
  // in full when it is approved [SCF:REQ-002].
  let previous;
  try { previous = yaml(base); validateDefinition(structuredClone(previous)); } catch { return null; }
  try {
    assertWorkflowReadinessChanges(previous, yaml(proposal));
    return null;
  } catch (error) {
    return { code: error.code ?? 'WORKFLOW_PROPOSAL_INVALID', message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
}

/**
 * The approval policy `sflow/config` holds at `commit`: whether a proposal's own author may approve it
 * [SCF:REQ-011, D4]. Read from the YAML even when the configuration does not load, so a broken sflow/config
 * keeps its policy; a file that cannot be read at all keeps the team default.
 */
function approvalPolicyAt(reader, commit) {
  let security;
  try {
    const definition = YAML.parse(reader.file(commit, 'singularity/workflow.yml')?.bytes.toString('utf8') ?? '{}', { maxAliasCount: 100 }) ?? {};
    security = normalizeApprovalSecurity(definition.approvalSecurity ?? {});
  } catch { security = normalizeApprovalSecurity({}); }
  return { profile: security.profile, allowSelfApproval: security.allowSelfApproval };
}

/**
 * Why a package proposal may not be approved over `sflow/config` now, or null: it came from a build older than the
 * one the current package baseline records [SCF:REQ-015, D1]. Going back is its own proposal, labelled as a
 * rollback, which names the build it goes back to (D8).
 */
function packageOrderFailure(reader, branch, targetCommit, proposalCommit) {
  if (configurationProposalKind(branch) !== 'package' || /\/rollback-to-/u.test(branch)) return null;
  const build = (commit) => {
    try { return YAML.parse(reader.file(commit, PACKAGE_BASELINE_PATH)?.bytes.toString('utf8') ?? '')?.build ?? null; }
    catch { return null; }
  };
  const current = build(targetCommit);
  const proposed = build(proposalCommit);
  if (!current?.builtAt || !proposed?.builtAt || current.commit === proposed.commit
      || !(Date.parse(current.builtAt) > Date.parse(proposed.builtAt))) return null;
  return { code: 'CONFIGURATION_BUILD_TOO_OLD',
    message: `This package proposal came from a build from ${String(proposed.builtAt).slice(0, 10)}, older than the one ${CONFIGURATION_BRANCH} holds `
      + `(${String(current.builtAt).slice(0, 10)}); approving it would go back. Going back is its own proposal, labelled as a rollback: `
      + 'singularity-flow workspace refresh-configuration --rollback, run from that older build.' };
}

/**
 * Each problem `workflow validate` finds in `ids`, read in `checkout` [finding ER-F7]: keyed by workflow and
 * finding, so the problems a landing adds are the ones its candidate has and the current sflow/config had not.
 */
async function workflowProblems(checkout, ids) {
  const problems = new Map();
  if (!ids.length) return problems;
  const { validateWorkflows } = await import('./workflow-validation.mjs');
  for (const id of ids) {
    let result;
    try { result = await validateWorkflows(checkout, { workflow: id }); }
    catch (error) { if (error?.code === 'WORKFLOW_UNKNOWN') continue; throw error; }
    for (const workflow of result.workflows ?? []) {
      for (const finding of (workflow.findings ?? []).filter((entry) => entry.severity === 'problem')) {
        problems.set(`${workflow.id}\0${finding.id ?? finding.code ?? finding.title}`, { workflow: workflow.id, title: finding.title, code: finding.code ?? null });
      }
      if (workflow.obligations && workflow.obligations.startable === false && !(workflow.findings ?? []).some((entry) => entry.severity === 'problem')) {
        problems.set(`${workflow.id}\0not-startable`, { workflow: workflow.id, title: workflow.reason ?? 'A Story cannot start it.', code: 'WORKFLOW_NOT_STARTABLE' });
      }
    }
  }
  return problems;
}

/**
 * Who a landing adds to an approval group although an approved change removed them, when the approver is that
 * person: they are never added back by their own approval [SCF:REQ-012, finding ER-F3].
 */
async function selfReadmissions(checkout, reviewed, files, reader, approver, env) {
  const { addedApprovalMembers, listsMember, PEOPLE_FILES, removedApprovalMemberships } = await import('./configuration-people-history.mjs');
  const peoplePaths = Object.values(PEOPLE_FILES);
  if (![...files.keys()].some((relative) => peoplePaths.includes(relative))) return [];
  const textOf = (file) => { try { return file?.bytes ? Buffer.from(file.bytes).toString('utf8') : null; } catch { return null; } };
  const before = {}, after = {};
  for (const relative of peoplePaths) {
    before[relative] = textOf(reader.file(reviewed.targetCommit, relative));
    after[relative] = files.has(relative) ? textOf(files.get(relative)) : before[relative];
  }
  const own = addedApprovalMembers(before, after).filter((entry) => listsMember([entry.member], approver, entry.scope));
  if (!own.length) return [];
  const groups = own.map(({ scope, id }) => ({ scope, id }));
  const removal = removedApprovalMemberships(checkout, reviewed.targetCommit, approver, groups, { env });
  // History that cannot be read decides nothing in the approver's favour.
  return removal.status === 'known' ? removal.removed : groups;
}

function changedConfigurationFiles(root, base, proposal, env) {
  return readGitNameStatusDiff(root, base, proposal, { env });
}

async function inspectWorkflowProposalCheckout(root, remote, branch, ref, {
  includeDiff = true, includeView = includeDiff, env = process.env, reader, binding, choices = null
} = {}) {
  // These exact commits were resolved just once during hydration in the same owned checkout.
  // Never carry this binding across invocations or reuse it for the final remote push proof.
  const { targetCommit, proposalCommit, proposalBase, mergeBase, merged, proposer } = binding;
  const createdSeconds = Number(run('git', ['show', '-s', '--format=%ct', proposalCommit], { cwd: root, env }).stdout.trim());
  const proposalCreatedAt = Number.isSafeInteger(createdSeconds) && createdSeconds > 0 && createdSeconds <= 8_640_000_000_000
    ? new Date(createdSeconds * 1000).toISOString() : null;
  // The change is everything from the proposal's merge base with sflow/config to its tip, however
  // many commits it has and whether or not the Git host merged sflow/config into it [SCF:REQ-005].
  // A merged proposal is shown against its tip's first parent, only to say what it changed.
  const reviewBase = proposalBase;
  await reader.hydrate([reviewBase, proposalCommit].flatMap(commit => reader.inventory(commit,
    ['singularity/workflow.yml', 'singularity/portfolio.yml'])));
  const changed = changedConfigurationFiles(root, reviewBase, ref, env);
  const invalidFiles = changed.names.filter((file) => !isConfigurationReadPath(file)
    && !(file === PACKAGE_BASELINE_PATH && configurationProposalKind(branch) === 'package'));
  const diff = includeDiff && invalidFiles.length === 0
    ? run('git', ['diff', '--no-ext-diff', '--unified=3', `${reviewBase}..${ref}`], {
      cwd: root, env
    }).stdout
    : null;
  const failure = merged ? null : workflowReadinessFailure(reader, reviewBase, proposalCommit)
    ?? packageOrderFailure(reader, branch, targetCommit, proposalCommit);
  // What approving it lands on sflow/config now, after any re-apply, and each field both sides
  // changed differently, with both values [SCF:REQ-007, REQ-008].
  const landing = merged || invalidFiles.length ? null : await planConfigurationLanding(reader,
    { proposalBase, proposalCommit, targetCommit, branch }, { env, choices });
  const invalid = [...invalidFiles, ...(landing?.invalid ?? []).filter((file) => !invalidFiles.includes(file))];
  const valid = changed.names.length > 0 && invalid.length === 0 && failure === null;
  const clashes = landing?.clashes ?? [];
  // Only a proposal a person could activate now names the way to do it.
  const activation = valid && !merged ? workflowActivationRoute(branch, proposalCommit, clashes) : null;
  const repositoryTests = repositoryTestsChange(reader, reviewBase, proposalCommit);
  const record = {
    remote: sanitizeRemote(remote), branch, kind: configurationProposalKind(branch), targetBranch: CONFIGURATION_BRANCH,
    targetCommit, proposalCommit, proposalBase, proposalCreatedAt, mergeBase, merged,
    valid,
    // The five states a person sees [SCF:REQ-009]; an invalid proposal is still proposed, with its failure.
    state: merged ? 'approved' : clashes.length ? 'needs-choice' : 'proposed',
    ...(proposer ? { proposer } : {}),
    // Whether its author may approve it: sflow/config's approvalSecurity, one policy for every approval [D4].
    approvalPolicy: approvalPolicyAt(reader, targetCommit),
    ...(failure ? { failure } : {}),
    ...(activation ? { activation, nextAction: activation.command } : {}),
    invalidFiles: invalid, changedFiles: changed.statuses,
    workflows: workflowChanges(reader, reviewBase, proposalCommit),
    ...(repositoryTests ? { repositoryTests } : {}),
    ...(landing ? { clashCount: clashes.length } : {}),
    ...(landing && includeView ? { lands: { fields: landing.fields, clashes, picked: landing.decided, unused: landing.unused } } : {}),
    diff: diff == null ? null
      : diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated …\n` : diff,
    diffDeferred: diff == null
  };
  // The approve view as lines, the same on every surface [SCF:REQ-008].
  if (includeView) record.viewLines = (await import('./configuration-approval-view.mjs')).proposalViewLines(record);
  return record;
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

/**
 * Run `operation` over one advertised proposal and the current authority. Activation needs a
 * disposable checkout; `checkout: false` (inspection) reads the configuration object pool in place,
 * so it creates none, and falls back to the checkout only when the pool declines (SDA-AC-013).
 */
async function withWorkflowProposalCheckout(root, requestedBranch, operation, {
  env = process.env, session = null, checkout = true
} = {}) {
  const branch = workflowProposalBranch(requestedBranch);
  const identityEnv = withoutGitProcessOverrides(env);
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  let scratch = null;
  let objectStore = null;
  try {
    const authorityRef = `refs/heads/${CONFIGURATION_BRANCH}`;
    const proposalRef = `refs/heads/${branch}`;
    const advertised = await remoteSession.observeAsync(remote, {
      refs: [authorityRef, proposalRef], includeHead: false, refresh: true
    });
    requireRemoteObservation(advertised, 'workflow proposal authority');
    if (!advertised.refs.get(proposalRef)) throw new SingularityFlowError(`Workflow proposal '${branch}' is no longer advertised.`, {
      code: 'WORKFLOW_PROPOSAL_UNAVAILABLE'
    });
    const pool = { remote, transport, env,
      authorityCommit: advertised.refs.get(authorityRef),
      branches: [{ branch, proposalCommit: advertised.refs.get(proposalRef) }], runRemoteCommand: runRemoteGitAsync };
    if (!checkout) objectStore = await prepareConfigurationObjectCheckout(root, null, { ...pool, checkout: false });
    if (objectStore) {
      const reader = await measureCommandSpan('proposal.materialize', () => readConfigurationSnapshot(objectStore.store, transport.remote,
        configurationRepositoryHead(objectStore.store, transport.env), transport.env, objectStore.download));
      const binding = await measureCommandSpan('proposal.hydrate', () => hydrateConfigurationProposal(reader, proposalRef, transport.env));
      return await operation(objectStore.store, remote, branch, proposalRef, {
        env: transport.env, identityEnv, remote: transport.remote, session: remoteSession, reader, binding
      });
    }
    scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-review-'));
    // A pool that just declined an inspection is not asked again for a checkout.
    if (checkout) objectStore = await prepareConfigurationObjectCheckout(root, scratch, pool);
    if (!objectStore) {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      '--no-checkout', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    const fetched = await runRemoteGitAsync([
      'fetch', '--quiet', '--no-tags', '--filter=blob:none', '--', transport.remote,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    if (fetched.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read workflow proposal '${branch}'. ${fetched.failure?.advice ?? 'Git fetch failed.'}`,
        { code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_UNAVAILABLE' }
      );
    }
    }
    const reader = await measureCommandSpan('proposal.materialize', () => materializeConfigurationSnapshot(scratch, transport.remote,
      configurationRepositoryHead(scratch, transport.env), transport.env, objectStore?.download ?? runRemoteGitAsync));
    const binding = await measureCommandSpan('proposal.hydrate', () => hydrateConfigurationProposal(reader, `refs/remotes/origin/${branch}`, transport.env));
    return await operation(
      scratch, remote, branch, `refs/remotes/origin/${branch}`,
      {
        env: transport.env, identityEnv, remote: transport.remote, session: remoteSession, reader, binding
      }
    );
  } finally {
    let cleaned = !scratch;
    try { if (scratch) { await removeTemporaryTree(scratch); cleaned = true; } }
    finally { await objectStore?.release({ cleanupConfirmed: cleaned }); }
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
  // Every kind this engine approves, in one list [SCF:REQ-010].
  const reviewPatterns = ENGINE_PROPOSAL_KINDS.map((kind) => `refs/heads/${proposalPrefix(kind)}*`);
  const advertised = await remoteSession.observeAsync(remote, {
    refs: [authorityRef, ...reviewPatterns], includeHead: false, refresh: true
  });
  requireRemoteObservation(advertised, 'workflow proposal authority');
  const branches = [...advertised.refs]
    .filter(([ref]) => ENGINE_PROPOSAL_KINDS.some((kind) => ref.startsWith(`refs/heads/${proposalPrefix(kind)}`)))
    .map(([ref, proposalCommit]) => ({
      proposalCommit,
      branch: advertisedWorkflowProposalBranch(ref)
    }))
    .sort((left, right) => left.branch.localeCompare(right.branch));
  if (!branches.length) return [];
  const authorityCommit = advertised.refs.get(authorityRef);
  // The database is only a verified-input read projection. Activation always observes Git anew.
  let stateService = null;
  try { stateService = await openConfigurationStateService(root, remote); } catch { /* disposable read cache */ }
  if (!includeDiff && stateService) {
    const cached = await stateService.cachedProposals(authorityCommit, branches);
    if (cached) {
      incrementCommandCounter('configuration.proposals-reuse');
      return includeMerged ? cached : cached.filter(record => !record.merged);
    }
  }
  const transport = frozenRemoteTransport(remote, { env: gitEnv });
  let scratch = null;
  let objectStore = null;
  try {
    // Exact objects, read in place from the configuration object pool: no checkout and no clone
    // (SDA-AC-013, §17). The pool names each proposal `refs/heads/<branch>` while it is leased.
    objectStore = await prepareConfigurationObjectCheckout(root, null, { remote, transport, env,
      authorityCommit, branches, runRemoteCommand: runRemoteGitAsync, checkout: false });
    let readRoot;
    let reviewRef;
    if (objectStore) {
      readRoot = objectStore.store;
      reviewRef = (branch) => `refs/heads/${branch}`;
    } else {
      // The pool declined (busy, over its authority budget, unqualified storage, or turned off):
      // the one remaining temporary clone, blobless and with no checkout. It is a listed exception
      // in test/sda-clone-boundary.test.mjs.
      scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposals-'));
      const cloned = await runRemoteGitAsync([
        'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--no-checkout',
        '--filter=blob:none',
        '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
      ], { operation: 'remote-configuration', env: transport.env });
      if (cloned.status !== 0) throw new SingularityFlowError(cloned.failure?.advice ?? 'Workflow authority clone failed.');
      const fetched = await runRemoteGitAsync([
        'fetch', '--quiet', '--no-tags', '--filter=blob:none', '--', transport.remote,
        ...ENGINE_PROPOSAL_KINDS.map((kind) => `+refs/heads/${proposalPrefix(kind)}*:refs/remotes/origin/${proposalPrefix(kind)}*`)
      ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0) throw new SingularityFlowError(fetched.failure?.advice ?? 'Workflow proposals could not be fetched.');
      readRoot = scratch;
      reviewRef = (branch) => `refs/remotes/origin/${branch}`;
    }
    if (configurationRepositoryHead(readRoot, transport.env) !== authorityCommit) {
      throw new SingularityFlowError('Approved configuration changed during proposal inspection. Refresh its exact snapshot and retry.', { code: 'CONFIGURATION_SNAPSHOT_STALE' });
    }
    const reader = objectStore
      ? await readConfigurationSnapshot(readRoot, transport.remote, authorityCommit, transport.env, objectStore.download)
      : await materializeConfigurationSnapshot(scratch, transport.remote, authorityCommit, transport.env, runRemoteGitAsync);
    const proposals = [];
    for (const entry of branches) {
      const ref = reviewRef(entry.branch);
      try {
        const binding = await hydrateConfigurationProposal(reader, ref, transport.env);
        const inspected = await inspectWorkflowProposalCheckout(
          readRoot, remote, entry.branch, ref, { includeDiff, env: transport.env, reader, binding }
        );
        if (inspected.proposalCommit !== entry.proposalCommit) {
          throw new SingularityFlowError('Proposal revision changed during inspection. Refresh before reviewing it.', { code: 'CONFIGURATION_SNAPSHOT_STALE' });
        }
        proposals.push(inspected);
      } catch (error) {
        proposals.push({
          remote: sanitizeRemote(remote), branch: entry.branch, targetBranch: CONFIGURATION_BRANCH,
          targetCommit: null, proposalCommit: entry.proposalCommit, merged: false, valid: false,
          invalidFiles: [], changedFiles: [], workflows: [], diff: null, diffDeferred: true,
          status: 'unreadable', failure: { code: error.code ?? 'WORKFLOW_PROPOSAL_UNREADABLE', message: error.message }
        });
      }
    }
    if (stateService && !includeDiff) {
      try {
        const projected = await stateService.projectProposals(authorityCommit, proposals);
        return includeMerged ? projected : projected.filter(record => !record.merged);
      } catch { /* cache failure cannot block inspection */ }
    }
    return includeMerged ? proposals : proposals.filter(record => !record.merged);
  } finally {
    let cleaned = !scratch;
    try { if (scratch) { await removeTemporaryTree(scratch); cleaned = true; } }
    finally { await objectStore?.release({ cleanupConfirmed: cleaned }); }
  }
}

/**
 * Exact commits, changed files, affected workflows, diff, and what approving it lands now for one
 * review proposal. `choices` are the approver's picks for fields both sides changed (SCF:REQ-007).
 */
export async function inspectWorkflowConfigurationProposal(root, branch, { choices = null } = {}) {
  return withWorkflowProposalCheckout(root, branch, (
    scratch, remote, proposalBranch, ref, transport
  ) => inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref, {
    env: transport.env, reader: transport.reader, binding: transport.binding, choices
  }), { checkout: false });
}

/**
 * Prove whether one exact proposal commit reached the approved authority, even when the review
 * platform deleted its source branch after merge. This is deliberately a fresh remote read: an
 * authority SHA advance alone is not merge evidence, and a missing branch can also mean discard.
 */
export async function configurationProposalCommitStatus(root, requestedBranch, requestedCommit, {
  env = process.env, session = null, candidateCommit = null
} = {}) {
  const branch = workflowProposalBranch(requestedBranch);
  const proposalCommit = String(requestedCommit ?? '').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(proposalCommit)) {
    throw new SingularityFlowError('Configuration proposal status requires an exact proposal commit.', {
      code: 'CONFIGURATION_PROPOSAL_COMMIT_INVALID'
    });
  }
  if (candidateCommit !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(candidateCommit)) {
    throw new SingularityFlowError('Configuration transaction status requires an exact candidate commit.', {
      code: 'CONFIGURATION_TRANSACTION_CANDIDATE_INVALID'
    });
  }
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const transport = frozenRemoteTransport(remote, { env: gitEnv });
  const proposalRef = `refs/heads/${branch}`;
  // The answer, read from one repository that holds the authority's complete history: a post-merge
  // branch deletion removes the review ref, but the exact proposal commit stays reachable through
  // the merge or fast-forward ancestry.
  const statusAt = async (readRoot, targetCommit, branchCommit, runRemoteCommand) => {
    const registry = await configurationStateAtRef(readRoot, transport.remote, targetCommit, transport.env, runRemoteCommand);
    const included = (commit) => gitCommitObjectExists(readRoot, commit, { env: transport.env })
      && gitIsAncestor(readRoot, commit, targetCommit, { env: transport.env });
    return {
      remote: sanitizeRemote(remote),
      branch,
      proposalCommit,
      targetBranch: CONFIGURATION_BRANCH,
      targetCommit,
      merged: included(proposalCommit),
      candidateIncluded: candidateCommit === null ? null : included(candidateCommit),
      branchStatus: branchCommit == null ? 'absent'
        : branchCommit === proposalCommit ? 'matching' : 'replaced',
      branchCommit,
      transaction: registry.transactions.findLast(record => record.branch === branch && record.proposalRevision === proposalCommit) ?? null
    };
  };
  // Exact objects first (SDA-AC-013): the configuration object pool fetches the advertised
  // authority with its complete history and is read in place, with no clone.
  const advertised = await remoteSession.observeAsync(remote, {
    refs: [`refs/heads/${CONFIGURATION_BRANCH}`, proposalRef], includeHead: false, refresh: true
  });
  requireRemoteObservation(advertised, `configuration proposal '${branch}'`);
  const authorityCommit = advertised.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
  const advertisedBranch = advertised.refs.get(proposalRef) ?? null;
  const objectStore = authorityCommit ? await prepareConfigurationObjectCheckout(root, null, {
    remote, transport, env, authorityCommit, runRemoteCommand: runRemoteGitAsync, checkout: false,
    branches: advertisedBranch ? [{ branch, proposalCommit: advertisedBranch }] : []
  }) : null;
  if (objectStore) {
    try { return await statusAt(objectStore.store, authorityCommit, advertisedBranch, objectStore.download); }
    finally { await objectStore.release({ cleanupConfirmed: true }); }
  }
  // The pool declined (busy, over its authority budget, unqualified storage, or turned off): a
  // blobless temporary clone with the same history, listed in test/sda-clone-boundary.test.mjs.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-status-'));
  try {
    const cloned = await runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      '--no-checkout', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    const observed = await remoteSession.observeAsync(remote, {
      refs: [proposalRef], includeHead: false, refresh: true
    });
    requireRemoteObservation(observed, `configuration proposal '${branch}'`);
    const branchCommit = observed.refs.get(proposalRef) ?? null;
    if (branchCommit != null) {
      const fetched = await runRemoteGitAsync([
        'fetch', '--quiet', '--no-tags', '--filter=blob:none', '--', transport.remote,
        `+${proposalRef}:refs/remotes/origin/${branch}`
      ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0) throw new SingularityFlowError(
        `Cannot read configuration proposal '${branch}'. ${fetched.failure?.advice ?? 'Git fetch failed.'}`,
        { code: fetched.failure?.code ?? 'WORKFLOW_PROPOSAL_AUTHORITY_UNAVAILABLE' }
      );
    }
    return await statusAt(scratch, configurationRepositoryHead(scratch, transport.env), branchCommit, runRemoteGitAsync);
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
  confirm = null, acknowledgeUnprotected = false, choices = null
} = {}) {
  try {
    return await withWorkflowProposalCheckout(root, branch, async (
    scratch, remote, proposalBranch, ref, transport
  ) => {
    const reviewed = await inspectWorkflowProposalCheckout(scratch, remote, proposalBranch, ref, {
      env: transport.env, includeDiff: false, reader: transport.reader, binding: transport.binding
    });
    if (String(confirm ?? '').trim() !== reviewed.proposalCommit) {
      const nextAction = approveCommand(proposalBranch, reviewed.proposalCommit);
      throw new SingularityFlowError(
        `Confirmation must be the exact workflow proposal commit '${reviewed.proposalCommit}'. Nothing was changed. Re-run: ${nextAction}`,
        { code: 'WORKFLOW_PROPOSAL_CONFIRMATION_MISMATCH', details: { nextAction } }
      );
    }
    if (reviewed.failure) {
      throw new SingularityFlowError(`${reviewed.failure.message} Nothing was changed.`,
        { code: reviewed.failure.code, details: reviewed.failure.details });
    }
    if (!reviewed.valid) {
      throw new SingularityFlowError(
        `Workflow proposal '${proposalBranch}' is not valid configuration-only work. Nothing was changed.`,
        { code: 'WORKFLOW_PROPOSAL_INVALID' }
      );
    }
    let alreadyMerged = reviewed.merged;
    let approver = null;
    const stateService = await openConfigurationStateService(root, remote);
    let prepared = null;
    let journalWarning = null;
    let mergeEvidence = alreadyMerged ? 'existing-ancestor' : null;
    let protection = {
      enforced: null,
      detail: alreadyMerged
        ? 'the reviewed proposal is already present in approved configuration'
        : 'repository enforcement has not been observed'
    };
    if (!alreadyMerged) {
      if (!acknowledgeUnprotected) {
        const nextAction = approveCommand(proposalBranch, reviewed.proposalCommit);
        throw new SingularityFlowError(
          `Git cannot prove whether '${CONFIGURATION_BRANCH}' is protected without attempting the real update. Nothing was changed. Approve it as a person: ${nextAction}`,
          { code: 'WORKFLOW_CONFIGURATION_UNPROTECTED', details: { nextAction } }
        );
      }
      approver = configurationCommitIdentity(root, { env: transport.identityEnv });
      // One policy for every approval [SCF:REQ-011, D4]: with approvalSecurity.allowSelfApproval false, a
      // configuration change needs a person other than its author.
      if (selfApproval(reviewed.proposer, approver) && reviewed.approvalPolicy?.allowSelfApproval === false) {
        throw new SingularityFlowError(
          `You proposed ${proposalBranch}, and this repository needs another person to approve it (allowSelfApproval is false). Nothing was changed.`,
          { code: 'CONFIGURATION_SELF_APPROVAL_REFUSED', details: { proposer: reviewed.proposer ?? null,
            nextAction: { label: 'Another person approves it', command: approveCommand(proposalBranch, reviewed.proposalCommit) } } }
        );
      }
      const actor = approver;
      // What `workflow validate` finds in each workflow this changes, before and after [finding ER-F7].
      const changedWorkflows = (reviewed.workflows ?? []).filter((row) => row.governs === 'story' && row.change !== 'removed').map((row) => row.id);
      const problemsBefore = await workflowProblems(scratch, changedWorkflows).catch(() => null);
      prepared = await measureCommandSpan('proposal.prepare', () => prepareConfigurationStateTransaction(scratch, transport.remote, reviewed, {
        env: transport.env, runRemoteCommand: runRemoteGitAsync, actor: { name: actor.name, email: actor.email },
        proposalId: stateService.identity(proposalBranch), objectReader: transport.reader, choices
      }));
      const readmitted = await selfReadmissions(scratch, reviewed, prepared.files, transport.reader, approver, transport.env);
      if (readmitted.length) {
        throw new SingularityFlowError(
          `This approval would add you back to ${readmitted.map((group) => group.id).join(', ')}, which an approved change removed you from. `
          + 'Someone else must approve it; nothing was changed.',
          { code: 'CONFIGURATION_SELF_READMISSION_REFUSED', details: { groups: readmitted,
            nextAction: { label: 'Another person approves it', command: approveCommand(proposalBranch, reviewed.proposalCommit) } } }
        );
      }
      if (problemsBefore) {
        const after = await workflowProblems(scratch, changedWorkflows);
        const added = [...after].filter(([key]) => !problemsBefore.has(key)).map(([, value]) => value);
        if (added.length) {
          const named = [...new Set(added.map((entry) => entry.workflow))];
          throw new SingularityFlowError(
            `Approving ${proposalBranch} would give ${named.join(', ')} ${added.length === 1 ? 'a problem' : `${added.length} problems`} \`workflow validate\` reports: `
            + `${added.map((entry) => `${entry.workflow}: ${entry.title}`).join('; ')}. Nothing was changed. Fix ${named.length === 1 ? 'it' : 'them'} in a new proposal, then approve that.`,
            { code: 'WORKFLOW_PROPOSAL_PROBLEMS', details: { problems: added, nextAction: {
              label: 'Draft the fixes', command: `singularity-flow workflow fix${named.length === 1 ? ` ${named[0]}` : ''}`, skill: '/sf-fix-workflow' } } }
          );
        }
      }
      if (prepared.receipt) await stateService.prepare(prepared.transaction, prepared.targetCommit);
    }

    // Validate the complete transaction, including agents and routing, before a ref can
    // move. This is the same read-only validator used by Configuration Center. A current
    // sflow/config that does not load is repaired like any other (SCF:REQ-002): it relaxes nothing.
    let baselineDefinition = null;
    try { baselineDefinition = validateDefinition(yamlAtRef(scratch, reviewed.targetCommit, 'singularity/workflow.yml', transport.env)); }
    catch { baselineDefinition = null; }
    await measureCommandSpan('proposal.validate', () => import('./editor.mjs').then(({ validateEditorConfiguration }) =>
      validateEditorConfiguration(scratch, { baselineDefinition })));
    const targetCommit = configurationRepositoryHead(scratch, transport.env);
    if (!alreadyMerged) {
      const targetRef = `refs/heads/${CONFIGURATION_BRANCH}`;
      let pushed = await measureCommandSpan('proposal.push', () => runRemoteGitAsync([
        'push', '--porcelain',
        `--force-with-lease=${targetRef}:${reviewed.targetCommit}`,
        '--', transport.remote, `HEAD:${targetRef}`
      ], { cwd: scratch, operation: 'remote-push', env: transport.env }));
      const transition = pushed.status === 0
        ? pushed.stdout.split(/\r?\n/).map((line) => {
          const [flag, refspec] = line.split('\t');
          return refspec?.endsWith(`:${targetRef}`) ? flag : null;
        }).find((flag) => flag !== null)
        : null;
      const acquired = transition === ' ' || transition === '+';
      let remoteOutcomeKnown = false;
      {
        // A successful no-op (`=`) is not proof that this invocation acquired the leased
        // transition. Re-read the exact authority: identical bytes mean a concurrent external
        // action installed the reviewed commit, while any other tip remains a recoverable refusal.
        const authority = await transport.session.observeAsync(remote, {
          includeHead: false, refs: [targetRef], refresh: true
        });
        remoteOutcomeKnown = authority.ok;
        if (authority.ok && authority.refs.get(targetRef) === targetCommit) {
          alreadyMerged = !acquired;
          mergeEvidence = acquired && pushed.status === 0 ? null : pushed.status === 0
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
        journalWarning = prepared.receipt ? await retainConfigurationOutcome(stateService, prepared.transaction.id,
          remoteOutcomeKnown ? 'activation-pending' : 'outcome-unknown', failure.code ?? 'REMOTE_PUSH_FAILED', proposalBranch) : null;
        return {
          status: reviewRequired ? 'review-required' : 'activation-pending', activated: false,
          remote: sanitizeRemote(remote), branch: proposalBranch,
          proposalCommit: reviewed.proposalCommit, targetBranch: CONFIGURATION_BRANCH,
          targetCommit: reviewed.targetCommit, proposedMergeCommit: targetCommit,
          transactionId: prepared.transaction.id, proposalId: prepared.transaction.proposalId,
          journalWarning,
          changedFiles: reviewed.changedFiles, workflows: reviewed.workflows, protection,
          failure: {
            code: reviewRequired ? 'WORKFLOW_ACTIVATION_REVIEW_REQUIRED' : failure.code,
            classification: failure.classification,
            retryable: failure.retryable,
            message: reviewRequired
              ? `Merge '${proposalBranch}' into '${CONFIGURATION_BRANCH}' through the repository review controls.`
              : failure.advice,
            diagnostic: gitFailureDiagnostic(pushed),
            exitCode: Number.isInteger(pushed.status) ? pushed.status : null,
            signal: pushed.signal ?? null,
            timedOut: pushed.timedOut === true,
            aborted: pushed.aborted === true,
            outputOverflow: pushed.outputOverflow === true,
            ...(failure.hook ? { hook: failure.hook } : {})
          },
          externalAction: reviewRequired ? {
            action: 'merge-proposal', sourceBranch: proposalBranch,
            targetBranch: CONFIGURATION_BRANCH, proposalCommit: reviewed.proposalCommit
          } : null,
          recoveryCommand: finishApprovalCommand(proposalBranch, prepared.transaction.id),
          nextAction: approveCommand(proposalBranch, reviewed.proposalCommit)
        };
      }
      if (!mergeEvidence) {
        mergeEvidence = 'direct-exact-lease';
        protection = {
          enforced: false,
          detail: 'the real exact leased update was accepted for this actor'
        };
      }
      journalWarning = prepared.receipt ? await retainConfigurationOutcome(stateService, prepared.transaction.id, 'committed', null, proposalBranch) : null;
    }
    const proposalCleanup = await cleanupActivatedConfigurationProposal(
      remote, proposalBranch, reviewed.proposalCommit, targetCommit,
      { proofRoot: scratch, env: transport.env, remoteSession: transport.session }
    );
    let referenceSync = null;
    let finished = null;
    if (prepared) {
      try { referenceSync = await syncConfigurationReferences(root, remote, targetCommit); }
      catch (error) { referenceSync = { status: 'attention', results: [], reason: error.code ?? 'CONFIGURATION_REFERENCE_SYNC_FAILED' }; }
      journalWarning = prepared.receipt ? await retainConfigurationOutcome(stateService, prepared.transaction.id,
        referenceSync.status === 'complete' ? 'synced' : 'sync-pending', null, proposalBranch) : null;
    } else {
      // Approved already: running approve again finishes whatever an interruption left on this machine [SCF:REQ-009].
      finished = await finishInterruptedApproval(root, proposalBranch, { proposalCommit: reviewed.proposalCommit });
      referenceSync = finished?.referenceSync ?? null;
      journalWarning = finished?.journalWarning ?? null;
    }
    return {
      status: 'activated', activated: true, alreadyMerged,
      remote: sanitizeRemote(remote), branch: proposalBranch,
      proposalCommit: reviewed.proposalCommit, targetBranch: CONFIGURATION_BRANCH,
      targetCommit, changedFiles: reviewed.changedFiles, workflows: reviewed.workflows,
      mergeEvidence, protection, proposalCleanup,
      transactionId: prepared?.transaction.id ?? null, proposalId: stateService.identity(proposalBranch),
      activationMethod: prepared ? 'semantic-transaction' : 'retained-history',
      // Who proposed and who approved, as the approval commit records them [SCF:REQ-018].
      ...(prepared ? { approval: { proposer: reviewed.proposer ?? null, approver: { name: approver.name, email: approver.email },
        selfApproved: prepared.selfApproved, picked: prepared.decided } } : {}),
      referenceSync, journalWarning, ...(finished ? { finished: finished.status } : {}),
      nextAction: journalWarning?.nextAction ?? (prepared && referenceSync?.status !== 'complete'
        ? finishApprovalCommand(proposalBranch, prepared.receipt ? prepared.transaction.id : null)
        : finished?.nextAction ?? 'singularity-flow workspace refresh-configuration')
    };
    });
  } catch (error) {
    if (!['WORKFLOW_PROPOSAL_UNAVAILABLE', 'REMOTE_BRANCH_NOT_FOUND'].includes(error?.code)
        || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(String(confirm ?? ''))) throw error;
    // A review provider, or successful activation, may have removed the source ref. Its absence
    // can be reconciled only when the exact confirmed commit is still in approved ancestry.
    let status;
    try { status = await configurationProposalCommitStatus(root, branch, confirm); }
    catch { throw error; }
    if (!status.merged || status.branchStatus !== 'absent') throw error;
    const finished = await finishInterruptedApproval(root, branch, { proposalCommit: status.proposalCommit });
    return {
      status: 'activated', activated: true, alreadyMerged: true,
      remote: status.remote, branch: status.branch, proposalCommit: status.proposalCommit,
      targetBranch: CONFIGURATION_BRANCH, targetCommit: status.targetCommit,
      changedFiles: [], workflows: [], mergeEvidence: 'commit-ancestry',
      protection: { enforced: null, detail: 'the confirmed proposal is in approved ancestry' },
      proposalCleanup: { branch: status.branch, proposalCommit: status.proposalCommit,
        status: 'already-absent' },
      transactionId: status.transaction?.id ?? null,
      ...(finished ? { finished: finished.status, referenceSync: finished.referenceSync ?? null, journalWarning: finished.journalWarning ?? null } : {}),
      nextAction: finished?.nextAction ?? 'singularity-flow workspace refresh-configuration'
    };
  }
}

/**
 * Finish what an interrupted approval of `branch` left on this machine [SCF:REQ-009]: each retained
 * transaction for it that is not yet synced is reconciled (proposal cleanup, reference sync, journal),
 * which never repeats a push. Null when nothing is left unfinished, or nothing could be finished here.
 */
export async function finishInterruptedApproval(root, branch, { proposalCommit = null } = {}) {
  let journals;
  try { journals = await readConfigurationTransactionJournals(root); } catch { return null; }
  const open = journals.transactions.filter(entry => entry.transaction?.branch === branch
    && (!proposalCommit || entry.transaction.proposalRevision === proposalCommit)
    && !['synced', 'superseded'].includes(entry.state));
  let finished = null;
  for (const entry of open) {
    let result;
    try { result = await reconcileConfigurationTransaction(root, entry.transaction.id); }
    catch (error) { if (error?.code === 'CONFIGURATION_TRANSACTION_UNKNOWN') continue; throw error; }
    if (!finished || (result.activated && !finished.activated)) finished = result;
  }
  return finished;
}

/**
 * Remove a rejected or withdrawn proposal's branch [SCF:REQ-009], with a lease on the exact revision
 * the person rejected: a proposal that moved since is refused, never removed with a revision nobody saw.
 * Returns `{ status: 'removed' | 'already-absent', branch, proposalCommit }`.
 */
export async function removeRejectedConfigurationProposal(root, requestedBranch, { confirm, env = process.env, session = null } = {}) {
  const branch = workflowProposalBranch(requestedBranch);
  const proposalCommit = String(confirm ?? '').trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(proposalCommit)) {
    throw new SingularityFlowError('Rejecting a proposal names the exact revision that was shown.', {
      code: 'CONFIGURATION_PROPOSAL_COMMIT_INVALID', details: { nextAction: `singularity-flow configuration reject ${quoted(branch, '<PROPOSAL>')}` }
    });
  }
  const gitEnv = enterpriseGitEnvironment(env);
  const remoteSession = session ?? new GitRemoteSession({ env: gitEnv });
  const remote = await proposalRemote(root, remoteSession);
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const ref = `refs/heads/${branch}`;
  const observe = async () => {
    remoteSession.invalidate?.(remote);
    const observed = await remoteSession.observeAsync(remote, { refs: [ref], includeHead: false, refresh: true });
    requireRemoteObservation(observed, `configuration proposal '${branch}'`);
    return observed.refs.get(ref) ?? null;
  };
  const before = await observe();
  if (before == null) return { status: 'already-absent', branch, proposalCommit };
  if (before !== proposalCommit) {
    throw new SingularityFlowError(`Proposal ${branch} changed after you were shown it, so it was not rejected. Look at it again: singularity-flow configuration reject ${branch}`, {
      code: 'CONFIGURATION_APPROVE_PROPOSAL_MOVED', details: { nextAction: `singularity-flow configuration reject ${quoted(branch, '<PROPOSAL>')}`, shown: before }
    });
  }
  const pushed = await runRemoteGitAsync(['push', '--porcelain', `--force-with-lease=${ref}:${proposalCommit}`, '--', transport.remote, `:${ref}`],
    { cwd: root, operation: 'remote-push', env: transport.env });
  // An exit status is not proof either way: read the branch again.
  const after = await observe();
  if (after == null) return { status: 'removed', branch, proposalCommit };
  const failure = pushed.failure ?? classifyGitRemoteFailure(pushed);
  throw new SingularityFlowError(`Proposal ${branch} could not be removed from the remote: ${failure.advice ?? 'the push was refused'}. Its rejection stands; remove the branch on your Git host.`, {
    code: after === proposalCommit ? 'CONFIGURATION_REJECT_BRANCH_KEPT' : 'CONFIGURATION_APPROVE_PROPOSAL_MOVED',
    details: { branch, diagnostic: gitFailureDiagnostic(pushed), nextAction: `singularity-flow configuration reject ${quoted(branch, '<PROPOSAL>')}` }
  });
}

/** Reconcile an exact retained transaction; this never re-executes an unconfirmed push. */
export async function configurationTransactions(root) {
  return readConfigurationTransactionJournals(root);
}

export async function reconcileConfigurationTransaction(root, id) {
  const session = new GitRemoteSession();
  const remote = await proposalRemote(root, session);
  const service = await openConfigurationStateService(root, remote);
  const record = (await service.transactions()).transactions.find(entry => entry.transaction.id === id);
  if (!record) throw new SingularityFlowError('Configuration transaction is not retained in this authority.', { code: 'CONFIGURATION_TRANSACTION_UNKNOWN' });
  const binding = record.transaction;
  const observed = await configurationProposalCommitStatus(root, binding.branch, binding.proposalRevision, { session, candidateCommit: record.targetCommit });
  const installed = observed.transaction;
  if (observed.merged && installed && installed.id !== id && !observed.candidateIncluded
      && ['prepared', 'outcome-unknown', 'activation-pending', 'superseded'].includes(record.state)
      && installed.proposalId === binding.proposalId && installed.expectedAuthorityCommit === binding.expectedAuthorityCommit
      && configurationDigest(installed.changes) === configurationDigest(binding.changes)) {
    const journalWarning = await retainConfigurationOutcome(service, id, 'superseded', `superseded-by:${installed.id}`, binding.branch);
    return { status: journalWarning ? 'sync-pending' : 'superseded', transactionId: id, activated: false, proposalInstalled: true,
      installedTransactionId: installed.id, targetCommit: observed.targetCommit, journalWarning,
      nextAction: journalWarning?.nextAction ?? 'singularity-flow workspace refresh-configuration' };
  }
  if (!observed.merged || !observed.candidateIncluded || observed.transaction?.id !== id || observed.transaction.digest !== binding.digest) {
    return { status: 'not-confirmed', transactionId: id, automaticRetry: false,
      nextAction: approveCommand(binding.branch, binding.proposalRevision),
      effects: { applicationCode: 'unchanged', worktree: 'unchanged', approvals: 'unchanged' } };
  }
  await retainConfigurationOutcome(service, id, 'committed');
  const cleanup = await cleanupActivatedConfigurationProposal(remote, binding.branch, binding.proposalRevision, observed.targetCommit, { remoteSession: session });
  let referenceSync;
  try { referenceSync = await syncConfigurationReferences(root, remote, observed.targetCommit); }
  catch (error) {
    const journalWarning = await retainConfigurationOutcome(service, id, 'sync-pending', error.code ?? 'CONFIGURATION_REFERENCE_SYNC_FAILED', binding.branch);
    return { status: 'sync-pending', transactionId: id, activated: true, targetCommit: observed.targetCommit,
      proposalCleanup: cleanup, journalWarning, nextAction: finishApprovalCommand(binding.branch, id) };
  }
  const complete = referenceSync.status === 'complete';
  const journalWarning = await retainConfigurationOutcome(service, id, complete ? 'synced' : 'sync-pending', null, binding.branch);
  return { status: complete && !journalWarning ? 'synced' : 'sync-pending', transactionId: id, activated: true,
    targetCommit: observed.targetCommit, proposalCleanup: cleanup, referenceSync, journalWarning,
    nextAction: complete && !journalWarning ? null : finishApprovalCommand(binding.branch, id) };
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
/**
 * The typed intent a proposal records (SDA M3): its kind and the canonical digest of its operations,
 * as commit trailers and in the push record. Files stay the proposal's content; the intent says what
 * was asked, so review and replay do not have to infer it from a diff. Absent for callers with none.
 */
function proposalIntent(intent) {
  if (intent == null) return null;
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(intent.kind ?? '') || !Array.isArray(intent.operations) || !intent.operations.length) {
    throw new SingularityFlowError('A configuration proposal intent needs a kind and at least one typed operation.', {
      code: 'CONFIGURATION_PROPOSAL_INTENT_INVALID'
    });
  }
  return Object.freeze({ kind: intent.kind, operations: intent.operations.length,
    sha256: `sha256:${createHash('sha256').update(configurationDigestInput(intent)).digest('hex')}` });
}

function configurationDigestInput(intent) {
  return canonicalJson({ kind: intent.kind, operations: intent.operations });
}

export async function proposeConfigurationChange(root, {
  operation, subject, message, mutate, expectedAuthority = null, verifyStaged = null, intent = null, kind = 'workflow'
}, { transport = {}, env = transport.env ?? process.env, session = null } = {}) {
  if (!ENGINE_PROPOSAL_KINDS.includes(kind)) {
    throw new SingularityFlowError(`A configuration proposal is one of ${ENGINE_PROPOSAL_KINDS.join(', ')}, not '${kind}'.`, {
      code: 'CONFIGURATION_PROPOSAL_KIND_INVALID',
      details: { nextAction: { label: 'See the proposals of each kind', command: 'singularity-flow configuration proposals' } }
    });
  }
  if (typeof mutate !== 'function') {
    throw new SingularityFlowError('A configuration proposal needs a mutation.', {
      code: 'CONFIGURATION_PROPOSAL_MUTATION_REQUIRED'
    });
  }
  if (verifyStaged !== null && typeof verifyStaged !== 'function') {
    throw new SingularityFlowError('Exact staged proposal verification must be an owner callback.', {
      code: 'CONFIGURATION_PROPOSAL_EXACT_VERIFIER_INVALID'
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
  // The typed intent this proposal carries (SDA M3): what was asked, not only the files it changed.
  const intentRecord = proposalIntent(intent);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-proposal-'));
  try {
    // No clone (SDA-AC-013): the authority's tip is fetched into this repository's object store and
    // projected from those exact objects into the disposable configuration repository.
    const { fetchConfigurationBase, createConfigurationProjection } = await import('./configuration-projection.mjs');
    const fetched = await fetchConfigurationBase(root, authorityTransport, { branch: CONFIGURATION_BRANCH });
    if (!fetched.commit) {
      const failure = fetched.failure?.failure;
      const advice = failure?.advice
        ?? 'Inspect the approved Git credential, proxy, and certificate configuration.';
      throw new SingularityFlowError(
        `Cannot read approved configuration from '${sanitizeRemote(remoteUrl)}': `
        + advice, {
          code: 'CONFIGURATION_PROPOSAL_AUTHORITY_UNAVAILABLE',
          details: {
            classification: failure?.classification ?? 'unknown',
            evidence: failure?.evidence ?? null
          }
        }
      );
    }
    const expectedSourceCommit = expected?.sourceCommit
      ?? (expected?.kind === 'verified-state-mirror' ? null : expected?.commit);
    // A proposal is made on the sflow/config commit its author read [SCF:REQ-005]: an editor that
    // loaded an earlier commit still proposes, and approval re-applies its field edits onto the newer
    // one, asking only about a field both sides changed. Only a read commit that is no longer in
    // sflow/config's history (rewritten outside SFlow) is refused.
    const readCommit = expectedSourceCommit && expected?.kind !== 'verified-state-mirror' && expectedSourceCommit !== fetched.commit
      && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(expectedSourceCommit)
      && gitCommitObjectExists(root, expectedSourceCommit, { env: authorityTransport.env })
      && gitIsAncestor(root, expectedSourceCommit, fetched.commit, { env: authorityTransport.env })
      ? expectedSourceCommit : fetched.commit;
    await createConfigurationProjection(root, scratch, readCommit, { branch: CONFIGURATION_BRANCH, env: authorityTransport.env, transport: authorityTransport });
    incrementCommandCounter('configuration.proposal-projection');

    const baseCommit = configurationRepositoryHead(scratch, authorityTransport.env);
    if (expectedSourceCommit && expectedSourceCommit !== baseCommit) {
      authorityChanged('The approved sflow/config commit changed after this editor loaded, and the commit it read is no longer in its history.', {
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
    // Only the exact approved base may establish managed roots and runtime exclusions. The
    // candidate workflow can request a root change for review, but cannot authorize its own files.
    // A base that is not valid YAML (an outside edit) still takes a repair proposal [SCF:REQ-002]: its policy is the default.
    const tolerantYaml = (relative) => { try { return yamlAtRef(scratch, baseCommit, relative, authorityTransport.env); } catch { return {}; } };
    const approvedAssetPolicy = configurationAssetPolicy(tolerantYaml('singularity/workflow.yml'), tolerantYaml('singularity/portfolio.yml'));
    const result = await mutate(scratch);
    run('git', ['add', '-A'], { cwd: scratch, env: authorityTransport.env });
    const files = run('git', ['diff', '--cached', '--name-only'], {
      cwd: scratch, env: authorityTransport.env
    }).stdout
      .split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    const escaped = files.filter((file) => isConfigurationStatePath(file) || !isConfigurationReadPath(file, approvedAssetPolicy));
    if (escaped.length) {
      throw new SingularityFlowError(
        `Configuration proposal attempted to change non-configuration paths: ${escaped.join(', ')}.`, {
          code: 'CONFIGURATION_PROPOSAL_SCOPE_INVALID', details: { files: escaped }
        }
      );
    }

    let verifiedTree = null;
    if (verifyStaged) {
      const staged = exactConfigurationProposalGitTree(scratch, { baselineCommit: baseCommit, env: authorityTransport.env });
      let verified = false;
      const mismatch = (message) => { throw new SingularityFlowError(message, { code: 'CONFIGURATION_PROPOSAL_REVIEWED_FILES_CHANGED' }); };
      const verifyFiles = (expectedFiles) => {
        if (!Array.isArray(expectedFiles) || !expectedFiles.length || expectedFiles.length > 1024) mismatch('Reviewed proposal file closure must be explicit and bounded.');
        const expected = expectedFiles.map((file) => {
          if (!file || Object.getPrototypeOf(file) !== Object.prototype || typeof file.path !== 'string'
              || !isConfigurationReadPath(file.path, approvedAssetPolicy) || !['100644', '100755'].includes(file.mode)
              || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 16 * 1024 * 1024
              || typeof file.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256)) mismatch('The reviewed proposal file manifest is invalid.');
          return { path: file.path, mode: file.mode, bytes: file.bytes, sha256: file.sha256 };
        });
        const paths = expected.map((file) => file.path);
        if (new Set(paths).size !== paths.length || expected.reduce((sum, file) => sum + file.bytes, 0) > 32 * 1024 * 1024
            || staged.changedPaths.some((relative) => !paths.includes(relative))) mismatch('The staged changes differ from the exact reviewed file closure.');
        const actual = staged.fileMetadata(paths);
        if (actual.some((file, index) => ['path', 'mode', 'bytes', 'sha256'].some((key) => file[key] !== expected[index][key]))) mismatch('Git staging changed reviewed file bytes or modes; obtain a new exact package preview.');
        verified = true;
        return Object.freeze({ candidateTree: staged.candidateTree, files: actual });
      };
      await verifyStaged(Object.freeze({ baseCommit, candidateTree: staged.candidateTree,
        changedPaths: staged.changedPaths, verifyFiles }));
      if (!verified) mismatch('The owner callback did not verify an exact reviewed file closure.');
      const current = exactConfigurationProposalGitTree(scratch, { baselineCommit: baseCommit, env: authorityTransport.env });
      if (current.candidateTree !== staged.candidateTree) mismatch('The staged proposal tree changed after exact review verification.');
      verifiedTree = staged.candidateTree;
    }
    if (!files.length) {
      return {
        ...result, changed: false, pushed: false, reviewRequired: false,
        branch: null, baseBranch: CONFIGURATION_BRANCH, baseCommit, files: []
      };
    }

    const tree = run('git', ['write-tree'], { cwd: scratch, env: authorityTransport.env }).stdout.trim();
    // The proposer, from their checkout and Git configuration (SCF:REQ-018): never the OS login or a placeholder.
    const actor = configurationCommitIdentity(root, { env: identityEnv });
    // Revisions are immutable. A new save on the same base is a new revision, not a naming dead end.
    // The proposer's key keeps one person's proposal apart from another's for the same operation: they
    // are separate proposals with separate IDs, never revisions of one (finding ER-F9). It is a digest,
    // so the branch name carries no address.
    // The branch's last component stays within 96 bytes (a portable file name with room for Git's
    // lock suffix): a label of at most 63, the key (11), the base (9) and the tree (13).
    const logical = `${operationId}-${subjectId}`;
    const label = logical.length <= 63 ? logical : /-[a-f0-9]{12}$/u.test(logical)
      ? logical.slice(0, 50) + logical.slice(-13)
      : logical.slice(0, 50) + '-' + createHash('sha256').update(logical).digest('hex').slice(0, 12);
    const reviewBranch = `${proposalPrefix(kind)}${label}-${configurationProposerKey(actor)}-${baseCommit.slice(0, 8)}-${tree.slice(0, 12)}`;
    const stateService = await openConfigurationStateService(root, remoteUrl);
    const proposalId = stateService.identity(reviewBranch);
    // A real command: it shows the proposal and, while it waits, the exact activation line and the
    // VS Code place for that revision (inspectWorkflowProposalCheckout's `activation`).
    const nextAction = workflowProposalCommand('proposal', reviewBranch);
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
      // A proposal Git could not read is not one "with different content or ancestry".
      const proposalObject = (revision, label) => gitReadOutput(run('git', [
        'rev-parse', '--verify', '--quiet', revision
      ], { cwd: scratch, env: authorityTransport.env, allowFailure: true }), label, { absentStatus: 1 })?.trim() ?? '';
      const fetchedCommit = fetched.status === 0
        ? proposalObject(`${localProposalRef}^{commit}`, `Existing proposal '${reviewBranch}' commit`)
        : null;
      const existingTree = fetchedCommit === existingCommit
        ? proposalObject(`${localProposalRef}^{tree}`, `Existing proposal '${reviewBranch}' tree`)
        : null;
      const existingParent = fetchedCommit === existingCommit
        ? proposalObject(`${localProposalRef}^`, `Existing proposal '${reviewBranch}' parent`)
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
          proposalId, proposalRevision: existingCommit,
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
    await (await repositoryCommitPolicyModule('writer', scratch)).runPolicyCommit(scratch, [
      '-c', `user.name=${actor.name}`,
      '-c', `user.email=${actor.email}`,
      'commit', '-m', String(message ?? '').trim() || `[configuration] ${operationId} ${subjectId}`,
      ...(intentRecord ? ['-m', `Sflow-Intent-Kind: ${intentRecord.kind}\nSflow-Intent-Sha256: ${intentRecord.sha256}`] : [])
    ], {
      env: authorityTransport.env, legacyRun: (argv, opts) => run('git', argv, {...opts, cwd: scratch})
    });
    const commit = configurationRepositoryHead(scratch, authorityTransport.env);
    if (verifiedTree) {
      const committed = exactConfigurationProposalGitTree(scratch, {
        baselineCommit: baseCommit, objectId: commit, env: authorityTransport.env
      });
      if (committed.candidateTree !== verifiedTree || committed.parents?.length !== 1 || committed.parents[0] !== baseCommit) {
        throw new SingularityFlowError('The committed proposal differs from its exact reviewed tree or approved base; nothing will be published.', {
          code: 'CONFIGURATION_PROPOSAL_REVIEWED_FILES_CHANGED'
        });
      }
    }

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
    const publication = await (transport.backgroundSync ? createTransportIntent : createAndPushTransportIntent)({
      repositoryRoot: root,
      remote,
      expectedRemoteUrl: remoteUrl,
      sourceCommit: commit,
      targetRef: `refs/heads/${reviewBranch}`,
      expectedRemote: null,
      scope: {
        operation: `sflow.configuration.${kind}.${operationId}`,
        subject: subjectId,
        baseBranch: CONFIGURATION_BRANCH,
        baseCommit,
        files,
        ...(intentRecord ? { intent: intentRecord } : {}),
        requiredLocalRef: `refs/singularity/transport/configuration-proposals/${commit}`
      }
    }, { ...transport, env: gitEnv });
    if (transport.backgroundSync) {
      const { startConfigurationProposalSync } = await import('./configuration-proposal-sync.mjs');
      const backgroundStarted = await startConfigurationProposalSync(publication.intentId, { env: gitEnv }).catch(() => false);
      return { ...result, changed: true, pushed: false, reviewRequired: true,
        branch: reviewBranch, proposalId, proposalRevision: commit,
        baseBranch: CONFIGURATION_BRANCH, baseCommit, commit, files,
        transportIntent: publication.intentId, transportStatus: publication.status,
        backgroundStarted, syncStatus: 'saved-locally', ...(intentRecord ? { intent: intentRecord } : {}),
        nextAction: `singularity-flow push status ${publication.intentId} --json` };
    }
    if (publication.status !== 'succeeded') {
      throw new SingularityFlowError(
        `Workflow proposal ${reviewBranch} was retained but publication is ${publication.status}. `
        + `${publication.fault?.advice ?? ''}\n`
        + `${publication.fault?.evidence?.diagnostics ?? publication.fault?.evidence?.diagnostic ?? ''}\n`
        + `Inspect: singularity-flow push status ${publication.intentId} --json. `
        + `After repairing the reported error, retry the retained upload: singularity-flow sync ${publication.intentId} --json.`, {
          code: 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING',
          details: { branch: reviewBranch, commit, intentId: publication.intentId, status: publication.status,
            failure: publication.fault, retryCommand: `singularity-flow sync ${publication.intentId} --json`,
            // The routed way out (recovery plans read nextAction, not retryCommand).
            ...(transportRetryAction(publication) ? { nextAction: transportRetryAction(publication) } : {}),
            recoveryCommands: [`singularity-flow push status ${publication.intentId}`] }
        }
      );
    }
    return {
      ...result,
      changed: true,
      pushed: true,
      reviewRequired: true,
      branch: reviewBranch,
      proposalId, proposalRevision: commit,
      baseBranch: CONFIGURATION_BRANCH,
      baseCommit,
      commit,
      files,
      transportIntent: publication.intentId,
      transportStatus: publication.status,
      ...(intentRecord ? { intent: intentRecord } : {}),
      nextAction
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}
