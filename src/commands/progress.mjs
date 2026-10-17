import { readStoryState } from '../story-state-read.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { progressBar, progressFlow, progressMarkdown, progressSnapshot } from '../progress.mjs';
import { optionBoolean, table } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => progressCommand(positionals, options)));
}

export async function progressCommand(positionals, options) {
  const root = repoRoot();
  const progress = await readProgress(root, positionals[1]);
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(progress, null, 2));
  if (optionBoolean(options, 'markdown')) return console.log(progressMarkdown(progress));
  console.log(`\n${progress.workId} — ${progress.workType}`);
  console.log(`${progressBar(progress.percentage)} ${progress.percentage}%`);
  console.log(`${progress.approvedPhases} of ${progress.totalPhases} phases approved; current: ${progress.currentPhase ?? 'none'} (${progress.currentPosition}/${progress.totalPhases})`);
  console.log(`Documents: ${progress.documents}  Tokens: ${progress.tokens.totalTokens || 'unavailable'}`);
  console.log(`\nWorkflow flow:\n${progressFlow(progress)}`);
  console.log(`\n${table(progress.phases, [
    { key: 'index', label: '#' }, { key: 'id', label: 'PHASE' }, { key: 'status', label: 'STATUS' },
    { key: 'generation', label: 'GEN' }, { key: 'approvals', label: 'APPROVED' }, { key: 'approvalsRequired', label: 'NEEDED' }, { key: 'tokens', label: 'TOKENS' }
  ])}`);
}

/** Recorded progress, not evidence that the phase may execute or be approved. */
export async function readProgress(root, workId = null) {
  return progressSnapshot(await readStoryState(root, workId));
}
