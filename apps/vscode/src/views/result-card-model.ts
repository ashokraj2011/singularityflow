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
  readonly detail: string | null;
  readonly command: string | null;
};

export type ResultCardView = {
  readonly tone: 'refusal' | 'clarification' | 'ceremony' | 'read';
  readonly headline: string;
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

export function buildResultCard(result: any): ResultCardView {
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

  return Object.freeze({
    tone,
    headline: headlineOf(result, gates),
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
