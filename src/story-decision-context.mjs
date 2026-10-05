import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { loadDefinition } from './config.mjs';
import { branch, checkout } from './git.mjs';
import { optionBoolean, optionString, SingularityFlowError } from './util.mjs';

export function storyDecisionArguments(phaseIds, positionals, options, action) {
  const positional = positionals[1];
  const explicitWorkId = optionString(options, 'work-id');
  const flaggedPhase = optionString(options, 'phase');
  if (!positional) return { requestedId: explicitWorkId, requestedPhase: flaggedPhase, implicitLegacyWorkId: false };
  if (explicitWorkId || phaseIds.includes(positional)) {
    if (flaggedPhase && positional !== flaggedPhase) {
      throw new SingularityFlowError(`${action} received two different phases: '${positional}' and '${flaggedPhase}'. Pass the phase once, either positionally or with --phase.`);
    }
    return { requestedId: explicitWorkId, requestedPhase: flaggedPhase ?? positional, implicitLegacyWorkId: false };
  }
  // Former `approve WORK-ID --phase PHASE` grammar remains supported. Prefer the explicit
  // `approve PHASE --work-id WORK-ID` form to avoid a phase/branch ambiguity.
  return { requestedId: positional, requestedPhase: flaggedPhase, implicitLegacyWorkId: true };
}

/** Approval/rejection are decisions about the accepted Story, never today's mutable templates
 * or agent catalog. Only machine-local Git transport is needed before checking out a target. */
export async function loadStoryDecisionExecution(root, positionals, options, action) {
  let current = null;
  const positional = positionals[1];
  const flaggedPhase = optionString(options, 'phase');
  if (!optionString(options, 'work-id') && (!positional || !flaggedPhase || positional === flaggedPhase)) {
    try {
      current = await loadAcceptedStoryExecution(root);
    } catch (error) {
      if (error.code !== 'STORY_NOT_FOUND') throw error;
    }
  }
  const selection = storyDecisionArguments(current?.workflow.phaseOrder ?? [], positionals, options, action);
  const { requestedId, implicitLegacyWorkId } = selection;
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) {
    const bootstrap = await loadDefinition(root, { storyBootstrap: true });
    try {
      await checkout(root, requestedId, {
        base: bootstrap.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'),
        existingOnly: true, remote: bootstrap.git?.remote ?? 'origin'
      });
    } catch (error) {
      if (implicitLegacyWorkId && /Branch .* does not exist/.test(error?.message ?? '')) {
        throw new SingularityFlowError(`'${requestedId}' is not a configured phase or an available Work ID. Use '${action} <PHASE>' for the current Story, or '${action} <PHASE> --work-id <WORK-ID>' for another Story.`);
      }
      throw error;
    }
  }
  const accepted = !requestedId && current ? current : await loadAcceptedStoryExecution(root, requestedId);
  return { ...selection, ...accepted };
}
