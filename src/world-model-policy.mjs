import { SingularityFlowError } from './util.mjs';

/**
 * The World Model is guidance, never authority. Nothing is refused, gated or authorized because a
 * model is missing, stale, invalid or unprovable: such a model is simply not used, with a warning.
 *
 * `worldModel.grounding: enforce` and `worldModel.staleness: fail` were blocking settings. They are
 * still accepted, so existing configuration loads unchanged, and they act as `warn`.
 */
export const WORLD_MODEL_GROUNDING_MODES = Object.freeze(['off', 'warn', 'enforce']);

/**
 * The registered World Model (WMB v4: published manifests and view files on the state branch, and
 * exact-history packets pinned to Stories) is off unless a repository sets
 * `worldModel.registered: on`. While it is off nothing builds, reads, verifies or asks for it, a
 * Story that pinned it continues without it, and phase prompts get the repository brief read from
 * the source instead. Its grounding, staleness and view settings are still accepted and ignored.
 */
export const WORLD_MODEL_REGISTERED_MODES = Object.freeze(['off', 'on']);

export function registeredWorldModelOn(definition = {}) {
  return definition?.worldModel?.registered === 'on';
}

/**
 * The grounding mode in effect: `off` while the registered World Model is off (whatever the
 * repository or a Story pinned), otherwise the Story's pinned mode or the configured one, with
 * `enforce` acting as `warn`. Every reader of a Story's grounding goes through here.
 */
export function effectiveGroundingMode(definition = {}, workflow = null) {
  if (!registeredWorldModelOn(definition)) return 'off';
  return guidanceGroundingMode(workflow ? workflow.resolution?.worldModelGrounding ?? 'off' : definition.worldModel?.grounding ?? 'off');
}

export function assertRegisteredWorldModelMode(definition = {}) {
  const value = definition?.worldModel?.registered;
  if (value != null && !WORLD_MODEL_REGISTERED_MODES.includes(value)) {
    throw new SingularityFlowError(`worldModel.registered must be off or on; got '${value}'.`);
  }
}
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
