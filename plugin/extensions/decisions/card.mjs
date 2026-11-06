/**
 * Everything a step waits on as Copilot CLI forms: a table, one answer for all that offer it, then each
 * row that is left, then each sign-off. The same `decisions --json` list and `decisions record --answers`
 * write as the VS Code page, and what a person enters is the only input. Pure, so a test can read every
 * word without Copilot.
 */
export const LEAVE = 'Leave undecided';
export const EACH = 'Decide each one';
export const NOT_NOW = 'Not now';
export const RECORD = 'Record these decisions';
export const SIGN = 'Record this review';
export const FORM_SIZE = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const cell = (value) => String(value ?? '').replace(/[\r\n]+/gu, ' ').replaceAll('|', '\\|');
const clip = (value) => String(value ?? '').slice(0, 200);
const choosable = (option) => option.recordable !== false && option.available !== false && option.decidedBy?.allowed === true;
const reviews = (item) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false);
const ownSteps = (item) => item.options.filter((option) => option.action?.command && !option.action.humanReview && option.decidedBy?.allowed);
const itemName = (item) => item.details?.path ?? item.title;

/** Every open decision: the approval itself stays with /sf-approve. */
export const openRows = (packet) => packet.items.filter((item) => item.kind !== 'approval');
/** What this card shows: the open decisions, then anything offered that nothing waits on. */
export const cardRows = (packet) => [...openRows(packet), ...(packet.offered ?? [])];
const decidable = (packet) => cardRows(packet).filter((item) => item.decidedBy?.allowed && item.options.some(choosable));

function howWords(item) {
  if (!item.decidedBy?.allowed) return `${item.decidedBy?.words ?? ''}${item.decidedBy?.share ? ` Share: ${item.decidedBy.share}` : ''}`;
  if (item.options.some(choosable)) return 'Your decision, on the forms below';
  if (reviews(item).length) return 'Your sign-off, on the forms below';
  const own = ownSteps(item);
  return own.length ? `Stays in your terminal: \`${own[0].action.command}\`` : (item.options[0]?.words ?? '');
}

export function decisionsTable(packet) {
  const rows = cardRows(packet).map((item) => `| ${cell(itemName(item))} | ${cell(item.why)} | ${cell(howWords(item))} |`);
  return [`**Decide ${packet.workId} · ${packet.phaseLabel}.** ${packet.headline} Nothing is recorded until you confirm the list.`, '',
    '| What it is | Why it waits | How it is answered |', '|---|---|---|', ...rows].join('\n');
}

/** The answers one reason may cover: offered by two or more rows, needing nothing but a reason. */
export function sharedAnswers(packet) {
  const seen = new Map();
  for (const item of decidable(packet)) {
    for (const option of item.options.filter(choosable)) {
      if (option.needs?.cause || option.needs?.expires || option.needs?.clause || option.needs?.article) continue;
      const known = seen.get(option.id);
      if (known) known.items.push(item); else seen.set(option.id, { id: option.id, label: option.label, items: [item] });
    }
  }
  return [...seen.values()].filter((entry) => entry.items.length > 1);
}

export function firstForm(packet) {
  const shared = sharedAnswers(packet).map((entry) => ({ ...entry, word: `${entry.label} for all ${entry.items.length}, with one reason` }));
  const open = decidable(packet).length;
  return { shared, form: { message: `${open} still need a decision from you.`, requestedSchema: { type: 'object', required: ['choice'], properties: {
    choice: { type: 'string', title: 'How do you want to decide?', enum: [...shared.map((entry) => entry.word), EACH, NOT_NOW] },
    reason: { type: 'string', title: 'Reason, if it is one answer for all', maxLength: 500 } } } } };
}

const answersChecklist = (item) => item.options.filter(choosable).some((option) => option.needs?.article);

export function rowForms(items) {
  const pages = [];
  const plain = items.filter((item) => !answersChecklist(item));
  for (let at = 0; at < plain.length; at += FORM_SIZE) pages.push(plain.slice(at, at + FORM_SIZE));
  // A checklist fills a form of its own.
  pages.push(...items.filter(answersChecklist).map((item) => [item]));
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}).`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.flatMap((item, row) => {
      const options = item.options.filter(choosable);
      const need = (flag) => options.find((option) => option.needs?.[flag])?.needs?.[flag];
      const articles = need('article');
      return [[`decision${row}`, { type: 'string', title: clip(`${itemName(item)}: ${item.why}`), enum: [LEAVE, ...options.map((option) => option.label)] }],
        ...(need('clause') ? [[`clause${row}`, { type: 'string', title: clip(`Clauses that carry ${itemName(item)}, separated by commas, if you include it${need('clause').known?.length ? ` (${need('clause').known.slice(0, 4).join(', ')})` : ''}`) }]] : []),
        ...(articles ? articles.articles.flatMap(({ id, question }) => [[`article${row}-${id}`, { type: 'string', title: clip(question), enum: articles.decisions }],
          [`why${row}-${id}`, { type: 'string', title: clip(`Why, if not satisfied: ${id}`), maxLength: 500 }]]) : []),
        ...(need('reason') ? [[`reason${row}`, { type: 'string', title: clip(`Reason for ${itemName(item)}`), maxLength: need('reason').maximum }]] : []),
        ...(need('cause') ? [[`cause${row}`, { type: 'string', title: clip(`What stops the tests, ${itemName(item)}`), maxLength: need('cause').maximum }]] : []),
        ...(need('expires') ? [[`until${row}`, { type: 'string', title: clip(`Until when, ${itemName(item)} (YYYY-MM-DD, at most ${need('expires').latest})`) }]] : [])];
    })) } } }));
}

function checked(item, option, values) {
  const needs = option.needs ?? {};
  const name = itemName(item);
  for (const [flag, words] of [['reason', 'reason'], ['cause', 'cause']]) {
    if (!needs[flag]) continue;
    const size = String(values[flag] ?? '').length;
    if (size < needs[flag].minimum || size > needs[flag].maximum) return `The ${words} for ${name} must be ${needs[flag].minimum} to ${needs[flag].maximum} characters.`;
  }
  if (needs.expires && (!DATE.test(values.expires ?? '') || values.expires > needs.expires.latest)) return `The date for ${name} must be YYYY-MM-DD and no later than ${needs.expires.latest}.`;
  if (needs.clause && !String(values.clause ?? '').trim()) return `Name the clauses that carry ${name}.`;
  if (needs.article) {
    const answers = values.article ?? [];
    if (needs.article.articles.some(({ id }) => !needs.article.decisions.includes(answers.find((entry) => entry.article === id)?.decision))) return `Answer every article of the checklist for ${name}.`;
    if (answers.some((entry) => entry.decision !== 'satisfied' && !entry.reason)) return `An article that is not satisfied needs its own reason, for ${name}.`;
  }
  return null;
}

/** A form's answers, by what each row is, or what is wrong with them. Nothing here is chosen for the person. */
export function answersFromRows(items, content) {
  const answers = [];
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    const reason = String(content?.[`reason${row}`] ?? '').trim();
    if (!word || word === LEAVE) {
      if (reason) return { answers: [], problem: `Choose a decision for ${itemName(item)}, or clear its reason.` };
      continue;
    }
    const option = item.options.filter(choosable).find((entry) => entry.label === word);
    if (!option) return { answers: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    const values = { ...(option.needs?.reason ? { reason } : {}), ...(option.needs?.cause ? { cause: String(content?.[`cause${row}`] ?? '').trim() } : {}),
      ...(option.needs?.expires ? { expires: String(content?.[`until${row}`] ?? '').trim() } : {}),
      ...(option.needs?.clause ? { clause: String(content?.[`clause${row}`] ?? '').trim() } : {}),
      ...(option.needs?.article ? { article: option.needs.article.articles.map(({ id }) => {
        const decision = content?.[`article${row}-${id}`];
        return { article: id, decision, ...(decision === 'satisfied' ? {} : { reason: String(content?.[`why${row}-${id}`] ?? '').trim() }) };
      }) } : {}) };
    const problem = checked(item, option, values);
    if (problem) return { answers: [], problem };
    answers.push({ item: item.id, title: item.title, option: option.id, ...values });
  }
  return { answers, problem: null };
}

const answersDocument = (packet, answers) => {
  const column = (flag) => Object.fromEntries(answers.filter((entry) => entry[flag] !== undefined).map((entry) => [entry.item, entry[flag]]));
  return { choose: Object.fromEntries(answers.map((entry) => [entry.item, entry.option])), reason: column('reason'), cause: column('cause'), expires: column('expires'), clause: column('clause'), article: column('article'), confirm: packet.packetSha256 };
};

export function confirmForm(packet, answers) {
  const items = new Map(cardRows(packet).map((item) => [item.id, item]));
  const words = answers.map((entry) => {
    const item = items.get(entry.item);
    const label = item?.options.find((option) => option.id === entry.option)?.label ?? entry.option;
    const articles = entry.article?.map((answer) => `${answer.article}: ${answer.decision}${answer.reason ? ` (${answer.reason})` : ''}`).join('; ');
    return `${itemName(item ?? { title: entry.title })}: ${label}.${entry.clause ? ` Carried by ${entry.clause}.` : ''}${articles ? ` ${articles}.` : ''}${entry.expires ? ` Until ${entry.expires}.` : ''}${entry.cause ? ` What stops the tests: ${entry.cause.replace(/\.+$/u, '')}.` : ''}${entry.reason ? ` Reason: ${entry.reason}` : ''}`;
  });
  const left = openRows(packet).filter((item) => item.decidedBy?.allowed && item.options.some(choosable) && !answers.some((entry) => entry.item === item.id));
  return { message: [`Record ${answers.length} decision${answers.length === 1 ? '' : 's'} on ${packet.workId}, each under your name:`, ...words,
    ...(left.length ? [`Still undecided: ${left.map(itemName).join(', ')}`] : [])].join('\n'),
  requestedSchema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', title: 'I reviewed this exact change', enum: [RECORD, NOT_NOW] } } } };
}

/** The answers on a list that changed, by what each row is: only those that still mean the same thing. */
export function answersOnCurrentList(packet, answers) {
  return answers.flatMap((entry) => {
    const item = cardRows(packet).find((candidate) => candidate.title === entry.title);
    return item?.options.some((option) => option.id === entry.option && choosable(option)) ? [{ ...entry, item: item.id }] : [];
  });
}

export const WITNESS_QUESTIONS = Object.freeze([
  ['states-the-outcome', 'Does this file show the acceptance criterion\'s observable outcome?'],
  ['matches-the-criterion', 'Does the evidence match the acceptance criterion as written?'],
  ['current-for-this-change', 'Is this evidence current for this change?']
]);

/** One sign-off, one form: the same three questions as VS Code's review, and the person's own words. */
export function witnessForm(review) {
  return { message: [`Sign off ${review.clauseId} · ${review.slot} (${review.method}).`, ...(review.clauseText ? [`The approved criterion: ${review.clauseText}`] : []),
    ...(review.files.length === 1 ? [`Look at ${review.files[0]} first.`] : [])].join('\n'),
  requestedSchema: { type: 'object', required: ['choice', ...WITNESS_QUESTIONS.map(([id]) => id)], properties: {
    choice: { type: 'string', title: 'Did you look at it?', enum: ['I looked at it', NOT_NOW] },
    ...(review.files.length === 1 ? {} : { file: { type: 'string', title: 'The file you looked at, from the repository root' } }),
    ...Object.fromEntries(WITNESS_QUESTIONS.map(([id, question]) => [id, { type: 'string', title: question, enum: ['Yes', 'No'] }])),
    reason: { type: 'string', title: 'What did you inspect? In your own words.', minLength: 10, maxLength: 1000 } } } };
}

export function witnessAnswers(review, content) {
  const reason = String(content?.reason ?? '').trim();
  const file = review.files.length === 1 ? review.files[0] : String(content?.file ?? '').trim();
  if (!file) return { problem: 'Name the file you looked at.' };
  if (reason.length < 10 || reason.length > 1000) return { problem: 'Describe what you inspected in 10 to 1000 characters.' };
  for (const [id] of WITNESS_QUESTIONS) if (!['Yes', 'No'].includes(content?.[id])) return { problem: 'Answer each question yes or no.' };
  return { problem: null, file, reason, answers: WITNESS_QUESTIONS.map(([id]) => [id, content[id] === 'Yes']) };
}

export function witnessConfirm(review, { file, reason, answers }) {
  return { message: [`Record this review of ${review.clauseId} · ${review.slot}, under your name. It is a witness, not the step's approval.`, `File: ${file}`,
    ...answers.map(([id, yes]) => `${id}: ${yes ? 'yes' : 'no'}`), `Your reason: ${reason}`].join('\n'),
  requestedSchema: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', title: 'I reviewed this exact change', enum: [SIGN, NOT_NOW] } } } };
}

/** A pending review on the current list, or null: the binding it records against is always this read's. */
const reviewOn = (packet, key) => cardRows(packet).flatMap(reviews).map((option) => option.action.humanReview)
  .find((review) => review.clauseId === key.clauseId && review.slot === key.slot) ?? null;

async function askRows(packet, ask, show) {
  const { shared, form } = firstForm(packet);
  let answers = [];
  if (shared.length) {
    for (;;) {
      const first = await ask(form);
      if (first?.action !== 'accept' || first.content?.choice === NOT_NOW) return null;
      if (first.content.choice === EACH) break;
      const entry = shared.find((candidate) => candidate.word === first.content.choice);
      const reason = String(first.content.reason ?? '').trim();
      const problem = entry && entry.items.map((item) => checked(item, item.options.find((option) => option.id === entry.id), { reason })).find(Boolean);
      if (entry && !problem) { answers = entry.items.map((item) => ({ item: item.id, title: item.title, option: entry.id, reason })); break; }
      await show(problem ?? 'Choose one of these.');
    }
  }
  const chosen = new Set(answers.map((entry) => entry.item));
  for (const page of rowForms(decidable(packet).filter((item) => !chosen.has(item.id)))) {
    for (;;) {
      const reply = await ask(page.form);
      if (reply?.action !== 'accept') return answers.length ? answers : null;
      const { answers: entered, problem } = answersFromRows(page.items, reply.content);
      if (problem) { await show(problem); continue; }
      answers.push(...entered);
      break;
    }
  }
  return answers;
}

/**
 * The whole conversation with one person. `ask(form)` answers `{ action, content }`, `show(text)` prints,
 * `read()` reads the list, `record(packet, document)` writes the choices, `witness(packet, review, answer)`
 * writes one sign-off and `inspect(packet, file)` puts a file in front of the person. The caller passes
 * these in, so a test can run every route and no route can be answered by anything but `ask`.
 */
export async function runCard({ ask, show, read, record, witness, inspect, askedInChat = false }) {
  let packet = await read();
  // A chat that asked carries on when nothing waits: only a person who typed /decide sees a review nothing waits on.
  if (!(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'nothing-to-decide', message: packet.headline, recorded: [], remaining: [] };
  await show(decisionsTable(packet));
  const recorded = [];
  // What was decided, in its own words: this is what the agent reports back, and a record's ID does not say it.
  const decided = [];
  let answers = decidable(packet).length ? await askRows(packet, ask, show) : [];
  if (answers === null) return { status: 'cancelled', recorded, remaining: [], message: 'No decision was recorded.' };
  while (answers.length) {
    const confirmed = await ask(confirmForm(packet, answers));
    if (confirmed?.action !== 'accept' || confirmed.content?.confirm !== RECORD) return { status: 'cancelled', recorded, remaining: [], message: 'No decision was recorded.' };
    try {
      const result = await record(packet, answersDocument(packet, answers));
      recorded.push(...(result.recorded ?? []).map((entry) => entry.record ?? entry.item));
      decided.push(...(result.decided ?? []).map((entry) => entry.words));
      answers = [];
    } catch (error) {
      // With SF Guard the signature is taken in the person's own terminal: one command, nothing to fill in, the same questions there.
      if (error.code === 'PSS_CARD_NOT_SHOWN') {
        return { status: 'needs-terminal', recorded, remaining: [], command: `singularity-flow decisions record ${packet.workId}`,
          message: `This Story signs each decision with SF Guard, and Touch ID is taken in your own terminal, so nothing was written here. In a second pane run: singularity-flow decisions record ${packet.workId}` };
      }
      if (error.code !== 'DECISIONS_PACKET_CHANGED') throw error;
      packet = await read();
      answers = answersOnCurrentList(packet, answers);
      await show(`The list changed while it was open, so nothing was recorded. Your answers still on it are kept: confirm them against the current list.${answers.length ? '' : ' None of them is left.'}`);
    }
  }
  packet = await read();
  // Each sign-off binds to the list as it stands now, so the choices above are recorded first.
  for (const key of cardRows(packet).flatMap(reviews).map((option) => option.action.humanReview)) {
    const current = reviewOn(packet, key);
    if (!current) continue;
    if (current.files.length === 1) await inspect?.(packet, current.files[0]);
    for (;;) {
      const reply = await ask(witnessForm(current));
      if (reply?.action !== 'accept' || reply.content?.choice === NOT_NOW) break;
      const answer = witnessAnswers(current, reply.content);
      if (answer.problem) { await show(answer.problem); continue; }
      const sign = await ask(witnessConfirm(current, answer));
      if (sign?.action === 'accept' && sign.content?.confirm === SIGN) {
        const result = await witness(packet, current, answer);
        if (result?.record?.id) {
          recorded.push(result.record.id);
          decided.push(`Signed off ${current.clauseId} · ${current.slot}`);
        }
        packet = await read();
      }
      break;
    }
  }
  const remaining = openRows(packet).map((item) => itemName(item));
  return { status: recorded.length ? 'recorded' : 'cancelled', recorded, decided, remaining,
    message: `${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : recorded.length ? `${recorded.length} recorded.` : 'No decision was recorded.'}${remaining.length ? ` ${remaining.length} still open.` : ' All decided.'}` };
}
