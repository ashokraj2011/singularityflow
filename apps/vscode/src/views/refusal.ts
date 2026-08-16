/**
 * Turning a CLI failure into a card. `[UXH:CON-007]` `[UXH:REQ-062]` `[DHR:REQ-061]`
 *
 * The extension runs the CLI as a subprocess, so a refusal arrives as an exit code and some stderr.
 * Every call site did the same thing with it — `showErrorMessage(error.message)` — which is the dead
 * end the shell exists to remove: a red toast, no reason a reader can act on, no statement about
 * what survived, and nothing to do next but dismiss it.
 *
 * Three tiers, and which one applies is *reported*, never guessed at silently:
 *
 *   1. **`sflow-result` v2** — the gateway contract. Rendered whole.
 *   2. **`command-result` v1** — what most CLI refusals already carry on stderr when `--json` was
 *      passed. Adapted here. It has `effects`, so its preservation statement is *derived* from a
 *      declared record rather than written next to a throw.
 *   3. **Prose only** — a plain error. Rendered as a card so the reader still gets a headline and a
 *      way out, and **with no preservation claim at all**.
 *
 * That last point is the one worth being stubborn about. It is tempting to have tier 3 say "your
 * work is untouched", because it almost always is and it is the sentence a refused reader most wants
 * to read. But nothing in a bare error message says so, and a reassurance the product cannot back is
 * exactly what `[DHR:CON-060]` forbids — the one time it is wrong is the time it matters. Tier 3
 * says what it knows and stops.
 */
import { buildResultCard, type ResultCardView } from './result-card-model.ts';
import { message } from './result-messages.ts';

/** Where a card's facts came from, so the panel can say so rather than implying full fidelity. */
export type RefusalFidelity = 'sflow-result-v2' | 'command-result-v1' | 'message-only';

export type Refusal = { readonly view: ResultCardView; readonly fidelity: RefusalFidelity };

/**
 * Find a JSON document in captured stderr.
 *
 * The CLI prints a structured result *and* human lines, in either order depending on the failure, so
 * this scans for a balanced object rather than assuming the stream is JSON. Anything unparseable is
 * not an error here — it means tier 3, which is a supported outcome and not a degraded one.
 */
function structuredResult(stderr: string): any | null {
  const start = stderr.indexOf('{');
  if (start < 0) return null;
  for (let end = stderr.lastIndexOf('}'); end > start; end = stderr.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(stderr.slice(start, end + 1));
      if (parsed?.resultType === 'sflow-result' || parsed?.resultType === 'command-result') return parsed;
    } catch { /* keep shrinking: a later brace may close a smaller, valid document */ }
  }
  return null;
}

/**
 * The four v1 effect keys, and what a reader is told when each is false.
 *
 * v1 has no `preserved[]` — the field regressed out of v2 and has now been restored there — so a v1
 * result's preservation statement is *computed* from its effects record. That is strictly better
 * than prose next to a throw and strictly worse than a producer saying what it meant, which is why
 * the fidelity is reported alongside.
 */
const V1_PRESERVATION: Readonly<Record<string, string>> = Object.freeze({
  stateChanged: 'work.nothing-was-carried-out',
  filesChanged: 'work.nothing-was-carried-out',
  publicationCreated: 'work.nothing-was-carried-out',
  externalSystemsChanged: 'work.nothing-was-carried-out'
});

/**
 * Adapt a v1 `command-result` into the v2 shape the card renders.
 *
 * Field by field rather than by spreading, so a v1 producer that grows a field does not silently
 * start rendering it, and so every gap between the two contracts is visible in this one function
 * instead of being discovered by a missing element on a screen.
 */
function fromCommandResultV1(result: any): any {
  const effects = {
    contextChanged: false,
    stateChanged: Boolean(result.effects?.stateChanged),
    filesChanged: Boolean(result.effects?.filesChanged),
    gitRefsChanged: false,
    publicationCreated: Boolean(result.effects?.publicationCreated),
    externalSystemsChanged: Boolean(result.effects?.externalSystemsChanged)
  };
  const untouched = Object.keys(V1_PRESERVATION).every((key) => !result.effects?.[key]);

  return {
    schemaVersion: 2,
    resultType: 'sflow-result',
    kind: result.outcome?.status === 'refused' ? 'refusal' : 'read',
    operation: result.operation ?? { id: 'unknown', classification: 'read' },
    subject: result.subject ? { ...result.subject, revision: {} } : null,
    outcome: result.outcome,
    effects,
    why: result.why ?? [],
    warnings: [],
    // Derived from the declared record, and only when the record actually says nothing changed.
    preserved: untouched
      ? [{ code: 'work.nothing-was-carried-out', source: 'evidence', scope: 'all', reference: null, slots: {} }]
      : [],
    checklist: [],
    next: (result.next ?? []).map((entry: any, index: number) => ({
      handle: entry.handle ?? entry.command ?? `v1:${index}`,
      id: entry.id ?? `v1:${index}`,
      label: entry.label ?? entry.command ?? 'Continue',
      rank: entry.rank ?? index,
      kind: 'read',
      reasonCode: entry.reasonCode ?? 'work.legal-now',
      confirmation: 'none',
      interaction: 'navigation',
      /** v1 has no emphasis. Leading with the first action is the producer's own ordering. */
      emphasis: index === 0 ? 'primary' : 'secondary',
      executable: false,
      slots: entry.slots ?? {},
      fallback: entry.command ? { label: entry.label ?? entry.command, command: entry.command } : null
    })),
    restState: result.restState ?? null,
    data: result.data ?? {}
  };
}

/**
 * A card for an error that carried no structure at all.
 *
 * Built by hand rather than through `sflowResult`, because the contract would rightly refuse this:
 * it has no catalogued reason code and no preservation statement. Constructing the *view* directly
 * is the honest way to render an unstructured failure without pretending it is a governed result —
 * and `fidelity` tells the panel to say so.
 */
function fromMessage(text: string, details: Record<string, string>, headline?: string): ResultCardView {
  return Object.freeze({
    tone: 'refusal' as const,
    headline: headline ?? message('gateway.refused').label,
    why: [{ label: text.trim() || 'The command did not complete.' }],
    warnings: [],
    checklist: [],
    gates: null,
    /**
     * Empty, deliberately. See the module note: a reassurance nothing can back is the one that
     * matters on the day it is wrong.
     */
    preserved: [],
    actions: [],
    // An unstructured failure knows nothing about phases, and claims nothing.
    rail: [],
    /**
     * Not a home, so there is nothing to have last checked.
     *
     * Null rather than a "could not compare" delta: this card is not about the home at all, and a
     * briefing block on a failed command would be answering a question the reader did not ask.
     */
    since: null,
    rest: 'blocked',
    details: Object.freeze(details)
  });
}

/**
 * Build the card for whatever came back from the CLI.
 *
 * `headline` is what the *caller* was trying to do — "Could not switch workspace". It is used only
 * for a tier-3 card, and deliberately not allowed to override tiers 1 and 2: when the result names
 * its own outcome from the catalog, that name is the accurate one, and a caller's summary of its
 * own intent would replace a fact with a paraphrase.
 */
export function refusalFor(error: unknown, { headline }: { headline?: string } = {}): Refusal {
  const stderr = String((error as { stderr?: string })?.stderr ?? '');
  const text = String((error as { message?: string })?.message ?? error ?? '');
  const exitCode = (error as { exitCode?: number | null })?.exitCode ?? null;

  const structured = structuredResult(stderr);
  if (structured?.resultType === 'sflow-result') {
    return { view: buildResultCard(structured), fidelity: 'sflow-result-v2' };
  }
  if (structured?.resultType === 'command-result') {
    return { view: buildResultCard(fromCommandResultV1(structured)), fidelity: 'command-result-v1' };
  }
  return {
    view: fromMessage(text, {
      exitCode: exitCode === null ? 'none' : String(exitCode),
      source: 'command output'
    }, headline),
    fidelity: 'message-only'
  };
}

/**
 * What the panel adds under a card whose facts are incomplete.
 *
 * Not a warning icon and not an apology — a statement of what this build could and could not read.
 * A reader who can see that a refusal carried no structured result knows why it is thinner than the
 * last one, instead of concluding the product is inconsistent.
 */
export function fidelityNote(fidelity: RefusalFidelity): string | null {
  if (fidelity === 'sflow-result-v2') return null;
  if (fidelity === 'command-result-v1') {
    return 'This command reports the older result contract, so there is no gate checklist. '
      + 'What it says about preserved work is derived from its declared effects.';
  }
  return 'This command did not report a structured result, so there is no statement here about '
    + 'what was preserved. Check the command output before assuming anything changed.';
}
