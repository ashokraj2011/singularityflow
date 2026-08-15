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
 * Four channels carry what the reader needs and are never merged into one another `[UXH:REQ-061]`:
 * `outcome` is what happened, `why[]` is the deterministic reason, `preserved[]` is what survived,
 * and `next[]` is what is safe to do now. A surface may lay them out however it likes; it may not
 * flatten them, because the moment they are one string the reader cannot be told the third thing
 * without also being told the other three, and the third is the one they are actually asking about.
 * `checklist[]` is the fifth and narrower: the gate-by-gate detail behind a refusal `[UXH:REQ-062]`.
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

/**
 * How a next action is carried out, from the reader's side. `[UXH:REQ-030]`
 *
 * Distinct from `kind`, which says how the host renders *this* result. A read result can offer a
 * ceremony; a refusal can offer a recovery. Deriving one from the other would be the single field
 * with two meanings that `kind` and `outcome.status` are already kept apart to avoid.
 *
 * `model-consent` is declared and has no v1 producer `[UXH:AC-015]`. Naming it now means the day a
 * model enters a journey, the surface that must ask already has somewhere to say so — and until
 * then a test can assert the silence rather than trusting it.
 */
export const INTERACTION_CLASSES = Object.freeze([
  'read', 'form', 'ceremony', 'model-consent', 'external', 'navigation', 'recovery'
]);

/**
 * Visual weight, and the whole of it. `[UXH:REQ-030]` `[UXH:REQ-064]`
 *
 * At most one `primary` per result, checked at construction. The default is `secondary`, so a
 * producer that has not thought about emphasis renders no filled button — visibly wrong and quickly
 * fixed — rather than three of them, which looks fine and quietly destroys the one-legal-next-action
 * promise the home is built on.
 */
export const ACTION_EMPHASIS = Object.freeze(['primary', 'secondary', 'link']);

/**
 * A gate's evidence state. `[UXH:REQ-062]`
 *
 * `unmet` and `unknown` are different facts and are never merged: one says a gate was evaluated and
 * failed, the other says it was never evaluated. A checklist that shows both as a red cross tells
 * the reader to go and satisfy something that may already be satisfied.
 */
export const CHECKLIST_STATES = Object.freeze(['met', 'unmet', 'unknown']);

/**
 * What a preservation claim can be about. `[DHR:REQ-061]`
 *
 * The six effect keys, plus `all` for the common case of an operation that did not act at all.
 * `all` is not a shorthand the reader has to unpack — it is the strongest claim available and the
 * easiest to check, and a refusal is entitled to make it because a refusal may declare no effects.
 */
export const PRESERVATION_SCOPES = Object.freeze(['all', ...EFFECT_KEYS]);

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
 * What this result left alone, and how a reader can trust the claim. `[UXH:REQ-061]` `[DHR:REQ-061]`
 *
 * v1 had only `preservedEverything()` — a boolean derived from the effects record, which answers
 * "was anything touched?" and not "is my work still there?". Those are different questions, and the
 * second is the one a person asks after a refusal.
 *
 * Every entry names a `scope`, and a scope is an effect key. That is the whole safety property:
 * `[DHR:CON-060]` forbids saying something was preserved without a record backing it, so a claim
 * that names a scope whose effect is `true` is rejected here rather than rendered. A producer cannot
 * tell a reader their work is untouched in the same breath as reporting that it changed.
 */
function frozenPreserved(entries, resolvedEffects) {
  if (!Array.isArray(entries)) invalid('preserved must be an array');
  return Object.freeze(entries.map((entry, index) => {
    if (!entry?.code) invalid(`preserved[${index}] has no catalog code`);
    if (!REASON_SOURCES.includes(entry.source)) {
      invalid(`preserved[${index}].source '${entry.source}' is not one of ${REASON_SOURCES.join(', ')}`);
    }
    if (!PRESERVATION_SCOPES.includes(entry.scope)) {
      invalid(`preserved[${index}].scope '${entry.scope}' is not one of ${PRESERVATION_SCOPES.join(', ')};`
        + ' a preservation claim must name what it is about so it can be checked');
    }
    const contradicted = entry.scope === 'all'
      ? EFFECT_KEYS.filter((key) => resolvedEffects[key])
      : (resolvedEffects[entry.scope] ? [entry.scope] : []);
    if (contradicted.length) {
      invalid(`preserved[${index}] claims ${entry.scope} was preserved while effects `
        + `${contradicted.join(', ')} ${contradicted.length === 1 ? 'is' : 'are'} true`);
    }
    return Object.freeze({
      code: String(entry.code),
      source: entry.source,
      scope: entry.scope,
      reference: entry.reference ?? null,
      slots: Object.freeze({ ...(entry.slots ?? {}) })
    });
  }));
}

/**
 * One row per gate, as a checklist rather than a red error. `[UXH:REQ-062]` `[UXH:AC-003]`
 *
 * `action` refers to a `next[]` entry by its stable `id`, never by handle and never by a command of
 * its own. Two consequences, both intended: a fix button goes through the same re-resolution as
 * every other action, and a row that points at an action this result did not offer is rejected here
 * — so the button that cannot work does not render at all.
 */
function frozenChecklist(entries, nextActions) {
  if (!Array.isArray(entries)) invalid('checklist must be an array');
  const offered = new Set(nextActions.map((action) => action.id));
  const seen = new Set();
  return Object.freeze(entries.map((entry, index) => {
    if (!entry?.id) invalid(`checklist[${index}] has no id`);
    if (seen.has(entry.id)) invalid(`checklist[${index}] repeats id '${entry.id}'`);
    seen.add(entry.id);
    if (!entry?.code) invalid(`checklist[${index}] has no catalog code`);
    if (!CHECKLIST_STATES.includes(entry.state)) {
      invalid(`checklist[${index}].state '${entry.state}' is not one of ${CHECKLIST_STATES.join(', ')}`);
    }
    if (!REASON_SOURCES.includes(entry.source)) {
      invalid(`checklist[${index}].source '${entry.source}' is not one of ${REASON_SOURCES.join(', ')}`);
    }
    if (entry.action != null && !offered.has(entry.action)) {
      invalid(`checklist[${index}].action '${entry.action}' is not one of this result's next actions`);
    }
    return Object.freeze({
      id: String(entry.id),
      code: String(entry.code),
      state: entry.state,
      source: entry.source,
      /** What was actually looked at. Null is honest for `unknown`; it is a lie for `met`. */
      evidence: entry.evidence ?? null,
      action: entry.action ?? null,
      slots: Object.freeze({ ...(entry.slots ?? {}) })
    });
  }));
}

/**
 * A next action the kernel computed. `[INT:IFC-022]` `[UXH:REQ-030]`
 *
 * `handle` is opaque on purpose: a host that can reconstruct an operation name from a next action
 * can invoke one that was never offered. The label is for the reader, the handle is for the kernel,
 * and `fallback` is what a host without the capability tells the user to type instead.
 *
 * `id` is separate from `handle` and both are required, because they have opposite lifetimes. A
 * handle is issued per resolution and rotates every time the result is recomputed; `id` names the
 * same action across recomputations, which is what focus restoration, telemetry and a checklist row
 * pointing at its fix button all need. Defaulting `id` to the handle would look correct and move
 * the focus ring on every refresh.
 */
function frozenNextActions(entries) {
  if (!Array.isArray(entries)) invalid('next must be an array');
  const seen = new Set();
  const actions = Object.freeze(entries.map((entry, index) => {
    if (!entry?.handle) invalid(`next[${index}] has no action handle`);
    if (!entry?.id) invalid(`next[${index}] has no stable id; a handle rotates and cannot name an action twice`);
    if (seen.has(entry.id)) invalid(`next[${index}] repeats id '${entry.id}'`);
    seen.add(entry.id);
    if (!entry?.label) invalid(`next[${index}] has no label`);
    if (!RESULT_KINDS.includes(entry.kind)) invalid(`next[${index}].kind '${entry.kind}' is not a result kind`);
    if (!CONFIRMATION_CLASSES.includes(entry.confirmation)) {
      invalid(`next[${index}].confirmation '${entry.confirmation}' is not a confirmation class`);
    }
    if (!INTERACTION_CLASSES.includes(entry.interaction)) {
      invalid(`next[${index}].interaction '${entry.interaction}' is not one of ${INTERACTION_CLASSES.join(', ')}`);
    }
    const emphasis = entry.emphasis ?? 'secondary';
    if (!ACTION_EMPHASIS.includes(emphasis)) {
      invalid(`next[${index}].emphasis '${entry.emphasis}' is not one of ${ACTION_EMPHASIS.join(', ')}`);
    }
    /**
     * The two ceremony vocabularies must agree `[INT:CON-113]`.
     *
     * `confirmation` gates the kernel and `interaction` drives the host. If they can disagree, the
     * failure is a surface that renders an approval as an ordinary button, which is precisely the
     * thing a ceremony exists to prevent.
     */
    if ((entry.confirmation === 'ceremony') !== (entry.interaction === 'ceremony')) {
      invalid(`next[${index}] has confirmation '${entry.confirmation}' and interaction '${entry.interaction}';`
        + ' a ceremony is both or neither');
    }
    if (!entry?.reasonCode) invalid(`next[${index}] has no reason code`);
    return Object.freeze({
      handle: String(entry.handle),
      id: String(entry.id),
      label: String(entry.label),
      rank: Number(entry.rank ?? index),
      kind: entry.kind,
      reasonCode: String(entry.reasonCode),
      confirmation: entry.confirmation,
      interaction: entry.interaction,
      emphasis,
      /** Which explanation answers "why is this here?". Resolved against the compiled topics. */
      topic: entry.topic ? String(entry.topic) : null,
      /**
       * A display-only summary of what carrying this out would change.
       *
       * Never authority: the effects that count are the ones the *plan* previews and the kernel
       * revalidates. This is here so a reader can weigh a button before pressing it, and a host that
       * treated it as a permission check would be trusting the sender of the thing it is checking.
       */
      effect: entry.effect
        ? Object.freeze({ summaryMessageId: String(entry.effect.summaryMessageId), target: entry.effect.target ?? null })
        : null,
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

  /**
   * At most one filled button `[UXH:REQ-064]`.
   *
   * The rule is about attention, not aesthetics: a surface offering two equally-weighted primaries
   * has told the reader nothing about which one the system believes is next, and a guided shell
   * whose guidance is "pick one" is a menu. What emphasis a producer *chooses* is still its own
   * judgement — REQ-064 also forbids giving a destructive action primary weight merely because it
   * is the only mutation on offer, and no schema can see that. This checks the half that is visible
   * from here and leaves the other half to the producer's own tests.
   */
  const primaries = actions.filter((action) => action.emphasis === 'primary');
  if (primaries.length > 1) {
    invalid(`next declares ${primaries.length} primary actions (${primaries.map((a) => a.id).join(', ')});`
      + ' at most one action may carry primary emphasis');
  }
  return actions;
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

/**
 * The whole-world preservation claim, for a result that did not act `[DHR:REQ-061]`.
 *
 * A helper rather than a default, because a producer that did act must say what specifically it left
 * alone, and a default would let it say "everything" by omission on the one path where that matters.
 */
export function preservedAll(code, { source = 'deterministic', reference = null, slots = {} } = {}) {
  return [{ code, source, scope: 'all', reference, slots }];
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
  preserved = [],
  checklist = [],
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

  /**
   * An authorization decision is a ceremony, always `[INT:CON-113]`. Checked here rather than only
   * at the tool boundary: a result claiming `kind: plan` for an approval would be executable by any
   * host that trusts the contract.
   *
   * First of the payload checks, because it is the only one that is a statement about the operation
   * rather than about what the producer put in the envelope — and a wrongly-classified approval
   * should be reported as that, not as whichever field it also happened to get wrong.
   */
  if (operation.classification === 'authorization' && kind !== 'ceremony') {
    invalid(`operation '${operation.id}' is an authorization and must return kind 'ceremony', not '${kind}'`);
  }

  const resolvedEffects = frozenEffects(declared);

  /**
   * A refusal that declares an effect is either lying or is not a refusal. Both are worth failing
   * loudly for, because a reader who cannot trust the effects record has to re-derive it from prose.
   */
  if (kind === 'refusal' || outcome.status === 'refused') {
    const claimed = EFFECT_KEYS.filter((key) => resolvedEffects[key]);
    if (claimed.length) invalid(`a refusal declared effects: ${claimed.join(', ')}`);
  }

  const resolvedPreserved = frozenPreserved(preserved, resolvedEffects);

  /**
   * A refusal says what was preserved, always `[DHR:REQ-061]`.
   *
   * The four things a blocked reader needs are what is blocked, why, what survived, and what is safe
   * to do next. Three of them already have somewhere to live — `outcome`, `why[]`, `next[]`. The
   * third had nowhere, so producers either omitted it or wrote it into prose, and a person who has
   * just been refused mid-flow and is not told their work is intact will go and check by hand.
   *
   * A failure is held to the same rule and is the harder case: some effects may have landed. The
   * scope check above is what keeps the answer honest there — a partially-applied operation can
   * still say truthfully what it did not touch, and cannot say anything else.
   */
  if (kind === 'refusal' || outcome.status === 'refused' || outcome.status === 'failed') {
    if (!resolvedPreserved.length) {
      invalid(`a ${outcome.status} result must state what it preserved;`
        + ' being told only that something was blocked is what sends a reader to check by hand');
    }
  }

  const resolvedNext = frozenNextActions(next);
  // Never a dead end `[INT:REQ-041]`. A result with no next action and no rest state leaves the
  // reader to guess whether the journey continues, which is the state every guided surface is for.
  if (!resolvedNext.length && !restState) {
    invalid('a result must offer at least one next action or declare an explicit rest state');
  }

  const resolvedChecklist = frozenChecklist(checklist, resolvedNext);

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
    preserved: resolvedPreserved,
    checklist: resolvedChecklist,
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

/** True when a result reports that it left everything as it was. The v1 question, still worth asking. */
export function preservedEverything(result) {
  return EFFECT_KEYS.every((key) => result.effects[key] === false);
}

/**
 * The gate counts, derived once. `[UXH:AC-002]`
 *
 * A refusal card says "2 of 5 gates unmet" and the status bar says "gates 3/5". Those are the same
 * fact rendered twice, and two surfaces that each count for themselves will eventually disagree —
 * usually on the day the definition of "unknown" changes for one of them. Exported so both call it.
 */
export function checklistSummary(result) {
  const rows = result.checklist ?? [];
  const met = rows.filter((row) => row.state === 'met').length;
  const unmet = rows.filter((row) => row.state === 'unmet').length;
  const unknown = rows.filter((row) => row.state === 'unknown').length;
  return Object.freeze({ total: rows.length, met, unmet, unknown, outstanding: unmet + unknown });
}

/** The single filled button, or null when the producer offered no leading action `[UXH:REQ-064]`. */
export function primaryAction(result) {
  return (result.next ?? []).find((action) => action.emphasis === 'primary') ?? null;
}
