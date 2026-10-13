/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { requirePositional, optionBoolean, SingularityFlowError } from '../util.mjs';
import { repoRoot, branch, checkout } from '../git.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { sessionDiscoveryConfiguration } from './shared/session-discovery-configuration.mjs';
import { sessionRepositoryAuthority } from './shared/session-repository-authority.mjs';
import { validateId, loadConfig, loadStoryAggregate, assertNoPendingPublication } from '../state-stores.mjs';
import { beginSelectionReceipt, answerSelectionReceipt, selectionReceiptStatus } from '../choices.mjs';
import { assertLifecycleWorktreeClean } from '../lifecycle-worktree.mjs';
import { printSelectionReceipt } from './shared/print-selection-receipt.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => choicesCommand(positionals, options)));
}

export async function choicesCommand(positionals, options) {
  const subcommand = requirePositional(positionals, 1, 'choices subcommand');
  if (subcommand === 'begin' && positionals[2] === 'approve' && options['review-packet'] === true) return (await import('./approval-packet.mjs')).run({ positionals, options });
  const root = repoRoot();
  let receipt;
  if (subcommand === 'begin') {
    const action = requirePositional(positionals, 2, 'selection action');
    const workId = requirePositional(positionals, 3, 'work ID');
    if (action === 'start') {
      // Keep the approved read scope alive through choice collection. `choiceSets` needs the exact
      // retained portfolio snapshot to reject stale workspace repository URLs before ls-remote.
      receipt = await withApprovedConfigurationRead(root, async () => {
        const config = (await sessionDiscoveryConfiguration(
          root, await sessionRepositoryAuthority(root)
        )).definition;
        validateId(config, workId);
        return beginSelectionReceipt(root, config, { action, workId, workflow: null });
      }, { preferAuthority: true });
    } else {
      let config = (await withApprovedConfigurationRead(
        root, async () => sessionDiscoveryConfiguration(
          root, await sessionRepositoryAuthority(root)
        )
      )).definition;
      validateId(config, workId);
      let workflow = null;
      if (action === 'approve') {
        assertLifecycleWorktreeClean(root, config, null, { workId });
        if (workId !== branch(root) || optionBoolean(options, 'fetch')) await checkout(root, workId, {
          base: config.defaultBaseBranch,
          fetch: optionBoolean(options, 'fetch'),
          existingOnly: true,
          remote: config.git?.remote ?? 'origin'
        });
        config = await loadConfig(root);
        workflow = await loadStoryAggregate(root, config, workId);
        await assertNoPendingPublication(root, config, workflow, 'prepare an approval selection');
        assertLifecycleWorktreeClean(root, config, workflow);
      }
      receipt = await beginSelectionReceipt(root, config, { action, workId, workflow });
    }
  } else if (subcommand === 'answer') {
    receipt = await answerSelectionReceipt(
      root,
      requirePositional(positionals, 2, 'selection receipt token'),
      requirePositional(positionals, 3, 'choice ID'),
      requirePositional(positionals, 4, 'selected option ID')
    );
  } else if (subcommand === 'status') receipt = await selectionReceiptStatus(root, requirePositional(positionals, 2, 'selection receipt token'));
  else throw new SingularityFlowError(`Unknown choices subcommand: ${subcommand}`);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2));
  else printSelectionReceipt(receipt);
}
