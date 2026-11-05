/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { requirePositional, optionBoolean, SingularityFlowError } from '../util.mjs';
import { repoRoot } from '../git.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';
import { sessionDiscoveryConfiguration } from './shared/session-discovery-configuration.mjs';
import { sessionRepositoryAuthority } from './shared/session-repository-authority.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { validateId, loadConfig, assertNoPendingPublication } from '../state-stores.mjs';
import { beginSelectionReceipt, answerSelectionReceipt, selectionReceiptStatus } from '../choices.mjs';
import { assertApprovalSubmitted } from '../approval-submitted.mjs';
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
        try { assertLifecycleWorktreeClean(root, config, null, { workId }); }
        catch (error) {
          if (error.code !== 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED') throw error;
          // A dirty draft of this exact target resumes authoring. Clean checkouts retain the
          // existing fetch-first path, including an approver behind another laptop's submission.
          let current = null;
          try { current = await loadAcceptedStoryExecution(root); }
          catch (readError) { if (readError.code !== 'STORY_NOT_FOUND') throw readError; }
          if (current?.workflow.workItem.id === workId) await assertApprovalSubmitted(root, current.definition, current.workflow);
          throw error;
        }
        // The Story's own branch, which need not be named after its ID.
        await checkoutStoryBranch(root, config, workId, { fetch: optionBoolean(options, 'fetch') });
        config = await loadConfig(root);
        workflow = await loadStoryAggregate(root, config, workId);
        await assertNoPendingPublication(root, config, workflow, 'prepare an approval selection');
        await assertApprovalSubmitted(root, config, workflow);
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
