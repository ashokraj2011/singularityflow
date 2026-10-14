import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { guideText, workflowGuide } from '../guide.mjs';
import { action as narrationAction, commandResult, noEffects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import * as style from '../style.mjs';
import { optionBoolean } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  const effectivePositionals = positionals[0] === 'quickstart' ? ['guide'] : positionals;
  const effectiveOptions = positionals[0] === 'quickstart' ? { ...options, 'first-run': true } : options;
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => guideCommand(effectivePositionals, effectiveOptions)));
}

export async function guideCommand(positionals, options) {
  if (optionBoolean(options, 'first-run')) {
    const { runFirstRunGuide } = await import('../first-run-guide.mjs');
    const json = optionBoolean(options, 'json');
    const result = await runFirstRunGuide({
      keep: optionBoolean(options, 'keep'),
      onBoundary: json ? undefined : (directory) => console.log(`Guide sandbox: ${directory}`)
    });
    if (json) return console.log(JSON.stringify(result, null, 2));
    console.log(`\n${style.heading('Singularity Flow first run completed.')}`);
    for (const step of result.steps) console.log(`  ${style.pass()} ${step.command}`);
    console.log(`\n${style.detail(style.fields(
      `work item ${result.workId}`,
      `${result.modelInvocations} model invocation(s)`,
      `network access: ${result.networkAccess ? 'yes' : 'no'}`,
      `final state ${result.finalStateSha256.slice(0, 12)}`
    ))}`);
    console.log(style.detail(result.retained
      ? `Guide repository retained at ${result.repository}`
      : 'Guide sandbox removed after successful completion.'));
    emitCommandResult(commandResult({
      operation: { id: 'quickstart', classification: 'read' },
      subject: { kind: 'repository', id: result.workId },
      outcome: succeeded('quickstart.completed', { steps: result.steps.length }),
      // The walkthrough runs entirely inside a sandbox it creates and removes. Nothing in the
      // reader's own repository is touched, which is what makes this safe as a first command.
      effects: noEffects(),
      // The sandbox is finished; the reader is not. Reporting a rest state here would answer the
      // newcomer's very first command with "there is nothing further to do".
      next: [
        narrationAction({
          id: 'quickstart.init',
          label: 'Set up a repository you already have',
          command: 'singularity-flow init'
        }),
        narrationAction({
          id: 'quickstart.bootstrap',
          label: 'Set up a new capability, with its configuration branch and ledger',
          command: 'singularity-flow bootstrap <REPOSITORY-URL>'
        }),
        narrationAction({
          id: 'quickstart.help',
          label: 'See what the other commands do',
          command: 'singularity-flow --help',
          rank: 'LATER'
        })
      ]
    }));
    return;
  }
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const root = repoRoot();
  const { workflow } = await loadAcceptedStoryExecution(root, positionals[1]);
  const guide = workflowGuide(workflow);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(guide, null, 2));
  else process.stdout.write(guideText(guide));
}
