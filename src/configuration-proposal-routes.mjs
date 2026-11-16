/**
 * Capability and repository setup proposals, approved and rejected like every other proposal [SCF:REQ-010]:
 * `configuration approve` and `configuration reject` show them, bind the decision to the revision shown, sign it
 * where SF Guard is on, and then hand it to their own engines. `capability activate` and `capability
 * setup-activate` stay as the same approval by their earlier names, with their own arguments and refusals.
 */
import { listLeadRepositories, rememberLeadRepository } from './lead-repositories.mjs';
import { SingularityFlowError } from './util.mjs';

const KIND = /^sflow\/config-change\/(capability|onboarding)\//u;

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
  if (kind === 'onboarding') {
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

/** What the proposal holds, as its engine reads it: revision, validity, changed files. */
export async function inspectDelegatedProposal(kind, repository, branch) {
  if (kind === 'capability') {
    const { inspectCapabilityProposal } = await import('./organisation.mjs');
    return inspectCapabilityProposal(repository, branch);
  }
  const { inspectRepositoryOnboardingProposal } = await import('./repository-onboarding.mjs');
  return inspectRepositoryOnboardingProposal(repository, branch, { includeDiff: false });
}

/**
 * Approve one exact revision: the person's signature where SF Guard is on (taken over the proposal, as for every
 * configuration approval, under the policy of the repository the proposal is on, so only from a checkout of it),
 * then the proposal's own engine, then the seal on that checkout's state branch. `acknowledgeUnprotected` is the
 * earlier commands' flag; `configuration approve` is itself the acknowledgement. Refusals are the engine's own.
 */
export async function activateDelegatedProposal(root, kind, repository, branch, { confirm = null, acknowledgeUnprotected = true, reviewed = null } = {}) {
  const seal = await import('./presence/configuration-seal.mjs');
  // From elsewhere, as before these commands were one approval, the proposal's repository's policy cannot be read here.
  const here = Boolean(root) && await sameRepositoryAsCheckout(root, repository);
  const approval = here ? await seal.signConfigurationApproval(root, {
    ...(reviewed ?? {}), branch, proposalCommit: String(confirm ?? reviewed?.proposalCommit ?? ''), targetCommit: reviewed?.targetCommit ?? null
  }) : null;
  let result;
  if (kind === 'capability') {
    const { activateCapabilityProposal } = await import('./organisation.mjs');
    result = await activateCapabilityProposal(repository, branch, { confirm, acknowledgeUnprotected, ...(root ? { initiatingRoot: root } : {}) });
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
  if (result?.activated === false || !approval) return result;
  if (approval.unsigned) return { ...result, presence: { status: 'unsigned', reason: approval.unsigned } };
  const sealed = await seal.publishConfigurationSeal(root, approval);
  return { ...result, presence: { status: sealed.status, path: sealed.path, ...(sealed.status === 'failed' ? { message: sealed.message } : {}) } };
}

async function sameRepositoryAsCheckout(root, repository) {
  try {
    const [{ configurationAuthorityCandidate }, { sameGitRepository }] = await Promise.all([
      import('./configuration-branch.mjs'), import('./git-repository-identity.mjs')]);
    const own = await configurationAuthorityCandidate(root);
    return Boolean(own && sameGitRepository(own, repository));
  } catch { return false; }
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
