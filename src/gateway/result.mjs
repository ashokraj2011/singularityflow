/**
 * The canonical `sflow-result` v2 contract. `[INT:IFC-020]`
 *
 * One shape for every gateway, CLI, skill and host operation, so a caller reads the same fields
 * whatever produced them. The v1 `commandResult` said what happened; v2 adds what the *host* should
 * do next, what the result is *about*, and exactly which revisions it was computed from — the three
 * things a conversational surface needs and cannot safely infer.
 *
 * Two fields are deliberately separate and neither is lifecycle authority `[INT:REQ-040]`:
 *
 *   - `kind` tells the host how to continue — render a read, offer a plan, open a ceremony, ask a
 *     question, or stop.
 *   - `outcome.status` tells the reader what happened.
 *
 * They differ more often than they agree. A refusal is a completed operation that produced nothing;
 * a candidates result succeeded and still requires a choice. Collapsing them into one field is what
 * made v1 producers reach for prose to explain the gap.
 *
 * The reset is deliberate `[INT:CON-042]`: a touched producer moves to v2 whole, and schema version
 * 1 keeps exactly one meaning. Two live meanings for one version number is the defect this contract
 * exists to prevent.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';

export const SFLOW_RESULT_SCHEMA_VERSION = 2;

/** How the host continues. Not what happened — that is `outcome.status`. `[INT:REQ-040]` */
export const RESULT_KINDS = Object.freeze([
  'read', 'plan', 'ceremony', 'host-action', 'candidates', 'clarification', 'refusal'
]);

/** What happened. */
export const RESULT_STATUSES = Object.freeze(['succeeded', 'refused', 'failed', 'noop']);

/**
 * Every effect a result can declare, and the complete set it must declare.
 *
 * Enumerated rather than open so a producer cannot report a subset and leave a reader guessing
 * whether an unlisted effect was false or simply unconsidered `[INT:CON-041]`. Each is a distinct
 * blast radius: local context, governed state, the worktree, Git refs, the publication ledger, and
 * the world outside this machine.
 */
export const EFFECT_KEYS = Object.freeze([
  'contextChanged', 'stateChanged', 'filesChanged',
  'gitRefsChanged', 'publicationCreated', 'externalSystemsChanged'
]);

/** How a next action may be authorized. `[INT:IFC-051]` */
export const CONFIRMATION_CLASSES = Object.freeze([
  'none', 'host-confirm', 'exact-confirm', 'ceremony', 'explicit-only'
]);

/** Where a reason or warning came from, so a reader can weigh it. `[INT:CON-010]` */
export const REASON_SOURCES = Object.freeze([
  'policy', 'lifecycle', 'evidence', 'provider', 'registry', 'deterministic', 'assisted', 'unavailable'
]);

function invalid(detail) {
  throw new SingularityFlowError(`Invalid sflow-result: ${detail}`, { code: 'SFLOW_RESULT_INVALID' });
}

function frozenRecords(entries, label) {
  if (!Array.isArray(entries)) invalid(`${label} must be an array`);
  return Object.freeze(entries.map((entry, index) => {
    // Structured, never handler-authored prose `[INT:IFC-021]`. Prose cannot be translated,
    // filtered, counted, or matched against a catalog, and every v1 surface that allowed it grew a
    // second vocabulary nobody could enumerate.
    if (!entry?.code) invalid(`${label}[${index}] has no catalog code`);
    if (!REASON_SOURCES.includes(entry.source)) {
      invalid(`${label}[${index}].source '${entry.source}' is not one of ${REASON_SOURCES.join(', ')}`);
    }
    return Object.freeze({
      code: String(entry.code),
      source: entry.source,
      reference: entry.reference ?? null,
      slots: Object.freeze({ ...(entry.slots ?? {}) })
    });
  }));
}

/**
 * A next action the kernel computed. `[INT:IFC-022]`
 *
 * `handle` is opaque on purpose: a host that can reconstruct an operation name from a next action
 * can invoke one that was never offered. The label is for the reader, the handle is for the kernel,
 * and `fallback` is what a host without the capability tells the user to type instead.
 */
function frozenNextActions(entries) {
  if (!Array.isArray(entries)) invalid('next must be an array');
  return Object.freeze(entries.map((entry, index) => {
    if (!entry?.handle) invalid(`next[${index}] has no action handle`);
    if (!entry?.label) invalid(`next[${index}] has no label`);
    if (!RESULT_KINDS.includes(entry.kind)) invalid(`next[${index}].kind '${entry.kind}' is not a result kind`);
    if (!CONFIRMATION_CLASSES.includes(entry.confirmation)) {
      invalid(`next[${index}].confirmation '${entry.confirmation}' is not a confirmation class`);
    }
    if (!entry?.reasonCode) invalid(`next[${index}] has no reason code`);
    return Object.freeze({
      handle: String(entry.handle),
      label: String(entry.label),
      rank: Number(entry.rank ?? index),
      kind: entry.kind,
      reasonCode: String(entry.reasonCode),
      confirmation: entry.confirmation,
      /**
       * The values a label names, structured rather than concatenated into it.
       *
       * §3.2 requires the home menu's first item to name the Story, repository, phase and legal next
       * action. A handler could assemble that into the label, and then the sentence is prose: it
       * cannot be translated, and the four values cannot be read back out. Slots are how `outcome`
       * and `why` already carry their values, and a next action needs the same for the same reason.
       */
      slots: Object.freeze({ ...(entry.slots ?? {}) }),
      // An authorization decision is never executable by an ambient tool `[INT:CON-113]`.
      executable: entry.confirmation === 'ceremony' ? false : entry.executable !== false,
      fallback: entry.fallback ? Object.freeze({ ...entry.fallback }) : null
    });
  }));
}

function frozenEffects(declared) {
  const effects = {};
  for (const key of EFFECT_KEYS) {
    if (typeof declared?.[key] !== 'boolean') {
      invalid(`effects.${key} must be declared as a boolean; a partial effects record cannot be read`);
    }
    effects[key] = declared[key];
  }
  return Object.freeze(effects);
}

/** No effect at all. The only correct effects record for a refusal `[INT:CON-041]`. */
export function noEffects() {
  return Object.fromEntries(EFFECT_KEYS.map((key) => [key, false]));
}

/** Declare the effects that occurred; everything unnamed is false. */
export function effects(occurred = {}) {
  for (const key of Object.keys(occurred)) {
    if (!EFFECT_KEYS.includes(key)) invalid(`'${key}' is not a known effect`);
  }
  return { ...noEffects(), ...occurred };
}

/**
 * Build a validated, frozen result.
 *
 * Validation happens at construction rather than at the boundary, so a producer cannot emit a
 * malformed result that only fails once it reaches a host that happens to read the missing field.
 */
export function sflowResult({
  kind,
  operation,
  subject = null,
  outcome,
  effects: declared,
  why = [],
  warnings = [],
  next = [],
  restState = null,
  data = {}
} = {}) {
  if (!RESULT_KINDS.includes(kind)) invalid(`kind '${kind}' is not one of ${RESULT_KINDS.join(', ')}`);
  if (!operation?.id) invalid('operation.id is required');
  if (!operation?.classification) invalid('operation.classification is required');
  if (!RESULT_STATUSES.includes(outcome?.status)) {
    invalid(`outcome.status '${outcome?.status}' is not one of ${RESULT_STATUSES.join(', ')}`);
  }
  if (!outcome?.messageId) invalid('outcome.messageId is required; narration comes from the catalog');

  const resolvedEffects = frozenEffects(declared);

  /**
   * A refusal that declares an effect is either lying or is not a refusal. Both are worth failing
   * loudly for, because a reader who cannot trust the effects record has to re-derive it from prose.
   */
  if (kind === 'refusal' || outcome.status === 'refused') {
    const claimed = EFFECT_KEYS.filter((key) => resolvedEffects[key]);
    if (claimed.length) invalid(`a refusal declared effects: ${claimed.join(', ')}`);
  }

  const resolvedNext = frozenNextActions(next);
  // Never a dead end `[INT:REQ-041]`. A result with no next action and no rest state leaves the
  // reader to guess whether the journey continues, which is the state every guided surface is for.
  if (!resolvedNext.length && !restState) {
    invalid('a result must offer at least one next action or declare an explicit rest state');
  }

  /**
   * An authorization decision is a ceremony, always `[INT:CON-113]`. Checked here rather than only
   * at the tool boundary: a result claiming `kind: plan` for an approval would be executable by any
   * host that trusts the contract.
   */
  if (operation.classification === 'authorization' && kind !== 'ceremony') {
    invalid(`operation '${operation.id}' is an authorization and must return kind 'ceremony', not '${kind}'`);
  }

  return Object.freeze({
    schemaVersion: SFLOW_RESULT_SCHEMA_VERSION,
    resultType: 'sflow-result',
    kind,
    operation: Object.freeze({ id: operation.id, classification: operation.classification }),
    subject: subject
      ? Object.freeze({
        kind: subject.kind,
        id: subject.id,
        revision: Object.freeze({
          sourceCommit: subject.revision?.sourceCommit ?? null,
          lifecycleHash: subject.revision?.lifecycleHash ?? null,
          policyHash: subject.revision?.policyHash ?? null,
          registryHash: subject.revision?.registryHash ?? null
        })
      })
      : null,
    outcome: Object.freeze({
      status: outcome.status,
      messageId: outcome.messageId,
      slots: Object.freeze({ ...(outcome.slots ?? {}) })
    }),
    effects: resolvedEffects,
    why: frozenRecords(why, 'why'),
    warnings: frozenRecords(warnings, 'warnings'),
    next: resolvedNext,
    restState: restState ?? null,
    data: Object.freeze({ ...data })
  });
}

/**
 * Validate a result that arrived from elsewhere.
 *
 * Rebuilding through `sflowResult` rather than re-checking field by field: one implementation of
 * what valid means, so a check cannot drift from construction.
 */
export function validateSflowResult(result) {
  if (result?.resultType !== 'sflow-result') invalid(`resultType '${result?.resultType}' is not sflow-result`);
  if (result?.schemaVersion !== SFLOW_RESULT_SCHEMA_VERSION) {
    invalid(`schemaVersion ${result?.schemaVersion} is not ${SFLOW_RESULT_SCHEMA_VERSION};`
      + ' v2 is a clean reset and version 1 keeps exactly one meaning');
  }
  sflowResult(result);
  return result;
}

/** Content address, so a plan, receipt or audit event can name a result without copying it. */
export function resultHash(result) {
  return createHash('sha256').update(canonicalJson(validateSflowResult(result))).digest('hex');
}
