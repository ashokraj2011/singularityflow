/**
 * Turning a CLI failure into a card. `[UXH:CON-007]` `[UXH:REQ-062]` `[DHR:REQ-061]`
 *
 * The extension runs the CLI as a subprocess, so a refusal arrives as an exit code and some stderr.
 * Every call site did the same thing with it — `showErrorMessage(error.message)` — which is the dead
 * end the shell exists to remove: a red toast, no reason a reader can act on, no statement about
 * what survived, and nothing to do next but dismiss it.
 *
 * Four tiers, and which one applies is *reported*, never guessed at silently:
 *
 *   1. **`sflow-result` v2** — the gateway contract. Rendered whole.
 *   2. **`command-result` v1** — what most CLI refusals already carry on stderr when `--json` was
 *      passed. Adapted here. It has `effects`, so its preservation statement is *derived* from a
 *      declared record rather than written next to a throw.
 *   3. **`sflow-refusal-plan` v1** — a plain CLI error plus deterministic recovery actions. It
 *      deliberately has no effects record, so no preservation statement is inferred.
 *   4. **Prose only** — a plain error. Rendered as a card so the reader still gets a headline and a
 *      way out, and **with no preservation claim at all**.
 *
 * That last point is the one worth being stubborn about. It is tempting to have tier 4 say "your
 * work is untouched", because it almost always is and it is the sentence a refused reader most wants
 * to read. But nothing in a bare error message says so, and a reassurance the product cannot back is
 * exactly what `[DHR:CON-060]` forbids — the one time it is wrong is the time it matters. Tier 4
 * says what it knows and stops.
 */
import { buildResultCard, type CardAction, type ResultCardView } from './result-card-model.ts';
import { message } from './result-messages.ts';
import { commandGuidance } from '../copilot-command.ts';
import { terminalCommand } from '../cli/runner.ts';

/** Where a card's facts came from, so the panel can say so rather than implying full fidelity. */
export type RefusalFidelity = 'sflow-result-v2' | 'command-result-v1' | 'refusal-plan-v1' | 'message-only';

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
      if (['sflow-result', 'command-result', 'sflow-refusal-plan'].includes(parsed?.resultType)) return parsed;
    } catch { /* keep shrinking: a later brace may close a smaller, valid document */ }
  }
  return null;
}

type ReviewableRecovery = {
  readonly id?: string;
  readonly label?: string;
  readonly command?: string;
  readonly executable?: 'singularity-flow' | 'sflow';
  readonly argv?: readonly string[];
  readonly skill?: string;
  readonly copilotCommand?: string;
};

/**
 * Convert only closed-crosswalk CLI guidance into reviewable, never-executed card actions.
 *
 * A diagnostic copied out of a repository-bound refusal must keep that repository boundary. The
 * public command remains the registered SFlow argv, while the shell form changes directory using
 * the same cross-platform quoting helper as timeout recovery. Without this, a command copied from
 * a World Model failure can run from HOME and active-workspace routing may diagnose a completely
 * different repository.
 */
function reviewableActions(planned: readonly ReviewableRecovery[],
  repositoryRoot: string | null = null): readonly CardAction[] {
  return Object.freeze(planned.slice(0, 3).flatMap((entry, index) => {
    const guidance = commandGuidance(entry);
    if (!guidance) return [];
    const command = repositoryRoot
      ? terminalCommand(repositoryRoot, guidance.argv)
      : guidance.command;
    return [{
      id: String(entry?.id ?? `recovery:${index}`),
      handle: String(entry?.id ?? `recovery:${index}`),
      label: String(entry?.label ?? 'Review recovery action'),
      emphasis: index === 0 ? 'primary' as const : 'secondary' as const,
      interaction: 'navigation',
      executable: false,
      detail: repositoryRoot
        ? `Prepared for review in the exact repository ${repositoryRoot}. Opening it never runs the command.`
        : 'Prepared for review. Opening it never runs the command.',
      command,
      skill: guidance.skill,
      copilotCommand: guidance.copilotCommand,
      copyable: guidance.copyable
    }];
  }));
}

/** Adapt bounded process-boundary guidance without claiming any effects or preservation. */
function fromRefusalPlan(result: any, displayMessage: string,
  repositoryRoot: string | null = null): ResultCardView {
  const planned = Array.isArray(result.remediationPlan?.steps)
    ? result.remediationPlan.steps
    : [];
  const actions = reviewableActions(planned, repositoryRoot);
  const code = String(result.error?.code ?? result.remediationPlan?.code ?? 'SINGULARITY_FLOW_ERROR');
  return Object.freeze({
    tone: 'refusal' as const,
    headline: 'This command is blocked — here is a safe path forward',
    replyName: null,
    // The runner already redacts and bounds this text. Do not re-read the raw JSON message here.
    why: [{ label: displayMessage.split('\nNext:')[0]?.trim() || 'The command did not complete.' }],
    warnings: [],
    checklist: [],
    gates: null,
    preserved: [],
    actions,
    rail: [],
    receipt: null,
    faults: [],
    auto: [],
    flightPlan: null,
    guidance: null,
    home: null,
    since: null,
    rest: actions.length ? null : 'blocked',
    details: Object.freeze({
      code,
      source: 'deterministic recovery planner',
      retry: String(result.remediationPlan?.retry?.label ?? 'Retry after resolving the blocking condition.')
    })
  });
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
    next: (result.next ?? []).map((entry: any, index: number) => {
      const guidance = commandGuidance(entry);
      return {
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
        fallback: guidance ? {
          label: entry.label ?? guidance.command,
          command: guidance.command,
          skill: guidance.skill,
          copilotCommand: guidance.copilotCommand
        } : null
      };
    }),
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
function fromMessage(text: string, details: Record<string, string>, headline?: string,
  actions: readonly CardAction[] = []): ResultCardView {
  return Object.freeze({
    tone: 'refusal' as const,
    headline: headline ?? message('gateway.refused').label,
    replyName: null,
    why: [{ label: text.trim() || 'The command did not complete.' }],
    warnings: [],
    checklist: [],
    gates: null,
    /**
     * Empty, deliberately. See the module note: a reassurance nothing can back is the one that
     * matters on the day it is wrong.
     */
    preserved: [],
    actions,
    // An unstructured failure knows nothing about phases, and claims nothing.
    rail: [],
    receipt: null,
    faults: [],
    auto: [],
    flightPlan: null,
    guidance: null,
    home: null,
    /**
     * Not a home, so there is nothing to have last checked.
     *
     * Null rather than a "could not compare" delta: this card is not about the home at all, and a
     * briefing block on a failed command would be answering a question the reader did not ask.
     */
    since: null,
    rest: actions.length ? null : 'blocked',
    details: Object.freeze(details)
  });
}

/**
 * A native error can retain a stable code even when the subprocess did not emit a result envelope.
 * Do not turn that into invented effects or an automatic retry. Offer only bounded, read-only
 * diagnostics whose shell/Copilot pairing is already registered by `commandGuidance`.
 */
function messageOnlyRecovery(error: unknown, text: string,
  repositoryRoot: string | null = null): readonly CardAction[] {
  const code = String((error as { code?: unknown })?.code ?? '');
  const typedDetails = (error as { details?: unknown })?.details;
  const exactRemote = typedDetails && typeof typedDetails === 'object'
    && typeof (typedDetails as { remote?: unknown }).remote === 'string'
    ? String((typedDetails as { remote: string }).remote).trim()
    : '';
  const authorityFailure = /Story configuration authority|configuration authority/i.test(text);
  const remoteFailure = authorityFailure || /^REMOTE_/.test(code);
  const worldModelFailure = /^(?:WMB|WMC|WORLD_MODEL)_/.test(code)
    || /World[ -]Model/i.test(text);
  if (remoteFailure) {
    const exactCandidate: ReviewableRecovery | null = exactRemote ? {
      id: 'diagnose-authority',
      label: 'Check this exact Story configuration authority.',
      executable: 'singularity-flow',
      argv: ['workspace', 'doctor', '--network', '--repository', exactRemote, '--json']
    } : null;
    // A redacted or credential-shaped remote is not an executable operand. Fall back to the exact
    // repository doctor instead of dropping the leading action or widening to all bootstrap URLs.
    const exactAuthorityDiagnostic: ReviewableRecovery = exactCandidate
      && commandGuidance(exactCandidate) ? exactCandidate : {
        id: 'diagnose-repository',
        label: 'Inspect this exact repository and its configured authority.',
        command: 'singularity-flow doctor --json'
      };
    return reviewableActions([
      exactAuthorityDiagnostic,
      {
        id: 'diagnose-world-model',
        label: 'Inspect World Model configuration, contracts, and stored artifacts.',
        command: 'singularity-flow wm doctor --json'
      }
    ], repositoryRoot);
  }
  if (worldModelFailure) {
    return reviewableActions([
      {
        id: 'diagnose-world-model',
        label: 'Inspect World Model configuration, contracts, and stored artifacts.',
        command: 'singularity-flow wm doctor --json'
      },
      {
        id: 'recommended-next',
        label: 'Ask the deterministic planner for the next legal repair.',
        command: 'singularity-flow recommend --json'
      }
    ], repositoryRoot);
  }
  return reviewableActions([
    {
      id: 'diagnose-repository',
      label: 'Run read-only repository and policy diagnostics.',
      command: 'singularity-flow doctor --json'
    },
    {
      id: 'recommended-next',
      label: 'Ask the deterministic planner for the next legal action.',
      command: 'singularity-flow recommend --json'
    }
  ], repositoryRoot);
}

/**
 * Build the card for whatever came back from the CLI.
 *
 * `headline` is what the *caller* was trying to do — "Could not switch workspace". It is used only
 * for a tier-3 card, and deliberately not allowed to override tiers 1 and 2: when the result names
 * its own outcome from the catalog, that name is the accurate one, and a caller's summary of its
 * own intent would replace a fact with a paraphrase.
 */
export function refusalFor(error: unknown, {
  headline, repositoryRoot = null
}: { headline?: string; repositoryRoot?: string | null } = {}): Refusal {
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
  if (structured?.resultType === 'sflow-refusal-plan') {
    return {
      view: fromRefusalPlan(structured, text, repositoryRoot), fidelity: 'refusal-plan-v1'
    };
  }
  const rawCode = String((error as { code?: unknown })?.code ?? '');
  const safeCodes = new Set([
    'REMOTE_UNKNOWN', 'WMB_VIEW_UNKNOWN', 'WMB_VIEW_VERSION_UNSUPPORTED',
    'WMB_VIEW_ASSIGNMENT_MIXED', 'WMB_SOURCE_SNAPSHOT_REQUIRED'
  ]);
  const code = safeCodes.has(rawCode) ? rawCode : '';
  const typedDetails = (error as { details?: unknown })?.details;
  const rawClassification = typedDetails && typeof typedDetails === 'object'
    ? String((typedDetails as { classification?: unknown }).classification ?? '') : '';
  const safeClassifications = new Set([
    'network-transient', 'offline', 'git-unavailable', 'working-directory-unavailable',
    'credential-helper-unavailable', 'authentication-required', 'sso-authorization-required',
    'authorization-denied', 'tls-trust', 'proxy-configuration', 'remote-not-found',
    'branch-not-found', 'rate-limited', 'policy-rejected', 'atomic-push-unsupported',
    'protocol-unsupported', 'unknown'
  ]);
  const classification = safeClassifications.has(rawClassification) ? rawClassification : '';
  const retryable = typedDetails && typeof typedDetails === 'object'
    && typeof (typedDetails as { retryable?: unknown }).retryable === 'boolean'
    ? String((typedDetails as { retryable: boolean }).retryable)
    : '';
  const details: Record<string, string> = {
    exitCode: exitCode === null ? 'none' : String(exitCode),
    source: 'command output'
  };
  if (code) details.code = code;
  if (classification) details.classification = classification;
  if (retryable) details.retryable = retryable;
  const actions = messageOnlyRecovery(error, text, repositoryRoot);
  return {
    view: fromMessage(text, details, headline, actions),
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
  if (fidelity === 'refusal-plan-v1') {
    return 'This command supplied a deterministic recovery plan. Its buttons prepare commands for '
      + 'review and never run them automatically; no preservation claim is made without an effects record.';
  }
  return 'This command did not report a structured result, so there is no statement here about '
    + 'what was preserved. Any displayed diagnostics are read-only, user-reviewed next steps; '
    + 'check the command output before assuming anything changed.';
}
