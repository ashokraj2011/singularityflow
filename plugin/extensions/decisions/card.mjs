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
// Answers already given and what the plan settled: asked only once the person chooses to, as /adjudicate does [SCS:REQ-034, REQ-035].
export const CHANGE = 'Change an answer or overrule the plan';
// What SFlow settled for the person waits the same way: undone only if they say it is wrong [owner, 2026-11-13].
export const UNDO_SETTLED = 'Undo what was settled for you';
export const CHANGEABLE_KINDS = Object.freeze(['convergence-answer', 'convergence-settled', 'settled']);
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
// A sign-off with no evidence file has nothing to look at yet: it is not asked.
const reviews = (item) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false
  && (option.action.humanReview.files ?? []).length > 0);
const ownSteps = (item) => item.options.filter((option) => option.action?.command && !option.action.humanReview && option.decidedBy?.allowed && option.available !== false);
const itemName = (item) => item.details?.path ?? item.title;

/** Every open decision: the approval is a row of its own, opened with /sf-approve. */
export const openRows = (packet) => packet.items.filter((item) => item.kind !== 'approval');
/**
 * What this card shows: the open decisions, then anything offered that nothing waits on, then what SFlow settled for
 * the person and carries beside the list, each with its Undo [owner, 2026-11-13].
 */
export const cardRows = (packet) => {
  const rows = [...openRows(packet), ...(packet.offered ?? [])];
  return [...rows, ...(packet.settled ?? []).filter((item) => item?.settled === true && !rows.some((row) => row.id === item.id))];
};
/** What SFlow settled for the person: under "Settled for you", never among what waits. */
export const settledRows = (packet) => cardRows(packet).filter((item) => item.settled === true);
/** The step's approval: it starts from this card too, and /sf-approve shows its documents [owner, 2026-11-13]. */
export const approvalRows = (packet) => packet.items.filter((item) => item.kind === 'approval');
const decidable = (packet) => cardRows(packet).filter((item) => item.decidedBy?.allowed && item.options.some(choosable));
const changeable = (item) => CHANGEABLE_KINDS.includes(item.kind);

function howWords(item, packet) {
  if (!item.decidedBy?.allowed) return `${item.decidedBy?.words ?? ''}${item.decidedBy?.share ? ` Share: ${item.decidedBy.share}` : ''}`;
  if (item.kind === 'approval') {
    const command = item.options[0]?.action?.command;
    const phase = item.details?.phase ?? packet?.phase;
    return `Review its documents and approve with /sf-approve${phase ? ` ${phase}` : ''} --work-id ${packet?.workId}${command ? `; or in your terminal: \`${command}\`` : ''}`;
  }
  // Every step that stays in the person's terminal, as the VS Code card shows them: a row with a form hid
  // "Fix the code", and an amendment's row showed only its first command.
  const own = ownSteps(item);
  // A choice recorded here keeps its exact terminal command beside it: an intent amendment's decide, which SF Guard signs there [owner, 2026-11-13].
  const steps = [...own.map((option) => [option.label, option.action.command]), ...item.options.filter((option) => choosable(option) && option.terminal).map((option) => [option.label, option.terminal])];
  const terminal = steps.length === 1 ? `\`${steps[0][1]}\``
    : steps.map(([label, command]) => `${label.replace(/[.!?]+$/u, '')}: \`${command}\``).join('; ');
  if (changeable(item) && item.options.some(choosable)) return `Yours to change if you disagree: "${CHANGE}" on the first form below`;
  if (item.options.some(choosable)) return `Your decision, on the forms below${steps.length ? `; or in your terminal: ${terminal}` : ''}`;
  if (reviews(item).length) return `Your sign-off, on the forms below${steps.length ? `; or in your terminal: ${terminal}` : ''}`;
  return own.length ? `Stays in your terminal: ${terminal}` : (item.options[0]?.words ?? '');
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
  const { coverage, proof, findings, hold, requiredChecks, askedFor, carried } = evidence;
  // A held package whose command a row above already offers is not offered twice.
  const offered = new Set(cardRows(packet).filter((item) => item.decidedBy?.allowed).flatMap((item) => ownSteps(item).map((option) => option.action.command)));
  const holdStep = (entry) => (!entry.allowed ? `    Share this with them: /sf-decide ${packet.workId}`
    : offered.has(entry.command) ? '    Its command is on the hold\'s row above.' : `    Stays in your terminal: \`${line(entry.command)}\``);
  return ['', `**Evidence for this approval.** ${line(evidence.words)}`, '',
    // Evidence counted on a step's approvers' "still holds", never silent [SCS:REQ-022].
    ...(carried ? [`- **Carried by "still holds".** ${line(carried.words)}`, ...carried.entries.map((entry) => `  - ${line(entry.words)}`), ...more(carried.more)] : []),
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

/**
 * What each intent amendment on the list changes, who proposed it and what it reaches, under the table: what its
 * approver decides, in the engine's words, as the VS Code card shows them [owner, 2026-11-13]. [] when none.
 */
export function amendmentLines(packet) {
  return cardRows(packet).filter((item) => item.kind === 'intent-amendment' && (item.details?.lines?.length || item.details?.reach)).flatMap((item) => ['',
    `**${line(item.title)}.**${item.details.proposedBy ? ` ${line(item.details.proposedBy)}` : ''}`, ...(item.details.lines ?? []).map((entry) => `- ${line(entry)}`),
    ...(item.details.reach ? [`- ${line(item.details.reach)}`] : [])]);
}

/**
 * Each item's recommended answer, and what each of its choices does to the Story, in the engine's words
 * [owner, 2026-11-13]: the forms below ask only for the choice, so every word a person weighs is here first.
 */
export function adviceLines(packet) {
  return [...cardRows(packet).filter((item) => !item.settled), ...approvalRows(packet)].flatMap((item) => {
    const choices = item.options.filter((option) => option.available !== false && option.does);
    return item.recommended?.words || choices.length ? ['', `**${line(itemName(item))}.** ${line(item.recommended?.words ?? '')}`.trimEnd(),
      ...choices.map((option) => `- ${line(option.label)}${item.recommended?.option === option.id ? ' (recommended)' : ''}: ${line(option.does)}`)] : [];
  });
}

/** What SFlow settled for the person, with what each rests on; each one's Undo is on the forms below. [] when none. */
export function settledLines(packet) {
  const rows = settledRows(packet);
  return rows.length ? ['', '**Settled for you.** SFlow settled these from its records; undo any of them on the forms below.',
    ...rows.flatMap((item) => [`- ${line(itemName(item)).replace(/[.!?]+$/u, '')}: ${line(item.why)}`,
      ...[item.evidence ?? item.details?.evidence].flat().filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => `  - ${line(entry)}`)])] : [];
}

export function decisionsTable(packet) {
  // What each holds back sits with why it is asked [decision map, finding 1], and its recommended answer beside it [owner, 2026-11-13].
  const rows = [...cardRows(packet).filter((item) => !item.settled), ...approvalRows(packet)]
    .map((item) => `| ${cell(itemName(item))} | ${cell([item.why, item.holdsWords, item.recommended?.words].filter(Boolean).join(' '))} | ${cell(howWords(item, packet))} |`);
  // Only what was settled for the person: no empty table above "Settled for you".
  return [`**Decide ${packet.workId} · ${packet.phaseLabel}.** ${packet.headline} Nothing is recorded until you confirm the list.`,
    ...(rows.length ? ['', '| What it is | Why it waits | How it is answered |', '|---|---|---|', ...rows] : []),
    ...adviceLines(packet), ...settledLines(packet), ...amendmentLines(packet), ...evidenceLines(packet)].join('\n');
}

/**
 * The answers one reason may cover: offered by two or more rows this person decides, needing nothing but a
 * reason. A departure's plan row, test or clause-touching wording is decided one by one (`oneByOne`), never
 * here. `others` names the rows offering the same answer that it does not cover: other approvers decide
 * them, and they stay listed for them.
 */
export function sharedAnswers(packet) {
  const seen = new Map();
  for (const item of decidable(packet)) {
    for (const option of item.options.filter(choosable)) {
      if (option.oneByOne || option.needs?.cause || option.needs?.expires || option.needs?.clause || option.needs?.article) continue;
      const known = seen.get(option.id);
      // One word for every row it covers: a row's own label may name its step ("Code still holds").
      if (known) known.items.push(item); else seen.set(option.id, { id: option.id, label: option.sharedLabel ?? option.label, items: [item] });
    }
  }
  return [...seen.values()].filter((entry) => entry.items.length > 1).map((entry) => ({ ...entry,
    others: cardRows(packet).filter((item) => !entry.items.includes(item) && item.options.some((option) => option.id === entry.id && !choosable(option))) }));
}

/** What an answer for all leaves to other approvers, in words; '' when it covers every row that offers it. */
const othersWords = ({ word, others = [] }) => (others.length
  ? ` "${word}" covers only the rows you decide; ${others.length === 1 ? '1 more stays' : `${others.length} more stay`} listed for their own approvers (${others.map(itemName).join('; ')}).`
  : '');

/**
 * How the person wants to decide: one answer for all that share it, each one, or, when the list offers answers given or files
 * the plan settled, changing those. `change` is that choice's words, null when there is nothing to change.
 */
export function firstForm(packet) {
  const shared = sharedAnswers(packet).map((entry) => ({ ...entry, word: `${entry.label} for all ${entry.items.length}, with one reason` }));
  const open = decidable(packet).filter((item) => !changeable(item)).length;
  const later = decidable(packet).filter(changeable).length;
  const settled = decidable(packet).filter((item) => item.settled === true).length;
  const change = later ? `${settled === later ? UNDO_SETTLED : CHANGE} (${later})` : null;
  const offered = settled === later ? `settled for you, which you may undo if ${later === 1 ? 'it is' : 'one is'} wrong`
    : `offered beside the list: an answer already given${settled ? ', a file the plan settled, or what SFlow settled for you' : ', or a file the plan settled'}, which you may change if you disagree`;
  return { shared, change, form: { message: `${open ? `${open} still need a decision from you.` : 'Nothing here waits on a decision from you.'}${later
    ? ` ${later} ${later === 1 ? 'is' : 'are'} ${offered}.` : ''}${shared.map(othersWords).join('')}`,
  requestedSchema: { type: 'object', required: ['choice'], properties: {
    choice: { type: 'string', title: 'How do you want to decide?', enum: [...shared.map((entry) => entry.word), ...(open ? [EACH] : []), ...(change ? [change] : []), NOT_NOW] } } } } };
}

/** The one reason an answer for all needs, under the tightest rule of the rows it covers. */
export function sharedReasonForm(entry) {
  const limits = entry.items.map((item) => item.options.find((option) => option.id === entry.id)?.needs?.reason).filter(Boolean);
  const minimum = Math.max(1, ...limits.map((need) => need.minimum));
  const maximum = Math.min(...limits.map((need) => need.maximum), 1000);
  // Each row it covers is still recorded on its own, with this reason.
  return { message: `${entry.word}. Each of the ${entry.items.length} is recorded on its own, with this reason.${othersWords(entry)}`,
    requestedSchema: { type: 'object', required: ['reason'], properties: { reason: textField('One reason for all of them', { minimum, maximum }) } } };
}

/** A choice as a form lists it: its label, marked when SFlow recommends it. Never preselected. */
const choiceWord = (item, option) => (item.recommended?.option === option.id ? `${option.label} (recommended)` : option.label);

/** Each row's choice, and nothing else: what a choice needs is asked once it is chosen, so a date is asked only of a risk. */
export function rowForms(items) {
  const pages = [];
  for (let at = 0; at < items.length; at += FORM_SIZE) pages.push(items.slice(at, at + FORM_SIZE));
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}). What a choice needs is asked next.`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.map((item, row) =>
      // The recommended choice says so in the list itself; the table above has why and what each choice does [owner, 2026-11-13].
      [`decision${row}`, { type: 'string', title: clipSentences(`${itemName(item)}: ${item.why}`), enum: [LEAVE, ...item.options.filter(choosable).map((option) => choiceWord(item, option))] }])) } } }));
}

/** What one choice needs, and only that; empty when it needs nothing. */
function neededFields(item, option) {
  const needs = option.needs ?? {};
  const name = itemName(item);
  return {
    ...(needs.clause ? { clause: { type: 'string', minLength: 1, title: clip(`${needs.clause.words ? `${needs.clause.words}, for ${name}` : `Clauses that carry ${name}`}, separated by commas${needs.clause.known?.length ? ` (${needs.clause.known.slice(0, 4).join(', ')})` : ''}`) } } : {}),
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
  // What it does to the Story first, then its own words on when to choose it [owner, 2026-11-13].
  const words = [option.does, option.words].filter((text, at, all) => text && all.indexOf(text) === at).join(' ');
  return { message: `${itemName(item)}: ${option.label}. ${words}`.trim(), requestedSchema: { type: 'object',
    // A reason that may be left empty (sending back to fix) is not required: the form must not demand what the record does not.
    required: Object.keys(properties).filter((name) => !name.startsWith('why-') && properties[name].minLength !== 0), properties } };
}

/** The rows a person chose on one form, or what is wrong with them. Nothing here is chosen for the person. */
export function choicesFromRows(items, content) {
  const picks = [];
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    if (!word || word === LEAVE) continue;
    const option = item.options.filter(choosable).find((entry) => entry.label === word || choiceWord(item, entry) === word);
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
  if (needs.clause && !String(values.clause ?? '').trim()) problems.push(needs.clause.words ? `Name ${needs.clause.words.replace(/^The /u, 'the ')}, for ${name}.` : `Name the clauses that carry ${name}.`);
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

/** A choice that writes a draft of an amendment, never a record [SCS:REQ-020]. */
const draftsOnly = (option) => Boolean(option?.effects?.length) && option.effects.every((effect) => effect.kind === 'intent-amendment-draft');

export function confirmForm(packet, answers) {
  const items = new Map(cardRows(packet).map((item) => [item.id, item]));
  const drafts = answers.filter((entry) => draftsOnly(items.get(entry.item)?.options.find((option) => option.id === entry.option)));
  const words = answers.map((entry) => {
    const item = items.get(entry.item);
    const label = item?.options.find((option) => option.id === entry.option)?.label ?? entry.option;
    const articles = entry.article?.map((answer) => `${answer.article}: ${answer.decision}${answer.reason ? ` (${answer.reason})` : ''}`).join('; ');
    const clauseLabel = item?.options.find((option) => option.id === entry.option)?.needs?.clause?.label;
    return `${itemName(item ?? { title: entry.title })}: ${label}.${entry.clause ? ` ${clauseLabel ? `${clauseLabel}:` : 'Carried by'} ${entry.clause}.` : ''}${articles ? ` ${articles}.` : ''}${entry.expires ? ` Until ${entry.expires}.` : ''}${entry.cause ? ` What stops the tests: ${entry.cause.replace(/\.+$/u, '')}.` : ''}${entry.reason ? ` Reason: ${entry.reason}` : ''}`;
  });
  const left = openRows(packet).filter((item) => item.decidedBy?.allowed && item.options.some(choosable) && !answers.some((entry) => entry.item === item.id));
  const head = drafts.length === answers.length ? `Draft ${answers.length === 1 ? 'this amendment' : `${answers.length} amendments`} on ${packet.workId}; nothing is recorded or decided:`
    : `Record ${answers.length - drafts.length} decision${answers.length - drafts.length === 1 ? '' : 's'} on ${packet.workId}, each under your name${drafts.length ? `, and write ${drafts.length === 1 ? 'a draft' : `${drafts.length} drafts`}, which records nothing` : ''}:`;
  return { message: [head, ...words,
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
    // Several files: the person picks the one they looked at; nobody is asked to type a path [PHR:REQ-006].
    ...(review.files.length === 1 ? {} : { file: { type: 'string', title: 'Which file did you look at?', enum: [...review.files] } }),
    ...Object.fromEntries(WITNESS_QUESTIONS.map(([id, question]) => [id, { type: 'string', title: question, enum: ['Yes', 'No'] }])),
    reason: textField('What did you inspect? In your own words', { minimum: 10, maximum: 1000 }) } } };
}

export function witnessAnswers(review, content) {
  const reason = String(content?.reason ?? '').trim();
  const file = review.files.length === 1 ? review.files[0] : String(content?.file ?? '').trim();
  if (!review.files.includes(file)) return { problem: `Pick the file you looked at: ${review.files.join(', ')}.` };
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
  const { shared, change, form } = firstForm(packet);
  let answers = [];
  let changing = false;
  if (shared.length || change) {
    const first = await askUntilRight(ask, form, (content) => (form.requestedSchema.properties.choice.enum.includes(content.choice)
      ? { choice: content.choice } : { problem: 'Choose one of these.' }));
    if (first.cancelled || first.choice === NOT_NOW) return { cancelled: true };
    if (first.refused) return first;
    changing = first.choice === change;
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
  // What waits; answers given and what the plan settled only once the person chose to change them, first, then what waits.
  const rows = decidable(packet).filter((item) => !taken.has(item.id));
  for (const page of rowForms(changing ? [...rows.filter(changeable), ...rows.filter((item) => !changeable(item))] : rows.filter((item) => !changeable(item)))) {
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
  // Drafts written, never recorded: where each is and what is next [SCS:REQ-020].
  const drafted = [];
  // A pin or plan amendment that changed the open code step after its summary was written [owner, 2026-11-13].
  let summaryUpdate = null;
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
      drafted.push(...(result.drafted ?? []).map((entry) => `Drafted at ${entry.path}. ${entry.next?.words ?? ''}`.trim()));
      summaryUpdate = result.summaryUpdate?.words ?? summaryUpdate;
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
      // One sign-off that cannot be recorded never loses the decisions and sign-offs already recorded.
      try {
        const result = await witness(packet, current, answer);
        if (result?.record?.id) {
          recorded.push(result.record.id);
          decided.push(`Signed off ${current.clauseId} · ${current.slot}`);
        }
      } catch (error) {
        await show(`The sign-off of ${current.clauseId} · ${current.slot} was not recorded: ${error.message}`);
      }
      packet = await read();
    }
  }
  const remaining = openRows(packet).map((item) => itemName(item));
  return { status: recorded.length ? 'recorded' : drafted.length ? 'drafted' : 'cancelled', recorded, decided, ...(drafted.length ? { drafted } : {}), remaining,
    ...(summaryUpdate ? { summaryUpdate } : {}),
    message: `${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : recorded.length ? `${recorded.length} recorded.` : 'No decision was recorded.'}`
      + `${drafted.length ? ` ${drafted.join(' ')}` : ''}${remaining.length ? ` ${remaining.length} still open.` : ' All decided.'}${summaryUpdate ? ` ${summaryUpdate}` : ''}` };
}
