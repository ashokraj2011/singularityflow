/**
 * Which answers matched SFlow's recommendation [owner, 2026-11-19, Q13]: the data that shows which questions could be
 * settled for the person, and which settled ones should go back to being asked.
 *
 * `workflow.adviceOutcomes` is append-only, one entry per answered item, written in the same Story commit as the decision
 * it describes (the decision's transaction appends it: story-publication-store.mjs `decisionAdvice`). An entry holds no
 * free text, no file contents and no actor; the decision's own record keeps those. It is no person record: SF Guard does
 * not sign it, and it decides nothing.
 *
 *   { id: 'ADV-001', kind: 'departure', subject: 'DEP-002', phase, recommended: { form, option }, chosen: { option, outcome },
 *     matched: true | false | null, reason: 'typed' | 'recommendation' | 'default' | 'none', surface, record: 'DDC-004', at }
 *
 * Reading it never changes anything: `adviceLearning` lists candidates, and retiring a question is always a code change
 * to the settle rules (SETTLED_KINDS, out-of-plan-classes.mjs) that the owner approves. Data never changes behaviour by
 * itself. A default draws more choices by itself, so a high match rate partly measures the default; reversals decide.
 * None of this is telemetry: nothing leaves the repository's own records.
 */

const FORMS = Object.freeze(['option', 'first', 'lean', 'check', 'none']);
const REASONS = Object.freeze(['typed', 'recommendation', 'default', 'none']);
export const ADVICE_SURFACES = Object.freeze(['card', 'terminal', 'chat', 'command']);
// The thresholds the owner approved [2026-11-19]: a candidate to settle, and a settled kind to ask again.
export const LEARNING_THRESHOLDS = Object.freeze({ answers: 20, stories: 5, matched: 0.95, undone: 0.1 });

const word = (value, maximum = 80) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : null);

/** One entry as it is kept: only the named fields, each bounded. */
function cleaned(entry) {
  const form = FORMS.includes(entry?.recommended?.form) ? entry.recommended.form : 'none';
  return {
    kind: word(entry?.kind, 64) ?? 'unknown', subject: word(entry?.subject, 300), phase: word(entry?.phase, 120),
    recommended: { form, option: word(entry?.recommended?.option, 64) },
    chosen: { option: word(entry?.chosen?.option, 64), outcome: word(entry?.chosen?.outcome, 32) },
    matched: typeof entry?.matched === 'boolean' ? entry.matched : null,
    reason: REASONS.includes(entry?.reason) ? entry.reason : 'none'
  };
}

/** The record a decision wrote, by its ID (DDC-004, PAM-003, UPD-002 ...), from what its writer returned; null when none. */
export function recordIdOf(value) {
  const candidates = [value?.id, value?.record?.id, value?.amendment?.id, value?.decision?.id, value?.undo?.id];
  return candidates.find((id) => typeof id === 'string' && /^[A-Z]{2,5}-[0-9]{3,}$/u.test(id)) ?? null;
}

/** Append one entry per answered item. Pure: the decision's own transaction commits it. */
export function appendAdviceOutcomes(workflow, entries, { surface, record = null, at }) {
  workflow.adviceOutcomes ??= [];
  const added = [];
  for (const entry of entries ?? []) {
    const kept = { id: `ADV-${String(workflow.adviceOutcomes.length + 1).padStart(3, '0')}`, ...cleaned(entry),
      surface: ADVICE_SURFACES.includes(surface) ? surface : 'command', ...(record ? { record } : {}), at };
    workflow.adviceOutcomes.push(kept);
    added.push(kept);
  }
  return added;
}

/**
 * Write `entries` with the next Story transaction `write` makes, in that same commit. The transaction is the decision's:
 * nothing else is written in its place, and when it fails nothing is kept.
 */
export async function withAdvice(entries, { surface, at = null } = {}, write) {
  const kept = (entries ?? []).filter(Boolean);
  if (!kept.length) return write();
  const { decisionAdvice } = await import('./story-publication-store.mjs');
  return decisionAdvice.run({ written: false, append: (workflow, value) => appendAdviceOutcomes(workflow, kept,
    { surface, record: recordIdOf(value), at: at ?? new Date().toISOString() }) }, write);
}

/**
 * Whether a later record took an answer back: a departure accepted and then reopened or rejected, a decision made again
 * on the same item, or the answer's step sent back by its review after it.
 */
function reversed(workflow, entry) {
  const later = (workflow.adviceOutcomes ?? []).filter((other) => other.kind === entry.kind && other.subject && other.subject === entry.subject
    && String(other.at) > String(entry.at));
  if (later.some((other) => other.chosen?.option !== entry.chosen?.option)) return true;
  if (entry.kind === 'departure' && entry.subject) {
    if ((workflow.departures ?? []).some((departure) => departure.supersedes === entry.subject && String(departure.at) > String(entry.at))) return true;
  }
  const phase = entry.phase;
  return Boolean(phase) && (workflow.history ?? []).some((event) => event.phase === phase && String(event.at) > String(entry.at)
    && /^(?:phase_rejected|rejected|returned|phase_returned)$/u.test(String(event.event ?? '')));
}

/** Every settlement of each kind, and how many a person undid. */
function settledCounts(workflow) {
  const list = workflow.settledDecisions ?? [];
  const undone = new Set(list.filter((entry) => entry.undoes).map((entry) => entry.undoes));
  const counts = new Map();
  for (const entry of list.filter((item) => !item.undoes)) {
    const key = entry.kind === 'plan-accounting' && entry.effect?.class ? `${entry.kind} (${entry.effect.class})` : entry.kind;
    const known = counts.get(key) ?? { kind: key, settled: 0, undone: 0 };
    known.settled += 1;
    if (undone.has(entry.id)) known.undone += 1;
    counts.set(key, known);
  }
  return [...counts.values()];
}

const percent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/**
 * What the answers say, across the Stories given (their workflows): by kind, recommendation form and recommended option,
 * how many answers, from how many Stories, how many matched, and how many were later taken back; then the candidates. Pure.
 */
export function adviceLearning(workflows, thresholds = LEARNING_THRESHOLDS) {
  const groups = new Map();
  for (const workflow of workflows ?? []) {
    const story = workflow?.workItem?.id ?? null;
    for (const entry of workflow?.adviceOutcomes ?? []) {
      const key = `${entry.kind}\u0000${entry.recommended?.form ?? 'none'}\u0000${entry.recommended?.option ?? ''}`;
      const group = groups.get(key) ?? { kind: entry.kind, form: entry.recommended?.form ?? 'none', option: entry.recommended?.option ?? null,
        answers: 0, stories: new Set(), matched: 0, reversed: 0, typed: 0 };
      group.answers += 1;
      if (story) group.stories.add(story);
      if (entry.matched === true) group.matched += 1;
      if (entry.reason === 'typed') group.typed += 1;
      if (reversed(workflow, entry)) group.reversed += 1;
      groups.set(key, group);
    }
  }
  const rows = [...groups.values()].map((group) => ({ kind: group.kind, form: group.form, option: group.option, answers: group.answers,
    stories: group.stories.size, matched: group.matched, matchedPercent: group.option ? percent(group.matched, group.answers) : null,
    reversed: group.reversed, typed: group.typed }))
    .sort((left, right) => right.answers - left.answers || left.kind.localeCompare(right.kind));
  const settled = new Map();
  for (const workflow of workflows ?? []) {
    for (const entry of settledCounts(workflow)) {
      const known = settled.get(entry.kind) ?? { kind: entry.kind, settled: 0, undone: 0 };
      known.settled += entry.settled;
      known.undone += entry.undone;
      settled.set(entry.kind, known);
    }
  }
  const settledRows = [...settled.values()].map((entry) => ({ ...entry, undonePercent: percent(entry.undone, entry.settled) }));
  return {
    stories: (workflows ?? []).length, rows, settled: settledRows, thresholds,
    toSettle: rows.filter((row) => row.option && row.answers >= thresholds.answers && row.stories >= thresholds.stories
      && row.matched / row.answers >= thresholds.matched && row.reversed === 0),
    toAsk: settledRows.filter((row) => row.settled > 0 && row.undone / row.settled >= thresholds.undone),
    rule: 'Retiring a question, or asking a settled one again, is a code change the owner approves; these numbers decide nothing by themselves.'
  };
}

/** The report in plain lines, for a terminal. */
export function adviceLearningLines(report) {
  const lines = [`Answers from ${report.stories} ${report.stories === 1 ? 'Story' : 'Stories'}, by what SFlow recommended:`];
  if (!report.rows.length) lines.push('  No answer is recorded yet.');
  for (const row of report.rows) {
    const what = row.option ? `${row.kind}, recommended ${row.option}` : `${row.kind}, ${row.form === 'none' ? 'no recommendation' : `a ${row.form}`}`;
    lines.push(`  ${what}: ${row.answers} ${row.answers === 1 ? 'answer' : 'answers'} in ${row.stories} ${row.stories === 1 ? 'Story' : 'Stories'}`
      + `${row.matchedPercent === null ? '' : `, ${row.matchedPercent}% followed it`}, ${row.reversed} taken back later, ${row.typed} with a typed reason.`);
  }
  if (report.settled.length) {
    lines.push('Settled for the person, and undone:');
    for (const row of report.settled) lines.push(`  ${row.kind}: ${row.settled} settled, ${row.undone} undone (${row.undonePercent}%).`);
  }
  lines.push(report.toSettle.length ? `Could be settled (at least ${report.thresholds.answers} answers in ${report.thresholds.stories} Stories, ${report.thresholds.matched * 100}% followed, none taken back): ${report.toSettle.map((row) => `${row.kind} ${row.option}`).join(', ')}.`
    : 'Nothing is ready to be settled yet.');
  if (report.toAsk.length) lines.push(`Could be asked again (undone ${report.thresholds.undone * 100}% of the time or more): ${report.toAsk.map((row) => row.kind).join(', ')}.`);
  lines.push(report.rule);
  return lines;
}
