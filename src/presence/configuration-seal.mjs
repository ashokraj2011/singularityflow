/**
 * SF Guard (SPEC-PSS-v1 §10.9): a configuration approval keeps its approver's presence seal.
 *
 * `configuration approve` takes the approver's one touch over the exact proposal commit they reviewed
 * (and the `sflow/config` commit it lands on), before anything moves. Once the proposal is active, the
 * seal is published to the state branch as `singularity/presence-seals/configuration/<commit>.json`:
 * `sflow/config` itself may be protected by the Git host, and the seal must survive a reviewed merge
 * there. The approved commit `sflow/config` points at reads as signed when its own commit, or the
 * proposal a merge brought in, has a seal that verifies against the approver's pinned key.
 *
 * Publishing the seal never undoes or holds the approval it records: a seal that could not be
 * published is reported with its route (approve the same proposal again, which records it).
 */
import { CONFIGURATION_SEAL_ROOT, parseSeal, repositorySeal, repositorySealVerdict, sealBytes, sealedRecord } from './repository-seals.mjs';

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Where the approval seal of `commit` lives on the state branch. */
export function configurationSealPath(commit) {
  if (!COMMIT.test(String(commit ?? ''))) throw new TypeError('A configuration approval seal needs an exact commit.');
  return `${CONFIGURATION_SEAL_ROOT}/${commit}.json`;
}

/** The record a configuration approval's signature covers. */
export function configurationApprovalRecord({ proposalCommit, baseCommit = null, branch = null }) {
  return sealedRecord('configuration-approval', proposalCommit, { proposalCommit, baseCommit, branch });
}

/**
 * Before `configuration approve` moves anything: the approver's seal over `reviewed` (the proposal as
 * inspected), or null while SF Guard is off in this repository. Refusals carry M2's routes.
 */
export async function signConfigurationApproval(root, reviewed) {
  const { signRepositoryStep } = await import('./repository-steps.mjs');
  const record = configurationApprovalRecord({ proposalCommit: reviewed.proposalCommit, baseCommit: reviewed.targetCommit ?? null, branch: reviewed.branch ?? null });
  const files = (reviewed.changedFiles ?? []).length;
  const presence = await signRepositoryStep(root, { action: 'configuration.approve', title: `approve configuration proposal ${reviewed.branch ?? reviewed.proposalCommit}`,
    lines: [`Proposal: ${reviewed.branch ?? '(unnamed)'}`, `Proposal commit: ${reviewed.proposalCommit}`, `Changes: ${files} file(s)`,
      'Step: approve a configuration change for new Stories'], record: { ...record } });
  return presence ? repositorySeal(presence, record) : null;
}

/**
 * Publish `seal` to the state branch once the approval is active. Returns `{ status, path, message }`:
 * `published`, `present` (already there) or `failed` (the approval stands; its route records the seal).
 */
export async function publishConfigurationSeal(root, seal, { config = null, env = process.env } = {}) {
  const path = configurationSealPath(seal.key);
  const bytes = sealBytes(seal);
  try {
    const [{ publishToStateBranch }, { createHash }] = await Promise.all([import('../ledger.mjs'), import('node:crypto')]);
    const definition = config ?? await (await import('../state-stores.mjs')).loadConfig(root).catch(() => ({}));
    await publishToStateBranch(root, definition?.ledger ?? {}, { [path]: bytes }, `[configuration][sf-guard] approval seal ${seal.key.slice(0, 12)}`, {
      exactBlobSha256: { [path]: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
      pathPreconditions: { [path]: { condition: 'absent' } }, env
    });
    return { status: 'published', path, message: null };
  } catch (error) {
    if (error?.code === 'state_branch.path_precondition_failed') return { status: 'present', path, message: null };
    return { status: 'failed', path, message: `the approval stands, but its SF Guard seal was not published (${error?.message ?? error}); approve the same proposal again in your own terminal to record it` };
  }
}

/**
 * How the approved configuration commit stands under SF Guard: `{ commit, counts, state, label, code,
 * reason, sealPath }`. `policy` is the repository's (readPresencePolicy); `readSeal(path)` reads a file
 * of the state branch; `parents(commit)` and `committedAt(commit)` read `sflow/config`'s history.
 */
export function configurationApprovalStanding(policy, commit, { readSeal, parents, committedAt, verify }) {
  if (!commit) return { commit: null, counts: true, state: 'not-required', label: null, code: null, reason: null, sealPath: null };
  // The commit itself (a fast-forward), then the proposal a merge brought in.
  for (const candidate of [commit, ...(parents(commit) ?? [])]) {
    const sealPath = configurationSealPath(candidate);
    const seal = parseSeal(readSeal(sealPath));
    if (!seal) continue;
    const fields = seal.invalid ? {} : (seal.record ?? {});
    const bound = !seal.invalid && fields.proposalCommit === candidate && (candidate === commit || (fields.baseCommit ? (parents(commit) ?? []).includes(fields.baseCommit) : true));
    const record = configurationApprovalRecord({ proposalCommit: candidate, baseCommit: fields.baseCommit ?? null, branch: fields.branch ?? null });
    const verdict = bound ? repositorySealVerdict(policy, { record, recordedAt: committedAt(commit), seal, ...(verify ? { verify } : {}) })
      : { counts: false, state: 'invalid', label: 'not counted: its seal is for another commit', code: 'PSS_SIGNATURE_INVALID', reason: 'its seal is for another commit' };
    return { commit, ...verdict, sealPath };
  }
  return { commit, ...repositorySealVerdict(policy, { record: configurationApprovalRecord({ proposalCommit: commit }), recordedAt: committedAt(commit), seal: null, ...(verify ? { verify } : {}) }), sealPath: null };
}

/**
 * The approved configuration commit's standing on this clone, from its `sflow/config` history and the
 * state branch as last fetched: null while SF Guard is off here.
 */
export async function localConfigurationStanding(root, policy, definition, { env = process.env, verify } = {}) {
  const commit = policy?.source?.commit ?? null;
  if (!commit || !policy?.folded?.enabled) return null;
  const [git, { normalizeLedgerConfig }] = await Promise.all([import('../git.mjs'), import('../ledger-config.mjs')]);
  const ledger = normalizeLedgerConfig(definition?.ledger ?? {});
  const stateRef = git.refCommit(root, `refs/remotes/${ledger.remote}/${ledger.branch}`, { env }) ?? git.refCommit(root, `refs/heads/${ledger.branch}`, { env });
  const shapes = new Map();
  const shape = (value) => { if (!shapes.has(value)) shapes.set(value, git.commitShape(root, value, { env })); return shapes.get(value); };
  return { ...configurationApprovalStanding(policy, commit, {
    readSeal: (path) => (stateRef ? git.committedFileBytes(root, stateRef, path, { env }) : null),
    parents: (value) => shape(value)?.parents ?? [], committedAt: (value) => shape(value)?.committedAt ?? null, verify
  }), stateCommit: stateRef ?? null };
}
