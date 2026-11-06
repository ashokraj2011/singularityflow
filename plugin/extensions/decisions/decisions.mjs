/**
 * The convergence decisions as Copilot CLI forms: a table, Accept all, then each item that is left.
 * The same `story adjudications` list and `story adjudicate --answers` write as the VS Code page, and
 * what a person enters is the only input. Pure, so a test can read every word without Copilot.
 */
export const LEAVE = 'Leave undecided';
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

export function decisionsTable(list) {
  const rows = list.items.map((item) => `| ${cell(itemName(item))} | ${cell(planWords(item.plan))} | ${cell(item.decision ? decided(list, item.decision) : 'Undecided')} |`);
  // Settled rows are never a question, and a reader still sees each one and the entry that answered it.
  const settled = (list.settled ?? []).map((item) => `| ${cell(itemName(item))} | ${cell(planWords(item.settledBy))} | ${cell(item.decision ? decided(list, item.decision) : 'Settled by the plan')} |`);
  return [`**Decide ${list.workId} · ${list.phase}.** ${list.decidedBy?.words ?? ''} ${list.open} of ${list.items.length} still need a decision.${settled.length ? ` ${settled.length} settled by the plan, not asked.` : ''}`, '',
    '| What changed | What the plan already says | Decision |', '|---|---|---|', ...rows, ...settled].join('\n');
}

/** One reason may cover only changed files no requirement claims, and only ones still open. */
export const acceptable = (list) => list.items.filter((item) => item.acceptAll && !item.decision);

export function firstForm(list) {
  const count = acceptable(list).length;
  const yes = `Accept all ${count} changed file${count === 1 ? '' : 's'} with one reason`;
  const properties = { choice: { type: 'string', title: 'How do you want to decide?', enum: [...(count ? [yes] : []), 'Decide each one', 'Not now'] },
    ...(count ? { reason: { type: 'string', title: 'Reason for accepting all', maxLength: REASON_LIMIT } } : {}) };
  return { yes, form: { message: `${list.open} of ${list.items.length} still need a decision.`, requestedSchema: { type: 'object', required: ['choice'], properties } } };
}

export function rowForms(list, items) {
  const pages = [];
  for (let at = 0; at < items.length; at += FORM_SIZE) pages.push(items.slice(at, at + FORM_SIZE));
  const words = list.dispositions.map((entry) => entry.label);
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}). Clauses are only for "${label(list, 'update-intent')}".`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.flatMap((item, row) => [
      [`decision${row}`, { type: 'string', title: `${itemName(item)}: ${planWords(item.plan)}`.slice(0, 200), enum: [LEAVE, ...words] }],
      [`reason${row}`, { type: 'string', title: `Reason for ${itemName(item)}`.slice(0, 200), maxLength: REASON_LIMIT }],
      [`clauses${row}`, { type: 'string', title: `Clauses for ${itemName(item)}`.slice(0, 200) }]
    ])) } } }));
}

/** A form's answers, or what is wrong with them. Nothing here is chosen for the person. */
export function answersFromRows(list, items, content) {
  const byLabel = new Map(list.dispositions.map((entry) => [entry.label, entry.id]));
  const answers = [];
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    const reason = String(content?.[`reason${row}`] ?? '').trim();
    if (!word || word === LEAVE) {
      if (reason) return { answers: [], problem: `Choose a decision for ${itemName(item)}, or clear its reason.` };
      continue;
    }
    const disposition = byLabel.get(word);
    if (!disposition) return { answers: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    if (!reason && disposition !== 'rework') return { answers: [], problem: `Give a reason for ${itemName(item)}.` };
    const clauseIds = String(content?.[`clauses${row}`] ?? '').split(/[\s,]+/u).filter(Boolean);
    if (disposition === 'update-intent' && !clauseIds.length) return { answers: [], problem: `Name the clauses that should change for ${itemName(item)}.` };
    answers.push({ itemId: item.id, disposition, reason, clauseIds: disposition === 'update-intent' ? clauseIds : [] });
  }
  return { answers, problem: null };
}

export const acceptAllAnswers = (list, reason) => acceptable(list).map((item) => ({ itemId: item.id, disposition: 'accepted-deviation', reason, clauseIds: [] }));

export const RECORD = 'Record these decisions';

export function confirmForm(list, answers) {
  const named = new Map(list.items.map((item) => [item.id, itemName(item)]));
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
export async function runDecisions({ ask, show, read, record }) {
  const list = await read();
  if (list.status !== 'open') return { status: list.status, message: list.message ?? 'There is nothing to decide here.' };
  await show(decisionsTable(list));
  if (!list.open) return { status: 'nothing-open', recorded: [], unchanged: [], remaining: [], message: 'Nothing here needs a decision.' };
  if (!list.decidedBy?.allowed) return { status: 'not-allowed', message: list.decidedBy?.words ?? 'You are not an approver of this step.' };
  const notNow = { status: 'cancelled', message: 'No decision was recorded.' };
  let answers = [];
  const { yes, form } = firstForm(list);
  for (;;) {
    const first = await ask(form);
    if (first?.action !== 'accept' || first.content?.choice === 'Not now') return notNow;
    if (first.content.choice === 'Decide each one') break;
    const reason = String(first.content.reason ?? '').trim();
    if (first.content.choice === yes && reason) { answers = acceptAllAnswers(list, reason); break; }
    await show('Give one reason for accepting them all, or choose to decide each one.');
  }
  const chosen = new Set(answers.map((answer) => answer.itemId));
  for (const page of rowForms(list, list.items.filter((item) => !item.decision && !chosen.has(item.id)))) {
    for (;;) {
      const reply = await ask(page.form);
      if (reply?.action !== 'accept') return notNow;
      const { answers: entered, problem } = answersFromRows(list, page.items, reply.content);
      if (problem) { await show(problem); continue; }
      answers.push(...entered);
      break;
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
