/**
 * What a mutation planner hands the kernel: the exact preview a person confirms. `[INT:IFC-050]`
 *
 * A mutation planner is a read. It looks at the world, decides precisely what carrying the act out
 * would change, and returns that as data; it never acts. The kernel signs the descriptor into a
 * plan whose hash a confirmation receipt binds to `[INT:REQ-111]`, so the preview is not a summary
 * of the plan — it *is* what is confirmed, and anything the person was not shown cannot be in it.
 *
 * `review.digest` is the content address of `review.preview`. An exact-confirm host shows the
 * preview and hands the digest of what it displayed back to `confirmPlan`; a preview recomputed
 * against a moved world has a different digest, so a confirmation of the old one cannot redeem
 * the new one `[INT:CON-064]`.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { effects as declaredEffects } from './result.mjs';

export function previewDigest(preview) {
  return `sha256:${createHash('sha256').update(canonicalJson(preview)).digest('hex')}`;
}

export function planDescriptor({ effects = {}, preview, idempotencyKey, externalTargets = [] } = {}) {
  if (!preview || typeof preview !== 'object') throw new TypeError('A plan descriptor needs the exact preview a person confirms.');
  if (!idempotencyKey) throw new TypeError('A plan descriptor needs an idempotency key.');
  return Object.freeze({
    effects: declaredEffects(effects),
    externalTargets: Object.freeze([...externalTargets]),
    idempotencyKey: String(idempotencyKey),
    review: Object.freeze({ digest: previewDigest(preview), preview: Object.freeze(structuredClone(preview)) })
  });
}

/** The actor a local, identity-scoped record is filed under: the binding's own choice of field. */
export function plannerActor(context = {}) {
  return context.actor?.email ?? context.actor?.login ?? null;
}
