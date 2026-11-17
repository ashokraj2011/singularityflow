/**
 * Capability and repository setup proposals, approved and rejected like every other proposal [SCF:REQ-010]:
 * `configuration approve` and `configuration reject` show them, bind the decision to the revision shown, and hand
 * it to their own engines. `capability activate` and `capability setup-activate` stay as the same approval by their
 * earlier names, with their own arguments and refusals.
 *
 * Like every configuration approval [owner, 2026-11-17]:
 * - SF Guard's signature is always taken under the policy of the repository the proposal is on, wherever the
 *   command runs; while SF Guard is on, a person who cannot sign is refused with the reason and the way forward,
 *   never approved unsigned.
 * - Its proposer is the author of its first own commit, as for every other proposal, and
 *   `approvalSecurity.allowSelfApproval: false` keeps them from approving it (D4). A proposal whose proposer Git does
 *   not record (an older build's placeholder author) is treated as possibly the approver's own.
 */
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import YAML from 'yaml';
import { listLeadRepositories, rememberLeadRepository } from './lead-repositories.mjs';
import { removeTemporaryTree, run, SingularityFlowError } from './util.mjs';

const KIND = /^sflow\/config-change\/(capability|onboarding)\//u;
const CONFIGURATION_REF = 'refs/heads/sflow/config';

/** `capability` or `onboarding` for a proposal another engine owns, else null. */
export function delegatedProposalKind(branch) {
  return KIND.exec(String(branch ?? ''))?.[1] ?? null;
}

/**
 * The repository a proposal of `kind` is on: `--lead`, else for a setup proposal the repository this checkout
 * belongs to, else the first capability-map repository this machine knows.
 */
export async function delegatedProposalRepository(root, kind, lead = null) {
  if (lead) return lead;
  if (kind === 'onboarding' && root) {
    const { configurationAuthorityCandidate } = await import('./configuration-branch.mjs');
    const own = await configurationAuthorityCandidate(root).catch(() => null);
    if (own) return own;
  }
  const known = (await listLeadRepositories())[0]?.url ?? null;
  if (known) return known;
  throw new SingularityFlowError('No repository is known for this proposal. Pass --lead <REPOSITORY-URL>.', {
    code: kind === 'onboarding' ? 'REPOSITORY_ONBOARDING_REPOSITORY_REQUIRED' : 'CAPABILITY_LEAD_REQUIRED',
    details: { nextAction: { command: 'singularity-flow configuration proposals', label: 'See each proposal and its repository' } }
  });
}

/** Whether `proposer` names a person, not an older build's placeholder (`unknown@invalid`) or nobody. */
function knownProposer(proposer) {
  const email = String(proposer?.email ?? '').trim().toLowerCase();
  return Boolean(email) && !email.endsWith('@invalid') ? { name: proposer.name ?? null, email } : null;
}

/**
 * Who proposed it, as for every other proposal: the author of its first own commit [SCF:REQ-005]. A proposal that
 * shares no history with `sflow/config` (a setup proposal creating it) or is already in it is proposed by its own
 * commit's author. Null, so never told apart from the approver, when Git cannot say.
 */
async function readProposer(store, configurationCommit, proposalCommit, { env, branch }) {
  const { readProposalHistory, readProposalAuthor } = await import('./git-proposal-history.mjs');
  try {
    if (configurationCommit) {
      let history = null;
      try { history = readProposalHistory(store, configurationCommit, proposalCommit, { env, branch }); }
      catch (error) { if (error?.code !== 'WORKFLOW_PROPOSAL_HISTORY_INVALID') return null; }
      if (history && !history.merged) return history.proposer;
    }
    return readProposalAuthor(store, proposalCommit, { env, branch });
  } catch { return null; }
}

/**
 * The repository's own record of one proposal, read with no checkout: `sflow/config`'s commit (null while a setup
 * proposal is still creating it), the proposal's commit, its proposer, and the approval policy that governs it
 * (`sflow/config`'s, else the one the setup proposal would create). `work(context)` runs while its objects exist;
 * `context.policyRoot()` writes `sflow/config`'s files where SF Guard's policy is read.
 */
async function withProposalRecord(repository, branch, work, { env = process.env } = {}) {
  const [{ enterpriseGitEnvironment }, { GitRemoteSession, requireRemoteObservation, runRemoteGitAsync },
    { frozenRemoteTransport, sanitizeRemote }] = await Promise.all([
    import('./git-enterprise-environment.mjs'), import('./git-execution.mjs'), import('./git-remote-diagnostics.mjs')]);
  const gitEnv = enterpriseGitEnvironment(env);
  const session = new GitRemoteSession({ env: gitEnv });
  const proposalRef = `refs/heads/${branch}`;
  const observed = await session.observeAsync(repository, { refs: [CONFIGURATION_REF, proposalRef], includeHead: false, refresh: true });
  requireRemoteObservation(observed, `configuration proposal '${branch}'`);
  const configurationCommit = observed.refs.get(CONFIGURATION_REF) ?? null;
  const proposalCommit = observed.refs.get(proposalRef) ?? null;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-delegated-proposal-'));
  const store = path.join(scratch, 'objects.git');
  try {
    run('git', ['init', '--quiet', '--bare', store], { env: gitEnv });
    const transport = frozenRemoteTransport(repository, { env: gitEnv });
    const refspecs = [...(configurationCommit ? [`+${CONFIGURATION_REF}:${CONFIGURATION_REF}`] : []),
      ...(proposalCommit ? [`+${proposalRef}:${proposalRef}`] : [])];
    if (refspecs.length) {
      const fetched = await runRemoteGitAsync(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', transport.remote, ...refspecs],
        { cwd: store, env: transport.env, operation: 'remote-configuration' });
      if (fetched.status !== 0) {
        throw new SingularityFlowError(`The proposal ${branch} on '${sanitizeRemote(repository)}' could not be read. ${fetched.failure?.advice ?? 'Git fetch failed.'} Nothing was changed.`, {
          code: fetched.failure?.code ?? 'CONFIGURATION_PROPOSAL_UNREADABLE',
          details: { nextAction: { command: 'singularity-flow configuration proposals', label: 'Look at the proposals again' } }
        });
      }
    }
    const proposer = proposalCommit ? await readProposer(store, configurationCommit, proposalCommit, { env: gitEnv, branch }) : null;
    const [{ sourceFileAt }, { normalizeApprovalSecurity }] = await Promise.all([
      import('./source-inspection.mjs'), import('./approval-authority.mjs')]);
    let security;
    let approvers = null;
    try {
      const shown = sourceFileAt(store, configurationCommit ?? proposalCommit, 'singularity/workflow.yml', { env: gitEnv, offline: true });
      const definition = YAML.parse(shown.status === 'present' ? shown.value : '{}', { maxAliasCount: 100 }) ?? {};
      security = normalizeApprovalSecurity(definition.approvalSecurity ?? {});
      // Who else may be asked when the proposer may not approve it (review 11-17, finding 2).
      approvers = (await import('./configuration-approvers.mjs')).namedApprovers(definition);
    } catch { security = normalizeApprovalSecurity({}); }
    let projected = null;
    const policyRoot = async () => {
      if (!configurationCommit) return null;
      if (projected) return projected;
      const { createConfigurationProjection } = await import('./configuration-projection.mjs');
      projected = path.join(scratch, 'configuration');
      await createConfigurationProjection(store, projected, configurationCommit, { branch: 'sflow/config', env: gitEnv, transport });
      // Its seal is published to that repository's own state branch.
      run('git', ['remote', 'add', 'origin', repository], { cwd: projected, env: gitEnv });
      return projected;
    };
    return await work({ configurationCommit, proposalCommit, proposer: knownProposer(proposer), recorded: Boolean(knownProposer(proposer)),
      approvalPolicy: { profile: security.profile, allowSelfApproval: security.allowSelfApproval, ...(approvers ? { approvers } : {}) }, policyRoot });
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** What the proposal holds, as its engine reads it, with its proposer and the policy that governs approving it. */
export async function inspectDelegatedProposal(kind, repository, branch) {
  let inspected;
  if (kind === 'capability') {
    const { inspectCapabilityProposal } = await import('./organisation.mjs');
    inspected = await inspectCapabilityProposal(repository, branch);
  } else {
    const { inspectRepositoryOnboardingProposal } = await import('./repository-onboarding.mjs');
    inspected = await inspectRepositoryOnboardingProposal(repository, branch, { includeDiff: false });
  }
  const record = await withProposalRecord(repository, branch, async (context) => ({
    proposer: context.proposer, proposerRecorded: context.recorded, approvalPolicy: context.approvalPolicy }));
  return { ...inspected, ...record };
}

/**
 * One policy for every approval [SCF:REQ-011, D4]: with `allowSelfApproval: false`, the proposer may not approve,
 * and neither may anyone when Git does not say who proposed it. Returns whether this is a self-approval (`'unknown'`
 * when the proposer is not recorded).
 */
async function assertMayApprove(context, approver, branch, command, repository) {
  const self = context.proposer ? context.proposer.email === String(approver?.email ?? '').trim().toLowerCase() : 'unknown';
  if (context.approvalPolicy.allowSelfApproval !== false || self === false) return self;
  if (self === true) {
    const { selfApprovalRefusalWords } = await import('./configuration-approvers.mjs');
    throw new SingularityFlowError(`You proposed ${branch}, and this repository needs another person to approve it (allowSelfApproval is false). Nothing was approved.`
      + selfApprovalRefusalWords(context.approvalPolicy.approvers, approver), {
      code: 'CONFIGURATION_SELF_APPROVAL_REFUSED', details: { proposer: context.proposer, nextAction: { label: 'Another person approves it', command } }
    });
  }
  // The route names the repository the approval read, so it reaches the same proposal (review 11-17, finding 9).
  throw new SingularityFlowError(`Git does not record who proposed ${branch}, so it could be your own, and this repository needs another person to approve it. Nothing was approved. Reject it, then propose it again.`, {
    code: 'CONFIGURATION_PROPOSER_UNKNOWN', details: { nextAction: { label: 'Reject it, then propose it again',
      command: `singularity-flow configuration reject ${branch}${repository ? ` --lead ${repository}` : ''}` } }
  });
}

/**
 * Approve one exact revision: who may (D4), SF Guard's signature under the policy of the repository the proposal is
 * on, wherever this runs, then the proposal's own engine, then the seal on that repository's state branch.
 * `acknowledgeUnprotected` is the earlier commands' flag; `configuration approve` is itself the acknowledgement.
 * The engine's refusals are its own. `signStep` stands in for SF Guard's step in tests.
 */
export async function activateDelegatedProposal(root, kind, repository, branch, {
  confirm = null, acknowledgeUnprotected = true, reviewed = null, env = process.env, signStep = null
} = {}) {
  const [{ configurationCommitIdentity, identity }, seal] = await Promise.all([
    import('./git.mjs'), import('./presence/configuration-seal.mjs')]);
  const caller = root ?? process.cwd();
  const approver = configurationCommitIdentity(caller, { env });
  const command = `singularity-flow configuration approve ${branch} --lead ${repository}`;
  return withProposalRecord(repository, branch, async (context) => {
    // A branch already gone approves nothing new: its engine either reports the same commit already active or refuses.
    // So does a confirmation of another revision, which its engine refuses with the revision to confirm.
    const pending = Boolean(context.proposalCommit) && String(confirm ?? '').trim() === context.proposalCommit;
    const selfApproved = pending ? await assertMayApprove(context, approver, branch, command, repository) : false;
    const policyRoot = pending ? await context.policyRoot() : null;
    const proposal = { ...(reviewed ?? {}), branch, proposalCommit: String(confirm ?? reviewed?.proposalCommit ?? context.proposalCommit ?? ''),
      targetCommit: context.configurationCommit };
    // No approved configuration yet (a setup proposal creating it) has no SF Guard policy to sign under.
    const approval = policyRoot ? await seal.signConfigurationApproval(policyRoot, proposal, {
      actor: identity(caller, { offline: true, env }), strict: true, command, ...(signStep ? { signStep } : {}) }) : null;
    let result;
    if (kind === 'capability') {
      const { activateCapabilityProposal } = await import('./organisation.mjs');
      result = await activateCapabilityProposal(repository, branch, { confirm, acknowledgeUnprotected,
        ...(root ? { initiatingRoot: root } : {}), ...(pending ? { proposer: context.proposer } : {}) });
      try { await rememberLeadRepository(repository); }
      catch {
        const warning = 'Capability activation completed, but this machine could not remember its capability-map repository.';
        result = { ...result, localCache: { remembered: false, code: 'CAPABILITY_LEAD_REGISTRY_WRITE_FAILED', warning },
          warnings: [...(result.warnings ?? []), warning] };
      }
    } else {
      const { activateRepositoryOnboardingProposal } = await import('./repository-onboarding.mjs');
      result = await activateRepositoryOnboardingProposal(repository, branch, { confirm, acknowledgeUnprotected });
    }
    const recorded = { proposer: context.proposer, approver: { name: approver.name, email: approver.email }, selfApproved };
    if (result?.activated === false) return { ...result, approval: recorded };
    if (!approval) return { ...result, approval: recorded };
    const sealed = await seal.publishConfigurationSeal(policyRoot, approval);
    return { ...result, approval: recorded,
      presence: { status: sealed.status, path: sealed.path, ...(sealed.status === 'failed' ? { message: sealed.message } : {}) } };
  }, { env });
}

/**
 * Reject one exact revision: a capability proposal is cancelled by its engine, which keeps the reason; a setup
 * proposal's branch is removed with a lease on that revision. Nothing in `sflow/config` changes.
 */
export async function removeDelegatedProposal(kind, repository, branch, { confirm, reason, cwd = process.cwd() }) {
  if (kind === 'capability') {
    const { cancelCapabilityProposal } = await import('./organisation.mjs');
    return cancelCapabilityProposal(repository, branch, { confirm, reason });
  }
  const { removeProposalBranch } = await import('./configuration-proposal.mjs');
  return removeProposalBranch(repository, branch, { confirm, cwd });
}
