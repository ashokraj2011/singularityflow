/**
 * A rejected or withdrawn configuration proposal [SCF:REQ-009].
 *
 * A person may reject a proposal with a reason; its author may withdraw it, which is a rejection by its
 * author. The decision is recorded on the state branch as
 * `singularity/configuration-rejections/<proposal commit>.json` before the proposal branch is removed,
 * so the reason outlives the branch and its author can read why. The record is additive (SPEC-CIC D3):
 * one file per rejected revision, never rewritten.
 */
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export const CONFIGURATION_REJECTION_ROOT = 'singularity/configuration-rejections';
export const CONFIGURATION_REJECTION_SCHEMA = 'sflow-configuration-rejection@1';

/** Where the rejection of the proposal revision `commit` is recorded on the state branch. */
export function configurationRejectionPath(commit) {
  if (!COMMIT.test(String(commit ?? ''))) throw new TypeError('A configuration rejection needs an exact proposal commit.');
  return `${CONFIGURATION_REJECTION_ROOT}/${commit}.json`;
}

/** The record of one rejection: who proposed it, who rejected it, whether that was its author, and why. */
export function configurationRejectionRecord({ branch, proposalCommit, proposer = null, rejectedBy, reason = null, at = new Date().toISOString() }) {
  const person = (identity) => (identity?.email ? { name: String(identity.name ?? ''), email: String(identity.email) } : null);
  const withdrawn = Boolean(proposer?.email && rejectedBy?.email
    && proposer.email.trim().toLowerCase() === rejectedBy.email.trim().toLowerCase());
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 2_000) : null;
  return { schema: CONFIGURATION_REJECTION_SCHEMA, branch, proposalCommit, proposer: person(proposer), rejectedBy: person(rejectedBy),
    withdrawn, reason: text, at };
}

/**
 * Publish `record` to the state branch. Returns `{ status, path, message }`: `published`, `present`
 * (this revision was already rejected) or `failed`, with the reason the rejection still stands.
 */
export async function publishConfigurationRejection(root, record, { env = process.env } = {}) {
  const path = configurationRejectionPath(record.proposalCommit);
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  try {
    const [{ publishToStateBranch }, { createHash }] = await Promise.all([import('./ledger.mjs'), import('node:crypto')]);
    const definition = await (await import('./state-stores.mjs')).loadConfig(root).catch(() => ({}));
    await publishToStateBranch(root, definition?.ledger ?? {}, { [path]: bytes },
      `[configuration] ${record.withdrawn ? 'withdraw' : 'reject'} ${record.proposalCommit.slice(0, 12)}`, {
        exactBlobSha256: { [path]: `sha256:${createHash('sha256').update(bytes).digest('hex')}` },
        pathPreconditions: { [path]: { condition: 'absent' } }, env
      });
    return { status: 'published', path, message: null };
  } catch (error) {
    if (error?.code === 'state_branch.path_precondition_failed') return { status: 'present', path, message: null };
    return { status: 'failed', path, message: `the reason was not recorded on the state branch (${error?.message ?? error})` };
  }
}
