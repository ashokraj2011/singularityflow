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

/** Effects are the six-key record, so a plan always separates context, state, files, refs, publication and external change `[INT:REQ-110]`. */
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

const FIELD_CHARACTERS = 400;
const DETAIL_CHARACTERS = 4000;

/** One value, bounded on its own, saying how much was left out. */
function boundedText(value, limit = FIELD_CHARACTERS) {
  const text = String(value);
  if (text.length <= limit) return text;
  const end = /[\uD800-\uDBFF]/u.test(text[limit - 1]) ? limit - 1 : limit;
  return `${text.slice(0, end)}… (${text.length - end} more characters)`;
}

/** A preview field as lines. A nested record flattens to dotted names, so each string is bounded alone. */
function fieldLines(name, value) {
  if (value === null || value === undefined) return [`${name}: none`];
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) return [`${name}: ${value.length ? boundedText(value.join(', ')) : 'none'}`];
    return value.flatMap((item, index) => fieldLines(`${name}[${index}]`, item));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? entries.flatMap(([key, item]) => fieldLines(`${name}.${key}`, item)) : [`${name}: none`];
  }
  return [`${name}: ${boundedText(value)}`];
}

/**
 * The words a person reads before confirming a plan: one text for every host. `[INT:REQ-069]`
 *
 * What the act changes, what it leaves alone, which outside systems it reads and where it reaches
 * come first and whole — they are what the confirmation is about. The rest of the preview follows
 * field by field, each long free-text value cut on its own with how much was left out, so a long
 * description can no longer push the effects off a text cut at a fixed length while the digest
 * binds the full preview. `review` is `kernel.planReview`'s record.
 */
export function confirmationText(review) {
  const preview = review?.review?.preview ?? {};
  const changes = Object.entries(review?.effects ?? {}).filter(([, value]) => value).map(([key]) => key);
  const effects = [`This will change: ${changes.length ? changes.join(', ') : 'nothing'}`];
  if (Array.isArray(preview.unchanged)) effects.push(`Leaves unchanged: ${preview.unchanged.length ? preview.unchanged.join(', ') : 'nothing named'}`);
  if (Array.isArray(preview.externalReferences)) {
    effects.push(`External references: ${preview.externalReferences.length
      ? preview.externalReferences.map((entry) => `${entry.tracker} ${entry.key} (${entry.access})`).join(', ') : 'none'}`);
  }
  const targets = review?.externalTargets ?? [];
  if (targets.length) effects.push(`Reaches: ${targets.map((target) => `${target.kind} (${target.purpose})`).join(', ')}`);
  const fields = Object.entries(preview).filter(([key]) => !['action', 'unchanged', 'externalReferences'].includes(key))
    .flatMap(([key, value]) => fieldLines(key, value));
  const lines = [...effects, ''];
  let length = lines.join('\n').length;
  for (const [index, line] of fields.entries()) {
    if (length + line.length + 1 > DETAIL_CHARACTERS) {
      lines.push(`(${fields.length - index} more fields not shown; the confirmation covers the full preview)`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  return Object.freeze({
    title: `Confirm: ${String(preview.action ?? review?.operationId ?? 'plan').replaceAll('-', ' ')}`,
    detail: lines.join('\n')
  });
}

/** The actor a local, identity-scoped record is filed under: the binding's own choice of field. */
export function plannerActor(context = {}) {
  return context.actor?.email ?? context.actor?.login ?? null;
}
