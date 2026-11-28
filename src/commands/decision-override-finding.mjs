/**
 * `decision override-finding`: a person overrides a blocking finding the check got wrong (owner, 2026-11-23). See
 * src/finding-overrides.mjs for the rules and src/finding-override-commit.mjs for the record every surface writes.
 *
 *   singularity-flow decision override-finding [WORK-ID] [--phase STEP] --finding CHK-… (--reason TEXT | --sign-off) [--json]
 *
 * `--sign-off` signs off a page SFlow could not capture on SFlow's saved screenshot (the finding's kind says which it is);
 * it takes no reason. "This check is wrong here" is an override of kind check-wrong, with the person's reason.
 *
 * The finding is one the step's own check raises now, named by the key its routes and the decision list give. The person
 * is someone the step's approval rules name, never the agent: a bound Yes in /sf-decide, or their own terminal.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { commitFindingOverride } from '../finding-override-commit.mjs';
import { repoRoot } from '../git.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { loadConfig } from '../state-stores.mjs';
import { optionBoolean, optionString } from '../util.mjs';
import { actionActor } from './kernel.mjs';

export async function decisionOverrideFindingCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const loadedSession = await loadSession(root, { required: false });
  const result = await commitFindingOverride(root, config, workflow, {
    phaseId: optionString(options, 'phase') ?? workflow.currentPhase ?? null, key: optionString(options, 'finding'), reason: optionString(options, 'reason')
  }, { actor: actionActor(root), agent: loadedSession?.workId === workflow.workItem.id ? loadedSession.agent ?? null : null });
  if (!optionBoolean(options, 'json')) {
    console.log(result.words);
    console.log(result.pushed ? 'Decision committed and pushed.' : 'Decision committed locally; push is disabled by git.publish: off.');
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.override-finding', classification: 'mutation' },
    subject: { kind: 'story', id: workflow.workItem.id },
    outcome: succeeded('decision.override-finding.succeeded', { record: result.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: result.commit, pushed: result.pushed, record: result.record, words: result.words }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
