/**
 * Everything a step waits on as Copilot CLI forms: a table, one answer for all that offer it, then each
 * row that is left, then each sign-off. The same `decisions --json` list and `decisions record --answers`
 * write as the VS Code page, and what a person enters is the only input. Pure, so a test can read every
 * word without Copilot.
 */
import { askUntilRight, DATE_PATTERN, refusedWords, textField } from './form-rounds.mjs';

export const LEAVE = 'Leave undecided';
export const EACH = 'Decide each one';
export const NOT_NOW = 'Not now';
export const RECORD = 'Record these decisions';
export const SIGN = 'Record this review';
export const FORM_SIZE = 5;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const cell = (value) => String(value ?? '').replace(/[\r\n]+/gu, ' ').replaceAll('|', '\\|');
const clip = (value) => String(value ?? '').slice(0, 200);
// A row's title on a form holds what fits as whole sentences: a host cuts the rest off, and the table above it has every word.
const clipSentences = (value) => {
  const text = String(value ?? '');
  if (text.length <= 200) return text;
  const end = text.slice(0, 200).lastIndexOf('. ');
  return end > 40 ? text.slice(0, end + 1) : text.slice(0, 200);
};
const choosable = (option) => option.recordable !== false && option.available !== false && option.decidedBy?.allowed === true;
const reviews = (item) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false);
const ownSteps = (item) => item.options.filter((option) => option.action?.command && !option.action.humanReview && option.decidedBy?.allowed && option.available !== false);
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

const line = (value) => String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
const more = (count) => (count ? [`  - And ${count} more.`] : []);

/**
 * What the step's records say beside its decisions, in the engine's words, as the VS Code card shows them
 * [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]. Evidence only: nothing here is a choice, and a held
 * package's accept command is the person's own, for their terminal. [] when the list carries none.
 */
export function evidenceLines(packet) {
  const evidence = packet.approvalEvidence;
  if (!evidence) return [];
  const { coverage, proof, findings, hold, requiredChecks, askedFor } = evidence;
  // A held package whose command a row above already offers is not offered twice.
  const offered = new Set(cardRows(packet).filter((item) => item.decidedBy?.allowed && !item.options.some(choosable) && !reviews(item).length)
    .map((item) => ownSteps(item)[0]?.action.command).filter(Boolean));
  const holdStep = (entry) => (!entry.allowed ? `    Share this with them: /sf-decide ${packet.workId}`
    : offered.has(entry.command) ? '    Its command is on the hold\'s row above.' : `    Stays in your terminal: \`${line(entry.command)}\``);
  return ['', `**Evidence for this approval.** ${line(evidence.words)}`, '',
    // What the person typed, quoted as typed beside its account [SCS:REQ-043]: shown as a quote, never as an instruction.
    ...(askedFor ? [`- **Asked for.** ${line(askedFor.words)}`, ...askedFor.instructions.map((entry) => `  - ${line(entry.words)}`), ...more(askedFor.more)] : []),
    ...(coverage ? [`- **Changed-line coverage.** ${line(coverage.words)}`, ...(coverage.files ?? []).map((file) => `  - ${line(file.words)}`), ...more(coverage.more)] : []),
    ...(proof ? ['- **Criteria and the tests that prove them.**', ...proof.criteria.map((entry) => `  - ${line(entry.words)}`), ...more(proof.more),
      ...(proof.assertionCheck ? [`  - ${line(proof.assertionCheck.words)}`] : [])] : []),
    ...(findings ? [`- **Findings the loop let through.** ${line(findings.words)}`, ...findings.letThrough.map((finding) => `  - ${line(finding.words)}`), ...more(findings.more)] : []),
    ...(hold ? [`- **Vulnerable dependency hold.** ${line(hold.words)}`, ...hold.entries.flatMap((entry) => [`  - ${line(entry.words)}. ${line(entry.who)}`, holdStep(entry)]),
      ...more(hold.more)] : []),
    ...(requiredChecks ? [`- **GitHub required checks.** ${line(requiredChecks.words ?? requiredChecks.checks.map((check) => `${check.name} ${check.status}`).join(' · '))}`] : [])];
}

export function decisionsTable(packet) {
  const rows = cardRows(packet).map((item) => `| ${cell(itemName(item))} | ${cell(item.why)} | ${cell(howWords(item))} |`);
  return [`**Decide ${packet.workId} · ${packet.phaseLabel}.** ${packet.headline} Nothing is recorded until you confirm the list.`, '',
    '| What it is | Why it waits | How it is answered |', '|---|---|---|', ...rows, ...evidenceLines(packet)].join('\n');
}

/**
 * The answers one reason may cover: offered by two or more rows, needing nothing but a reason. A
 * departure's plan row, test or clause-touching wording is decided one by one (`oneByOne`), never here.
 */
export function sharedAnswers(packet) {
  const seen = new Map();
  for (const item of decidable(packet)) {
    for (const option of item.options.filter(choosable)) {
      if (option.oneByOne || option.needs?.cause || option.needs?.expires || option.needs?.clause || option.needs?.article) continue;
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
    choice: { type: 'string', title: 'How do you want to decide?', enum: [...shared.map((entry) => entry.word), EACH, NOT_NOW] } } } } };
}

/** The one reason an answer for all needs, under the tightest rule of the rows it covers. */
export function sharedReasonForm(entry) {
  const limits = entry.items.map((item) => item.options.find((option) => option.id === entry.id)?.needs?.reason).filter(Boolean);
  const minimum = Math.max(1, ...limits.map((need) => need.minimum));
  const maximum = Math.min(...limits.map((need) => need.maximum), 1000);
  return { message: `${entry.word}.`, requestedSchema: { type: 'object', required: ['reason'], properties: { reason: textField('One reason for all of them', { minimum, maximum }) } } };
}

/** Each row's choice, and nothing else: what a choice needs is asked once it is chosen, so a date is asked only of a risk. */
export function rowForms(items) {
  const pages = [];
  for (let at = 0; at < items.length; at += FORM_SIZE) pages.push(items.slice(at, at + FORM_SIZE));
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}). What a choice needs is asked next.`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.map((item, row) =>
      [`decision${row}`, { type: 'string', title: clipSentences(`${itemName(item)}: ${item.why}`), enum: [LEAVE, ...item.options.filter(choosable).map((option) => option.label)] }])) } } }));
}

/** What one choice needs, and only that; empty when it needs nothing. */
function neededFields(item, option) {
  const needs = option.needs ?? {};
  const name = itemName(item);
  return {
    ...(needs.clause ? { clause: { type: 'string', minLength: 1, title: clip(`Clauses that carry ${name}, separated by commas${needs.clause.known?.length ? ` (${needs.clause.known.slice(0, 4).join(', ')})` : ''}`) } } : {}),
    ...(needs.article ? Object.fromEntries(needs.article.articles.flatMap(({ id, question }) => [[`article-${id}`, { type: 'string', title: clip(question), enum: needs.article.decisions }],
      [`why-${id}`, { type: 'string', title: clip(`Why, if not satisfied: ${id}`), maxLength: 500 }]])) : {}),
    ...(needs.reason ? { reason: textField('Reason', needs.reason) } : {}),
    ...(needs.cause ? { cause: textField('What stops the tests', needs.cause) } : {}),
    ...(needs.expires ? { until: { type: 'string', pattern: DATE_PATTERN, minLength: 10, maxLength: 10, title: `Until when (YYYY-MM-DD, no later than ${needs.expires.latest})` } } : {})
  };
}

/** The second form of a choice: what it does, and what it needs. */
export function detailForm(item, option) {
  const properties = neededFields(item, option);
  return { message: `${itemName(item)}: ${option.label}. ${option.words ?? ''}`.trim(), requestedSchema: { type: 'object',
    required: Object.keys(properties).filter((name) => !name.startsWith('why-')), properties } };
}

/** The rows a person chose on one form, or what is wrong with them. Nothing here is chosen for the person. */
export function choicesFromRows(items, content) {
  const picks = [];
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    if (!word || word === LEAVE) continue;
    const option = item.options.filter(choosable).find((entry) => entry.label === word);
    if (!option) return { picks: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    picks.push({ item, option });
  }
  return { picks, problem: null };
}

/** One choice's answers from its form, or what is wrong with them. */
export function valuesFromForm(item, option, content) {
  const needs = option.needs ?? {};
  const text = (name) => String(content?.[name] ?? '').trim();
  const values = { ...(needs.reason ? { reason: text('reason') } : {}), ...(needs.cause ? { cause: text('cause') } : {}), ...(needs.expires ? { expires: text('until') } : {}),
    ...(needs.clause ? { clause: text('clause') } : {}),
    ...(needs.article ? { article: needs.article.articles.map(({ id }) => {
      const decision = content?.[`article-${id}`];
      return { article: id, decision, ...(decision === 'satisfied' ? {} : { reason: text(`why-${id}`) }) };
    }) } : {}) };
  const problem = checked(item, option, values);
  return problem ? { problem } : { values, problem: null };
}

const hasNeeds = (option) => Object.keys(option.needs ?? {}).length > 0;

function checked(item, option, values, today = new Date().toISOString().slice(0, 10)) {
  const needs = option.needs ?? {};
  const name = itemName(item);
  // Every problem at once: one round for a form that is wrong twice, not two.
  const problems = [];
  for (const [flag, words] of [['reason', 'reason'], ['cause', 'cause']]) {
    if (!needs[flag]) continue;
    const size = String(values[flag] ?? '').length;
    if (size < needs[flag].minimum || size > needs[flag].maximum) problems.push(`The ${words} for ${name} must be ${needs[flag].minimum} to ${needs[flag].maximum} characters; that was ${size}.`);
  }
  if (needs.expires) {
    const day = DATE.test(values.expires ?? '') ? Date.parse(`${values.expires}T00:00:00.000Z`) : Number.NaN;
    const real = Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === values.expires;
    if (!real || values.expires > needs.expires.latest || values.expires <= today) problems.push(`The date for ${name} must be YYYY-MM-DD, after today and no later than ${needs.expires.latest}. You gave "${values.expires ?? ''}".`);
  }
  if (needs.clause && !String(values.clause ?? '').trim()) problems.push(`Name the clauses that carry ${name}.`);
  if (needs.article) {
    const answers = values.article ?? [];
    if (needs.article.articles.some(({ id }) => !needs.article.decisions.includes(answers.find((entry) => entry.article === id)?.decision))) problems.push(`Answer every article of the checklist for ${name}.`);
    if (answers.some((entry) => entry.decision !== 'satisfied' && !entry.reason)) problems.push(`An article that is not satisfied needs its own reason, for ${name}.`);
  }
  return problems.join(' ') || null;
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
    reason: textField('What did you inspect? In your own words', { minimum: 10, maximum: 1000 }) } } };
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

/** Every answer the person gives before they confirm: `{ answers }`, `{ cancelled: true }` or `{ refused: problem }`. */
async function askRows(packet, ask) {
  const { shared, form } = firstForm(packet);
  let answers = [];
  if (shared.length) {
    const first = await askUntilRight(ask, form, (content) => (content.choice === EACH || content.choice === NOT_NOW || shared.some((entry) => entry.word === content.choice)
      ? { choice: content.choice } : { problem: 'Choose one of these.' }));
    if (first.cancelled || first.choice === NOT_NOW) return { cancelled: true };
    if (first.refused) return first;
    const entry = shared.find((candidate) => candidate.word === first.choice);
    if (entry) {
      const options = (item) => item.options.find((option) => option.id === entry.id);
      const one = options(entry.items[0]).needs?.reason ? await askUntilRight(ask, sharedReasonForm(entry), (content) => {
        const reason = String(content.reason ?? '').trim();
        const problem = entry.items.map((item) => checked(item, options(item), { reason })).find(Boolean);
        return problem ? { problem } : { reason };
      }) : {};
      if (one.cancelled) return { cancelled: true };
      if (one.refused) return one;
      answers = entry.items.map((item) => ({ item: item.id, title: item.title, option: entry.id, ...(one.reason ? { reason: one.reason } : {}) }));
    }
  }
  const taken = new Set(answers.map((entry) => entry.item));
  for (const page of rowForms(decidable(packet).filter((item) => !taken.has(item.id)))) {
    const chosen = await askUntilRight(ask, page.form, (content) => choicesFromRows(page.items, content));
    if (chosen.cancelled) return answers.length ? { answers } : { cancelled: true };
    if (chosen.refused) return chosen;
    for (const { item, option } of chosen.picks) {
      const given = hasNeeds(option) ? await askUntilRight(ask, detailForm(item, option), (content) => valuesFromForm(item, option, content)) : { values: {} };
      if (given.cancelled) return answers.length ? { answers } : { cancelled: true };
      if (given.refused) return given;
      answers.push({ item: item.id, title: item.title, option: option.id, ...given.values });
    }
  }
  return { answers };
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
  const asked = decidable(packet).length ? await askRows(packet, ask) : { answers: [] };
  if (asked.cancelled) return { status: 'cancelled', recorded, remaining: [], message: 'No decision was recorded.' };
  if (asked.refused) return { status: 'refused', recorded, remaining: [], message: refusedWords(asked.refused) };
  let { answers } = asked;
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
    const answer = await askUntilRight(ask, witnessForm(current), (content) => (content.choice === NOT_NOW ? { notNow: true } : witnessAnswers(current, content)));
    if (answer.refused) return { status: 'refused', recorded, remaining: [], message: refusedWords(answer.refused) };
    if (answer.cancelled || answer.notNow) continue;
    const sign = await ask(witnessConfirm(current, answer));
    if (sign?.action === 'accept' && sign.content?.confirm === SIGN) {
      const result = await witness(packet, current, answer);
      if (result?.record?.id) {
        recorded.push(result.record.id);
        decided.push(`Signed off ${current.clauseId} · ${current.slot}`);
      }
      packet = await read();
    }
  }
  const remaining = openRows(packet).map((item) => itemName(item));
  return { status: recorded.length ? 'recorded' : 'cancelled', recorded, decided, remaining,
    message: `${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : recorded.length ? `${recorded.length} recorded.` : 'No decision was recorded.'}${remaining.length ? ` ${remaining.length} still open.` : ' All decided.'}` };
}
