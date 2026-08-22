import { loadModelTiers, MODEL_TIERS_PATH, tierLadder } from './model-tiers.mjs';
import { SingularityFlowError } from './util.mjs';

export const WORLD_MODEL_DISCOVERY_TASK = 'analyze';
export const WORLD_MODEL_SYNTHESIS_TASK = 'reason';

function routedStage(mapping, task) {
  const ladder = tierLadder(mapping, task);
  return Object.freeze({
    request: Object.freeze({ task }),
    planned: Object.freeze({
      mode: 'task-routed',
      task,
      mappingRevision: mapping.revision,
      preferredModel: ladder.models[0],
      availableModels: Object.freeze([...ladder.models]),
      aliasOf: ladder.aliasOf ?? null,
      paramsDigest: ladder.paramsDigest ?? null,
      reason: null
    })
  });
}

function namedStage(model, reason) {
  return Object.freeze({
    request: Object.freeze({ model }),
    planned: Object.freeze({
      mode: 'caller-named',
      task: null,
      mappingRevision: null,
      preferredModel: model,
      availableModels: Object.freeze([model]),
      aliasOf: null,
      paramsDigest: null,
      reason
    })
  });
}

/**
 * Resolve how the existing discovery and synthesis calls will be routed.
 *
 * This is deliberately a preflight as well as a description. It proves both ADP tasks resolve
 * before the expensive analysis worktree or any provider process is started. The actual model
 * remains selected inside `invokeModel`: routed stages pass only a task, never the concrete model
 * observed here for diagnostics.
 */
export async function resolveWorldModelGenerationRouting(root, {
  explicitModel = null,
  legacyModel = null
} = {}) {
  const explicit = typeof explicitModel === 'string' && explicitModel.trim()
    ? explicitModel.trim()
    : null;
  if (explicit) {
    const discovery = namedStage(explicit, 'explicit-model-override');
    const synthesis = namedStage(explicit, 'explicit-model-override');
    return Object.freeze({
      mode: 'caller-named',
      warning: null,
      discovery,
      synthesis,
      identity: Object.freeze({ mode: 'caller-named', model: explicit, reason: 'explicit-model-override' })
    });
  }

  const mapping = await loadModelTiers(root);
  if (mapping) {
    const discovery = routedStage(mapping, WORLD_MODEL_DISCOVERY_TASK);
    const synthesis = routedStage(mapping, WORLD_MODEL_SYNTHESIS_TASK);
    return Object.freeze({
      mode: 'task-routed',
      warning: null,
      discovery,
      synthesis,
      identity: Object.freeze({
        mode: 'task-routed',
        mappingRevision: mapping.revision,
        discoveryTask: WORLD_MODEL_DISCOVERY_TASK,
        synthesisTask: WORLD_MODEL_SYNTHESIS_TASK
      })
    });
  }

  const legacy = typeof legacyModel === 'string' && legacyModel.trim()
    ? legacyModel.trim()
    : null;
  if (legacy) {
    const discovery = namedStage(legacy, 'legacy-configured-model');
    const synthesis = namedStage(legacy, 'legacy-configured-model');
    return Object.freeze({
      mode: 'caller-named',
      warning: `${MODEL_TIERS_PATH} is absent; world-model generation is using the legacy configured model '${legacy}'. Add the task mapping to enable analyze/reason routing.`,
      discovery,
      synthesis,
      identity: Object.freeze({ mode: 'caller-named', model: legacy, reason: 'legacy-configured-model' })
    });
  }

  throw new SingularityFlowError(
    `World-model generation cannot select a model: ${MODEL_TIERS_PATH} is absent and the configured provider names no legacy model. Restore the task mapping, configure a provider model for legacy compatibility, or pass --model explicitly.`,
    { code: 'WORLD_MODEL_ROUTING_UNAVAILABLE' }
  );
}

/** Stable, content-free attribution suitable for a governed manifest or checkpoint. */
export function worldModelInvocationAttribution(result, stage, { reason = null } = {}) {
  const routing = result?.routing ?? null;
  return {
    mode: routing ? 'task-routed' : stage?.planned?.mode ?? 'caller-named',
    task: routing?.task ?? stage?.planned?.task ?? null,
    mapping_revision: routing?.mappingRevision ?? stage?.planned?.mappingRevision ?? null,
    resolved_model: result?.model ?? stage?.planned?.preferredModel ?? null,
    available_models: routing?.available ?? stage?.planned?.availableModels ?? [],
    fallback_hops: routing?.fallbackHops ?? [],
    alias_of: routing?.aliasOf ?? stage?.planned?.aliasOf ?? null,
    params_digest: routing?.paramsDigest ?? stage?.planned?.paramsDigest ?? null,
    reason: routing ? null : reason ?? stage?.planned?.reason ?? null
  };
}

export function worldModelRoutingSummary(plan) {
  return {
    mode: plan.mode,
    discovery: worldModelInvocationAttribution(null, plan.discovery),
    synthesis: worldModelInvocationAttribution(null, plan.synthesis)
  };
}
