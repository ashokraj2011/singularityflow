import { SingularityFlowError } from './util.mjs';

/**
 * The World Model is guidance, never authority. Nothing is refused, gated or authorized because a
 * model is missing, stale, invalid or unprovable: such a model is simply not used, with a warning.
 *
 * `worldModel.grounding: enforce` and `worldModel.staleness: fail` were blocking settings. They are
 * still accepted, so existing configuration loads unchanged, and they act as `warn`.
 */
export const WORLD_MODEL_GROUNDING_MODES = Object.freeze(['off', 'warn', 'enforce']);
export const WORLD_MODEL_STALENESS_POLICIES = Object.freeze(['ignore', 'warn', 'fail']);

/** The grounding mode in effect for a configured one: `enforce` acts as `warn`. */
export function guidanceGroundingMode(mode = 'off') {
  if (!WORLD_MODEL_GROUNDING_MODES.includes(mode)) {
    throw new SingularityFlowError(`worldModel.grounding must be off, warn, or enforce; got '${mode}'.`);
  }
  return mode === 'enforce' ? 'warn' : mode;
}

/** The configured World Model settings that used to block and now only warn, for diagnostics. */
export function retiredWorldModelBlockingSettings(definition = {}) {
  return [
    ...(definition.worldModel?.grounding === 'enforce' ? ['worldModel.grounding: enforce'] : []),
    ...(definition.worldModel?.staleness === 'fail' ? ['worldModel.staleness: fail'] : [])
  ];
}

/**
 * Decide what a stale model means for one consumer: warn about it, or ignore it. A stale model is
 * still guidance; it never stops a lifecycle step.
 */
export function worldModelStalenessDecision(policy = 'warn', fresh = true, message = 'Repository world model is stale.') {
  if (!WORLD_MODEL_STALENESS_POLICIES.includes(policy)) {
    throw new SingularityFlowError("worldModel.staleness must be 'warn', 'fail', or 'ignore'.");
  }
  const effective = policy === 'fail' ? 'warn' : policy;
  const stale = fresh !== true;
  return Object.freeze({
    policy: effective,
    fresh: !stale,
    stale,
    warns: stale && effective === 'warn',
    ignored: stale && effective === 'ignore',
    status: !stale ? 'fresh' : effective === 'warn' ? 'warning' : 'ignored',
    message: stale ? message : null
  });
}
