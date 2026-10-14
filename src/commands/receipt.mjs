import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { composeEvidenceReceipt, renderEvidenceReceipt, renderEvidenceReceiptMarkdown } from '../evidence-receipt.mjs';
import { repoRoot } from '../git.mjs';
import { readStoryReviewPacket } from '../story-lineage.mjs';
import { SingularityFlowError, optionBoolean, optionString } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => receiptCommand(positionals, options)));
}

export async function receiptCommand(positionals, options) {
  const subcommand = positionals[1] ?? 'show';
  if (subcommand !== 'show') throw new SingularityFlowError("receipt supports only 'show'.");
  const root = repoRoot();
  const workId = positionals[2] ?? optionString(options, 'work-id');
  const { config, workflow } = await loadAcceptedStoryExecution(root, workId);
  if (!optionString(options, 'packet') && !workflow.lineage?.submissions?.length) {
    const none = { status: 'unavailable', reason: 'no-submission', workId: workflow.workItem.id };
    return optionBoolean(options, 'json') ? console.log(JSON.stringify(none, null, 2)) : console.log(`No receipt yet: ${workflow.workItem.id} has not been submitted for review.`);
  }
  const packet = await readStoryReviewPacket(root, config, workflow, optionString(options, 'packet'));
  const receipt = await composeEvidenceReceipt(root, config, workflow, packet);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(receipt, null, 2));
  if (optionBoolean(options, 'markdown')) return console.log(renderEvidenceReceiptMarkdown(receipt));
  console.log(renderEvidenceReceipt(receipt));
}
