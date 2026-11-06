/**
 * The convergence decisions as Copilot CLI forms: a table, Accept all, then each item that is left.
 * The same `story adjudications` list and `story adjudicate --answers` write as the VS Code page, and
 * what a person enters is the only input. Pure, so a test can read every word without Copilot.
 */
import { askUntilRight, refusedWords, textField } from './form-rounds.mjs';

export const LEAVE = 'Leave undecided';
export const KEEP = 'Keep what the plan says';
export const OVERRULE = 'Overrule a row the plan settled';
export const FORM_SIZE = 5;
const REASON_LIMIT = 1000;

const cell = (value) => String(value ?? '').replace(/[\r\n]+/gu, ' ').replaceAll('|', '\\|');
export const itemName = (item) => item.paths?.join(', ') || item.clauseIds?.join(', ') || item.detail || item.id;

export function planWords(plan) {
  if (!plan) return 'Not in the plan';
  const source = plan.kind === 'amendment' ? `${plan.id ?? 'Amendment'}${plan.clause ? ` under ${plan.clause}` : ''}` : 'Supporting file';
  return `${source}${plan.text ? `: ${plan.text}` : ''}${plan.askedBecause ? ` · Still asked: ${plan.askedBecause}.` : ''}`;
}

const label = (list, id) => list.dispositions.find((entry) => entry.id === id)?.label ?? id;

// A person may change an answer; the one it replaced stays in sight, with whose it was.
const decided = (list, decision) => [label(list, decision.disposition),
  ...(decision.replaced ?? []).map((answer) => `changed from ${label(list, answer.disposition)} by ${answer.actor}`)].join(', ');

/** The rows a person is asked: a group's items read as one, at the place of its first. Each is still recorded by name. */
export function decisionRows(list) {
  const seen = new Set();
  return list.items.flatMap((item) => {
    if (!item.group) return [item];
    if (seen.has(item.group)) return [];
    seen.add(item.group);
    const members = list.items.filter((entry) => entry.group === item.group);
    return [{ ...item, ids: members.map((entry) => entry.id), paths: members.flatMap((entry) => entry.paths) }];
  });
}
const rowName = (item) => `${item.ids ? 'Test setup: ' : ''}${itemName(item)}`;

export function decisionsTable(list) {
  const rows = decisionRows(list).map((item) => `| ${cell(rowName(item))} | ${cell(item.ids ? list.groupWords?.[item.group] ?? planWords(item.plan) : planWords(item.plan))} | ${cell(item.decision ? decided(list, item.decision) : 'Undecided')} |`);
  // Settled rows are never a question, and a reader still sees each one and the entry that answered it.
  const settled = (list.settled ?? []).map((item) => `| ${cell(itemName(item))} | ${cell(planWords(item.settledBy))} | ${cell(item.decision ? decided(list, item.decision) : 'Settled by the plan')} |`);
  return [`**Decide ${list.workId} · ${list.phase}.** ${list.decidedBy?.words ?? ''} ${list.open} of ${list.items.length} still need a decision.${settled.length ? ` ${settled.length} settled by the plan, not asked.` : ''}`, '',
    '| What changed | What the plan already says | Decision |', '|---|---|---|', ...rows, ...settled].join('\n');
}

/** One reason may cover only changed files no requirement claims, and only ones still open. */
export const acceptable = (list) => list.items.filter((item) => item.acceptAll && !item.decision);

/** Rows the approved plan answered, as rows a person may still answer: an overrule is the same write as any other. */
export const settledRows = (list) => (list.settled ?? []).map((item) => ({ ...item, plan: item.settledBy }));

export function firstForm(list) {
  const count = acceptable(list).length;
  const yes = `Accept all ${count} changed file${count === 1 ? '' : 's'} with one reason`;
  const properties = { choice: { type: 'string', title: 'How do you want to decide?', enum: [...(count ? [yes] : []), ...(list.open ? ['Decide each one'] : []), ...(settledRows(list).length ? [OVERRULE] : []), 'Not now'] } };
  return { yes, form: { message: `${list.open} of ${list.items.length} still need a decision.`, requestedSchema: { type: 'object', required: ['choice'], properties } } };
}

/** The one reason accepting them all needs. */
export function acceptAllForm(list) {
  const count = acceptable(list).length;
  return { message: `Accept all ${count} changed file${count === 1 ? '' : 's'}.`, requestedSchema: { type: 'object', required: ['reason'],
    properties: { reason: textField('One reason for accepting all of them', { minimum: 1, maximum: REASON_LIMIT }) } } };
}

/** Each row's choice, and nothing else: what a choice needs is asked once it is chosen. */
export function rowForms(list, items) {
  const pages = [];
  for (let at = 0; at < items.length; at += FORM_SIZE) pages.push(items.slice(at, at + FORM_SIZE));
  const words = list.dispositions.map((entry) => entry.label);
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}). What a choice needs is asked next.`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.map((item, row) =>
      [`decision${row}`, { type: 'string', title: `${rowName(item)}: ${item.ids ? 'one change, one decision' : planWords(item.plan)}`.slice(0, 200), enum: [item.settledBy ? KEEP : LEAVE, ...words] }])) } } }));
}

/** The second form of a choice: its reason, and the clauses only for what changes the spec. Null when it needs neither. */
export function detailForm(list, item, disposition) {
  const clauses = disposition === 'update-intent';
  if (disposition === 'rework' && !clauses) return null;
  return { message: `${rowName(item)}: ${label(list, disposition)}.`, requestedSchema: { type: 'object', required: ['reason', ...(clauses ? ['clauses'] : [])], properties: {
    reason: textField(`Reason for ${rowName(item)}`, { minimum: 1, maximum: REASON_LIMIT }),
    ...(clauses ? { clauses: { type: 'string', minLength: 1, title: `Clauses that should change for ${rowName(item)}, separated by commas`.slice(0, 200) } } : {}) } } };
}

/** The rows a person chose on one form, or what is wrong with them. Nothing here is chosen for the person. */
export function choicesFromRows(list, items, content) {
  const byLabel = new Map(list.dispositions.map((entry) => [entry.label, entry.id]));
  const picks = [];
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    if (!word || word === LEAVE || word === KEEP) continue;
    const disposition = byLabel.get(word);
    if (!disposition) return { picks: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    picks.push({ item, disposition });
  }
  return { picks, problem: null };
}

/** One choice's answers from its second form, or what is wrong with them. */
export function valuesFromForm(item, disposition, content) {
  const reason = String(content?.reason ?? '').trim();
  if (!reason && disposition !== 'rework') return { problem: `Give a reason for ${itemName(item)}.` };
  const clauseIds = String(content?.clauses ?? '').split(/[\s,]+/u).filter(Boolean);
  if (disposition === 'update-intent' && !clauseIds.length) return { problem: `Name the clauses that should change for ${itemName(item)}.` };
  return { reason, clauseIds: disposition === 'update-intent' ? clauseIds : [], problem: null };
}

export const acceptAllAnswers = (list, reason) => acceptable(list).map((item) => ({ itemId: item.id, disposition: 'accepted-deviation', reason, clauseIds: [] }));

export const RECORD = 'Record these decisions';

export function confirmForm(list, answers) {
  const named = new Map([...list.items, ...settledRows(list)].map((item) => [item.id, itemName(item)]));
  const left = list.items.filter((item) => !item.decision && !answers.some((answer) => answer.itemId === item.id));
  const lines = answers.map((answer) => `${named.get(answer.itemId)}: ${label(list, answer.disposition)}${answer.clauseIds.length ? ` (${answer.clauseIds.join(', ')})` : ''}${answer.reason ? `. Reason: ${answer.reason}` : ''}`);
  return { message: [`Record ${answers.length} decision${answers.length === 1 ? '' : 's'} on ${list.workId}, each under your name:`, ...lines,
    ...(left.length ? [`Still undecided: ${left.map(itemName).join(', ')}`] : [])].join('\n'),
  requestedSchema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', title: 'I reviewed this exact change', enum: [RECORD, 'Not now'] } } } };
}

/**
 * The whole conversation with one person. `ui.ask(form)` answers `{ action, content }`, `ui.show(text)`
 * prints, `ui.read()` reads the list, `ui.record(list, answers)` writes it. The caller passes these
 * in, so a test can run every route and no route can be answered by anything but `ask`.
 */
export async function runDecisions({ ask, show, read, record, askedInChat = false }) {
  const list = await read();
  if (list.status !== 'open') return { status: list.status, message: list.message ?? 'There is nothing to decide here.' };
  await show(decisionsTable(list));
  // A chat that asked carries on when nothing is open: only a person who opened this table overrules the plan.
  if (!list.open && (askedInChat || !settledRows(list).length)) return { status: 'nothing-open', recorded: [], unchanged: [], remaining: [], message: 'Nothing here needs a decision.' };
  if (!list.decidedBy?.allowed) return { status: 'not-allowed', message: list.decidedBy?.words ?? 'You are not an approver of this step.' };
  const notNow = { status: 'cancelled', message: 'No decision was recorded.' };
  const refused = (problem) => ({ status: 'refused', message: refusedWords(problem) });
  let answers = [];
  const { yes, form } = firstForm(list);
  const first = await askUntilRight(ask, form, (content) => (form.requestedSchema.properties.choice.enum.includes(content.choice) ? { choice: content.choice } : { problem: 'Choose one of these.' }));
  if (first.cancelled || first.choice === 'Not now') return notNow;
  if (first.refused) return refused(first.refused);
  const overruling = first.choice === OVERRULE ? settledRows(list) : [];
  if (first.choice === yes) {
    const one = await askUntilRight(ask, acceptAllForm(list), (content) => {
      const reason = String(content.reason ?? '').trim();
      return reason ? { reason } : { problem: 'Give one reason for accepting them all, or close this and decide each one.' };
    });
    if (one.cancelled) return notNow;
    if (one.refused) return refused(one.refused);
    answers = acceptAllAnswers(list, one.reason);
  }
  const taken = new Set(answers.map((answer) => answer.itemId));
  for (const page of rowForms(list, [...overruling, ...decisionRows(list).filter((item) => !item.decision && !taken.has(item.id))])) {
    const chosen = await askUntilRight(ask, page.form, (content) => choicesFromRows(list, page.items, content));
    if (chosen.cancelled) return notNow;
    if (chosen.refused) return refused(chosen.refused);
    for (const { item, disposition } of chosen.picks) {
      const details = detailForm(list, item, disposition);
      const given = details ? await askUntilRight(ask, details, (content) => valuesFromForm(item, disposition, content)) : { reason: '', clauseIds: [] };
      if (given.cancelled) return notNow;
      if (given.refused) return refused(given.refused);
      for (const id of item.ids ?? [item.id]) answers.push({ itemId: id, disposition, reason: given.reason, clauseIds: given.clauseIds });
    }
  }
  if (!answers.length) return { status: 'cancelled', message: 'No row was given a decision, so nothing was recorded.' };
  const confirmed = await ask(confirmForm(list, answers));
  if (confirmed?.action !== 'accept' || confirmed.content?.confirm !== RECORD) return notNow;
  const result = await record(list, answers);
  const remaining = result.remaining ?? [];
  return { status: 'recorded', recorded: result.recorded ?? [], unchanged: result.unchanged ?? [], remaining, next: result.next,
    message: `${(result.recorded ?? []).length} recorded.${remaining.length ? ` ${remaining.length} still need a decision.` : ' All decided.'}` };
}
