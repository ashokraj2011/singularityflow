/**
 * Handles, plans and confirmation receipts. `[INT:REQ-033]` `[INT:REQ-034]` `[INT:IFC-050]` `[INT:REQ-111]`
 *
 * The five model-facing tools take a handle and almost nothing else `[INT:IFC-013]` `[INT:IFC-015]`.
 * That is the safety story in one sentence: the model can ask for a thing to be resolved, and it can
 * ask for something already resolved to be carried out, but between those two moments it never holds
 * a name it could substitute. This module is what makes a handle worth trusting.
 *
 * Three properties do the work, and each fails differently without the others:
 *
 *   - **Opaque.** The payload is signed and the model sees an ID, never the operation name. A host
 *     that can reconstruct the operation from a handle can invoke one that was never offered.
 *   - **Bound.** Every handle carries the exact world it was computed against — subject, revisions,
 *     registry hash, policy hash, actor, session. Anything that moves invalidates it, so a plan
 *     cannot be approved against one reality and executed against another.
 *   - **Expiring and, for plans, single-use.** A confirmation is for one act, not for a while.
 *
 * The signing secret is generated per gateway session and never written down. Handles are already
 * session-bound, so a key that outlives the session would only add somewhere for it to leak from.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';
import { EFFECT_KEYS } from './result.mjs';

export const HANDLE_SCHEMA_VERSION = 1;

/**
 * `selection` names one of several candidates the kernel offered `[INT:REQ-033]`; `read` executes a
 * resolved read `[INT:REQ-034]`; `plan` is the one that can change something `[INT:IFC-050]`.
 */
export const HANDLE_KINDS = Object.freeze(['selection', 'read', 'plan']);

/** Default lifetimes. Short enough that a stale handle is the common failure, not a silent success. */
export const HANDLE_TTL_MS = Object.freeze({ selection: 120_000, read: 300_000, plan: 600_000 });

/** A confirmation is exchanged and used immediately, or not at all `[INT:REQ-111]`. */
export const RECEIPT_TTL_MS = 120_000;

function reject(code, detail, details = {}) {
  throw new SingularityFlowError(detail, { code, details });
}

/**
 * The world a handle was computed against `[INT:REQ-034]`.
 *
 * Every field is required and may be explicitly null, never absent. A binding with a missing field
 * cannot be distinguished from one where the field did not apply, and revalidation would then have
 * to decide which — so it is declared, the way effects are `[INT:CON-041]`.
 *
 * `[INT:REQ-035]`: what belongs here is what the answer actually depended on. Binding a document
 * read to an unrelated source commit means an unrelated commit invalidates it, which trains people
 * to re-confirm reflexively — and a confirmation nobody reads is not a confirmation.
 */
export const BINDING_FIELDS = Object.freeze([
  'workspaceId', 'repository', 'branch', 'subjectKind', 'subjectId', 'sourceCommit', 'worktreeHash',
  'lifecycleRevision', 'policyHash', 'registryHash', 'actorId', 'hostSessionId'
]);

function frozenBinding(binding, { label }) {
  if (!binding || typeof binding !== 'object') reject('HANDLE_BINDING_INVALID', `${label} requires a binding.`);
  const resolved = {};
  for (const field of BINDING_FIELDS) {
    if (!(field in binding)) {
      reject('HANDLE_BINDING_INVALID', `${label} binding omits '${field}'; declare it as null if it does not apply.`, { field });
    }
    resolved[field] = binding[field] ?? null;
  }
  // These four are what make revalidation meaningful; a handle without them binds nothing.
  for (const field of ['policyHash', 'registryHash', 'actorId', 'hostSessionId']) {
    if (!resolved[field]) reject('HANDLE_BINDING_INVALID', `${label} binding requires ${field}.`, { field });
  }
  return Object.freeze(resolved);
}

function frozenEffects(preview, label) {
  const effects = {};
  for (const key of EFFECT_KEYS) {
    if (typeof preview?.[key] !== 'boolean') {
      reject('PLAN_EFFECTS_INVALID', `${label} must preview effects.${key} as a boolean.`, { effect: key });
    }
    effects[key] = preview[key];
  }
  return Object.freeze(effects);
}

const digest = (secret, value) => createHmac('sha256', secret).update(canonicalJson(value)).digest('hex');

function sameSignature(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Issue and verify handles for one gateway session.
 *
 * `now` is injected rather than read from the clock so expiry is testable, and because a kernel that
 * takes its own time from one place is a kernel whose audit records agree with each other.
 */
export function createHandleAuthority({ secret = randomBytes(32), now = () => Date.now() } = {}) {
  const issued = new Map();

  const sign = (payload) => digest(secret, payload);

  function issue(kind, { operationId, classification, arguments: args = {}, binding, ttlMs, ...rest }) {
    if (!HANDLE_KINDS.includes(kind)) reject('HANDLE_KIND_INVALID', `'${kind}' is not a handle kind.`, { kind });
    if (!operationId) reject('HANDLE_INVALID', 'A handle requires the operation it resolved to.');
    if (!classification) reject('HANDLE_INVALID', 'A handle requires the classification it resolved to.');

    const createdAt = now();
    /**
     * `rest` is spread first, deliberately. Everything below it — the ID, the timestamps, the
     * binding — is the kernel's to set, and a caller that could pass `expiresAt` could issue a
     * handle that never dies.
     */
    const payload = Object.freeze({
      ...rest,
      schemaVersion: HANDLE_SCHEMA_VERSION,
      kind,
      id: `${kind.slice(0, 3)}_${randomUUID().replaceAll('-', '')}`,
      operationId,
      classification,
      arguments: Object.freeze({ ...args }),
      binding: frozenBinding(binding, { label: `A ${kind} handle` }),
      createdAt,
      expiresAt: createdAt + (ttlMs ?? HANDLE_TTL_MS[kind])
    });
    const record = Object.freeze({ ...payload, signature: sign(payload) });
    issued.set(record.id, { record, consumed: false });
    /**
     * What the model is given, and all it is given.
     *
     * Not the operation, not the arguments, not the binding — an ID and when it dies. Everything
     * else stays here, where the kernel can compare it against the world at execution time.
     */
    return Object.freeze({ record, reference: Object.freeze({ id: record.id, kind, expiresAt: record.expiresAt }) });
  }

  return Object.freeze({
    /** One of several candidates the kernel offered, so the next turn refers to a choice, not a name. */
    issueSelection: (input) => issue('selection', input),
    issueRead: (input) => issue('read', input),

    /**
     * A content-hashed plan `[INT:IFC-050]`. The hash is what a receipt binds to, so drift in any
     * field the user was shown invalidates the confirmation rather than being carried past it.
     */
    issuePlan(input) {
      const effects = frozenEffects(input.effects, 'A plan');
      if (input.classification === 'authorization') {
        reject('PLAN_FORBIDDEN', 'An authorization is a ceremony and has no executable plan.', { operationId: input.operationId });
      }
      if (!input.confirmation || input.confirmation === 'none') {
        reject('PLAN_INVALID', 'A plan requires a confirmation class other than none.', { operationId: input.operationId });
      }
      if (!input.idempotencyKey) reject('PLAN_INVALID', 'A plan requires an idempotency key.', { operationId: input.operationId });
      const { record, reference } = issue('plan', {
        ...input,
        effects,
        externalTargets: Object.freeze([...(input.externalTargets ?? [])]),
        confirmation: input.confirmation,
        idempotencyKey: input.idempotencyKey
      });
      return { plan: record, reference, planHash: record.signature };
    },

    /**
     * Revalidate at the moment of use, against the world as it is now `[INT:REQ-036]`.
     *
     * Signature, expiry, single-use and every bound field, in that order. The binding comparison is
     * whole-record rather than field-by-field: a check that names the fields it compares is a check
     * that silently stops covering the field someone adds next.
     */
    verify(reference, { kind, binding, consume = false } = {}) {
      const entry = issued.get(reference?.id ?? reference);
      if (!entry) reject('HANDLE_UNKNOWN', 'That handle was not issued by this session.');
      const { record } = entry;
      if (kind && record.kind !== kind) reject('HANDLE_KIND_MISMATCH', `That is a ${record.kind} handle, not a ${kind} handle.`);
      const { signature, ...payload } = record;
      if (!sameSignature(signature, sign(payload))) {
        reject('HANDLE_TAMPERED', 'That handle does not match its signature.');
      }
      if (now() >= record.expiresAt) reject('HANDLE_EXPIRED', 'That handle has expired; ask again and it will be recomputed.');
      if (entry.consumed) reject('HANDLE_CONSUMED', 'That handle has already been used.');
      if (binding) {
        const current = frozenBinding(binding, { label: 'Revalidation' });
        const drifted = BINDING_FIELDS.filter((field) => current[field] !== record.binding[field]);
        if (drifted.length) {
          reject('HANDLE_DRIFTED', `The world moved under that handle: ${drifted.join(', ')} changed.`, { drifted });
        }
      }
      if (consume) entry.consumed = true;
      return record;
    },

    /** Whether a handle is still usable, without the throw. For rendering, never for gating. */
    status(reference) {
      const entry = issued.get(reference?.id ?? reference);
      if (!entry) return 'unknown';
      if (entry.consumed) return 'consumed';
      return now() >= entry.record.expiresAt ? 'expired' : 'live';
    }
  });
}

/**
 * Exchange a host-collected confirmation for a one-time receipt. `[INT:CON-111]` `[INT:REQ-111]`
 *
 * The split return is the contract, not a convenience. `value` is the secret and goes to the host
 * out of band; `record` is what the kernel keeps and contains only its hash. The value must never
 * reach conversation, tool arguments, tool results, narration, telemetry or logs `[INT:CON-039]`,
 * and the cheapest way to guarantee that is for the stored side to be unable to reproduce it.
 */
export function issueConfirmationReceipt({ planHash, actorId, hostSessionId, audience, now = () => Date.now(), ttlMs = RECEIPT_TTL_MS } = {}) {
  if (!planHash) reject('RECEIPT_INVALID', 'A receipt must be bound to a plan hash.');
  if (!actorId) reject('RECEIPT_INVALID', 'A receipt must be bound to an actor.');
  if (!hostSessionId) reject('RECEIPT_INVALID', 'A receipt must be bound to a host session.');
  if (!audience) reject('RECEIPT_INVALID', 'A receipt must name the audience allowed to redeem it.');

  const value = randomBytes(32).toString('base64url');
  const createdAt = now();
  const record = Object.freeze({
    schemaVersion: HANDLE_SCHEMA_VERSION,
    kind: 'confirmation-receipt',
    id: `rcp_${randomUUID().replaceAll('-', '')}`,
    planHash,
    actorId,
    hostSessionId,
    audience,
    createdAt,
    expiresAt: createdAt + ttlMs,
    // The hash, never the value. Whoever reads this record cannot replay it.
    valueHash: digest(planHash, value),
    redeemedAt: null
  });
  return { value, record };
}

/**
 * Redeem a receipt exactly once, against the plan it was issued for.
 *
 * Returns the record marked redeemed rather than mutating in place, so the caller has to store the
 * result — a single-use token whose consumption is optional to persist is not single-use.
 */
export function redeemConfirmationReceipt(record, value, { planHash, actorId, hostSessionId, audience, now = () => Date.now() } = {}) {
  if (record?.kind !== 'confirmation-receipt') reject('RECEIPT_INVALID', 'That is not a confirmation receipt.');
  if (record.redeemedAt) reject('RECEIPT_SPENT', 'That confirmation has already been used.');
  if (now() >= record.expiresAt) reject('RECEIPT_EXPIRED', 'That confirmation has expired; confirm again.');
  for (const [field, expected] of [['planHash', planHash], ['actorId', actorId], ['hostSessionId', hostSessionId], ['audience', audience]]) {
    if (record[field] !== expected) {
      reject('RECEIPT_MISBOUND', `That confirmation was not issued for this ${field}.`, { field });
    }
  }
  if (!sameSignature(record.valueHash, digest(record.planHash, value ?? ''))) {
    reject('RECEIPT_INVALID', 'That confirmation value does not match.');
  }
  return Object.freeze({ ...record, redeemedAt: now() });
}
