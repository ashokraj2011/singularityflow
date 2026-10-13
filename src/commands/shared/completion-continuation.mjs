/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { completionRecoveryActions } from '../../completion-verdict.mjs';

/** A Story that reached its end rests complete only when the final check passed; otherwise it says how to recover. */
export function completionContinuation(completion) {
  if (!completion) return {};
  return completion.verified ? { restState: 'complete' } : { next: completionRecoveryActions(completion) };
}
