/**
 * Every code a gateway result may carry, enumerated. `[UXH:REQ-061]` `[INT:IFC-021]`
 *
 * The contract already refuses handler-authored prose, on the grounds that prose cannot be
 * translated, filtered, counted or matched. That argument only holds if the codes it accepts
 * instead are themselves a closed set — an open string field rejects `"Not ready to submit"` and
 * accepts `"not.ready.to.submit"`, which is the same sentence wearing a hat.
 *
 * `RESOLUTION_REASONS` has been enumerated since the resolver was written and is the model here.
 * The rest of the gateway grew its codes as string literals at the point of use, and nothing could
 * answer "what can a result say?" — which a translator, a message catalog and an operator dashboard
 * all need to ask before they can be built at all.
 *
 * ## Adding a code
 *
 * Add it here, in its family, with the others. That is the whole ceremony, and it is deliberately
 * small enough not to be worth routing around.
 *
 * ## Codes composed at runtime
 *
 * Three sites build a code from data — a lifecycle blocker name, a readiness gate, a handle error.
 * Those are closed sets today and none of them is closed *here*, so each site resolves through
 * {@link catalogued} and lands on its family's `unrecognised` code when the data outruns this file.
 * The alternative — rejecting at construction — turns a new lifecycle blocker into a crash in a
 * read path, and a read path that crashes because the world gained a state is worse than one that
 * says so plainly. The completeness of these families is asserted by test instead, where the cost
 * of being wrong is a red build rather than a broken sidebar.
 */
import { SingularityFlowError } from '../util.mjs';

/** Resolution: words to an operation, and every way that ends. `[INT:REQ-032]` */
export const RESOLUTION_CODES = Object.freeze([
  'resolution.selection-handle.invalid',
  'resolution.subject.unknown-kind',
  'resolution.goal.unknown',
  'resolution.no-match',
  'resolution.not-legal-now',
  'resolution.arguments.invalid',
  'resolution.arguments.missing',
  'resolution.denied-by-policy',
  'resolution.goal-alone-cannot-write',
  'resolution.ambiguous',
  'resolution.matched.selection-handle',
  'resolution.matched.phrase',
  'resolution.matched.conversation',
  'resolution.matched.goal',
  'resolution.nothing-was-carried-out'
]);

/**
 * The kernel's own vocabulary, including one code per handle failure.
 *
 * The handle codes are spelled out rather than derived from `handles.mjs` at import time. Deriving
 * them would make this file agree with that one by construction and stop it being a list anybody
 * can read — and the reason a translator needs this file is precisely that it is a list.
 */
export const KERNEL_CODES = Object.freeze([
  'gateway.planner-unavailable',
  'gateway.denied-by-policy',
  'gateway.not-a-read',
  'gateway.read-only',
  'gateway.not-implemented',
  'gateway.legal-now',
  'gateway.nothing-was-carried-out',
  'gateway.handle-unknown',
  'gateway.handle-kind-mismatch',
  'gateway.handle-kind-invalid',
  'gateway.handle-tampered',
  'gateway.handle-expired',
  'gateway.handle-consumed',
  'gateway.handle-drifted',
  'gateway.handle-binding-invalid',
  'gateway.handle-invalid',
  /** A handle failed for a reason this build has no name for. See the module note. */
  'gateway.handle-unrecognised'
]);

/** The home planner: what leads, why it leads, and when nothing does. */
export const HOME_CODES = Object.freeze([
  'home.active-work-leads',
  'home.briefing-unavailable',
  'home.default-order',
  'home.no-workspace-selected',
  'home.select-a-workspace-first',
  'home.continue-active-work',
  'home.local-work-unreconciled',
  /**
   * The lifecycle states the home can be in, named. `[UXH:REQ-051]` `[DHR:REQ-070]`
   *
   * `recovery-required` is the one that mattered most to add: the group had existed since the work
   * records were written and the home never mentioned it, so §8's highest-priority rule was the one
   * rule with no implementation.
   */
  'home.recovery-required',
  'home.needs-your-decision',
  'home.nothing-waiting',
  'home.work-summary',
  'home.stable-choice'
]);

/** The canonical developer recommendation and its honest empty-state alternatives. */
export const DEVELOPER_CODES = Object.freeze([
  'developer.recommended-next',
  'developer.start-with-intake',
  'developer.no-current-work'
]);

/**
 * Work: where a record came from, what is true of it, and what it is blocked by.
 *
 * `work.blocked.*` mirrors `blockersOf()` in `work-records.mjs`. The test holds them level.
 */
export const WORK_CODES = Object.freeze([
  'work.from-governed-records',
  'work.reconstructed-from-records',
  'work.local-changes-present',
  'work.single-repository-scope',
  'work.not-in-this-repository',
  'work.nothing-was-carried-out',
  'work.legal-now',
  'work.no-legal-action',
  'work.check-readiness',
  'work.resume-phase',
  /**
   * Why a work item is in the group it is in — `item.because`, from `work-records.mjs`.
   *
   * These reach the reader through `data`, not through `why[]`, and are catalogued anyway. A code
   * a surface renders is a code a surface must be able to translate, and the field it arrived in
   * does not change that; leaving them out would have made `data` the place a second, unenumerable
   * vocabulary grew, which is the thing the contract's prose ban is guarding against.
   */
  'work.all-phases-complete',
  'work.no-current-phase',
  'work.final-phase-approved',
  'work.in-progress',
  'work.blocked.publication-pending',
  'work.blocked.approvals-outstanding',
  'work.blocked.required-artifact-missing',
  'work.blocked.unrecognised'
]);

/**
 * Readiness: one code per gate, plus the four this planner cannot evaluate.
 *
 * Both halves are catalogued deliberately. An `unknown` row is a statement the reader is entitled
 * to read in their own language just as much as an `unmet` one, and leaving the unevaluated gates
 * uncatalogued would have made them the only rows a surface could not translate — which is a
 * quiet incentive to stop rendering them.
 */
/**
 * The return briefing `[DHR:REQ-040]`–`[DHR:REQ-046]`.
 *
 * `current-state` and `since-you-were-here` are two codes rather than one with a slot, because
 * `[DHR:REQ-024]` makes them different claims: the second asserts a delta, and a reader given a
 * delta assumes anything absent from it did not change.
 */
export const RETURN_CODES = Object.freeze([
  'return.current-state',
  'return.since-you-were-here',
  'return.reconciled',
  'return.no-open-interval',
  'return.planned',
  'return.unplanned',
  'return.protected',
  'return.unrecognised-verdict',
  'return.clean-worktree',
  'return.local-changes-unread',
  'return.reconciliation-unavailable',
  'return.acknowledgement-boundary-unavailable',
  'return.reconcile-before-submitting',
  'return.nothing-was-carried-out'
]);

export const READINESS_CODES = Object.freeze([
  'readiness.no-blockers-found',
  'readiness.blocked',
  'readiness.partial-inputs',
  'readiness.publication-pending',
  'readiness.approvals-outstanding',
  'readiness.required-artifact-missing',
  'readiness.tests',
  'readiness.stale-approvals',
  'readiness.clarifications',
  'readiness.unclaimed-changes',
  'readiness.unrecognised-gate',
  'readiness.resume-publication',
  'readiness.awaiting-a-human-decision',
  'readiness.produce-the-artifact',
  'readiness.no-known-step'
]);

/** Workspaces, impact, documentation and the two that name a decision waiting on a person. */
export const SURFACE_CODES = Object.freeze([
  'workspace.from-registry',
  'workspace.evidence-gap',
  'workspace.selectable',
  'impact.from-changed-paths',
  'impact.evidence-gap',
  'impact.tests-by-path-convention',
  'impact.work-in-the-same-area',
  'explain.cited',
  'explain.ambiguous',
  'explain.no-match',
  'explain.unstamped-docs',
  'approval.open-the-packet',
  'approval.waiting',
  'approval.you-submitted-it',
  'approval.awaiting-a-reviewer',
  'approval.you-are-authorized',
  'approval.requires-an-authorized-reviewer',
  'recovery.resume-publication',
  'publication.pending'
]);

/** Every code, in one frozen set, which is the thing a surface actually needs. */
export const REASON_CODES = Object.freeze([
  ...RESOLUTION_CODES, ...KERNEL_CODES, ...HOME_CODES, ...DEVELOPER_CODES,
  ...WORK_CODES, ...READINESS_CODES, ...RETURN_CODES, ...SURFACE_CODES
]);

/**
 * The codes no source sweep will find, and where each one is assembled.
 *
 * A grep for `'gateway.handle-expired'` returns nothing: the kernel builds it from an error code,
 * and readiness and work-continue build theirs from a gate or blocker name. Declaring them here is
 * what lets the completeness test hold the catalog to "every entry is reachable" without either
 * inferring reachability through string concatenation — a guess — or dropping the check, which is
 * how a catalog fills with entries no surface will ever render and a translator cannot tell apart
 * from the live ones.
 */
/**
 * The codes that mean "a handle did not hold", as a set rather than a prefix.
 *
 * Callers ask this instead of testing `code.startsWith('gateway.handle-')`. Two reasons, and the
 * second is the one that matters: a prefix test silently starts matching any future code that
 * happens to share the stem, and it makes "which failures are handle failures?" a fact about string
 * shape rather than a fact the catalog states.
 */
export const HANDLE_FAILURE_CODES = Object.freeze(
  KERNEL_CODES.filter((code) => code.startsWith('gateway.handle-'))
);

export const COMPOSED_CODES = Object.freeze({
  'src/gateway/kernel.mjs handleCode()': HANDLE_FAILURE_CODES,
  'src/gateway/planners/work-continue.mjs': WORK_CODES.filter((code) => code.startsWith('work.blocked.')),
  'src/gateway/planners/work-return.mjs verdictCode()':
    RETURN_CODES.filter((code) => ['return.planned', 'return.unplanned', 'return.protected'].includes(code)),
  'src/gateway/planners/work-readiness.mjs gateCode()':
    READINESS_CODES.filter((code) => !code.startsWith('readiness.no-')
      && !['readiness.blocked', 'readiness.partial-inputs', 'readiness.resume-publication',
        'readiness.awaiting-a-human-decision', 'readiness.produce-the-artifact'].includes(code))
});

/**
 * The codes that may appear in `warnings[]`, enumerated. `[UXH:REQ-061]` `[INT:CON-010]`
 *
 * `why[]` and `warnings[]` are two of the four channels a result keeps apart, and until now they
 * drew from one flat list of 106 codes with nothing distinguishing them. Two consequences, and the
 * second is the one that matters:
 *
 *   - Nothing could answer "what warnings does this product emit?". `RESOLUTION_REASONS` is the
 *     model here: a named subset is what lets a translator, a test or a support engineer enumerate
 *     a channel rather than grep for it.
 *   - Nothing stopped a producer putting a reason in the warning channel or a warning in the reason
 *     channel. `[UXH:REQ-061]` forbids merging the channels, and a rule with no check is a
 *     convention — this is the same class as `preserved[]` claiming a scope whose effect is true,
 *     which *is* rejected at construction.
 *
 * Every entry is also in `REASON_CODES`, asserted below: one vocabulary with a subset view, never a
 * second vocabulary. What makes a code belong here is that it reports something the operation could
 * not establish — all four carry `source: 'unavailable'` — which is the same not-checked distinction
 * the checklist draws between `unmet` and `unknown`, at the level of the whole result.
 */
export const WARNING_CODES = Object.freeze([
  /** The My Flow briefing is cross-workspace; a planner that read one repository says so. */
  'home.briefing-unavailable',
  /** `git status` could not be read, so "no local changes" would be a guess rather than a finding. */
  'return.local-changes-unread',
  /** No reconciliation record exists for this interval, so the comparison was not made. */
  'return.reconciliation-unavailable',
  /** An acknowledgement exists, but this report was not computed from its snapshot. */
  'return.acknowledgement-boundary-unavailable',
  /** The work list covers one repository; anything in a sibling is absent rather than empty. */
  'work.single-repository-scope',
  /** A readiness answer computed from some of its inputs, and it says which were missing. */
  'readiness.partial-inputs',
  /** Impact was assessed without a piece of evidence it would ordinarily use. */
  'impact.evidence-gap',
  /** Tests were located by path convention rather than by a declared mapping. */
  'impact.tests-by-path-convention',
  /** The documentation this explanation drew on carries no release stamp. */
  'explain.unstamped-docs',
  /** A workspace field the registry does not carry, named per field rather than as one blur. */
  'workspace.evidence-gap',
  /**
   * Uncommitted work exists in the tree this answer was computed against.
   *
   * A disclosure rather than a problem: the reader's local changes are real and the result is still
   * correct, but anything derived from the committed tree does not account for them.
   */
  'work.local-changes-present'
]);

const CODES = new Set(REASON_CODES);

const WARNINGS = new Set(WARNING_CODES);

const uncatalogued = WARNING_CODES.filter((code) => !CODES.has(code));
if (uncatalogued.length) {
  throw new SingularityFlowError(`Warning codes missing from the reason catalog: ${uncatalogued.join(', ')}.`,
    { code: 'WARNING_CATALOG_ORPHAN', details: { uncatalogued } });
}

/** Whether a code is one this product may say in the warning channel. */
export function isWarningCode(code) {
  return WARNINGS.has(code);
}

/** Duplicates across families would make the catalog ambiguous about which family owns a code. */
const duplicates = REASON_CODES.filter((code, index) => REASON_CODES.indexOf(code) !== index);
if (duplicates.length) {
  throw new SingularityFlowError(`The reason catalog repeats ${[...new Set(duplicates)].join(', ')}.`,
    { code: 'REASON_CATALOG_DUPLICATE', details: { duplicates } });
}

export function isCatalogued(code) {
  return CODES.has(code);
}

/**
 * Resolve a code built from runtime data, falling back rather than throwing.
 *
 * Used at the three composing sites. The fallback is a real catalogued code and the composed value
 * survives in the caller's slots, so a surface renders "a blocker this build has no name for:
 * <name>" — which is both honest and translatable, where the raw composed string was neither.
 */
export function catalogued(code, fallback) {
  if (CODES.has(code)) return code;
  if (!CODES.has(fallback)) {
    throw new SingularityFlowError(`'${fallback}' is not a catalogued fallback code.`,
      { code: 'REASON_CATALOG_UNKNOWN_FALLBACK', details: { fallback } });
  }
  return fallback;
}
