/**
 * Which repository a setup proposal answers. Pure, so it can be checked without the VS Code runtime.
 */
import { createHash } from 'node:crypto';
import { sameGitRepository } from '../repository-refresh-model.ts';

/**
 * Whether a proposal is the one asked for. A local checkout is inspected through its origin, so its
 * `remote` is the origin URL, not the folder that was chosen; the engine binds the result to the
 * exact repository input (as onboarding plans do). Results without that binding compare remotes.
 */
export function setupProposalMatchesLead(
  candidate: { remote?: unknown; repository?: { inputIdentity?: unknown } | null },
  lead: string
): boolean {
  if (typeof candidate.remote !== 'string') return false;
  const inputIdentity = candidate.repository?.inputIdentity;
  if (typeof inputIdentity === 'string') {
    return inputIdentity === `sha256:${createHash('sha256').update(lead.trim()).digest('hex')}`;
  }
  return sameGitRepository(candidate.remote, lead);
}
