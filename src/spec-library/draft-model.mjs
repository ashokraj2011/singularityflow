/**
 * What a specification draft holds, and the pure changes each `spec author` command makes to it
 * (SPEC-SPA v1.3 §2, §4.3, §5).
 *
 * A draft is `{ title, basedOn, areas, spec, gaps, research, checklist }`:
 * - `spec` is the Markdown prose, the only text a Story ever receives;
 * - `gaps` is the append-only gap event list (opened, decided, deferred, reopened);
 * - `research` is the cited facts the specification relies on (research.mjs builds code items);
 * - `checklist` is the person's decisions on the analyzer's starter checklist articles.
 * Nothing here reads files, Git or a model.
 */
import { CHECKLIST_DECISIONS, STARTER_CHECKLIST } from '../engine-compatibility/node-specification-policy.mjs';
import { canonicalJson } from '../foundation/record-schema.mjs';
import { SingularityFlowError } from '../util.mjs';
import { formatGapId, GAP_ID, nextNumber } from './ids.mjs';

export const TEMPLATE_SECTIONS = Object.freeze([
  'Outcome', 'Actors', 'User scenarios', 'Scope', 'Requirements', 'Acceptance', 'Decisions and open questions'
]);
export const GAP_KINDS = Object.freeze(['code-disagrees', 'missing-unwanted-path', 'vague-term', 'missing-boundary', 'open-question']);
export const CHECKLIST_ARTICLES = Object.freeze(STARTER_CHECKLIST.articles.map((article) => article.id));
export const MAXIMUM_OPTIONS = 4;
const OPTION_ID = /^O[1-9]$/u;

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const text = (value) => String(value ?? '').trim();
const who = (actor) => (actor ? { name: actor.name ?? null, email: actor.email ?? null } : null);

/** A publication acknowledges only its reviewed content; newer local writing stays unreviewed. */
export function publicationContinuation(current, reviewed, basedOn) {
  return { ...current, basedOn: { ...basedOn,
    ...(canonicalJson(current) !== canonicalJson(reviewed) ? { pendingChanges: true } : {}) } };
}

/** The library template: every required section, one literal anchor per clause kind it starts with. */
export function specTemplate(specId, title, intent = '') {
  return `# ${title}

## Outcome

${text(intent) || 'TODO: what is true for the people this serves once it is delivered.'}

## Actors

- TODO: who uses or is affected by this behaviour.

## User scenarios

1. TODO: one concrete scenario, start to finish.

## Scope

In scope: TODO. Out of scope: TODO.

## Requirements

WHEN TODO, the TODO SHALL TODO. [${specId}:REQ-001]

## Acceptance

TODO: an observable result that proves REQ-001. [${specId}:AC-001]

## Decisions and open questions

TODO: state each decided or deferred gap here by its ID and its outcome.
`;
}

export const SPEC_KINDS = Object.freeze(['business', 'technical']);
export function normalizeSpecKind(kind) {
  if (kind == null || kind === '') return null;
  if (!SPEC_KINDS.includes(kind)) fail('Choose Business needs or Technical details.', 'SPEC_KIND_INVALID');
  return kind;
}

export function newDraft({ title, spec, areas = [], kind = null }) {
  return { title: text(title), kind: normalizeSpecKind(kind), basedOn: null, areas: [...new Set(areas)].sort(), spec, gaps: [], research: [], checklist: [] };
}

/** Each gap's current state from its events, in ID order. */
export function foldGaps(events = []) {
  const gaps = new Map();
  for (const event of events) {
    if (event.event === 'opened') {
      gaps.set(event.gap, { id: event.gap, kind: event.kind, question: event.question, evidence: event.evidence ?? [],
        clauses: event.clauses ?? [], options: event.options ?? [], openedBy: event.by, openedAt: event.at,
        status: 'open', decision: null, deferral: null, history: [event] });
      continue;
    }
    const gap = gaps.get(event.gap);
    if (!gap) continue;
    gap.history.push(event);
    if (event.event === 'decided') { gap.status = 'decided'; gap.decision = event; gap.deferral = null; }
    else if (event.event === 'deferred') { gap.status = 'deferred'; gap.deferral = event; gap.decision = null; }
    else if (event.event === 'reopened') { gap.status = 'open'; }
  }
  return [...gaps.values()].sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
}

function requireGap(draft, gapId) {
  if (!GAP_ID.test(String(gapId ?? ''))) fail(`'${gapId ?? ''}' is not a gap ID; gaps are named GAP-001, GAP-002 and so on.`, 'SPEC_GAP_UNKNOWN', { gap: gapId ?? null });
  const gap = foldGaps(draft.gaps).find((entry) => entry.id === gapId);
  if (!gap) fail(`${gapId} is not a gap of this draft.`, 'SPEC_GAP_UNKNOWN', { gap: gapId });
  return gap;
}

/** Validate up to four options: `[{ id?, wording, changesCode? }]`. */
export function normalizeOptions(options = []) {
  if (!Array.isArray(options)) fail('Gap options must be a list of { wording, changesCode } entries.', 'SPEC_GAP_OPTIONS_INVALID');
  if (options.length > MAXIMUM_OPTIONS) fail(`A gap has at most ${MAXIMUM_OPTIONS} options; got ${options.length}.`, 'SPEC_GAP_OPTIONS_INVALID');
  const seen = new Set();
  return options.map((option, index) => {
    const id = option?.id ?? `O${index + 1}`;
    if (!OPTION_ID.test(id) || seen.has(id)) fail(`Option ${index + 1} has the ID '${id}'; options are O1 to O${MAXIMUM_OPTIONS}, each once.`, 'SPEC_GAP_OPTIONS_INVALID');
    seen.add(id);
    if (!text(option?.wording)) fail(`Option ${id} has no wording: give the clause text the option would put in the specification.`, 'SPEC_GAP_OPTIONS_INVALID');
    if (option.changesCode !== undefined && typeof option.changesCode !== 'boolean') fail(`Option ${id}'s changesCode must be true or false.`, 'SPEC_GAP_OPTIONS_INVALID');
    return { id, wording: text(option.wording), changesCode: option.changesCode ?? true };
  });
}

export function openGap(draft, { kind, question, evidence = [], clauses = [], options = [] }, { actor, at }) {
  if (!GAP_KINDS.includes(kind)) fail(`Gap kind '${kind ?? ''}' is not one of ${GAP_KINDS.join(', ')}.`, 'SPEC_GAP_KIND_INVALID', { kind: kind ?? null });
  if (!text(question)) fail('A gap needs its question.', 'SPEC_GAP_QUESTION_MISSING');
  const known = new Set(draft.research.map((item) => item.id));
  const unknown = evidence.filter((id) => !known.has(id));
  if (unknown.length) fail(`Evidence ${unknown.join(', ')} is not a research item of this draft.`, 'SPEC_GAP_EVIDENCE_UNKNOWN', { evidence: unknown });
  // A code fact that cites nothing (a proposal accepted unverified) supports no gap (§4.2).
  const uncited = evidence.filter((id) => draft.research.some((item) => item.id === id && item.basis === 'code' && !item.citation));
  if (uncited.length) fail(`Evidence ${uncited.join(', ')} cites no code, so it can support no gap; research the code it is about, or remove it.`, 'SPEC_GAP_EVIDENCE_UNVERIFIED', { evidence: uncited });
  const gap = formatGapId(nextNumber(foldGaps(draft.gaps).map((entry) => entry.id), 'GAP-'));
  draft.gaps.push({ event: 'opened', gap, kind, question: text(question), evidence: [...new Set(evidence)],
    clauses: [...new Set(clauses)], options: normalizeOptions(options), by: who(actor), at });
  return { draft, gap };
}

export function decideGap(draft, gapId, { option = null, choice = null, reason }, { actor, at }) {
  const gap = requireGap(draft, gapId);
  if (gap.status !== 'open') fail(`${gapId} is ${gap.status}; reopen it before deciding it again.`, 'SPEC_GAP_NOT_OPEN', { gap: gapId, status: gap.status });
  if (!text(reason)) fail(`Deciding ${gapId} needs a reason: --reason TEXT.`, 'SPEC_DECISION_REASON_MISSING', { gap: gapId });
  let wording = text(choice);
  if (option) {
    const chosen = gap.options.find((entry) => entry.id === option);
    if (!chosen) fail(`${gapId} has no option ${option}; its options are ${gap.options.map((entry) => entry.id).join(', ') || 'none'}.`, 'SPEC_GAP_OPTION_UNKNOWN', { gap: gapId, option });
    wording = chosen.wording;
  }
  if (!wording) fail(`Deciding ${gapId} needs --option ID or --choice TEXT.`, 'SPEC_DECISION_CHOICE_MISSING', { gap: gapId });
  draft.gaps.push({ event: 'decided', gap: gapId, option: option ?? null, choice: wording, reason: text(reason), by: who(actor), at });
  return draft;
}

export function deferGap(draft, gapId, { owner, reason }, { actor, at }) {
  const gap = requireGap(draft, gapId);
  if (gap.status !== 'open') fail(`${gapId} is ${gap.status}; reopen it before deferring it.`, 'SPEC_GAP_NOT_OPEN', { gap: gapId, status: gap.status });
  if (!text(owner) || !text(reason)) fail(`Deferring ${gapId} needs --owner NAME and --reason TEXT.`, 'SPEC_DEFERRAL_INCOMPLETE', { gap: gapId });
  draft.gaps.push({ event: 'deferred', gap: gapId, owner: text(owner), reason: text(reason), by: who(actor), at });
  return draft;
}

export function reopenGap(draft, gapId, { reason }, { actor, at }) {
  const gap = requireGap(draft, gapId);
  if (gap.status === 'open') fail(`${gapId} is already open.`, 'SPEC_GAP_ALREADY_OPEN', { gap: gapId });
  if (!text(reason)) fail(`Reopening ${gapId} needs a reason: --reason TEXT.`, 'SPEC_DECISION_REASON_MISSING', { gap: gapId });
  draft.gaps.push({ event: 'reopened', gap: gapId, reason: text(reason), by: who(actor), at });
  return draft;
}

/** The latest decision on each checklist article. */
export function foldChecklist(events = []) {
  const latest = new Map();
  for (const event of events) latest.set(event.article, event);
  return CHECKLIST_ARTICLES.map((article) => ({ article, decision: latest.get(article) ?? null }));
}

/** `{ completeness: 'satisfied', … }`: an exception or not-applicable needs the reason. */
export function settleArticles(draft, decisions, { reason = null }, { actor, at }) {
  const entries = Object.entries(decisions ?? {});
  if (!entries.length) fail(`Name the articles to settle: --article ARTICLE=DECISION (articles: ${CHECKLIST_ARTICLES.join(', ')}).`, 'SPEC_SETTLE_EMPTY');
  for (const [article, decision] of entries) {
    if (!CHECKLIST_ARTICLES.includes(article)) fail(`'${article}' is not a checklist article; the articles are ${CHECKLIST_ARTICLES.join(', ')}.`, 'SPEC_ARTICLE_UNKNOWN', { article });
    if (!CHECKLIST_DECISIONS.includes(decision)) fail(`'${decision}' is not a checklist decision; use ${CHECKLIST_DECISIONS.join(', ')}.`, 'SPEC_ARTICLE_DECISION_INVALID', { article, decision });
    if (decision !== 'satisfied' && !text(reason)) fail(`Article ${article} is '${decision}', which needs --reason TEXT.`, 'SPEC_DECISION_REASON_MISSING', { article });
  }
  for (const [article, decision] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    draft.checklist.push({ event: 'settled', article, decision, reason: text(reason) || null, by: who(actor), at });
  }
  return draft;
}

/** Explicit derivation coverage. Parent IDs are references, never new anchors in the child. */
export function originCoverage(draft, ownClauseIds) {
  const origins = draft.origins ?? [];
  if (!origins.length) return { rows: [], findings: [] };
  const own = new Set(ownClauseIds);
  const expected = new Set(origins.flatMap(origin => (origin.clauses ?? []).map(clause => clause.id)));
  const rows = [], findings = [];
  const add = (message, clause) => findings.push({ code: 'spec.origin-coverage', message, ...(clause ? { clause } : {}) });
  if (origins.length > 16 || origins.some(origin => !/^SPEC-[A-Z0-9-]+@[1-9]\d*$/u.test(origin.revision ?? '') || !/^sha256:[a-f0-9]{64}$/u.test(origin.manifestSha256 ?? ''))) {
    add('The parent specification references are incomplete. Derive again from an exact reviewed version.');
    return { rows, findings };
  }
  let inCoverage = false;
  for (const line of String(draft.spec).split(/\r?\n/u)) {
    if (/^##\s+/u.test(line)) inCoverage = /^##\s+Business coverage\s*$/iu.test(line);
    if (!inCoverage || !/^\s*\|/u.test(line)) continue;
    const [source, target, reason] = line.trim().replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim().replace(/`/gu, ''));
    if (!/^SPEC-[A-Z0-9-]+:(?:REQ|BEH|IFC|AC|CON)-\d{3,}$/u.test(source)) continue;
    if (!expected.has(source)) { add('Coverage names a requirement outside the pinned parent versions: ' + source, source); continue; }
    if (rows.some(row => row.source === source)) { add('Give one coverage outcome for ' + source, source); continue; }
    const disposition = /^(excluded|deferred)$/iu.test(target) ? target.toLowerCase() : null;
    const targets = disposition ? [] : (target ?? '').split(/[,\s]+/u).filter(Boolean);
    if ((!disposition && (!targets.length || targets.some(id => !own.has(id)))) || !reason || /\bTODO\b/u.test(reason)) {
      add('Map ' + source + ' to this specification’s requirement IDs, or explicitly exclude/defer it, with a reason.', source); continue;
    }
    rows.push({ source, targets, ...(disposition ? { disposition } : {}), reason });
  }
  for (const id of expected) if (!rows.some(row => row.source === id)) add('The technical draft does not account for ' + id + ' in Business coverage.', id);
  return { rows, findings };
}
