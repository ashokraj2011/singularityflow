import { SingularityFlowError } from './util.mjs';

export const WORLD_MODEL_STALENESS_POLICIES = Object.freeze(['ignore', 'warn', 'fail']);

/**
 * Decide staleness independently from grounding availability.
 *
 * Grounding answers whether a phase requires repository context. Staleness answers whether an
 * otherwise valid snapshot may be consumed after its source bytes move. Combining those two axes
 * made `grounding: enforce` override `staleness: ignore`, and made `grounding: warn` disarm
 * `staleness: fail`. Every lifecycle consumer uses this result instead.
 */
export function worldModelStalenessDecision(policy = 'warn', fresh = true, message = 'Repository world model is stale.') {
  if (!WORLD_MODEL_STALENESS_POLICIES.includes(policy)) {
    throw new SingularityFlowError("worldModel.staleness must be 'warn', 'fail', or 'ignore'.");
  }
  const stale = fresh !== true;
  return Object.freeze({
    policy,
    fresh: !stale,
    stale,
    blocks: stale && policy === 'fail',
    warns: stale && policy === 'warn',
    ignored: stale && policy === 'ignore',
    status: !stale ? 'fresh' : policy === 'fail' ? 'blocked' : policy === 'warn' ? 'warning' : 'ignored',
    message: stale ? message : null
  });
}

/** Raise the one policy-specific stale-model refusal used by lifecycle composition paths. */
export function assertWorldModelStaleness(policy, fresh, message = 'Repository world model is stale.') {
  const decision = worldModelStalenessDecision(policy, fresh, message);
  if (decision.blocks) {
    throw new SingularityFlowError(`${message} Rebuild it.`, {
      code: 'WORLD_MODEL_STALE',
      details: { staleness: policy }
    });
  }
  return decision;
}
