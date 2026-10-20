import { operationContext } from '../operation-context.mjs';
import { optionBoolean, optionString } from '../util.mjs';
import { agentOrIndentedJson, phaseEntryAgentPresentation } from '../agent-packet-presentation.mjs';
import { validatePhaseEntryRequest } from '../agent-entry-options.mjs';
export { validatePhaseEntryRequest };

let lifecycleModule, publicationModule;
export async function load({ positionals, options }) {
  if (positionals[1] === 'enter') return;
  if (positionals[1] === 'show') return import('./phase-show.mjs');
  if (positionals[1] === 'prepublish' && options['publish-if-ready'] === true) {
    publicationModule ??= import('./phase-publish-if-ready.mjs');
    return publicationModule;
  }
  lifecycleModule ??= import('./phase-lifecycle.mjs');
  return lifecycleModule;
}

export async function run(argv, { positionals, options, invocationCwd = process.cwd() }) {
  if (positionals[1] === 'prepublish' && options['publish-if-ready'] === true) {
    return (await load({ positionals, options })).run({ positionals, options });
  }
  if (positionals[1] !== 'enter') return (await load({ positionals, options })).run(argv, { positionals, options });
  validatePhaseEntryRequest({ positionals, options });
  const { enterPhase } = await import('../phase-entry.mjs');
  const result = await enterPhase({ phaseId: positionals[2] ?? null,
    workId: optionString(options, 'work-id'), compose: optionBoolean(options, 'compose'),
    modelEnabled: operationContext()?.modelMode?.enabled !== false });
  const forAgent = optionBoolean(options, 'for-agent');
  if (forAgent && result.ready && !result.paused) {
    await (await import('../copilot-story-follow.mjs')).recordCopilotStoryFollow({
      originPath: invocationCwd, repositoryPath: result.repositoryPath, workId: result.workId
    }).catch(() => {});
  }
  console.log(agentOrIndentedJson(forAgent, forAgent ? phaseEntryAgentPresentation(result) : result));
}
