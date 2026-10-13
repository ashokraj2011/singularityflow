/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { gitReadOutput, run } from '../../util.mjs';

/**
 * Git's answer to a read a command decision rests on, or a refusal when Git could not give one.
 *
 * An empty answer here means "unborn", "no parent", "no remotes" or "never published", so only a
 * read that succeeded, or Git's own documented negative answer, may produce one.
 */
export function gitAnswer(root, args, label, options) {
  return gitReadOutput(run('git', args, { cwd: root, allowFailure: true }), label, options);
}
