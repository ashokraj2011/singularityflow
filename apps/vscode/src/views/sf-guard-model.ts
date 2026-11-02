/**
 * SF Guard in VS Code: what the Guard page, the sign card and the Story views show, from the CLI's
 * own `--json` readers. [SPEC-PSS-v1 M5, AC-014] [SPEC-SFG-v1 G5, AC-012]
 *
 * Nothing here decides anything. On or off, each key's standing, each exception, the remote check,
 * recording and every label come from `guard status`, `guard report` and `approvals`, as the
 * terminal prints them; the counts are the report's own, never recounted. A person step that needs a
 * presence signature is never signed here: the CLI refuses it without a terminal
 * (`PSS_CARD_NOT_SHOWN`) before anything is written, and the sign card hands the same command to the
 * person's own terminal, where the CLI prints its card and Touch ID prompts [PSS:REQ-012].
 */

/** The rule on every card, in the CLI's words (src/presence/signer.mjs). */
export const SF_GUARD_RULE = 'Touch the sensor only for a command you started yourself, right after its card. A prompt you did not start is an agent asking: decline it.';

/** Where the first-run card's dismissal is kept (this machine's VS Code, never the repository). */
export const SF_GUARD_FIRST_RUN_KEY = 'singularityFlow.sfGuard.firstRunSeen';

/** The CI recipe's path and the route that writes it (src/presence/remote-recipe.mjs). */
export const SF_GUARD_RECIPE_PATH = '.github/workflows/sf-guard-verify.yml';
export const SF_GUARD_RECIPE_ROUTE = `singularity-flow guard remote-check --recipe > ${SF_GUARD_RECIPE_PATH}`;

/** The refusal code the CLI gives a person step started without a terminal for its card. */
export const CARD_NOT_SHOWN = 'PSS_CARD_NOT_SHOWN';

export const guardStatusArgv = (): string[] => ['guard', 'status', '--json'];
export const guardRemoteCheckArgv = (): string[] => ['guard', 'remote-check', '--json'];
export function guardReportArgv({ story = null, since = null }: { story?: string | null; since?: string | null } = {}): string[] {
  return ['guard', 'report', ...(since ? ['--since', since] : []), ...(story ? ['--story', story] : []), '--json'];
}
export const storyApprovalsArgv = (workId: string): string[] => ['approvals', workId, '--json'];

/** The attribution classes in the report's order, with the words `guard report` prints for each. */
export const CLASS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  declared: 'declared', 'outside-workflow': 'outside the workflow', 'unknown-agent': 'agent unknown',
  shell: 'shell commands', unattributed: 'unattributed', 'pre-guard': 'before SF Guard'
});

type Json = Record<string, unknown>;
const object = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export type Tone = 'ok' | 'wait' | 'bad' | 'idle';

export interface GuardKeyRow {
  approver: string;
  label: string;
  state: string;
  standing: string;
  keyId: string | null;
  recovered: boolean;
  exception: string | null;
  expiry: string;
  expiryTone: Tone;
}

export interface GuardExceptionRow { id: string; approver: string; who: string; reason: string; active: boolean; label: string }

export interface GuardStatus {
  on: boolean;
  chainId: string | null;
  events: number;
  validEvents: number;
  historyChecked: boolean;
  remote: { check: string | null; status: string; branch: string | null; repository: string | null; reason: string | null; suggested: string } | null;
  remoteCheck: string | null;
  keys: GuardKeyRow[];
  exceptions: GuardExceptionRow[];
  recording: { state: string; gaps: number; lastGap: { code: string; at: string } | null } | null;
  problems: Array<{ code: string; message: string }>;
  agents: Array<{ id: string; stamp: string }>;
}

/** When a key expires, in words: this Mac's `sc_auth` listing, or why it cannot be read here. */
function expiryWords(expiry: Json | null, keyId: string | null): { words: string; tone: Tone } {
  if (!keyId) return { words: '—', tone: 'idle' };
  if (!expiry) return { words: 'expiry not reported by this SFlow', tone: 'idle' };
  if (expiry.here !== true) return { words: `expiry read on the Mac that holds it (${text(expiry.reason) ?? 'not this computer'})`, tone: 'idle' };
  if (expiry.valid === false) return { words: `expired${text(expiry.validTo) ? ` ${expiry.validTo}` : ''}: rotate it (singularity-flow guard rotate --key <NEW-KEY-ID>)`, tone: 'bad' };
  return { words: `valid to ${text(expiry.validTo) ?? 'an unreadable date'}`, tone: 'ok' };
}

/** `guard status --json` as the page reads it, or null when the answer is not SF Guard's. */
export function guardStatusFrom(raw: unknown): GuardStatus | null {
  const result = object(raw);
  if (!result || result.resultType !== 'sflow-guard' || !['required', 'off'].includes(String(result.status))) return null;
  const approvers = list(result.approvers).map(object).filter((row): row is Json => Boolean(row));
  const labelOf = (approver: string): string => text(approvers.find((row) => row.approver === approver)?.label) ?? approver;
  const remote = object(result.remote);
  const recording = object(result.recording);
  const lastGap = object(recording?.lastGap);
  return {
    on: result.status === 'required',
    chainId: text(result.chainId),
    events: count(result.events),
    validEvents: count(result.validEvents),
    historyChecked: result.historyChecked !== false,
    remote: remote ? { check: text(remote.check), status: text(remote.status) ?? 'unknown', branch: text(remote.branch), repository: text(remote.repository),
      reason: text(remote.reason), suggested: text(remote.suggested) ?? 'sf-guard-verify' } : null,
    remoteCheck: text(result.remoteCheck),
    keys: approvers.map((row) => {
      const keyId = text(row.keyId);
      const expiry = expiryWords(object(row.expiry), keyId);
      return { approver: text(row.approver) ?? '', label: text(row.label) ?? '', state: text(row.state) ?? '', standing: text(row.standing) ?? '',
        keyId, recovered: row.recovered === true, exception: text(row.exception), expiry: expiry.words, expiryTone: expiry.tone };
    }),
    exceptions: list(result.exceptions).map(object).filter((row): row is Json => Boolean(row) && Boolean(text(row?.id))).map((row) => {
      const id = text(row.id)!;
      const approver = text(row.approver) ?? '';
      // The CLI's own words for a bypass (src/presence/chain.mjs exceptionLabel).
      return { id, approver, who: labelOf(approver), reason: text(row.reason) ?? '', active: row.active === true,
        label: `bypass: per-person exception ${id}${row.hostReview ? " (the repository owner's reviewed change; the remote check confirms the review)" : ''}` };
    }),
    recording: recording ? { state: text(recording.state) ?? 'off', gaps: count(recording.gaps),
      lastGap: lastGap ? { code: text(lastGap.code) ?? 'unknown', at: text(lastGap.at) ?? '' } : null } : null,
    problems: list(result.problems).map(object).filter((row): row is Json => Boolean(row))
      .map((row) => ({ code: text(row.code) ?? 'PSS_PROBLEM', message: text(row.message) ?? '' })),
    agents: list(result.agents).map(object).filter((row): row is Json => Boolean(row))
      .map((row) => ({ id: text(row.id) ?? '', stamp: text(row.stamp) ?? '' }))
  };
}

/** The remote check and branch protection, in words, with the recipe route a person takes. */
export function remoteWords(status: GuardStatus): { words: string; tone: Tone } {
  const remote = status.remote;
  if (!status.on) return { words: 'Read when SF Guard is on.', tone: 'idle' };
  if (!remote) return status.remoteCheck
    ? { words: `Remote check ${status.remoteCheck}: branch protection could not be read here.`, tone: 'wait' }
    : { words: 'No remote check named.', tone: 'wait' };
  if (remote.status === 'unnamed') return { words: `No remote check named. Name one when opting in (--remote-check ${remote.suggested}).`, tone: 'wait' };
  if (remote.status === 'required') return { words: `${remote.check} is a required status check on ${remote.branch}.`, tone: 'ok' };
  if (remote.status === 'not-required' || remote.status === 'unprotected') {
    return { words: `${remote.check} is NOT a required status check on ${remote.branch} yet${remote.reason ? ` (${remote.reason})` : ''}: a merge is not held by it.`, tone: 'bad' };
  }
  return { words: `Whether ${remote.check} is required on ${remote.branch} could not be read (${remote.reason ?? 'unknown'}).`, tone: 'wait' };
}

export interface ReportGroup { classification: string; agent: string | null; skill: string | null; kind: string; calls: number; continued: boolean; words: string }
export interface ReportSubject { scope: string; title: string; counts: Record<string, number>; groups: ReportGroup[] }
export interface PacketLabels { phase: string; generation: number; packetSha256: string; packet: string; labels: string[]; summary: string | null }
export interface GuardReport {
  sfGuard: string;
  recording: string;
  since: string | null;
  story: string | null;
  totals: Record<string, number>;
  subjects: ReportSubject[];
  storyLabels: { status: string; steps: PacketLabels[] } | null;
  lastGap: { code: string; at: string } | null;
}

function skillWords(group: Json): string {
  const skill = text(group.skill) ?? 'none';
  return group.continued ? `${skill} (continued)` : skill;
}

/**
 * A packet's attribution counts on one line, exactly as `attributionSummary` in
 * src/presence/attribution.mjs writes it for the approval card.
 */
export function attributionSummaryText(block: unknown): string | null {
  const value = object(block);
  if (!value) return null;
  if (value.status === 'unavailable') return `SF Guard labels: unavailable (${String(value.reason)})`;
  const counts = object(value.counts) ?? {};
  const parts = [`${count(counts.declared)} declared`];
  for (const [name, words] of [['outside-workflow', 'outside the workflow'], ['unknown-agent', 'agent unknown'], ['shell', 'shell command'],
    ['unattributed', 'unattributed'], ['pre-guard', 'before SF Guard']] as const) if (count(counts[name])) parts.push(`${count(counts[name])} ${words}`);
  return `SF Guard labels: ${parts.join(' · ')} (lines)${value.partial ? ', partial' : ''}`;
}

/** `guard report --json` as the page reads it: the report's own counts, never recounted. */
export function guardReportFrom(raw: unknown): GuardReport | null {
  const result = object(raw);
  if (!result || result.resultType !== 'sflow-guard-report') return null;
  const totals = object(result.totals) ?? {};
  const story = object(result.storyLabels);
  const lastGap = object(result.lastGap);
  return {
    sfGuard: text(result.sfGuard) ?? 'off',
    recording: text(result.recording) ?? 'off',
    since: text(result.since),
    story: text(result.story),
    totals: Object.fromEntries(Object.keys(CLASS_WORDS).map((name) => [name, count(totals[name])])),
    subjects: list(result.subjects).map(object).filter((row): row is Json => Boolean(row)).map((subject) => {
      const scope = text(subject.scope) ?? 'repository';
      const counts = object(subject.counts) ?? {};
      return {
        scope, title: scope === 'repository' ? 'Outside any Story' : `Story ${scope}`,
        counts: Object.fromEntries(Object.keys(CLASS_WORDS).map((name) => [name, count(counts[name])])),
        groups: list(subject.groups).map(object).filter((row): row is Json => Boolean(row)).map((group) => {
          const calls = count(group.calls);
          const kind = group.kind === 'shell' ? 'shell' : 'edit';
          const classification = text(group.classification) ?? 'unattributed';
          // `guard report`'s own line for a group (src/presence/attribution.mjs sfGuardReportText).
          return { classification, agent: text(group.agent), skill: text(group.skill), kind, calls, continued: group.continued === true,
            words: `${classification}: ${plural(calls, kind === 'shell' ? 'shell call' : 'edit')} — agent ${text(group.agent) ?? 'none'}, skill ${skillWords(group)}` };
        })
      };
    }),
    storyLabels: story ? { status: text(story.status) ?? 'absent', steps: list(story.steps).map(object).filter((row): row is Json => Boolean(row)).map((step) => ({
      phase: text(step.phase) ?? '', generation: count(step.generation), packetSha256: text(step.packetSha256) ?? '', packet: text(step.packet) ?? 'absent',
      labels: list(step.labels).filter((line): line is string => typeof line === 'string'), summary: attributionSummaryText(step.attribution)
    })) } : null,
    lastGap: lastGap ? { code: text(lastGap.code) ?? 'unknown', at: text(lastGap.at) ?? '' } : null
  };
}

/** The report's totals as `guard report` prints its "Recorded calls" line. */
export function totalsWords(totals: Record<string, number>): string {
  const parts = Object.entries(totals).filter(([, n]) => n).map(([name, n]) => `${n} ${CLASS_WORDS[name] ?? name}`);
  return parts.length ? parts.join(' · ') : 'none';
}

// --- A Story's SF Guard standing: its approvals as SF Guard counts them, and its packets' labels ---

export type ApprovalState = 'signed' | 'pre-signing' | 'bypass' | 'not-counted' | 'other';
export interface ApprovalStanding { phase: string; actor: string; at: string | null; decision: string; generation: number | null; active: boolean; state: ApprovalState; label: string; counted: boolean }
export interface StoryStanding { workId: string; approvals: ApprovalStanding[]; packets: PacketLabels[]; packetStatus: string | null }

/** The state a CLI presence label names: `signed with …`, `bypass: …`, `pre-signing: …`, `not counted: …`. */
export function approvalState(label: string): ApprovalState {
  if (/^signed\b/u.test(label)) return 'signed';
  if (/^bypass\b/u.test(label)) return 'bypass';
  if (/^pre-signing\b/u.test(label)) return 'pre-signing';
  if (/^not counted\b/u.test(label)) return 'not-counted';
  return 'other';
}

export const APPROVAL_STATE_PILL: Readonly<Record<ApprovalState, { tone: Tone; words: string }>> = Object.freeze({
  signed: { tone: 'ok', words: 'signed' },
  'pre-signing': { tone: 'idle', words: 'pre-signing' },
  bypass: { tone: 'wait', words: 'bypass' },
  'not-counted': { tone: 'bad', words: 'not counted' },
  other: { tone: 'idle', words: 'SF Guard' }
});

/**
 * `approvals <WORK-ID> --json` and `guard report --story <WORK-ID> --json`, joined: each recorded
 * decision with the label SF Guard's verifier gave it, and each submitted packet's labels.
 */
export function storyStandingFrom(workId: string, approvalsRaw: unknown, reportRaw: unknown): StoryStanding {
  const result = object(approvalsRaw);
  const chain = object(object(result?.data)?.approvalChain) ?? object(result?.approvalChain);
  const approvals: ApprovalStanding[] = [];
  for (const phase of list(chain?.phases).map(object)) {
    const decisions = list(object(phase?.approval)?.decisions).map(object);
    for (const decision of decisions) {
      const label = text(decision?.presence);
      if (!decision || !label) continue;
      approvals.push({ phase: text(phase?.id) ?? '', actor: text(decision.actor) ?? 'unknown', at: text(decision.at), decision: text(decision.decision) ?? 'unknown',
        generation: typeof decision.generation === 'number' ? decision.generation : null, active: decision.active !== false,
        state: approvalState(label), label, counted: decision.counted !== false });
    }
  }
  const report = guardReportFrom(reportRaw);
  return { workId, approvals, packets: report?.storyLabels?.steps ?? [], packetStatus: report?.storyLabels?.status ?? null };
}

/** Whether a Story pinned SF Guard's policy at start: only then do its views read its standing. */
export function storyPinsSfGuard(workflow: unknown): boolean {
  return Boolean(object(object(object(workflow)?.resolution)?.presence));
}

/** A key that changes whenever the Story's approvals or submissions do, so a cached standing is never stale. */
export function storyStandingKey(workflow: unknown): string | null {
  const value = object(workflow);
  const workId = text(object(value?.workItem)?.id);
  if (!workId) return null;
  const phases = object(value?.phases) ?? {};
  const approvals = Object.entries(phases).map(([id, phase]) => [id, list(object(phase)?.approvals).map((entry) => {
    const record = object(entry);
    return `${text(record?.at) ?? ''}|${text(record?.decision) ?? ''}|${text(record?.invalidatedAt) ?? ''}`;
  })]);
  const submissions = list(object(value?.lineage)?.submissions).map((entry) => text(object(entry)?.packetSha256) ?? '');
  return JSON.stringify([workId, approvals, submissions]);
}

/** The standing of one recorded decision, matched by phase and time (each record has its own `at`). */
export function approvalStandingFor(standing: StoryStanding | null | undefined, phase: string, at: string | null): ApprovalStanding | null {
  if (!standing || !at) return null;
  return standing.approvals.find((entry) => entry.phase === phase && entry.at === at) ?? null;
}

/** The labels of a phase's latest submitted packet (its generation when given). */
export function packetFor(standing: StoryStanding | null | undefined, phase: string, generation: number | null = null): PacketLabels | null {
  const entries = (standing?.packets ?? []).filter((entry) => entry.phase === phase && (generation == null || entry.generation === generation));
  return entries.at(-1) ?? null;
}

// --- The sign card: a person step the CLI refused for want of a terminal ---

export interface SignRequest {
  repository: string;
  /** The exact command the extension ran, without `--json`: the CLI prints its card for a person. */
  args: string[];
  title: string;
  message: string;
}

/** Arguments whose values are bearer tokens: shown as `<…>` on the card, never as their value. */
const SECRET_OPTIONS = new Set(['--selection-receipt', '--intake-receipt']);

/** The command as the card shows it: SFlow's words, with any receipt token hidden. */
export function signCommandText(args: readonly string[]): string {
  const shown: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    shown.push(/\s|['"]/u.test(value) ? JSON.stringify(value) : value);
    if (SECRET_OPTIONS.has(value) && index + 1 < args.length) { shown.push('<receipt>'); index += 1; }
  }
  return `singularity-flow ${shown.join(' ')}`;
}

/** What the person is about to sign, in a few words: the step, its subject. */
export function signTitle(args: readonly string[]): string {
  const [verb, ...rest] = args;
  const option = (name: string): string | null => {
    const at = rest.indexOf(name);
    return at >= 0 ? rest[at + 1] ?? null : null;
  };
  if (verb === 'approve' || verb === 'reject') {
    const phase = option('--phase') ?? rest.find((value) => !value.startsWith('-')) ?? 'a phase';
    const workId = option('--work-id') ?? (option('--phase') ? rest[0] : null);
    return `${verb} ${phase}${workId ? ` for ${workId}` : ''}`;
  }
  if (verb === 'spec' && rest[0] === 'author') {
    const words = rest.slice(1).filter((value) => !value.startsWith('-')).slice(0, 3);
    const optionId = option('--option');
    return `spec ${words.join(' ')}${optionId ? ` with ${optionId}` : ''}`;
  }
  return [verb, ...rest.filter((value) => !value.startsWith('-')).slice(0, 2)].filter(Boolean).join(' ');
}

/**
 * The sign card's request for a refusal, or null: only `PSS_CARD_NOT_SHOWN` from a command this
 * extension ran itself, with no stdin input (a terminal cannot replay it), qualifies. Anything else
 * stays an ordinary refusal card with the CLI's own routes.
 */
export function signRequestFrom(error: unknown): SignRequest | null {
  const value = object(error);
  if (!value || value.name !== 'CliError') return null;
  const result = object(value.result);
  const code = text(object(result?.error)?.code) ?? text(object(object(result?.outcome)?.error)?.code);
  if (code !== CARD_NOT_SHOWN) return null;
  const invocation = object(value.invocation);
  const repository = text(invocation?.repository);
  const args = list(invocation?.args).filter((entry): entry is string => typeof entry === 'string');
  if (!repository || !args.length || invocation?.input) return null;
  const replay = args.filter((entry) => entry !== '--json');
  return { repository, args: replay, title: signTitle(replay), message: text(object(result?.error)?.message) ?? text(value.message) ?? '' };
}
