/**
 * The decision list as a page: what blocks a Story's step, item by item, with its choices.
 * [decision list, VS Code surface]
 *
 * The engine owns every rule. `singularity-flow decisions --json` returns the list (items, options,
 * who decides each, the editable defaults and the list's digest); a preview with `--choose` returns
 * the summary and the exact record command; `decisions record --answers FILE` re-reads the list,
 * refuses a changed digest and checks the person's approval groups. This module only turns those
 * results into rows and turns a person's clicks into the answers the engine reads. Nothing here
 * decides, records or relaxes anything, and an option the engine says the person may not decide is
 * never offered as a button.
 *
 * Pure on purpose (no `vscode` import), so the tests pin every control and every argv.
 */
import type { ReviewConfirmationRequest } from './review-confirmation-page.ts';

export interface DecisionTextNeed { default: string; minimum: number; maximum: number }
export interface DecisionDateNeed { default: string; latest: string }
/** The clauses a person may name for a statement. */
/** `words` asks for the clauses and `label` names them in a summary, when they are not the ones that carry the item. */
export interface DecisionClauseNeed { known?: string[]; words?: string; label?: string }
/** A checklist answered one article at a time. */
export interface DecisionArticleNeed { articles: Array<{ id: string; title: string; question: string }>; decisions: string[] }
export interface DecisionNeeds { reason?: DecisionTextNeed; cause?: DecisionTextNeed; expires?: DecisionDateNeed; clause?: DecisionClauseNeed; article?: DecisionArticleNeed }
export interface DecisionDecidedBy { groups?: string[]; labels?: string[]; allowed: boolean; words: string; share?: string }

export interface DecisionOptionPacket {
  id: string; label: string; recommended: boolean; words?: string;
  effects?: Array<Record<string, unknown>>;
  needs?: DecisionNeeds;
  decidedBy: DecisionDecidedBy;
  /**
   * False only says `decisions record` does not write this option: the person takes its own command.
   * It says nothing about who may run that command, or whether a /sf-decide turn may.
   */
  recordable?: boolean;
  available?: boolean;
  /** A departure decided on its own row with its own reason, never by one answer for all [CQF:REQ-024]. */
  oneByOne?: boolean;
  action?: { command: string | null; alternativeCommands?: string[]; humanReview?: { kind: 'witness'; clauseId: string; clauseText?: string | null; slot: string; method: string; files: string[]; owners: string[]; contextBinding: string };
    /** A file the person writes before running the command (an intent-amendment draft), named by the engine. */
    file?: string };
}

export interface DecisionItemPacket {
  id: string; kind: string; title: string; why: string;
  options: DecisionOptionPacket[];
  decidedBy: DecisionDecidedBy;
  details?: Record<string, unknown>;
}

/**
 * The evidence `decisions --json` carries beside a code step's decisions [CQF:REQ-031, REQ-033, REQ-034,
 * REQ-052, REQ-055]: shown, never recorded; the engine words every line, so each host shows the same facts.
 */
export interface ApprovalEvidencePacket {
  phase: string; phaseLabel: string; words: string;
  coverage?: { status: 'measured' | 'not-measured' | string; minimum: number; percent?: number | null; below?: boolean; words: string; reasons?: string[];
    files?: Array<{ path: string; inReport: boolean; percent: number | null; words: string }>; more?: number };
  proof?: { criteria: Array<{ clauseId: string; tests: number; asserting: number; silent: number; words: string;
    assertsNothing: Array<{ test: string; testSource: string; line: number | null }> }>; more?: number;
    assertionCheck?: { status: string; words: string; tests: Array<{ name: string; path: string; line: number | null }> } };
  findings?: { letThrough: Array<{ id: string; tool: string; rule: string | null; severity: string; file: string | null; line: number | null;
    accepted: { id: string; by: string; until: string } | null; words: string }>; more?: number; words: string };
  hold?: { code: string; words: string; more?: number;
    entries: Array<{ id: string; package: string; installedVersion: string | null; fixedVersion: string | null; rule: string | null; severity: string;
      who: string; allowed: boolean; command: string; words: string }> };
  requiredChecks?: { status: string; words: string | null; checks: Array<{ name: string; status: string }> };
  /** What the person typed after /sf-code or /sf-phase, quoted, with each instruction's account [SCS:REQ-043]. */
  askedFor?: { words: string; unaccounted: number; more?: number;
    instructions: Array<{ instruction: number; generation: number; text: string; truncated?: boolean;
      account?: { as: string; clauses: string[]; departure: string | null } | null; accountWords?: string; words: string }> };
}

export interface DecisionPacket {
  resultType: 'sflow-decisions';
  workId: string; phase: string; phaseLabel: string;
  repositoryPath?: string;
  recorded?: Array<{ id: string; kind: string; summary: string; at?: string }>;
  status: 'decisions-needed' | 'nothing-to-decide' | string;
  headline: string; rule?: string;
  items: DecisionItemPacket[];
  /** Offered beside what waits: on the list's digest and record, in nobody's count. */
  offered?: DecisionItemPacket[];
  packetSha256: string;
  next?: { item: string; kind: string; title: string; command: string; copilotCommand: string | null } | null;
  record?: { form?: string; recommended?: string | null; interactive?: string; share?: string };
  unavailable?: Array<{ phase?: string; reason?: string }>;
  approvalEvidence?: ApprovalEvidencePacket | null;
}

/** What a person chose for one item, with the values they see in its fields. */
export interface DecisionArticleAnswer { article: string; decision: string; reason?: string }
export interface DecisionChoice { item: string; option: string; reason?: string; expires?: string; cause?: string; clause?: string; article?: DecisionArticleAnswer[] }

/** The answers `decisions record --answers FILE` reads; only values a person changed from the defaults. */
export interface DecisionAnswers {
  choose: Record<string, string>;
  reason: Record<string, string>;
  expires: Record<string, string>;
  cause: Record<string, string>;
  clause?: Record<string, string>;
  article?: Record<string, DecisionArticleAnswer[]>;
}

export interface DecisionPreview {
  steps: Array<{ item: string; title?: string; option: string; label?: string; values?: Record<string, string> }>;
  refused: Array<{ item: string; title?: string; option?: string; words?: string; share?: string }>;
  summary: string[];
  record: { command: string; recordInChat?: boolean; terminal?: string } | null;
}

export interface DecisionOptionRow {
  id: string; label: string; recommended: boolean; words: string;
  /** A button the person may press: recorded here, available, and theirs to decide. */
  choosable: boolean;
  /** Why it is not a button, in the engine's words, when it is not. */
  notChoosable: string | null;
  /** A person's own action (take the screenshot and record it): its command, never run here. */
  yours: { command: string; alternativeCommands: string[]; humanReview?: boolean; file?: string } | null;
  needs: DecisionNeeds;
}

export interface DecisionItemRow {
  id: string; kind: string; title: string; why: string;
  /** Who decides it, in plain words. */
  who: string;
  /** False when the person may decide none of its options: no buttons, the share line instead. */
  allowed: boolean;
  share: string | null;
  options: DecisionOptionRow[];
  chosen: DecisionChoice | null;
}

export interface DecisionListOutcome {
  kind: 'recorded' | 'stale' | 'partial' | 'not-yours' | 'failed';
  message: string;
  recorded: string[];
  remaining: string[];
  /** What was decided, one entry a decision, in its own words: a record's ID does not say it. */
  decided?: string[];
  /** Drafts written, never recorded: where each is and what is next [SCS:REQ-020]. */
  drafted?: string[];
}

export interface DecisionListView {
  available: boolean;
  workId: string | null; phase: string | null; phaseLabel: string | null;
  headline: string; rule: string | null; digest: string | null;
  nothingToDecide: boolean;
  items: DecisionItemRow[];
  unavailable: string[];
  chosen: number;
  notice: string | null; error: string | null;
  outcome: DecisionListOutcome | null;
  busy: boolean;
  recorded?: string[];
}

const ITEM = /^d\d{1,3}$/u;
const OPTION = /^[a-z][a-z0-9-]{0,63}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The list from a CLI result: the command-result envelope's data, or the packet itself. Null otherwise. */
export function decisionPacketFrom(result: unknown): DecisionPacket | null {
  const response = object(result);
  const data = response?.resultType === 'sflow-decisions' ? response : object(response?.data);
  if (data?.resultType !== 'sflow-decisions' || typeof data.workId !== 'string' || !Array.isArray(data.items)
      || typeof data.packetSha256 !== 'string' || !DIGEST.test(data.packetSha256)) return null;
  return data as unknown as DecisionPacket;
}

/** The preview a `decisions --choose` result carries, or null. */
export function decisionPreviewFrom(result: unknown): DecisionPreview | null {
  const response = object(result);
  const data = object(response?.data) ?? response;
  const preview = object(data?.preview);
  if (!preview || !Array.isArray(preview.steps) || !Array.isArray(preview.refused) || !Array.isArray(preview.summary)) return null;
  return preview as unknown as DecisionPreview;
}

/** Recommended first, then in the engine's order (the engine sorts too; a page never reorders choices otherwise). */
function ordered(options: DecisionOptionPacket[]): DecisionOptionPacket[] {
  return options.map((option, index) => ({ option, index }))
    .sort((left, right) => Number(right.option.recommended) - Number(left.option.recommended) || left.index - right.index)
    .map((entry) => entry.option);
}

export function optionRow(option: DecisionOptionPacket): DecisionOptionRow {
  const yours = option.action?.command ? { command: option.action.command, alternativeCommands: option.action.alternativeCommands ?? [], ...(option.action.humanReview ? { humanReview: true } : {}),
    ...(typeof option.action.file === 'string' && option.action.file ? { file: option.action.file } : {}) } : null;
  const recorded = option.recordable !== false;
  const available = option.available !== false;
  const allowed = option.decidedBy?.allowed === true;
  const choosable = recorded && available && allowed;
  return {
    id: option.id, label: option.label, recommended: option.recommended === true, words: option.words ?? '',
    choosable,
    notChoosable: choosable ? null : yours ? 'Yours to do; nothing is recorded here.'
      : !available ? (option.words || 'Not available.') : (option.decidedBy?.words ?? 'Not yours to decide.'),
    yours, needs: recorded ? option.needs ?? {} : {}
  };
}

/** What a person chose, kept only while the item and the option still exist and are theirs. */
function keptChoice(item: DecisionItemPacket, draft: DecisionChoice[] | undefined): DecisionChoice | null {
  const choice = draft?.find((entry) => entry.item === item.id) ?? null;
  if (!choice) return null;
  const option = item.options.find((entry) => entry.id === choice.option);
  return option && optionRow(option).choosable ? choice : null;
}

/**
 * The page's rows. `draft` is what the person chose before a re-render (an error, a refused
 * preview); a choice the current list no longer offers is dropped rather than carried over.
 */
export function buildDecisionListView(packet: DecisionPacket | null, {
  draft = [], notice = null, error = null, outcome = null, busy = false
}: {
  draft?: DecisionChoice[]; notice?: string | null; error?: string | null; outcome?: DecisionListOutcome | null; busy?: boolean;
} = {}): DecisionListView {
  if (!packet) {
    return { available: false, workId: null, phase: null, phaseLabel: null, headline: '', rule: null, digest: null,
      nothingToDecide: false, items: [], unavailable: [], chosen: 0, notice, error, outcome, busy };
  }
  const items = packet.items.map((item): DecisionItemRow => {
    const options = ordered(item.options).map(optionRow);
    // Theirs when they may choose an option here or take one of its steps themselves (a command to run).
    const allowed = item.decidedBy?.allowed === true && options.some((option) => option.choosable || option.yours !== null);
    return {
      id: item.id, kind: item.kind, title: item.title, why: item.why,
      who: item.decidedBy?.words ?? '', allowed,
      share: allowed ? null : item.decidedBy?.share ?? packet.record?.share ?? `/sf-decide ${packet.workId}`,
      options, chosen: allowed ? keptChoice(item, draft) : null
    };
  });
  return {
    available: true, workId: packet.workId, phase: packet.phase, phaseLabel: packet.phaseLabel,
    headline: packet.items.length ? packet.headline : `${packet.phaseLabel} has nothing left waiting for a decision.`,
    // The verdict rule is about conformance verdicts: shown only beside them.
    rule: packet.items.some((item) => ['conformance-gap', 'upstream-issue'].includes(item.kind)) ? packet.rule ?? null : null, digest: packet.packetSha256,
    nothingToDecide: packet.items.length === 0,
    items,
    unavailable: (packet.unavailable ?? []).map((entry) => `${entry.phase ?? 'A step'}'s report could not be read (${entry.reason ?? 'unreadable'}).`),
    chosen: items.filter((item) => item.chosen).length,
    notice, error, outcome, busy,
    recorded: (packet.recorded ?? []).map(entry => `${entry.id}: ${entry.summary}`)
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The answers for what the person chose, checked against the list they saw. Values equal to an
 * option's default are left out (the engine records the default), so the record command is the one
 * the preview prints. The engine checks everything again; these checks only say early what it would.
 */
export function decisionAnswersFromChoices(packet: DecisionPacket, raw: unknown, { today = null }: { today?: string | null } = {}): {
  answers: DecisionAnswers; choices: DecisionChoice[]; errors: string[];
} {
  const answers: DecisionAnswers = { choose: {}, reason: {}, expires: {}, cause: {} };
  const choices: DecisionChoice[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(raw) ? raw.slice(0, 1000) : []) {
    const entry = object(value);
    const itemId = text(entry?.item) ?? '';
    const optionId = text(entry?.option) ?? '';
    if (!ITEM.test(itemId) || !OPTION.test(optionId)) { errors.push('A choice did not name an item and an option of this list.'); continue; }
    if (seen.has(itemId)) { errors.push(`${itemId} was chosen twice.`); continue; }
    seen.add(itemId);
    const item = [...packet.items, ...(packet.offered ?? [])].find((candidate) => candidate.id === itemId);
    const option = item?.options.find((candidate) => candidate.id === optionId);
    if (!item || !option) { errors.push(`${itemId} has no option '${optionId}' in this list. Refresh it and choose again.`); continue; }
    const row = optionRow(option);
    if (!row.choosable) { errors.push(`${item.title}: ${row.notChoosable}`); continue; }
    const choice: DecisionChoice = { item: itemId, option: optionId };
    let valid = true;
    for (const flag of ['reason', 'cause'] as const) {
      const need = option.needs?.[flag];
      if (!need) continue;
      const typed = (text(entry?.[flag]) ?? need.default).trim();
      choice[flag] = typed;
      if (typed.length < need.minimum || typed.length > need.maximum) {
        errors.push(`${item.title}: the ${flag} must be ${need.minimum} to ${need.maximum} characters.`);
        valid = false;
      } else if (typed !== need.default.trim()) answers[flag][itemId] = typed;
    }
    const expiry = option.needs?.expires;
    if (expiry) {
      const typed = (text(entry?.expires) ?? expiry.default).trim();
      choice.expires = typed;
      if (!DATE.test(typed) || typed > expiry.latest || (today && typed <= today)) {
        errors.push(`${item.title}: choose a date after today and no later than ${expiry.latest}.`);
        valid = false;
      } else if (typed !== expiry.default) answers.expires[itemId] = typed;
    }
    if (option.needs?.clause) {
      const typed = (text(entry?.clause) ?? '').trim();
      choice.clause = typed;
      if (typed) (answers.clause ??= {})[itemId] = typed;
      else { errors.push(`${item.title}: name ${(option.needs.clause.words ?? 'the clauses that carry it').replace(/^The /u, 'the ')}.`); valid = false; }
    }
    const articles = option.needs?.article;
    if (articles) {
      const given = (Array.isArray(entry?.article) ? entry.article : []).map((value) => object(value)).filter((value) => value !== null);
      const answered = given.map((value) => ({ article: text(value.article) ?? '', decision: text(value.decision) ?? '', reason: (text(value.reason) ?? '').trim() }))
        .map(({ reason, ...rest }) => ({ ...rest, ...(rest.decision === 'satisfied' ? {} : { reason }) }));
      choice.article = answered;
      (answers.article ??= {})[itemId] = answered;
      if (articles.articles.some(({ id }) => !articles.decisions.includes(answered.find((value) => value.article === id)?.decision ?? ''))) {
        errors.push(`${item.title}: answer every article of the checklist.`); valid = false;
      } else if (answered.some((value) => value.decision !== 'satisfied' && !value.reason)) {
        errors.push(`${item.title}: an article that is not satisfied needs its own reason.`); valid = false;
      }
    }
    choices.push(choice);
    if (valid) answers.choose[itemId] = optionId;
  }
  if (!choices.length && !errors.length) errors.push('Choose an option for at least one item.');
  return { answers, choices, errors };
}

function phaseArgs(phase: string | null | undefined): string[] {
  return phase ? ['--phase', phase] : [];
}

function assertWorkId(workId: string): string {
  if (!WORK_ID.test(workId) || workId.includes('..')) throw new Error('Select the Story whose decisions you want to see.');
  return workId;
}

/** The read: the list as it stands now. */
export function decisionListArgv(workId: string, phase: string | null = null): string[] {
  return ['decisions', assertWorkId(workId), ...phaseArgs(phase), '--json'];
}

/** The preview: the same list with the choices, which records nothing and returns the summary. */
export function decisionPreviewArgv(workId: string, answers: DecisionAnswers, phase: string | null = null): string[] {
  const argv = ['decisions', assertWorkId(workId), ...phaseArgs(phase)];
  for (const [item, option] of Object.entries(answers.choose)) argv.push('--choose', `${item}=${option}`);
  for (const flag of ['reason', 'expires', 'cause', 'clause'] as const) {
    for (const [item, value] of Object.entries(answers[flag] ?? {})) if (answers.choose[item]) argv.push(`--${flag}`, `${item}=${value}`);
  }
  return [...argv, '--json'];
}

/** The record: the answers file carries the choices and the digest of the list they were made from. */
export function decisionRecordArgv(workId: string, answersFile: string, phase: string | null = null): string[] {
  return ['decisions', 'record', assertWorkId(workId), ...phaseArgs(phase), '--answers', answersFile, '--json'];
}

/** The answers file's JSON: exactly what was previewed, bound to the digest the person confirmed. */
export function decisionAnswersDocument(answers: DecisionAnswers, digest: string): Record<string, unknown> {
  if (!DIGEST.test(digest)) throw new Error('The decision list has no digest to confirm.');
  const chosen = <T>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([item]) => answers.choose[item]));
  return { choose: { ...answers.choose }, reason: chosen(answers.reason), expires: chosen(answers.expires), cause: chosen(answers.cause),
    ...(Object.keys(answers.clause ?? {}).length ? { clause: chosen(answers.clause!) } : {}), ...(Object.keys(answers.article ?? {}).length ? { article: chosen(answers.article!) } : {}), confirm: digest };
}

/**
 * The confirmation page for a preview: the engine's own summary, what is not the person's to
 * decide, and the exact record command with the list's digest. Null when nothing would be recorded.
 */
export function decisionConfirmationRequest(packet: DecisionPacket, preview: DecisionPreview): ReviewConfirmationRequest | null {
  if (!preview.record?.command || !preview.steps.length) return null;
  const lines = [...preview.summary];
  if (preview.refused.length) {
    lines.push('', 'Not recorded, because it is not yours to decide:');
    for (const entry of preview.refused) lines.push(`${entry.item}. ${entry.title ?? ''}: ${entry.words ?? ''} Share this with them: ${entry.share ?? `/sf-decide ${packet.workId}`}`);
  }
  lines.push('', 'The exact command, bound to the list you reviewed:', preview.record.command,
    '', 'The list is read again when you confirm. If it changed, nothing is recorded and the current list is shown.');
  const count = preview.steps.length;
  return {
    title: `Record ${count} decision${count === 1 ? '' : 's'} for ${packet.workId}`,
    summary: `${packet.headline} Each choice is written as the record its own command writes, under your approval group.`,
    detail: lines.join('\n'),
    confirmLabel: count === 1 ? 'Record this decision' : 'Record these decisions'
  };
}

/** Why a preview records nothing, in plain words. */
export function decisionPreviewEmptyReason(packet: DecisionPacket, preview: DecisionPreview): string {
  if (preview.refused.length) {
    return `Nothing would be recorded: you may not decide what you chose. ${preview.refused
      .map((entry) => `${entry.title ?? entry.item}: ${entry.words ?? ''} Share this with them: ${entry.share ?? `/sf-decide ${packet.workId}`}`).join(' ')}`;
  }
  return 'Nothing would be recorded. Choose an option for at least one item.';
}

function refusalOf(result: unknown): { code: string | null; message: string; details: Record<string, unknown> } | null {
  const error = object(object(result)?.error);
  if (!error) return null;
  return { code: typeof error.code === 'string' ? error.code : null, message: text(error.message) ?? '', details: object(error.details) ?? {} };
}

function recordedWords(entries: unknown): string[] {
  return (Array.isArray(entries) ? entries : []).flatMap((value) => {
    const entry = object(value);
    return entry && typeof entry.item === 'string' ? [`${entry.item}: ${String(entry.record ?? entry.kind ?? '')}`.trim()] : [];
  });
}

/**
 * What a record attempt did, from its result or its refusal: recorded; the list changed (with the
 * fresh list, so the page shows it); recorded part way (what was written and what remains); not the
 * person's to decide; or failed. `failure` is the CLI's structured refusal (CliError.result).
 */
export function decisionRecordOutcome(result: unknown, failure: { message: string; result?: unknown } | null = null): {
  outcome: DecisionListOutcome; packet: DecisionPacket | null;
} {
  if (!failure) {
    const data = object(object(result)?.data) ?? object(result) ?? {};
    const recorded = recordedWords(data.recorded);
    const refused = (Array.isArray(data.refused) ? data.refused : []).map((value) => object(value)).filter(Boolean)
      .map((entry) => `${entry!.item}: ${entry!.words ?? ''}`.trim());
    const remaining = (Array.isArray(data.remaining) ? data.remaining : []).map((value) => object(value)).filter(Boolean)
      .map((entry) => `${entry!.id}: ${entry!.title ?? ''}`.trim());
    // A draft is a file written, not a record: said apart, with where it is and what is next.
    const drafted = (Array.isArray(data.drafted) ? data.drafted : []).map((value) => object(value)).filter(Boolean)
      .map((entry) => `${entry!.item}: drafted at ${String(entry!.path ?? '')}. ${String(object(entry!.next)?.words ?? '')}`.trim());
    const recordLine = recorded.length || !drafted.length ? `Recorded ${recorded.length} record${recorded.length === 1 ? '' : 's'} from your choices.` : '';
    const draftLine = drafted.length ? `Drafted ${drafted.length === 1 ? 'the amendment' : `${drafted.length} amendments`}; a draft is not a record, and nothing is decided until it is proposed and approved.` : '';
    return {
      outcome: { kind: 'recorded', message: `${[recordLine, draftLine].filter(Boolean).join(' ')}${refused.length ? ` Not recorded (not yours to decide): ${refused.join('; ')}.` : ''}`,
        recorded, remaining, decided: (Array.isArray(data.decided) ? data.decided : []).map((value) => object(value)?.words).filter((words): words is string => typeof words === 'string'),
        ...(drafted.length ? { drafted } : {}) },
      packet: null
    };
  }
  const refusal = refusalOf(failure.result);
  const message = refusal?.message || failure.message;
  if (refusal?.code === 'DECISIONS_PACKET_CHANGED') {
    return {
      outcome: { kind: 'stale', message: 'The decision list changed since you reviewed it, so nothing was recorded. This is the current list; choose again.', recorded: [], remaining: [] },
      packet: decisionPacketFrom(refusal.details.packet ?? null)
    };
  }
  if (refusal?.code === 'DECISIONS_PARTLY_RECORDED') {
    const remaining = (Array.isArray(refusal.details.remaining) ? refusal.details.remaining : []).map((value) => object(value)).filter(Boolean)
      .map((entry) => `${entry!.item}: ${entry!.words ?? entry!.kind ?? ''}`.trim());
    return { outcome: { kind: 'partial', message, recorded: recordedWords(refusal.details.recorded), remaining }, packet: null };
  }
  if (refusal?.code === 'DECISIONS_NOT_YOURS') return { outcome: { kind: 'not-yours', message, recorded: [], remaining: [] }, packet: null };
  return { outcome: { kind: 'failed', message, recorded: [], remaining: [] }, packet: null };
}

/** Human witness orchestration. Tool input selects a review; only native UI supplies answers. */

export interface WitnessReviewTarget { workId: string; criterion?: string; slot?: string }
export interface WitnessReviewChoice {
  clauseId: string; clauseText?: string | null; slot: string; method: string; files: string[]; contextBinding: string;
}
export interface WitnessReviewHost {
  read(): Promise<DecisionPacket>;
  choose(choices: WitnessReviewChoice[]): Promise<WitnessReviewChoice | undefined>;
  file(repository: string, files: string[]): Promise<string | undefined>;
  digest(repository: string, file: string): Promise<string>;
  inspect(repository: string, file: string): Promise<void>;
  answer(question: string): Promise<boolean | undefined>;
  reason(): Promise<string | undefined>;
  confirm(detail: string): Promise<boolean>;
  record(repository: string, argv: string[]): Promise<unknown>;
}
export const WITNESS_QUESTIONS = [
  ['states-the-outcome', 'Does this file show the acceptance criterion’s observable outcome?'],
  ['matches-the-criterion', 'Does the evidence match the acceptance criterion as written?'],
  ['current-for-this-change', 'Is this evidence current for this change?']
] as const;

export function witnessReviewChoices(packet: DecisionPacket): WitnessReviewChoice[] {
  const seen = new Set<string>();
  return packet.items.flatMap(item => item.options.filter(option => option.decidedBy.allowed).flatMap(option => {
    const review = option.action?.humanReview;
    if (!review || review.kind !== 'witness' || !/^sha256:[a-f0-9]{64}$/u.test(review.contextBinding ?? '')) return [];
    const key = `${review.clauseId}\0${review.slot}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [review];
  }));
}

/** No selection, answer or reason ever arrives from Copilot. Closing any native prompt cancels. */
export async function runWitnessReview(target: WitnessReviewTarget, host: WitnessReviewHost) {
  if (typeof target.workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(target.workId)
      || target.criterion && !/^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u.test(target.criterion)
      || target.slot && !/^[A-Za-z0-9._-]{1,128}$/u.test(target.slot)) throw new Error('Select an exact Story, acceptance criterion and witness slot.');
  const packet = await host.read();
  if (packet.workId !== target.workId || !packet.repositoryPath) throw new Error('The witness review has no verified Story checkout.');
  const choices = witnessReviewChoices(packet).filter(entry => (!target.criterion || entry.clauseId === target.criterion) && (!target.slot || entry.slot === target.slot));
  if (!choices.length) return { status: 'unavailable', message: 'No pending witness review is available to your identity for this selection. Refresh Decisions for the current status and approval authority.' };
  const review = choices.length === 1 ? choices[0]! : await host.choose(choices);
  if (!review) return { status: 'cancelled', message: 'No witness was recorded.' };
  const repository = packet.repositoryPath;
  const file = await host.file(repository, review.files);
  if (!file) return { status: 'cancelled', message: 'No witness was recorded.' };
  const digest = await host.digest(repository, file);
  await host.inspect(repository, file);
  const answers: Array<[string, boolean]> = [];
  for (const [id, question] of WITNESS_QUESTIONS) {
    const answer = await host.answer(`${review.clauseId} · ${review.slot}: ${question}`);
    if (answer === undefined) return { status: 'cancelled', message: 'No witness was recorded.' };
    answers.push([id, answer]);
  }
  const reason = (await host.reason())?.trim();
  if (!reason) return { status: 'cancelled', message: 'No witness was recorded.' };
  if (reason.length < 10 || reason.length > 1000) throw new Error('Describe what you inspected in 10 to 1000 characters.');
  const detail = [`Story: ${target.workId}`, `Criterion: ${review.clauseId}`, ...(review.clauseText ? [`Approved criterion: ${review.clauseText}`] : []), `Slot: ${review.slot} (${review.method})`,
    `File: ${file}`, `File SHA-256: ${digest}`, `Candidate binding: ${review.contextBinding}`,
    ...answers.map(([id, answer]) => `${id}: ${answer ? 'yes' : 'no'}`), `Your reason: ${reason}`].join('\n');
  if (!await host.confirm(detail)) return { status: 'cancelled', message: 'No witness was recorded.' };
  const fresh = await host.read();
  const current = witnessReviewChoices(fresh).find(entry => entry.clauseId === review.clauseId && entry.slot === review.slot);
  if (fresh.workId !== target.workId || fresh.repositoryPath !== repository || current?.contextBinding !== review.contextBinding
      || await host.digest(repository, file) !== digest) throw new Error('The candidate, evidence or pending review changed while you inspected it. Nothing was recorded; reopen the current review.');
  const result = await host.record(repository, ['decision', 'witness', '--work-id', target.workId, '--criterion', review.clauseId,
    '--slot', review.slot, '--file', file, '--reason', reason, '--expected-context-sha256', review.contextBinding,
    '--expected-file-sha256', digest, ...answers.flatMap(([id, answer]) => [answer ? '--confirm' : '--deny', id]), '--json']);
  return { status: 'recorded', result };
}
