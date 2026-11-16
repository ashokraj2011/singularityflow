/**
 * Everything a step waits on as Copilot CLI forms, in plain words [owner, 2026-11-16]: each open item as its question,
 * why in one sentence and "Recommended: …", then its options, recommended first; what nobody can answer yet on one
 * "Later:" line; what SFlow settled for the person one line each, with its Undo. One open item is asked directly; several
 * are named on the first form. The same `decisions --json` list and `decisions record --answers` write as the VS Code
 * page, and what a person enters is the only input. Pure, so a test can read every word without Copilot.
 */
import { askUntilRight, DATE_PATTERN, refusedWords, textField } from './form-rounds.mjs';

export const LEAVE = 'Leave undecided';
export const EACH = 'Decide each one';
export const NOT_NOW = 'Not now';
// Answers already given and what the plan settled: asked only once the person chooses to, as /adjudicate does [SCS:REQ-034, REQ-035].
export const CHANGE = 'Change an answer or overrule the plan';
// What SFlow settled for the person waits the same way: undone only if they say it is wrong [owner, 2026-11-13].
export const UNDO_SETTLED = 'Undo what was settled for you';
// Beside one question asked directly, each settled line is kept unless the person undoes it.
export const KEEP_SETTLED = 'Keep it';
export const CHANGEABLE_KINDS = Object.freeze(['convergence-answer', 'convergence-settled', 'settled']);
export const RECORD = 'Record these decisions';
export const SIGN = 'Record this review';
export const FORM_SIZE = 5;
// How long the card's first read checks before it asks, and how long "Check first" waits (decision-probes.mjs).
export const CHECK_SECONDS = 60;
export const CHECK_FIRST_SECONDS = 900;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

const clip = (value) => String(value ?? '').slice(0, 200);
// A title on a form holds what fits as whole sentences: a host cuts the rest off, and the card above it has every word.
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
const line = (value) => String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
const bare = (value) => line(value).replace(/[.!?]+$/u, '');
const more = (count) => (count ? [`  - And ${count} more.`] : []);

/**
 * An item's plain words, from the engine (decision-plain.mjs): `{ question, why, recommended }`, `{ later }` or
 * `{ settled }`. A list from an engine before them reads its title, the first sentence of its why and its
 * recommendation instead.
 */
export function plainWords(item) {
  if (item?.plain && (item.plain.question || item.plain.later || item.plain.settled)) return item.plain;
  if (item?.settled) return { settled: `${bare(item.title)}. Undo if wrong.` };
  const why = line(item?.why);
  return { question: item?.title ?? '', why: why.split(/(?<=[.!?])\s+/u)[0] ?? why, recommended: item?.recommended?.words ?? null };
}
/** The check SFlow runs itself before an item whose answer depends on it, offered first; null once it has a result. */
export const checkOf = (item) => (item?.check && item.check.status !== 'checked' ? item.check : null);
/** Whether nobody can answer it yet: it is a "Later:" line, never a question or a form [owner, 2026-11-16]. */
export const laterOf = (item) => plainWords(item).later ?? null;

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
/** The items the card asks now, as questions: open, offered and the approval, never what waits for later or was settled. */
const askedRows = (packet) => [...cardRows(packet).filter((item) => !item.settled), ...approvalRows(packet)].filter((item) => !laterOf(item));

/** The recommended option first, then the rest in the list's order. */
const recommendedFirst = (item, options) => [...options].sort((left, right) => Number(item.recommended?.option === right.id) - Number(item.recommended?.option === left.id));
/** A choice as a form lists it: its label, marked when SFlow recommends it. Never preselected. */
const choiceWord = (item, option) => (item.recommended?.option === option.id ? `${option.label} (recommended)` : option.label);
/** The check as a form lists it: first, and marked when it is what SFlow recommends. */
const checkWord = (item) => `${checkOf(item).label}${item.recommended?.check ? ' (recommended)' : ''}`;

/** The options under an item, recommended first, each with what it does; where it is answered when not on the forms. */
function optionLines(item, packet) {
  if (!item.decidedBy?.allowed) return [`${line(item.decidedBy?.words)}${item.decidedBy?.share ? ` Share this with them: ${item.decidedBy.share}` : ''}`];
  if (item.kind === 'approval') {
    const command = item.options[0]?.action?.command;
    const phase = item.details?.phase ?? packet?.phase;
    return [`- ${bare(item.options[0]?.label ?? 'Review and approve')}: /sf-approve${phase ? ` ${phase}` : ''} --work-id ${packet?.workId} opens its documents${command ? `; or in your terminal: \`${command}\`` : ''}.`];
  }
  const check = checkOf(item);
  const live = recommendedFirst(item, item.options.filter((option) => option.available !== false && option.decidedBy?.allowed));
  // Many choices: their names, one line each; what each does is on its own form once chosen.
  const terse = live.length > 3;
  return [...(check ? [`- ${checkWord(item)}: ${line(check.does)}`] : []),
    ...live.map((option) => {
      const name = `${bare(option.label)}${item.recommended?.option === option.id ? ' (recommended)' : ''}`;
      const own = option.action?.command && !option.action.humanReview ? `, in your terminal: \`${option.action.command}\`` : null;
      const does = terse || own ? '' : bare(option.does);
      // A choice recorded here may also be made in the person's own terminal, with its exact command (SF Guard signs it there).
      const terminal = option.terminal ? `${own || does ? ' ' : '. '}Or in your terminal: \`${option.terminal}\`.` : '';
      return `- ${name}${own ?? (does ? `: ${does}.` : '')}${terminal}`;
    })];
}

/** One open item: its question, why and recommendation, what an amendment changes, then its options. */
function itemBlock(item, packet, number) {
  const plain = plainWords(item);
  const amendment = item.kind === 'intent-amendment' ? [...(item.details?.proposedBy ? [line(item.details.proposedBy)] : []),
    ...(item.details?.lines ?? []).map((entry) => `- ${line(entry)}`), ...(item.details?.reach ? [`- ${line(item.details.reach)}`] : [])] : [];
  return ['', `**${number ? `${number}. ` : ''}${line(plain.question)}**`, ...(plain.why ? [line(plain.why)] : []), ...(plain.recommended ? [line(plain.recommended)] : []),
    ...amendment, ...(item.decidedBy?.allowed && item.answer?.also ? [line(item.answer.also)] : []), ...optionLines(item, packet)];
}

/**
 * What the step's records say beside its decisions, in the engine's words, as the VS Code card shows them
 * [CQF:REQ-031, REQ-033, REQ-034, REQ-052, REQ-055]. Evidence only: nothing here is a choice, and a held
 * package's accept command is the person's own, for their terminal. [] when the list carries none.
 */
export function evidenceLines(packet) {
  const evidence = packet.approvalEvidence;
  if (!evidence) return [];
  const { coverage, proof, findings, hold, requiredChecks, askedFor, carried } = evidence;
  // A held package whose command an item above already offers is not offered twice.
  const offered = new Set(cardRows(packet).filter((item) => item.decidedBy?.allowed).flatMap((item) => ownSteps(item).map((option) => option.action.command)));
  const holdStep = (entry) => (!entry.allowed ? `    Share this with them: /sf-decide ${packet.workId}`
    : offered.has(entry.command) ? '    Its command is on the hold\'s item above.' : `    Stays in your terminal: \`${line(entry.command)}\``);
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

/** What SFlow settled for the person, one line each: what it chose, because of what, and its Undo. [] when none. */
export function settledLines(packet) {
  const rows = settledRows(packet);
  if (!rows.length) return [];
  return rows.length === 1 ? ['', `**Settled for you.** ${line(plainWords(rows[0]).settled)}`]
    : ['', '**Settled for you.**', ...rows.map((item) => `- ${line(plainWords(item).settled)}`)];
}

/** Answers given and files the plan settled, one line each: kept unless the person chooses to change them. */
function changeableLines(packet) {
  const rows = cardRows(packet).filter((item) => changeable(item) && !item.settled && !laterOf(item));
  return rows.length ? ['', `**Already answered or settled by the plan.** Keep them, or change one with "${CHANGE}" on the first form.`,
    ...rows.map((item) => `- ${line(itemName(item))}: ${bare(plainWords(item).why ?? item.why)}.`)] : [];
}

/** The card: every open item in plain words, then what waits for later, what was settled, and the approval's evidence. */
export function decisionsTable(packet) {
  const asked = askedRows(packet).filter((item) => !changeable(item));
  const later = [...cardRows(packet).filter((item) => !item.settled), ...approvalRows(packet)].map(laterOf).filter(Boolean);
  const headline = packet.plain?.headline ?? packet.headline;
  return [`**Decide ${packet.workId} · ${packet.phaseLabel}.** ${line(headline)} Nothing is recorded until you confirm.`,
    ...asked.flatMap((item, index) => itemBlock(item, packet, asked.length > 1 ? index + 1 : null)),
    ...changeableLines(packet),
    ...(later.length ? ['', ...later.map((entry) => `Later: ${line(entry)}`)] : []),
    ...settledLines(packet), ...evidenceLines(packet)].join('\n');
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

/** The one open item the card asks directly, or null: exactly one waits, with no answer for all and nothing to change. */
export function directItem(packet) {
  const open = decidable(packet).filter((item) => !changeable(item));
  const offered = decidable(packet).filter((item) => changeable(item) && !item.settled);
  return open.length === 1 && !sharedAnswers(packet).length && !offered.length ? open[0] : null;
}

/**
 * One open item, asked as its own question [owner, 2026-11-16]: its recommended option first (after the check, when
 * SFlow could not finish it), and "How do you want to decide?" never asked. Each settled line sits beside it, kept
 * unless the person undoes it. Nothing is preselected.
 */
export function directForm(packet, item = directItem(packet)) {
  const plain = plainWords(item);
  const settled = decidable(packet).filter((row) => row.settled);
  const words = [plain.why, plain.recommended].filter(Boolean).map(line);
  return { item, settled, form: { message: [...words, ...settled.map((row) => `Settled for you: ${line(plainWords(row).settled)}`)].join('\n'),
    requestedSchema: { type: 'object', required: ['decision0'], properties: {
      decision0: { type: 'string', title: clipSentences(line(plain.question)),
        enum: [...(checkOf(item) ? [checkWord(item)] : []), ...recommendedFirst(item, item.options.filter(choosable)).map((option) => choiceWord(item, option)), LEAVE] },
      ...Object.fromEntries(settled.map((row, index) => [`settled${index}`, { type: 'string', title: clipSentences(line(plainWords(row).settled)),
        enum: [KEEP_SETTLED, ...row.options.filter(choosable).map((option) => option.label)] }])) } } } };
}

/** The direct form's answers: the item's choice or its check, and any settled line undone. */
export function directChoices(item, settled, content) {
  const word = content?.decision0;
  if (checkOf(item) && word === checkWord(item)) return { picks: [], check: item, problem: null };
  const { picks, problem } = choicesFromRows([item], { decision0: word });
  if (problem) return { picks: [], problem };
  for (const [index, row] of settled.entries()) {
    const chosen = content?.[`settled${index}`];
    if (!chosen || chosen === KEEP_SETTLED) continue;
    const option = row.options.filter(choosable).find((entry) => entry.label === chosen);
    if (!option) return { picks: [], problem: `That is not a choice SFlow knows for what was settled: ${bare(plainWords(row).settled)}.` };
    picks.push({ item: row, option });
  }
  return { picks, problem: null };
}

/**
 * Several items: how the person wants to decide, naming each one: one answer for all that share it, each one, or,
 * when the list offers answers given or files the plan settled, changing those. `change` is that choice's words, null
 * when there is nothing to change.
 */
export function firstForm(packet) {
  const shared = sharedAnswers(packet).map((entry) => ({ ...entry, word: `${entry.label} for all ${entry.items.length}, with one reason` }));
  const open = decidable(packet).filter((item) => !changeable(item));
  const later = decidable(packet).filter(changeable).length;
  const settled = decidable(packet).filter((item) => item.settled === true);
  const change = later ? `${settled.length === later ? UNDO_SETTLED : CHANGE} (${later})` : null;
  // Named, never counted: "1. Run Implementation's tests on Node 22? 2. …" [owner, 2026-11-16].
  const asked = (item) => line(plainWords(item).question).replace(/([^.!?])$/u, '$1.');
  const named = open.length ? `${open.length === 1 ? 'One question for you' : `${open.length} questions for you`}: ${open.map((item, index) => `${index + 1}. ${asked(item)}`).join(' ')}`
    : 'Nothing waits on you now.';
  const offered = settled.length === later ? `Settled for you: ${settled.map((item) => line(plainWords(item).settled)).join(' ')}`
    : `${later === 1 ? '1 is' : `${later} are`} offered beside the list: an answer already given${settled.length ? ', a file the plan settled, or what SFlow settled for you' : ', or a file the plan settled'}, which you may change if you disagree.`;
  return { shared, change, form: { message: `${named}${later ? ` ${offered}` : ''}${shared.map(othersWords).join('')}`,
    requestedSchema: { type: 'object', required: ['choice'], properties: {
      choice: { type: 'string', title: 'How do you want to decide?', enum: [...shared.map((entry) => entry.word), ...(open.length ? [EACH] : []), ...(change ? [change] : []), NOT_NOW] } } } } };
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

/** Each row's choice, and nothing else: its question, its options recommended first; what a choice needs is asked once it is chosen. */
export function rowForms(items) {
  const pages = [];
  for (let at = 0; at < items.length; at += FORM_SIZE) pages.push(items.slice(at, at + FORM_SIZE));
  return pages.map((page, index) => ({ items: page, form: {
    message: `Decide each one (${index + 1} of ${pages.length}). What a choice needs is asked next.`,
    requestedSchema: { type: 'object', required: page.map((_, row) => `decision${row}`), properties: Object.fromEntries(page.map((item, row) =>
      // The recommended choice says so in the list itself, first; the card above has why and what each choice does.
      // An answer given or what the plan settled is named by its file, with what it says now.
      [`decision${row}`, { type: 'string', title: clipSentences(changeable(item) ? `${itemName(item)}: ${line(plainWords(item).why ?? item.why)}` : line(plainWords(item).question)),
        enum: [...(checkOf(item) ? [checkWord(item)] : []), ...recommendedFirst(item, item.options.filter(choosable)).map((option) => choiceWord(item, option)), LEAVE] }])) } } }));
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

/**
 * The rows a person chose on one form, or what is wrong with them; `check` is an item whose check they chose to run
 * first. Nothing here is chosen for the person.
 */
export function choicesFromRows(items, content) {
  const picks = [];
  let check = null;
  for (const [row, item] of items.entries()) {
    const word = content?.[`decision${row}`];
    if (!word || word === LEAVE) continue;
    if (checkOf(item) && word === checkWord(item)) { check ??= item; continue; }
    const option = item.options.filter(choosable).find((entry) => entry.label === word || choiceWord(item, entry) === word);
    if (!option) return { picks: [], problem: `That is not a decision SFlow knows for ${itemName(item)}.` };
    picks.push({ item, option });
  }
  return { picks, problem: null, ...(check ? { check } : {}) };
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
/** What each pick needs, asked one form at a time, as answers; or the cancel or refusal that ended it. */
async function detailsOf(ask, picks, answers) {
  for (const { item, option } of picks) {
    const given = hasNeeds(option) ? await askUntilRight(ask, detailForm(item, option), (content) => valuesFromForm(item, option, content)) : { values: {} };
    if (given.cancelled) return answers.length ? { answers } : { cancelled: true };
    if (given.refused) return given;
    answers.push({ item: item.id, title: item.title, option: option.id, ...given.values });
  }
  return null;
}

/**
 * Every answer the person gives before they confirm: `{ answers }`, `{ cancelled: true }`, `{ refused: problem }`, or
 * `{ check: item }` when they chose to have SFlow check first.
 */
async function askRows(packet, ask) {
  // One open item: its own question, never "How do you want to decide?" [owner, 2026-11-16].
  if (directItem(packet)) {
    const { item, settled, form } = directForm(packet);
    const chosen = await askUntilRight(ask, form, (content) => directChoices(item, settled, content));
    if (chosen.cancelled) return { cancelled: true };
    if (chosen.refused) return chosen;
    if (chosen.check) return { check: chosen.check };
    const answers = [];
    return await detailsOf(ask, chosen.picks, answers) ?? { answers };
  }
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
    // Checked first, then the whole list asked again with what the check found.
    if (chosen.check) return { check: chosen.check };
    const ended = await detailsOf(ask, chosen.picks, answers);
    if (ended) return ended;
  }
  return { answers };
}

/** The items whose answer waits on a check SFlow runs itself, in words: "run the tests on Node 22". */
const checkNames = (packet) => cardRows(packet).filter((item) => checkOf(item) && item.decidedBy?.allowed).map((item) => checkOf(item).label.replace(/^Check first: /u, ''));

/**
 * The whole conversation with one person. `ask(form)` answers `{ action, content }`, `show(text)` prints,
 * `read({ probe })` reads the list (with `probe`, after SFlow ran its checks for at most that many seconds),
 * `record(packet, document)` writes the choices, `witness(packet, review, answer)` writes one sign-off and
 * `inspect(packet, file)` puts a file in front of the person. The caller passes these in, so a test can run every
 * route and no route can be answered by anything but `ask`.
 */
/** The start of a step's next version as the card asks it: the proposal's own question, yes or not now [D3, OSA Stage 4]. */
export const START_VERSION = 'Yes, start it';
export function versionOpeningForm(opening) {
  return { message: `${opening.question}\nYour yes is kept for this exact proposal; the step's work command then opens it. Nothing starts on "Not now".`,
    requestedSchema: { type: 'object', required: ['start'], properties: { start: { type: 'string', title: 'Start it?', enum: [START_VERSION, NOT_NOW] } } } };
}

/**
 * A step's next version waiting for the person's yes (the list's `versionOpening`): asked first, as its own question.
 * `consent(opening)` records the yes outside the chat (`decisions record --version-consent`). Null when none waits.
 */
async function askVersionOpening(packet, { ask, show, consent }) {
  const opening = packet?.versionOpening;
  if (!opening || !consent) return null;
  const answer = await ask(versionOpeningForm(opening));
  if (answer?.action !== 'accept' || answer.content?.start !== START_VERSION) return { started: false };
  const result = await consent(opening);
  await show(result?.words ?? `Your yes to start version ${opening.version} of ${opening.phase} is kept.`);
  return { started: true };
}

export async function runCard({ ask, show, read, record, witness, inspect, consent = null, askedInChat = false }) {
  let packet = await read();
  const opening = await askVersionOpening(packet, { ask, show, consent });
  if (opening?.started && !(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'recorded', recorded: ['version-opening'], remaining: [],
    message: `Your yes to start version ${packet.versionOpening.version} of ${packet.versionOpening.phase} is kept; its work command opens it.` };
  // A chat that asked carries on when nothing waits: only a person who typed /decide sees a review nothing waits on.
  if (!(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'nothing-to-decide', message: packet.headline, recorded: [], remaining: [] };
  // What an answer depends on, SFlow checks before it asks, read-only and bounded [owner, 2026-11-16].
  if (checkNames(packet).length) {
    await show(`Checking first: ${checkNames(packet).join('; ')} (up to ${CHECK_SECONDS} seconds; nothing is recorded).`);
    // A read that fails here asks from the list as first read: the check is then offered first.
    packet = await read({ probe: CHECK_SECONDS }).catch(() => packet);
  }
  await show(decisionsTable(packet));
  const recorded = [];
  // What was decided, in its own words: this is what the agent reports back, and a record's ID does not say it.
  const decided = [];
  // Drafts written, never recorded: where each is and what is next [SCS:REQ-020].
  const drafted = [];
  // A pin or plan amendment that changed the open code step after its summary was written [owner, 2026-11-13].
  let summaryUpdate = null;
  let asked = decidable(packet).length ? await askRows(packet, ask) : { answers: [] };
  // "Check first": SFlow runs it with the time the person chose to give it, then asks again once with what it found.
  for (let round = 0; asked.check && round < 2; round += 1) {
    if (round === 1) return { status: 'cancelled', recorded, remaining: [], message: 'The check gave no answer in time; nothing was recorded.' };
    await show(`Checking: ${checkOf(asked.check).label.replace(/^Check first: /u, '')} (up to ${CHECK_FIRST_SECONDS / 60} minutes; nothing is recorded).`);
    packet = await read({ probe: CHECK_FIRST_SECONDS });
    await show(decisionsTable(packet));
    asked = decidable(packet).length ? await askRows(packet, ask) : { answers: [] };
  }
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
