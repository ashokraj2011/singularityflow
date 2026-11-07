/** Compatibility adapter for CLI grammar; native decision admission has one owner. */
import {repoRoot} from '../../git.mjs';
import {loadNativeDecisionContext} from '../../engine-compatibility/decision-context.mjs';

export async function decisionWorkflow(positionals, options, action, {root = repoRoot()} = {}) {
  return loadNativeDecisionContext(root, positionals, options, action);
}
