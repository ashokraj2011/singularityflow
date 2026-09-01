/** Pure AUT v2 cards rendered by My Work's generic result surface. */
export type AutoCardActionView = {
  /** Stable host lookup identity. The webview never receives a mutable record handle. */
  readonly id: string;
  readonly label: string;
  /** Exact terminal prefill. Pressing the button never submits this command. */
  readonly command: string;
  /** The CAS/hash authority already embedded in command, when the action requires one. */
  readonly confirmation: string | null;
};

export type AutoCardView = {
  readonly kind: 'plan' | 'running' | 'status' | 'refusal' | 'needs-you' | 'takeover' | 'report' | 'unavailable';
  readonly title: string;
  readonly status: string | null;
  readonly details: readonly { readonly label: string; readonly value: string }[];
  /** Bounded, immutable review-prefill controls. No action executes in the webview or host. */
  readonly actions: readonly AutoCardActionView[];
};

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const PLAN_ID = /^APL-[A-F0-9]{26}$/;
const REQUEST_ID = /^AHR-[A-F0-9]{26}$/;
const REFUSAL_ID = /^ARF-[A-F0-9]{26}$/;
const CANDIDATE_ID = /^CAN-[A-F0-9]{26}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_CHOICE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_ACTIONS_PER_CARD = 6;
const MAX_DETAIL_ITEMS = 8;
const MAX_DETAIL_VALUE_CHARS = 480;

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

function matching(value: unknown, pattern: RegExp): string | null {
  const normalized = text(value);
  return normalized && pattern.test(normalized) ? normalized : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, stable((value as Record<string, unknown>)[key])]));
}

function boundedValue(value: unknown, maximum = MAX_DETAIL_VALUE_CHARS): string | null {
  let normalized: string | null = null;
  if (typeof value === 'string') normalized = text(value);
  else if (typeof value === 'number' || typeof value === 'boolean') normalized = String(value);
  else if (value !== null && value !== undefined) {
    try { normalized = JSON.stringify(stable(value)); } catch { return null; }
  }
  if (!normalized) return null;
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1)}…`;
}

function boundedList(value: unknown, separator = ', '): string | null {
  if (!Array.isArray(value) || !value.length) return null;
  const visible = value.slice(0, MAX_DETAIL_ITEMS)
    .map((entry) => boundedValue(entry, 120)).filter((entry): entry is string => entry !== null);
  if (!visible.length) return null;
  const omitted = Math.max(0, value.length - visible.length);
  return boundedValue(`${visible.join(separator)}${omitted ? `${separator}+${omitted} more` : ''}`);
}

function boundedPairs(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return boundedList(entries.map(([key, entry]) => `${key}=${boundedValue(entry, 120) ?? 'unavailable'}`));
}

function detail(label: string, value: unknown) {
  const normalized = boundedValue(value);
  return normalized ? Object.freeze({ label, value: normalized }) : null;
}

function action(
  kind: string, subject: string | null, verb: string, label: string,
  command: string | null, confirmation: string | null = null
): AutoCardActionView | null {
  if (!subject || !command) return null;
  return Object.freeze({ id: `auto:${kind}:${subject}:${verb}`, label, command, confirmation });
}

function boundedActions(values: readonly (AutoCardActionView | null)[]): readonly AutoCardActionView[] {
  const unique = new Map<string, AutoCardActionView>();
  for (const value of values) {
    if (value && !unique.has(value.id)) unique.set(value.id, value);
    if (unique.size >= MAX_ACTIONS_PER_CARD) break;
  }
  return Object.freeze([...unique.values()]);
}

function optionView(option: unknown): { id: string; label: string } | null {
  if (typeof option === 'string') {
    const id = text(option);
    return id && SAFE_CHOICE.test(id) ? { id, label: id } : null;
  }
  if (!option || typeof option !== 'object') return null;
  const entry = option as Record<string, unknown>;
  const id = text(entry.id);
  if (!id || !SAFE_CHOICE.test(id)) return null;
  return { id, label: text(entry.label) ?? id };
}

function candidateAuthority(card: any, auto: any): { id: string | null; sha256: string | null } {
  const source = card?.candidate ?? card?.report?.candidate ?? auto?.candidate ?? null;
  const id = matching(source?.candidateId ?? card?.candidateId, CANDIDATE_ID);
  const sha256 = matching(
    source?.candidateSha256 ?? card?.candidateSha256 ?? auto?.references?.candidate,
    HASH
  );
  return { id, sha256 };
}

function statusAction(kind: string, flightId: string, card: any, auto: any): AutoCardActionView {
  const status = text(card.status);
  const checkpoint = matching(card.checkpointSha256 ?? auto?.checkpointSha256, HASH);
  const workId = matching(card.story?.workId ?? auto?.story?.workId, SAFE_WORK_ID);
  if (['paused', 'manual-takeover'].includes(status ?? '') && checkpoint) {
    return action(kind, flightId, 'resume', 'Prepare resume',
      `singularity-flow auto resume ${flightId} --confirm ${checkpoint}`, checkpoint)!;
  }
  if (status === 'waiting-human') {
    return action(kind, flightId, 'needs-you', 'Review request',
      `singularity-flow auto needs-you ${flightId}`)!;
  }
  if (status === 'recovery-required' && workId) {
    return action(kind, flightId, 'recover', 'Prepare recovery',
      `singularity-flow auto recover ${workId} --flight ${flightId}`)!;
  }
  return action(kind, flightId, 'status', 'Refresh status',
    `singularity-flow auto status ${flightId}`)!;
}

export function buildAutoCards(auto: any): readonly AutoCardView[] {
  if (!auto || !Array.isArray(auto.cards)) return Object.freeze([]);
  return Object.freeze(auto.cards.slice(0, 12).flatMap((card: any): AutoCardView[] => {
    const kind = text(card?.kind);
    if (!['plan', 'running', 'status', 'refusal', 'needs-you', 'takeover', 'report', 'unavailable'].includes(kind ?? '')) return [];
    const report = card.report && typeof card.report === 'object' ? card.report : null;
    const flightId = matching(card.flightId ?? report?.flightId ?? auto.flightId, FLIGHT_ID);
    const planId = matching(card.planId ?? report?.planId ?? auto.planId, PLAN_ID);
    const candidate = candidateAuthority(card, auto);
    const story = text(card.story?.workId ?? auto.story?.workId);
    const phase = text(card.story?.phase ?? auto.story?.phase);
    const details = [
      detail('Origin', flightId ? `Auto · ${flightId}` : 'Auto'),
      detail('Plan', planId), detail('Story', story), detail('Phase', phase),
      detail('Phase rail', boundedList(card.phaseRail, ' → ')),
      detail('Scope', card.scope?.status),
      detail('Predicted reads', boundedList(card.scope?.predictedRead)),
      detail('Predicted writes', boundedList(card.scope?.predictedWrite)),
      detail('Protected paths', boundedList(card.scope?.protected)),
      detail('Forbidden paths', boundedList(card.scope?.forbidden)),
      detail('Evidence readiness', card.evidenceReadiness?.status),
      detail('Verification commands', boundedList(card.evidenceReadiness?.commandIds)),
      detail('Acceptance criteria', boundedList(card.evidenceReadiness?.acceptanceCriteria)),
      detail('Ceilings', boundedPairs(card.ceilings)),
      detail('Human stops', boundedList(card.humanStops)),
      detail('Capability', boundedValue(card.capability)),
      detail('Repositories', boundedList(card.repositories)),
      detail('Position', card.position), detail('Stopped because', card.stopReason),
      detail('Attempt', card.attempt), detail('Execution Unit', card.executionUnit?.id ?? card.executionUnit),
      detail('Refusal', card.refusalId), detail('Gate', card.gate), detail('Code', card.code),
      detail('Request', card.requestId), detail('Request type', card.requestType),
      detail('Request hash', card.requestSha256),
      detail('Candidate', candidate.id), detail('Candidate hash', candidate.sha256),
      detail('Report', card.reportSha256 ?? report?.reportSha256),
      detail('Next', card.nextAction)
    ].filter((entry): entry is { label: string; value: string } => entry !== null);
    let title = `Auto flight ${flightId ?? ''}`.trim();
    let actions: readonly AutoCardActionView[] = Object.freeze([]);

    if (kind === 'plan') {
      title = `Auto Plan ${planId ?? ''}`.trim();
      const packet = matching(card.packetSha256, HASH);
      const startable = text(card.status) === 'startable';
      actions = boundedActions([
        action(kind, planId, 'start', 'Prepare start', startable && planId && packet
          ? `singularity-flow auto start --plan ${planId} --confirm ${packet}` : null, packet),
        action(kind, planId, 'review', 'Review plan', planId
          ? `singularity-flow auto show-plan ${planId}` : null)
      ]);
    } else if (kind === 'running') {
      title = 'Auto is running';
      const checkpoint = matching(card.checkpointSha256 ?? auto?.checkpointSha256, HASH);
      actions = boundedActions([
        action(kind, flightId, 'pause', 'Prepare pause', flightId
          && checkpoint ? `singularity-flow auto pause ${flightId} --confirm ${checkpoint}` : null,
        checkpoint),
        action(kind, flightId, 'takeover', 'Prepare takeover', flightId
          && checkpoint ? `singularity-flow auto takeover ${flightId} --confirm ${checkpoint}` : null,
        checkpoint),
        action(kind, flightId, 'stop', 'Prepare stop', flightId
          && checkpoint ? `singularity-flow auto stop ${flightId} --confirm ${checkpoint}` : null,
        checkpoint)
      ]);
    } else if (kind === 'refusal') {
      title = 'Auto stopped safely';
      const refusalId = matching(card.refusalId, REFUSAL_ID);
      const eligibility = text(card.repair?.eligibility ?? card.repair);
      const takeoverAvailable = !['completed', 'halted', 'discarded', 'recovery-required'].includes(text(card.status) ?? '');
      actions = boundedActions([
        action(kind, refusalId, 'repair', 'Review bounded repair',
          flightId && refusalId && ['auto-eligible', 'ask-only'].includes(eligibility ?? '')
            ? `singularity-flow auto repair ${flightId} --refusal ${refusalId}` : null),
        action(kind, candidate.id ?? candidate.sha256, 'candidate', 'Show report JSON',
          flightId && (candidate.id || candidate.sha256)
            ? `singularity-flow auto report ${flightId} --json` : null),
        action(kind, flightId, 'takeover', 'Prepare takeover',
          flightId && takeoverAvailable ? `singularity-flow auto takeover ${flightId}` : null)
      ]);
    } else if (kind === 'needs-you') {
      title = text(card.title) ?? 'Auto needs your decision';
      const requestId = matching(card.requestId, REQUEST_ID);
      const requestSha = matching(card.requestSha256, HASH);
      const choices = Array.isArray(card.options)
        ? card.options.map(optionView).filter(Boolean) as { id: string; label: string }[] : [];
      actions = boundedActions([
        action(kind, requestId, 'review', 'Review request', flightId
          ? `singularity-flow auto needs-you ${flightId}` : null),
        ...choices.map((choice) => action(
          kind, requestId, `choice-${choice.id}`, `Choose ${choice.label}`,
          flightId && requestId && requestSha
            ? `singularity-flow auto respond ${flightId} --request ${requestId} --choice ${choice.id} --confirm ${requestSha}`
            : null,
          requestSha
        ))
      ]);
    } else if (kind === 'takeover' || kind === 'report') {
      title = kind === 'takeover' ? 'Manual takeover' : 'Auto report';
      actions = boundedActions([
        action(kind, flightId, 'report', 'Open report', flightId
          ? `singularity-flow auto report ${flightId}` : null),
        action(kind, candidate.id ?? candidate.sha256, 'candidate', 'Show report JSON',
          flightId && (candidate.id || candidate.sha256)
            ? `singularity-flow auto report ${flightId} --json` : null)
      ]);
    } else if (kind === 'unavailable') {
      title = card.status === 'report-unavailable' ? 'Auto report unavailable' : 'Auto status unavailable';
      const rawWorkId = text(card.story?.workId ?? auto.story?.workId);
      const workId = matching(rawWorkId, SAFE_WORK_ID);
      actions = boundedActions([
        action(kind, flightId ?? text(card.status), 'recover', 'Prepare recovery',
          flightId && workId
            ? `singularity-flow auto recover ${workId} --flight ${flightId}`
            : rawWorkId ? null : 'singularity-flow doctor')
      ]);
    } else if (kind === 'status' && flightId) {
      actions = boundedActions([statusAction(kind, flightId, card, auto)]);
    }

    return [Object.freeze({
      kind: kind as AutoCardView['kind'], title, status: text(card.status),
      details: Object.freeze(details), actions
    })];
  }));
}
