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
import { approvalReceiptCommands, beginSelectionReceipt, answerSelectionReceipt, selectionReceiptStatus } from '../choices.mjs';
import { assertApprovalSubmitted } from '../approval-submitted.mjs';
import { assertLifecycleWorktreeClean, heldForLaterCode, withSetAsideRoute } from '../lifecycle-worktree.mjs';
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
          if (current?.workflow.workItem.id !== workId) throw error;
          // What is kept in place for a later code step is not this decision's (SPEC-CIC switch 2).
          const held = await heldForLaterCode(root, current.definition, current.workflow);
          try { if (!held?.size) throw error; assertLifecycleWorktreeClean(root, current.definition, current.workflow, { held }); }
          catch (dirty) {
            await assertApprovalSubmitted(root, current.definition, current.workflow);
            throw await withSetAsideRoute(dirty, root, current.definition, current.workflow);
          }
        }
        // The Story's own branch, which need not be named after its ID.
        await checkoutStoryBranch(root, config, workId, { fetch: optionBoolean(options, 'fetch') });
        config = await loadConfig(root);
        workflow = await loadStoryAggregate(root, config, workId);
        await assertNoPendingPublication(root, config, workflow, 'prepare an approval selection');
        await assertApprovalSubmitted(root, config, workflow);
        try { assertLifecycleWorktreeClean(root, config, workflow, { held: await heldForLaterCode(root, config, workflow) }); }
        catch (error) { throw await withSetAsideRoute(error, root, config, workflow); }
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
    // A ready receipt names the command it is for, filled: the token is never assembled into a command by hand. It is a
    // private execution command (the receipt is never reusable guidance), so it is checked as one: before, it went through
    // the presentation check, which refuses every --selection-receipt, `next` was always null, and a real /sf-approve
    // turn ran a bare `approve` the guard refused after the person's Yes (2026-11-22).
    const filled = receipt.ready ? approvalReceiptCommands(receipt) : null;
    // Run, never shown: a person read it back as "Now — approval" with its receipt and --for-agent beside /sf-approve, after it
    // had run (owner, 2026-11-25). What comes next is the approval result's own.
    const approve = filled ? await receiptCommand(filled.approve) : null;
    if (approve) receipt = { ...receipt, next: { ...approve, instruction: PRIVATE_RUN } };
    else if (receipt.ready && receipt.action === 'start') {
      const start = await receiptCommand(['start', receipt.workId, '--selection-receipt', receipt.token]);
      if (start) receipt = { ...receipt, next: { ...start, adds: 'The Story\'s own content and policy flags only (--story-file or --jira, --readiness-baseline, --test-execution-mode, --gate-mode, --target-url); the receipt carries the person\'s choices.' } };
    }
  } else if (subcommand === 'status') receipt = await selectionReceiptStatus(root, requirePositional(positionals, 2, 'selection receipt token'));
  else throw new SingularityFlowError(`Unknown choices subcommand: ${subcommand}`);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(receipt, null, 2));
  else printSelectionReceipt(receipt);
}

const PRIVATE_RUN = 'Run this once now: it records the person\'s Yes with its private receipt. Never show it to the person or offer it as a next step; after it, say what its result names next.';

/**
 * A receipt's filled command, as the agent runs it in this turn: `{ command, executable, argv, copyable: false }`, checked as
 * private execution syntax (one well-formed receipt on the command that takes it), or null when it is not one.
 */
async function receiptCommand(argv) {
  const { validateSflowExecutionCommand } = await import('../safe-command-guidance.mjs');
  const command = ['singularity-flow', ...argv].join(' ');
  const checked = argv.every((word) => /^[A-Za-z0-9._:=@/-]+$/u.test(word)) ? validateSflowExecutionCommand(command) : null;
  return checked ? { command, executable: 'singularity-flow', argv: [...argv], copyable: false } : null;
}

