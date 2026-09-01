/**
 * An `sflow-result` envelope, turned into something a card can render. `[UXH:REQ-060]`–`[UXH:REQ-065]`
 *
 * Pure, and separated from the HTML for the reason every `*-model` / `*-page` pair in this codebase
 * is: the interesting decisions are here, where a test can make them without a webview, and the
 * page below is left with nothing to decide.
 *
 * The shape this produces is deliberately the same for a refusal, a read and a clarification. A
 * refusal is not a special case with its own template — it is a result whose checklist has unmet
 * rows and whose preservation statement matters more. Giving it a separate renderer is how a
 * codebase ends up with a red error box that shares no code, and no behaviour, with the thing it is
 * supposed to be a variant of.
 */
import { message, type Message, type Slots } from './result-messages.ts';
import { homeDelta, type HomeAcknowledgement, type HomeDelta } from './home-acknowledgement.ts';
import { buildAutoCards, type AutoCardView } from './auto-cards-model.ts';

/** One gate, as the reader meets it. `[UXH:REQ-062]` */
export type ChecklistRow = {
  readonly id: string;
  readonly state: 'met' | 'unmet' | 'unknown';
  readonly label: string;
  readonly detail: string | null;
  /** `statusSuccess` | `statusBlocked` | `statusIdle` — three states, never two. */
  readonly icon: 'statusSuccess' | 'statusBlocked' | 'statusIdle';
  readonly evidence: string | null;
  readonly action: CardAction | null;
};

export type CardAction = {
  readonly id: string;
  /**
   * The opaque handle, kept in the model and never in the markup.
   *
   * The extension host needs it to dispatch through the executor; the webview must never see it.
   * That split is the whole reason the model and the page are separate modules — this field exists
   * on one side of a boundary the other side cannot reach, and a test asserts the markup is clean.
   */
  readonly handle: string;
  readonly label: string;
  readonly emphasis: 'primary' | 'secondary' | 'link';
  readonly interaction: string;
  /**
   * Whether this handle is read now or selected and re-resolved. `[UXH:REQ-031]`
   *
   * It changes nothing on screen, which is why it was left out — and why the host then had to
   * invent a value, choosing `executable: false` for every action. That is right for a
   * disambiguation choice and wrong for a read handle, so pressing the single primary on a
   * "Ready to go" card resolved a read handle as a selection and came back "that choice is no
   * longer current" — a stale-handle refusal with nothing stale about it, blaming the world for
   * the host's guess.
   *
   * Carried through the model because the model is what the host dispatches from. A field that
   * only the dispatcher reads still belongs to the contract between them.
   */
  readonly executable: boolean;
  readonly detail: string | null;
  readonly command: string | null;
};

export type HomeAttentionView = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly workId: string | null;
  readonly phase: string | null;
  readonly reasonCode: string;
  readonly detail: string | null;
  readonly action: CardAction | null;
};

export type HomeProjectionView = {
  readonly asOf: string;
  readonly projectionRevision: string;
  readonly actor: { readonly display: string | null };
  readonly context: {
    readonly workspaceLabel: string | null; readonly repositoryId: string | null;
    readonly branch: string | null; readonly head: string | null;
  };
  readonly lens: string;
  readonly needsUser: readonly HomeAttentionView[];
  readonly activeWork: {
    readonly id: string; readonly title: string | null; readonly phase: string | null;
    readonly status: string | null; readonly repositoryId: string | null; readonly branch: string | null;
  } | null;
  readonly now: CardAction | null;
  readonly promptActions: readonly CardAction[];
  readonly today: any | null;
  readonly yesterday: any | null;
  readonly worthChecking: readonly HomeAttentionView[];
  readonly recent: readonly any[];
  readonly health: { readonly status: string; readonly journal: string; readonly warnings: readonly string[] };
};

export type ResultCardView = {
  readonly tone: 'refusal' | 'clarification' | 'ceremony' | 'read';
  readonly headline: string;
  /** Presentation-only name from the local Git identity; never an authority or binding input. */
  readonly replyName: string | null;
  readonly why: readonly Message[];
  readonly warnings: readonly Message[];
  readonly checklist: readonly ChecklistRow[];
  readonly gates: {
    readonly total: number; readonly met: number;
    /** Evaluated and failed. Never merged with the ones nobody looked at. */
    readonly unmet: number;
    /** `unmet` plus `unknown` — everything standing between the reader and submitting. */
    readonly outstanding: number;
  } | null;
  readonly preserved: readonly Message[];
  readonly actions: readonly CardAction[];
  /**
   * The phase rail, when the result is about work that has one. `[UXH:REQ-050]`
   *
   * Read from `data.rail` rather than derived: only the record layer has the pinned definition, and
   * a renderer handed a current phase would have to guess the sequence — wrong for any repository
   * that configured its own.
   */
  readonly rail: readonly { readonly id: string; readonly label: string; readonly state: 'done' | 'current' | 'pending' }[];
  /** Deterministic replay of the latest durable submission packet; never a second evidence store. */
  readonly receipt: {
    readonly workId: string; readonly phase: string; readonly generation: number;
    readonly changes: string; readonly checks: string; readonly approvals: string;
    readonly publication: string; readonly sha256: string;
  } | null;
  /** Redacted unresolved-fault summaries. Evidence paths and raw payloads never enter the webview. */
  readonly faults: readonly {
    readonly faultId: string; readonly severity: string; readonly type: string;
    readonly summary: string; readonly disposition: string; readonly repairId: string | null;
  }[];
  /** AUT v2 projections from the read-only gateway; commands route back through CLI/kernel. */
  readonly auto: readonly AutoCardView[];
  /** Change Flight Plan projection; source bodies and unrestricted host paths never enter it. */
  readonly flightPlan: {
    readonly planId: string; readonly status: string; readonly intent: string;
    readonly baseline: string; readonly recommendedStart: string;
    readonly counts: { readonly proven: number; readonly inferred: number; readonly unknown: number };
    readonly findings: readonly {
      readonly id: string; readonly classification: string; readonly kind: string;
      readonly subject: string; readonly relationship: string; readonly explanation: string;
    }[];
    readonly unknowns: readonly { readonly id: string; readonly subject: string; readonly explanation: string }[];
  } | null;
  /** Shared developer guidance, present only on the canonical recommendation result. */
  readonly guidance: {
    readonly context: { readonly workspace: string | null; readonly workId: string | null; readonly phase: string | null };
    readonly recommendation: {
      readonly command: string; readonly skill: string | null; readonly reason: string | null;
      readonly confirmationRequired: boolean; readonly effect: string;
    } | null;
    readonly preflight: readonly { readonly id: string; readonly state: string; readonly detail: string }[];
    readonly evidence: {
      readonly artifacts: { readonly recorded: number; readonly total: number };
      readonly checks: { readonly passed: number; readonly failed: number; readonly total: number };
      readonly approvals: { readonly approved: number; readonly total: number };
    } | null;
    readonly requiredInputs: readonly string[];
  } | null;
  /** Home-specific hierarchy, sourced only from the kernel-sealed HomeProjectionV2. */
  readonly home: HomeProjectionView | null;
  /**
   * The return briefing, on the card rather than on a home of its own. `[DHR:REQ-024]` `[UXH:REQ-020]`
   *
   * Null for every result that is not a home, and for a home the host did not offer an
   * acknowledgement store for. It is not part of the envelope and must not look like it is: the
   * delta is the *host's* memory of this reader compared against the kernel's answer, which is
   * exactly the kind of fact `data` is forbidden from carrying.
   */
  readonly since: HomeDelta | null;
  readonly rest: string | null;
  readonly details: Readonly<Record<string, string>>;
};

const ICONS = Object.freeze({ met: 'statusSuccess', unmet: 'statusBlocked', unknown: 'statusIdle' } as const);

/**
 * `unknown` is not a soft `unmet`.
 *
 * A gate nobody evaluated and a gate that failed look identical on a screen that only lists
 * problems, and the reader who acts on that screen is the one submitting against an untested
 * change. They get different icons, and the sentence for `unknown` says nothing was read.
 */
function row(entry: { id: string; code: string; state: 'met' | 'unmet' | 'unknown'; source: string; evidence: string | null; slots?: Slots; action: string | null },
  actions: readonly CardAction[]): ChecklistRow {
  const text = message(entry.code, entry.slots ?? {});
  return {
    id: entry.id,
    state: entry.state,
    label: text.label,
    detail: entry.state === 'unknown'
      ? 'Not evaluated — this answer does not cover it.'
      : text.detail ?? null,
    icon: ICONS[entry.state],
    evidence: entry.evidence,
    action: actions.find((candidate) => candidate.id === entry.action) ?? null
  };
}

function toneOf(result: { kind: string; outcome: { status: string } }): ResultCardView['tone'] {
  if (result.kind === 'refusal' || result.outcome.status === 'refused' || result.outcome.status === 'failed') return 'refusal';
  if (result.kind === 'ceremony') return 'ceremony';
  if (result.kind === 'clarification' || result.kind === 'candidates') return 'clarification';
  return 'read';
}

/**
 * The one line at the top.
 *
 * When there is a checklist, the count comes from it and from nowhere else — the card and the
 * status bar render the same number because they derive it the same way `[UXH:AC-002]`. Counting
 * `unmet` and `unknown` together as *outstanding* is the honest total: both are things standing
 * between the reader and submitting, and separating them in the headline would invite the reader to
 * treat "not evaluated" as "fine".
 */
function headlineOf(result: any, gates: ResultCardView['gates']): string {
  /**
   * `outcome.messageId`, not a string built from the operation and status.
   *
   * The envelope names its own narration ID precisely so a surface does not have to compose one,
   * and a composed key is a key nothing enumerates — the second unenumerable vocabulary, reinvented
   * in the renderer.
   */
  const named = message(result.outcome.messageId, result.outcome.slots ?? {}).label;
  if (!gates || gates.outstanding === 0) return named;
  /**
   * "Unmet" is only said about gates that were actually evaluated.
   *
   * Counting unknowns into an "unmet" total would undo the distinction the checklist is built to
   * preserve, in the one line most readers stop at. When some gates were never looked at the
   * headline says both numbers, because "5 of 7 unmet" and "1 unmet, 4 not evaluated" send a reader
   * to do completely different things.
   */
  const unknown = gates.outstanding - gates.unmet;
  if (!unknown) return `${named} — ${gates.unmet} of ${gates.total} gates unmet`;
  if (!gates.unmet) return `${named} — ${unknown} of ${gates.total} gates not evaluated`;
  return `${named} — ${gates.unmet} of ${gates.total} gates unmet, ${unknown} not evaluated`;
}

function actionOf(entry: any): CardAction {
  const text = message(entry.reasonCode, entry.slots ?? {});
  return {
    id: entry.id,
    handle: entry.handle,
    // The producer's label leads; the reason code explains underneath rather than replacing it.
    label: entry.label,
    emphasis: entry.emphasis,
    interaction: entry.interaction,
    // The envelope normalises this, so `!== false` matches `result.mjs` rather than re-deciding it.
    executable: entry.executable !== false,
    detail: text.label,
    /**
     * The terminal equivalent, shown for learning and reproducibility `[UXH:REQ-073]`.
     *
     * Display-only. Pressing the button still goes through the handle — a card that offered a
     * command as the way to act would be the second dispatch path this design exists to remove.
     */
    command: entry.fallback?.command ?? null
  };
}

/**
 * What a support engineer needs and a user must never be shown by accident. `[UXH:REQ-065]`
 *
 * Operation, status, revisions and effects — enough to find the moment in a log. Never a prompt,
 * never an environment value, never an absolute path: the envelope carries none of those, and the
 * card is built by naming fields rather than by spreading `data`, so a producer that starts putting
 * a path in `data` does not silently start rendering it here.
 */
function detailsOf(result: any): Record<string, string> {
  const changed = Object.entries(result.effects).filter(([, value]) => value).map(([key]) => key);
  return {
    operation: result.operation.id,
    classification: result.operation.classification,
    kind: result.kind,
    status: result.outcome.status,
    message: result.outcome.messageId,
    effects: changed.length ? changed.join(', ') : 'none',
    ...(result.subject ? { subject: `${result.subject.kind}:${result.subject.id}` } : {}),
    ...(result.subject?.revision?.sourceCommit ? { sourceCommit: result.subject.revision.sourceCommit } : {})
  };
}

/**
 * What the host knows that the envelope cannot. `[UXH:REQ-020]`
 *
 * `acknowledgement` is passed rather than read, because this module is pure and `globalState` is
 * not. `undefined` means the caller has no acknowledgement store — most call sites — and `null`
 * means it has one and the reader has never marked this home as checked. Collapsing them would put
 * a "Mark as checked" button on the refusal card, which stores nothing and acknowledges nothing.
 */
export type ResultCardOptions = { readonly acknowledgement?: HomeAcknowledgement | null };

export function buildResultCard(result: any, { acknowledgement }: ResultCardOptions = {}): ResultCardView {
  const tone = toneOf(result);
  const actions = (result.next ?? []).map(actionOf);
  const checklist = (result.checklist ?? []).map((entry: any) => row(entry, actions));
  const gates = checklist.length
    ? {
      total: checklist.length,
      met: checklist.filter((entry: ChecklistRow) => entry.state === 'met').length,
      unmet: checklist.filter((entry: ChecklistRow) => entry.state === 'unmet').length,
      outstanding: checklist.filter((entry: ChecklistRow) => entry.state !== 'met').length
    }
    : null;

  /**
   * A reason already shown as a gate row is not repeated above it.
   *
   * The readiness planner puts one `why[]` entry per blocker *and* one checklist row per gate, which
   * is correct in the envelope — a consumer with no checklist still needs the reasons. On a card
   * that renders both it reads as the same sentence twice, and the second copy makes the reader
   * look for a difference that is not there.
   */
  const shown = new Set(checklist.map((entry: ChecklistRow) => entry.id));
  const why = (result.why ?? [])
    .filter((entry: any) => !shown.has(entry.slots?.gate))
    .map((entry: any) => message(entry.code, entry.slots));
  const projection = result.data?.homeProjection?.resultType === 'my-work-home'
    && result.data.homeProjection.schemaVersion === 2 ? result.data.homeProjection : null;
  const projectedAction = (entry: any): CardAction | null => entry?.id
    ? actions.find((action: CardAction) => action.id === entry.id) ?? null : null;
  const projectedAttention = (entry: any): HomeAttentionView => Object.freeze({
    id: String(entry.id ?? ''), kind: String(entry.kind ?? 'attention'), title: String(entry.title ?? 'Needs attention'),
    workId: entry.workId ? String(entry.workId) : null, phase: entry.phase ? String(entry.phase) : null,
    reasonCode: String(entry.reasonCode ?? 'home.default-order'),
    detail: entry.detail ? String(entry.detail) : null, action: projectedAction(entry.action)
  });

  return Object.freeze({
    tone,
    headline: headlineOf(result, gates),
    replyName: ['home.overview', 'developer.next'].includes(result.operation?.id)
      && typeof result.data?.personalization?.replyName === 'string'
      ? result.data.personalization.replyName
      : null,
    why,
    warnings: (result.warnings ?? []).map((entry: any) => message(entry.code, entry.slots)),
    checklist,
    gates,
    /**
     * The sentence a refused reader is actually looking for `[DHR:REQ-061]` `[UXH:REQ-061]`.
     *
     * Kept as its own channel rather than folded into `why`. "Here is why you were stopped" and
     * "here is what is still intact" answer different questions, and a reader who is told only the
     * first goes and checks the second by hand.
     */
    preserved: (result.preserved ?? []).map((entry: any) => message(entry.code, entry.slots)),
    actions,
    /** Named, not spread: a producer that puts something else in `data` does not start rendering it. */
    rail: Array.isArray(result.data?.rail) ? result.data.rail : [],
    receipt: result.data?.latestReceipt?.kind === 'submission-evidence-receipt'
      ? Object.freeze({
        workId: String(result.data.latestReceipt.work?.id ?? ''),
        phase: String(result.data.latestReceipt.work?.phase ?? ''),
        generation: Number(result.data.latestReceipt.work?.generation ?? 0),
        changes: result.data.latestReceipt.changes?.status === 'exact'
          ? `${Number(result.data.latestReceipt.changes?.count ?? 0)} changed path(s)`
          : 'Changed paths unavailable',
        checks: `${Number(result.data.latestReceipt.checks?.passed ?? 0)} passed · ${Number(result.data.latestReceipt.checks?.failed ?? 0)} failed · ${Number(result.data.latestReceipt.checks?.unavailable ?? 0)} unavailable`,
        approvals: `${Number(result.data.latestReceipt.approvals?.current ?? 0)} of ${Number(result.data.latestReceipt.approvals?.required ?? 0)} required`,
        publication: String(result.data.latestReceipt.publication?.state ?? 'unavailable'),
        sha256: String(result.data.latestReceipt.receiptSha256 ?? '')
      }) : null,
    faults: Array.isArray(result.data?.faults) ? Object.freeze(result.data.faults.map((fault: any) => Object.freeze({
      faultId: String(fault.faultId ?? ''),
      severity: String(fault.severity ?? 'unknown'),
      type: String(fault.type ?? 'unknown'),
      summary: String(fault.summary ?? 'Recorded fault'),
      disposition: String(fault.disposition ?? 'recorded'),
      repairId: fault.repair?.repairId ? String(fault.repair.repairId) : null
    })).filter((fault: any) => fault.faultId)) : Object.freeze([]),
    auto: buildAutoCards(result.data?.auto),
    flightPlan: String(result.operation?.id ?? '').startsWith('impact.what-if') && result.data?.changeFlightPlan
      ? (() => {
        const plan = result.data.changeFlightPlan;
        const findings = [...(Array.isArray(plan.findings) ? plan.findings : [])];
        const unknowns = [...(Array.isArray(plan.unknowns) ? plan.unknowns : [])];
        const all = [...findings, ...unknowns];
        return Object.freeze({
          planId: String(plan.planId ?? ''), status: String(plan.status ?? 'preview'),
          intent: String(plan.intent?.text ?? ''), baseline: String(plan.baseline?.revision ?? ''),
          recommendedStart: String(plan.recommendedStart?.subject ?? ''),
          counts: Object.freeze({
            proven: all.filter((finding: any) => finding.classification === 'proven').length,
            inferred: all.filter((finding: any) => finding.classification === 'inferred').length,
            unknown: all.filter((finding: any) => finding.classification === 'unknown').length
          }),
          findings: Object.freeze(findings.slice(0, 40).map((finding: any) => Object.freeze({
            id: String(finding.findingId ?? ''), classification: String(finding.classification ?? 'unknown'),
            kind: String(finding.kind ?? 'finding'), subject: String(finding.subject ?? ''),
            relationship: String(finding.relationship ?? ''), explanation: String(finding.explanation ?? '')
          }))),
          unknowns: Object.freeze(unknowns.slice(0, 20).map((finding: any) => Object.freeze({
            id: String(finding.findingId ?? ''), subject: String(finding.subject ?? ''),
            explanation: String(finding.explanation ?? '')
          })))
        });
      })() : null,
    guidance: result.operation?.id === 'developer.next' && result.data?.guidance
      ? Object.freeze({
        context: Object.freeze({
          workspace: result.data?.workspace?.name ?? result.data?.workspace?.id ?? null,
          workId: result.data.guidance.workId ?? null,
          phase: result.data.guidance.currentPhase ?? null
        }),
        recommendation: result.data.guidance.recommendation ? Object.freeze({
          command: result.data.guidance.recommendation.command,
          skill: result.data.guidance.recommendation.skill ?? null,
          reason: result.data.guidance.recommendation.reason ?? null,
          confirmationRequired: result.data.guidance.recommendation.confirmation?.required === true,
          effect: result.data.guidance.recommendation.effect?.class ?? 'read'
        }) : null,
        preflight: Object.freeze([...(result.data.guidance.preflight ?? [])]),
        evidence: result.data.guidance.evidence ?? null,
        requiredInputs: Object.freeze([...(result.data.guidance.requiredInputs ?? [])])
      }) : null,
    home: projection ? Object.freeze({
      asOf: String(projection.asOf),
      projectionRevision: String(projection.subjectRevision),
      actor: Object.freeze({ display: projection.actor?.display ? String(projection.actor.display) : null }),
      context: Object.freeze({
        workspaceLabel: projection.context?.workspaceLabel ? String(projection.context.workspaceLabel) : null,
        repositoryId: projection.context?.repositoryId ? String(projection.context.repositoryId) : null,
        branch: projection.context?.branch ? String(projection.context.branch) : null,
        head: projection.context?.head ? String(projection.context.head) : null
      }),
      lens: String(projection.lens?.id ?? 'developer'),
      needsUser: Object.freeze((projection.needsUser ?? []).map(projectedAttention)),
      activeWork: projection.activeWork ? Object.freeze({
        id: String(projection.activeWork.id), title: projection.activeWork.title ? String(projection.activeWork.title) : null,
        phase: projection.activeWork.phase ? String(projection.activeWork.phase) : null,
        status: projection.activeWork.status ? String(projection.activeWork.status) : null,
        repositoryId: projection.activeWork.repositoryId ? String(projection.activeWork.repositoryId) : null,
        branch: projection.activeWork.branch ? String(projection.activeWork.branch) : null
      }) : null,
      now: projectedAction(projection.now),
      promptActions: Object.freeze((projection.prompt?.goals ?? []).map(projectedAction)
        .filter((action: CardAction | null): action is CardAction => action !== null)),
      today: projection.today ?? null,
      yesterday: projection.yesterday ?? null,
      worthChecking: Object.freeze((projection.worthChecking ?? []).map(projectedAttention)),
      recent: Object.freeze([...(projection.recent ?? [])]),
      health: Object.freeze({
        status: String(projection.health?.status ?? 'degraded'),
        journal: String(projection.health?.journal ?? 'unavailable'),
        warnings: Object.freeze([...(projection.health?.warnings ?? [])].map(String))
      })
    }) : null,
    /**
     * The delta belongs to `home.overview` and to nothing else.
     *
     * Gated on the operation rather than on "did the caller pass an acknowledgement", so a future
     * host that keeps one store for the whole shell cannot make a readiness card start claiming to
     * know what changed since the reader last looked at it.
     */
    since: acknowledgement !== undefined && ['home.overview', 'developer.next'].includes(result.operation?.id)
      ? homeDelta(result, acknowledgement)
      : null,
    rest: result.restState ?? null,
    details: Object.freeze(detailsOf(result))
  });
}

/**
 * The gate count, for a surface that renders no card. `[UXH:AC-002]`
 *
 * The status bar shows `gates 3/5` and the card shows "2 of 5 gates unmet". Same numbers, one
 * derivation — exported so the status bar calls this rather than counting for itself.
 */
export function gateSummary(result: any): ResultCardView['gates'] {
  return buildResultCard(result).gates;
}
