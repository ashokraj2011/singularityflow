
import { SingularityFlowError } from './util.mjs';

export const MATERIALIZATION_MODES = Object.freeze(['on-demand', 'explicit', 'disabled']);
export const MATERIALIZATION_DEPTHS = Object.freeze(['light', 'phase']);
export const MATERIALIZATION_CONFIRMATIONS = Object.freeze(['prompt', 'automatic']);

export function materializationPolicy(definition = {}) {
  const configured = definition.worldModel?.materialization ?? {};
  const mode = configured.mode ?? 'explicit';
  const publish = configured.publish ?? 'governed';
  const lookahead = configured.lookahead ?? 'none';
  const depth = configured.depth ?? 'phase';
  const confirmation = configured.confirmation ?? 'prompt';
  if (!MATERIALIZATION_MODES.includes(mode)) throw new SingularityFlowError(`worldModel.materialization.mode must be ${MATERIALIZATION_MODES.join(', ')}.`);
  if (!['governed', 'local'].includes(publish)) throw new SingularityFlowError("worldModel.materialization.publish must be 'governed' or 'local'.");
  if (!['none', 'next-phase'].includes(lookahead)) throw new SingularityFlowError("worldModel.materialization.lookahead must be 'none' or 'next-phase'.");
  if (!MATERIALIZATION_DEPTHS.includes(depth)) throw new SingularityFlowError(`worldModel.materialization.depth must be ${MATERIALIZATION_DEPTHS.join(' or ')}.`);
  if (!MATERIALIZATION_CONFIRMATIONS.includes(confirmation)) throw new SingularityFlowError(`worldModel.materialization.confirmation must be ${MATERIALIZATION_CONFIRMATIONS.join(' or ')}.`);
  // A phase-depth ensure may invoke the configured model provider. Automatic materialization is
  // intentionally limited to the deterministic light builder, which uses zero model tokens.
  if (confirmation === 'automatic' && depth !== 'light') {
    throw new SingularityFlowError("worldModel.materialization.confirmation 'automatic' requires depth 'light'; model-driven phase materialization must be confirmed.");
  }
  return { mode, publish, lookahead, depth, confirmation };
}

/** Resolve an immutable work-item snapshot before falling back to the live repository policy. */
export function effectiveMaterializationPolicy(config = {}, workflow = null) {
  const pinned = workflow?.resolution?.worldModelMaterialization;
  return pinned
    ? materializationPolicy({ worldModel: { materialization: pinned } })
    : materializationPolicy(config.definition ?? config);
}

/**
 * Decide whether unattended lifecycle materialization may proceed.
 *
 * Automatic mode may create the first model, or add missing selections to an integrity-verified
 * model for the exact same source snapshot. It must never replace an existing stale, divergent,
 * or invalid model. That boundary requires an explicit `wm ensure` or `wm build` request.
 */
export function automaticMaterializationDecision(availability) {
  if (!availability || !Array.isArray(availability.candidates)) {
    return {
      allowed: false,
      mode: 'preserve-existing',
      reason: 'world-model authority could not be inspected, so absence is not proven'
    };
  }
  if (availability?.ready) {
    return { allowed: false, mode: 'reuse', reason: 'the existing world model already satisfies the grounding plan' };
  }
  if (availability?.remoteModelInHistory === true && availability?.remoteModelAtTip === false) {
    return {
      allowed: false,
      mode: 'preserve-existing',
      reason: 'the governed state branch removed its world-model projection; automatic recreation or extension is prohibited'
    };
  }
  if (Array.isArray(availability?.conflicts) && availability.conflicts.length > 0) {
    return {
      allowed: false,
      mode: 'preserve-existing',
      reason: `the existing world-model authority requires review: ${availability.conflicts[0].message}`
    };
  }
  const present = (availability?.candidates ?? []).some((candidate) => candidate?.present === true);
  if (!present) {
    return { allowed: true, mode: 'initial-create', reason: 'no existing world model is present' };
  }
  if (availability?.extensionBase) {
    return {
      allowed: true,
      mode: 'same-source-extension',
      reason: 'an integrity-verified same-source model can retain its existing bytes while missing selections are added'
    };
  }
  return {
    allowed: false,
    mode: 'preserve-existing',
    reason: 'an existing world model is stale, invalid, or belongs to another source snapshot; automatic replacement is prohibited'
  };
}
