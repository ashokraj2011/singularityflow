/**
 * Everything a step waits on as Copilot CLI forms, in plain words [owner, 2026-11-16]: each open item as its question,
 * why in one sentence and "Recommended: …", then its options, recommended first; what nobody can answer yet on one
 * "Later:" line; what SFlow settled for the person one line each, with its Undo. One open item is asked directly; several
 * are named on the first form. The same `decisions --json` list and `decisions record --answers` write as the VS Code
 * page, and what a person enters is the only input. Pure, so a test can read every word without Copilot.
 */
import { askUntilRight, DATE_PATTERN, refusedWords, textField } from './form-rounds.mjs';

// Skipping a row that waits on the person says what skipping does [owner, 2026-11-20: "what does Leave undecided even mean?"];
// a row offered beside the list skips with its own default instead (decision-plain.mjs `plain.skip`), never "undecided".
export const LEAVE = 'Not now (stays open)';
// A row offered beside the list whose list gives no words for its default (an engine before them).
export const LEAVE_AS_IS = 'Leave it as it is';
export const EACH = 'Decide each one';
export const NOT_NOW = 'Not now';
// A form that offers to undo or change what was settled or answered keeps everything first, never an undo [owner, 2026-11-20:
// "How do you want to decide?" offered only "Undo … for all 6" and "Undo what was settled for you (6)", the first preselected].
export const KEEP_ALL = 'Not now (keep all)';
// Answers already given and what the plan settled: asked only once the person chooses to, as /adjudicate does [SCS:REQ-034, REQ-035].
export const CHANGE = 'Change an answer or overrule the plan';
// What SFlow settled for the person waits the same way: undone only if they say it is wrong [owner, 2026-11-13].
export const UNDO_SETTLED = 'Undo what was settled for you';
// Beside one question asked directly, each settled line is kept unless the person undoes it.
export const KEEP_SETTLED = 'Keep it';
export const CHANGEABLE_KINDS = Object.freeze(['convergence-answer', 'convergence-settled', 'settled']);
// A reviewer's finding nothing waits on, and any other row offered beside the list: asked only once the person chooses to.
export const DISPUTE = 'Dispute a reviewer\'s finding';
export const OPTIONAL = 'Answer an optional row';
export const OVERRIDE = 'Override a check\'s finding';
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
// A sign-off with a file to look at, or one with none that the person checks themselves (`attest`, owner 2026-11-22).
const reviews = (item) => item.options.filter((option) => option.action?.humanReview && option.decidedBy?.allowed && option.available !== false
  && ((option.action.humanReview.files ?? []).length > 0 || option.action.humanReview.attest === true));
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
// A row is asked when it has a choice to record, or a check SFlow runs when asked: a sign-off's screenshot is taken first.
const decidable = (packet) => cardRows(packet).filter((item) => item.decidedBy?.allowed && (item.options.some(choosable) || Boolean(checkOf(item))));
const changeable = (item) => CHANGEABLE_KINDS.includes(item.kind);
/**
 * Offered beside the list, nothing waits on it (`optional`) [owner, 2026-11-20: ask a person only what waits on them]: never one
 * of the questions, never shared, and on a form only once the person chooses to, never a required field.
 */
const optional = (item) => item?.optional === true && !item.settled;
/** Everything beside what waits: answers given, what the plan or SFlow settled, and what is offered. */
const besides = (item) => changeable(item) || optional(item);
/** The choice that skips a row, saying what skipping does: what was settled is kept, an offered row keeps its default. */
export const skipWord = (item) => (item.settled ? KEEP_SETTLED : plainWords(item).skip ?? (optional(item) ? LEAVE_AS_IS : LEAVE));
/** What is offered beside the list and is no answer given or settlement: a reviewer's finding, a completeness review. */
const offeredOnly = (item) => optional(item) && !changeable(item);
/** The first form's choice for those, by what they are: "Dispute a reviewer's finding (4)". */
const offerWord = (rows) => (rows.every((item) => item.kind === 'review-finding') ? DISPUTE
  : rows.every((item) => item.kind === 'check-finding') ? OVERRIDE : OPTIONAL);
const listWords = (values) => (values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`);
/** What is offered beside the list, named, never counted: the reviewer's findings by their IDs, then anything else. */
function optionalWords(rows) {
  const findings = rows.filter((item) => item.kind === 'review-finding').map((item) => item.details?.finding ?? bare(item.title));
  // A check's findings by their codes [owner, 2026-11-23].
  const checks = rows.filter((item) => item.kind === 'check-finding').map((item) => item.details?.code ?? bare(item.title));
  const others = rows.filter((item) => !['review-finding', 'check-finding'].includes(item.kind)).map((item) => bare(item.title));
  return [findings.length ? `the reviewer's ${findings.length === 1 ? 'finding' : 'findings'} ${listWords(findings)}, which you may dispute if the reviewer is wrong; left alone, the author fixes ${findings.length === 1 ? 'it' : 'them'}` : null,
    checks.length ? `the check's ${checks.length === 1 ? 'finding' : 'findings'} ${listWords(checks)}, which you may override if the check is wrong; left alone, the author fixes ${checks.length === 1 ? 'it' : 'them'}` : null,
    others.length ? `${listWords(others)}, which you may answer if you disagree` : null].filter(Boolean).join('; and ');
}
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
    // One question with a Yes (owner, 2026-11-19): /sf-approve shows the documents, with those of the steps SFlow approved
    // since the last approval, and asks "Approve <Step> v<N>?" once.
    const strings = (value) => (Array.isArray(value) ? value : []).filter((file) => typeof file === 'string' && file);
    const documents = [...strings(item.details?.documents), ...(Array.isArray(item.details?.covers) ? item.details.covers : []).flatMap((cover) => strings(cover?.documents))];
    const covered = (Array.isArray(item.details?.covers) ? item.details.covers : []).map((cover) => `${cover?.label} v${Number(cover?.generation) || 0}`);
    return [`- ${bare(item.options[0]?.label ?? 'Review and approve')}: /sf-approve${phase ? ` ${phase}` : ''} --work-id ${packet?.workId} shows ${documents.length ? documents.map((file) => `\`${file}\``).join(', ') : 'its documents'} and asks for your Yes once${command ? `; or in your terminal: \`${command}\`` : ''}.`,
      ...(covered.length ? [`  Your Yes also covers ${covered.join(', ')}: SFlow approved them when they were ready.`] : [])];
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

/** What is offered beside the list, one line each, under a line saying nothing waits on it [owner, 2026-11-20]. */
function optionalLines(packet) {
  const rows = cardRows(packet).filter((item) => offeredOnly(item) && !laterOf(item));
  if (!rows.length) return [];
  return ['', `**Optional; nothing waits on these.** Answer one only if you disagree: choose "${offerWord(rows)}" on the first form.`,
    ...rows.map((item) => `- ${bare(item.title)}: ${bare(plainWords(item).why ?? item.why)}.`)];
}

/**
 * The Story's own next step when nothing here waits on this person, from the planner (`decisions` adds `storyNext`):
 * every screen ends with a next action [owner, 2026-11-18]. '' when the list carries none.
 */
export function nextWords(packet) {
  const next = packet?.storyNext;
  if (!next) return '';
  return `Next: ${line(next.title)}: ${next.copilotCommand ?? next.command}${next.copilotCommand && next.command ? ` (or in your terminal: ${next.command})` : ''}.`;
}
const withNext = (message, packet) => [message, nextWords(packet)].filter(Boolean).join(' ');

/** The card: every open item in plain words, then what waits for later, what was settled, and the approval's evidence. */
export function decisionsTable(packet) {
  const asked = askedRows(packet).filter((item) => !besides(item));
  const later = [...cardRows(packet).filter((item) => !item.settled), ...approvalRows(packet)].map(laterOf).filter(Boolean);
  const headline = packet.plain?.headline ?? packet.headline;
  return [`**Decide ${packet.workId} · ${packet.phaseLabel}.** ${line(headline)} Nothing is recorded until you confirm.`,
    ...asked.flatMap((item, index) => itemBlock(item, packet, asked.length > 1 ? index + 1 : null)),
    ...changeableLines(packet), ...optionalLines(packet),
    ...(later.length ? ['', ...later.map((entry) => `Waiting: ${line(entry)}`)] : []),
    ...settledLines(packet), ...evidenceLines(packet),
    // Always the last line: the Story's next step, or what happens once the person answers [owner, 2026-11-18].
    ...(packet.storyNext ? ['', `**${nextWords(packet)}**`] : packet.plain?.afterAnswer ? ['', `**Next: ${line(packet.plain.afterAnswer)}**`] : [])].join('\n');
}

/**
 * The answers one reason may cover: offered by two or more rows this person decides, needing nothing but a
 * reason. A departure's plan row, test or clause-touching wording is decided one by one (`oneByOne`), never
 * here. `others` names the rows offering the same answer that it does not cover: other approvers decide
 * them, and they stay listed for them.
 */
export function sharedAnswers(packet) {
  const seen = new Map();
  // An offered row is never answered for all, nor is an undo of what was settled: each is the person's own, only if they disagree.
  for (const item of decidable(packet).filter((row) => !optional(row) && !row.settled)) {
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
  const open = decidable(packet).filter((item) => !besides(item));
  const offered = decidable(packet).filter((item) => besides(item) && !item.settled);
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
        enum: [...(checkOf(item) ? [checkWord(item)] : []), ...recommendedFirst(item, item.options.filter(choosable)).map((option) => choiceWord(item, option)), skipWord(item)] },
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
  const open = decidable(packet).filter((item) => !besides(item));
  const later = decidable(packet).filter(changeable).length;
  const settled = decidable(packet).filter((item) => item.settled === true);
  const change = later ? `${settled.length === later ? UNDO_SETTLED : CHANGE} (${later})` : null;
  // What is offered beside the list waits behind a choice of its own: never one of the questions [owner, 2026-11-20].
  const offeredRows = decidable(packet).filter(offeredOnly);
  const offer = offeredRows.length ? `${offerWord(offeredRows)} (${offeredRows.length})` : null;
  // Named, never counted: "1. Run Implementation's tests on Node 22? 2. …" [owner, 2026-11-16].
  const asked = (item) => line(plainWords(item).question).replace(/([^.!?])$/u, '$1.');
  const named = open.length ? `${open.length === 1 ? 'One question for you' : `${open.length} questions for you`}: ${open.map((item, index) => `${index + 1}. ${asked(item)}`).join(' ')}`
    : 'Nothing waits on you now.';
  // At most three settled lines, then how many more the Decide page lists [owner, 2026-11-20].
  const shownSettled = `${settled.slice(0, 3).map((item) => line(plainWords(item).settled)).join(' ')}${settled.length > 3 ? ` And ${settled.length - 3} more on the Decide page.` : ''}`;
  const offered = settled.length === later ? `Settled for you: ${shownSettled}`
    : `${later === 1 ? '1 is' : `${later} are`} offered beside the list: an answer already given${settled.length ? ', a file the plan settled, or what SFlow settled for you' : ', or a file the plan settled'}, which you may change if you disagree.`;
  const optionalLine = offeredRows.length ? ` Optional, nothing waits on ${offeredRows.length === 1 ? 'it' : 'them'}: ${optionalWords(offeredRows)}.` : '';
  return { shared, change, offer, form: { message: `${named}${later ? ` ${offered}` : ''}${optionalLine}${shared.map(othersWords).join('')}`,
    requestedSchema: { type: 'object', required: ['choice'], properties: {
      // Keeping everything comes first wherever an undo or a change is offered, so nothing is undone by default.
      choice: { type: 'string', title: 'How do you want to decide?', enum: [...(change ? [KEEP_ALL] : []), ...shared.map((entry) => entry.word), ...(open.length ? [EACH] : []),
        ...(change ? [change] : []), ...(offer ? [offer] : []), ...(change ? [] : [NOT_NOW])] } } } } };
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
    // Only what waits is required: a row offered beside the list is the person's to leave as it is [owner, 2026-11-20].
    requestedSchema: { type: 'object', required: page.flatMap((item, row) => (optional(item) ? [] : [`decision${row}`])), properties: Object.fromEntries(page.map((item, row) =>
      // The recommended choice says so in the list itself, first; the card above has why and what each choice does.
      // An answer given or what the plan settled is named by its file, with what it says now. Its skip says what skipping does.
      // A row beside the list keeps what it is first (its default, or what was settled), so a form never undoes by default.
      [`decision${row}`, { type: 'string', title: clipSentences(changeable(item) ? `${itemName(item)}: ${line(plainWords(item).why ?? item.why)}` : line(plainWords(item).question)),
        enum: besides(item) || item.settled ? [skipWord(item), ...recommendedFirst(item, item.options.filter(choosable)).map((option) => choiceWord(item, option))]
          : [...(checkOf(item) ? [checkWord(item)] : []), ...recommendedFirst(item, item.options.filter(choosable)).map((option) => choiceWord(item, option)), skipWord(item)] }])) } } }));
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
    if (!word || word === LEAVE || word === skipWord(item)) continue;
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

/*
 * A sign-off asked as one question [owner, 2026-11-18]: "Does this screenshot show what AC-002 asks for?" with Yes,
 * No (say what's wrong) or Not sure; the file opens beside it, and answering is the looking. The same words and the
 * same records as src/sign-off-question.mjs, which this card cannot import (a test holds the two equal): Yes confirms
 * all three checks, with the note or CONFIRMED_ON_CARD as its reason; No denies the first two, its note required;
 * Not sure records nothing.
 */
export const SIGN_OFF_ANSWERS = Object.freeze({ yes: 'Yes', no: 'No (say what\'s wrong)', unsure: 'Not sure', self: 'I checked it myself (no screenshot)' });
// A sign-off with no screenshot or file is the person's word about what they checked themselves (owner, 2026-11-22): its note
// is required, and says what they checked, where and how.
export const ATTEST_NOTE = 'Say what you checked yourself, where and how (20 to 1000 characters).';
export const CONFIRMED_ON_CARD = 'Confirmed on the decision card: it shows what the criterion asks for.';
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/iu;
const shortName = (clauseId) => String(clauseId ?? '').slice(String(clauseId ?? '').lastIndexOf(':') + 1);
/** A slot's name as people say it: "layout-structure" is "the layout structure". */
const slotWords = (slot) => (/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(String(slot ?? '')) ? `the ${String(slot).replaceAll('-', ' ')}` : null);

export function signOffQuestion(review, file = review?.files?.[0] ?? null) {
  const subject = review?.method === 'visual' || IMAGE_FILE.test(String(file ?? '')) ? 'this screenshot' : file;
  return `Does ${subject} show what ${shortName(review?.clauseId)} asks for?`;
}

/** The question when there is no screenshot or file to look at: the person's own check is the sign-off. */
export function attestQuestion(review) {
  return `No screenshot: did you check yourself that the app does what ${shortName(review?.clauseId)} asks for?`;
}
export const unsureWords = (workId) => `Nothing was recorded for ${workId}. Ask someone who knows that screen, or take the screenshot again; the sign-off stays open on the Decide card.`;
export function signOffAnswers(answer, note = '', { attest = false } = {}) {
  const text = String(note ?? '').trim();
  if (answer === 'unsure') return { unsure: true };
  // No screenshot (the question asked without one, or "I checked it myself"): the note is the evidence.
  if (attest || answer === 'self') {
    if (text.length < 20 || text.length > 1000) return { problem: ATTEST_NOTE };
    const yes = answer !== 'no';
    return { reason: text, attest: true, answers: [['states-the-outcome', yes], ['matches-the-criterion', yes], ['current-for-this-change', true]] };
  }
  if (answer === 'no' && !text) return { problem: 'Say what is wrong with it (10 to 1000 characters).' };
  if (text && (text.length < 10 || text.length > 1000)) return { problem: 'Keep the note to 10 to 1000 characters.' };
  if (answer === 'yes') return { reason: text || CONFIRMED_ON_CARD, answers: [['states-the-outcome', true], ['matches-the-criterion', true], ['current-for-this-change', true]] };
  if (answer === 'no') return { reason: text, answers: [['states-the-outcome', false], ['matches-the-criterion', false], ['current-for-this-change', true]] };
  return { problem: `Answer ${SIGN_OFF_ANSWERS.yes}, ${SIGN_OFF_ANSWERS.no} or ${SIGN_OFF_ANSWERS.unsure}.` };
}

/** What a sign-off decides and why, in one line: the item's own words when the list gives them. */
function signOffWhat(review, item = null) {
  if (item?.plain?.why) return item.plain.why;
  const named = slotWords(review.slot);
  const check = review.method === 'visual' ? 'tests can\'t check how it looks' : 'tests can\'t check this file';
  return `Sign off ${shortName(review.clauseId)}${named ? `, ${named}` : ''}: ${check}, so a person confirms it.`;
}

/** One sign-off, one question: what is decided and why, the criterion, then Yes, No (say what's wrong) or Not sure. */
export function witnessForm(review, item = null) {
  // No screenshot: the person's own check is the sign-off, and the note saying what they checked is required.
  if (review.attest || !(review.files ?? []).length) return { message: [signOffWhat(review, item), ...(review.clauseText ? [`${shortName(review.clauseId)}: ${review.clauseText}`] : [])].join('\n'),
    requestedSchema: { type: 'object', required: ['answer', 'note'], properties: {
      answer: { type: 'string', title: attestQuestion(review), enum: [SIGN_OFF_ANSWERS.yes, SIGN_OFF_ANSWERS.no, SIGN_OFF_ANSWERS.unsure] },
      note: { type: 'string', title: 'What did you check, where and how?', maxLength: 1000 } } } };
  return { message: [signOffWhat(review, item), ...(review.clauseText ? [`${shortName(review.clauseId)}: ${review.clauseText}`] : []),
    ...(review.files.length === 1 ? ['It is open beside this question.'] : [])].join('\n'),
  requestedSchema: { type: 'object', required: ['answer'], properties: {
    answer: { type: 'string', title: signOffQuestion(review), enum: [SIGN_OFF_ANSWERS.yes, SIGN_OFF_ANSWERS.no, SIGN_OFF_ANSWERS.unsure, SIGN_OFF_ANSWERS.self] },
    // Several files: the person picks the one they looked at; nobody is asked to type a path [PHR:REQ-006].
    ...(review.files.length === 1 ? {} : { file: { type: 'string', title: 'Which file did you look at?', enum: [...review.files] } }),
    note: { type: 'string', title: 'What is wrong (needed for No; for Yes, optional); what you checked, for I checked it myself', maxLength: 1000 } } } };
}

export function witnessAnswers(review, content) {
  const attest = review.attest === true || !(review.files ?? []).length;
  if (attest) {
    const answer = Object.entries(SIGN_OFF_ANSWERS).find(([, word]) => word === content?.answer)?.[0];
    if (!answer) return { problem: `Answer ${SIGN_OFF_ANSWERS.yes}, ${SIGN_OFF_ANSWERS.no} or ${SIGN_OFF_ANSWERS.unsure}.` };
    const given = signOffAnswers(answer, content?.note, { attest: true });
    if (given.unsure) return { problem: null, unsure: true };
    if (given.problem) return { problem: given.problem };
    return { problem: null, file: null, attest: true, reason: given.reason, answers: given.answers };
  }
  const file = review.files.length === 1 ? review.files[0] : String(content?.file ?? '').trim();
  if (!review.files.includes(file)) return { problem: `Pick the file you looked at: ${review.files.join(', ')}.` };
  const answer = Object.entries(SIGN_OFF_ANSWERS).find(([, word]) => word === content?.answer)?.[0];
  if (!answer) return { problem: `Answer ${SIGN_OFF_ANSWERS.yes}, ${SIGN_OFF_ANSWERS.no} or ${SIGN_OFF_ANSWERS.unsure}.` };
  const given = signOffAnswers(answer, content?.note);
  if (given.unsure) return { problem: null, unsure: true };
  if (given.problem) return { problem: given.problem };
  // "I checked it myself (no screenshot)": recorded with no file, whatever was open beside it.
  if (given.attest) return { problem: null, file: null, attest: true, reason: given.reason, answers: given.answers };
  return { problem: null, file, reason: given.reason, answers: given.answers };
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
  const { shared, change, offer, form } = firstForm(packet);
  let answers = [];
  let changing = false;
  let offering = false;
  if (shared.length || change || offer) {
    const first = await askUntilRight(ask, form, (content) => (form.requestedSchema.properties.choice.enum.includes(content.choice)
      ? { choice: content.choice } : { problem: 'Choose one of these.' }));
    if (first.cancelled || first.choice === NOT_NOW || first.choice === KEEP_ALL) return { cancelled: true };
    if (first.refused) return first;
    changing = first.choice === change;
    offering = first.choice === offer;
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
  // What is offered, only once the person chose it too, never required (rowForms).
  const waits = rows.filter((item) => !besides(item));
  for (const page of rowForms(changing ? [...rows.filter(changeable), ...waits] : offering ? [...rows.filter(offeredOnly), ...waits] : waits)) {
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

/**
 * The items whose answer waits on a check SFlow runs itself before it asks, in words: "run the tests on Node 22". One
 * that runs only when the person asks for it (SFlow's screenshot builds the app) is offered on its row instead.
 */
const checkNames = (packet) => cardRows(packet).filter((item) => checkOf(item) && !checkOf(item).onRequest && item.decidedBy?.allowed)
  .map((item) => checkOf(item).label.replace(/^Check first: /u, ''));

/**
 * The whole conversation with one person. `ask(form)` answers `{ action, content }`, `show(text)` prints,
 * `read({ probe })` reads the list (with `probe`, after SFlow ran its checks for at most that many seconds),
 * `record(packet, document)` writes the choices, `witness(packet, review, answer)` writes one sign-off and
 * `inspect(packet, file)` puts a file in front of the person. The caller passes these in, so a test can run every
 * route and no route can be answered by anything but `ask`.
 */
/**
 * The start of a step's next version as the card asks it: the proposal's own question, yes or not now [D3, OSA Stage 4]; for
 * a version proposed for words the person typed, a third answer, "No, it was just a question" (owner, 2026-11-18).
 */
export const START_VERSION = 'Yes, start it';
export const JUST_A_QUESTION = 'No, it was just a question';
const QUESTION_NOTE = `"${JUST_A_QUESTION}" keeps what you typed as a question and starts nothing.`;
export function versionOpeningForm(opening, { question = true } = {}) {
  const third = opening.justAQuestion === true && question;
  return { message: `${opening.question}\nYour yes is kept for this exact proposal; the step's work command then opens it. Nothing starts on "Not now".${third ? ` ${QUESTION_NOTE}` : ''}`,
  requestedSchema: { type: 'object', required: ['start'], properties: { start: { type: 'string', title: 'Start it?', enum: [START_VERSION, ...(third ? [JUST_A_QUESTION] : []), NOT_NOW] } } } };
}

/**
 * A step's next version waiting for the person's yes (the list's `versionOpening`): asked first, as its own question.
 * `consent(opening)` records the yes outside the chat (`decisions record --version-consent`); `question(opening)` records
 * "No, it was just a question" the same way (`decisions record --just-a-question`), and opens nothing. Null when none waits.
 */
async function askVersionOpening(packet, { ask, show, consent, question = null }) {
  const opening = packet?.versionOpening;
  if (!opening || !consent) return null;
  const answer = await ask(versionOpeningForm(opening, { question: Boolean(question) }));
  if (answer?.action === 'accept' && answer.content?.start === JUST_A_QUESTION && question && opening.justAQuestion === true) {
    const result = await question(opening);
    await show(result?.words ?? `Version ${opening.version} of ${opening.phase} was not started; what you typed is kept as a question.`);
    return { started: false, answered: true, words: result?.words ?? null, next: result?.next ?? null };
  }
  if (answer?.action !== 'accept' || answer.content?.start !== START_VERSION) return { started: false };
  const result = await consent(opening);
  await show(result?.words ?? `Your yes to start version ${opening.version} of ${opening.phase} is kept.`);
  // What really happens next, in the engine's words, and its route: the step's work command, which asks nothing again.
  return { started: true, words: result?.words ?? null, next: result?.next ?? null };
}

export async function runCard({ ask, show, read, record, witness, inspect, screenshot = null, consent = null, question = null, askedInChat = false }) {
  let packet = await read();
  const opening = await askVersionOpening(packet, { ask, show, consent, question });
  if (opening?.started && !(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'recorded', recorded: ['version-opening'], remaining: [],
    message: opening.words ?? `Your yes to start version ${packet.versionOpening.version} of ${packet.versionOpening.phase} is kept; its work command opens it.`,
    ...(opening.next ? { next: opening.next } : {}) };
  // "No, it was just a question": recorded, nothing opened, and nothing more asked about it (owner, 2026-11-18). It changed the
  // Story, so the list is read again for anything else that waits.
  const answered = opening?.answered ? opening.words ?? `Version ${packet.versionOpening.version} of ${packet.versionOpening.phase} was not started; what you typed is kept as a question` : null;
  if (answered) packet = await read();
  if (answered && !(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'recorded', recorded: ['version-question'], remaining: [],
    message: answered, ...(opening.next ? { next: opening.next } : {}) };
  // A chat that asked carries on when nothing waits: only a person who typed /decide sees a review nothing waits on.
  // What was settled is said in one line at most, never asked [owner, 2026-11-20].
  if (!(askedInChat ? openRows(packet) : cardRows(packet)).length) return { status: 'nothing-to-decide', message: withNext([packet.headline, packet.plain?.settledLine].filter(Boolean).join(' '), packet), recorded: [], remaining: [],
    ...(packet.storyNext ? { next: packet.storyNext } : {}) };
  // What an answer depends on, SFlow checks before it asks, read-only and bounded [owner, 2026-11-16].
  if (checkNames(packet).length) {
    await show(`Checking first: ${checkNames(packet).join('; ')} (up to ${CHECK_SECONDS} seconds; nothing is recorded).`);
    // A read that fails here asks from the list as first read: the check is then offered first.
    packet = await read({ probe: CHECK_SECONDS }).catch(() => packet);
  }
  await show(decisionsTable(packet));
  // Nothing on the list is this person's to act on now: said, with why and what it holds, never an empty form [owner, 2026-11-18].
  if (!answered && packet.plain?.nothingToRecord && !cardRows(packet).flatMap(reviews).length) {
    await show(packet.plain.nothingToRecord);
    return { status: 'nothing-recordable', recorded: [], remaining: openRows(packet).map((item) => itemName(item)), message: withNext(packet.plain.nothingToRecord, packet),
      ...(packet.storyNext ? { next: packet.storyNext } : {}) };
  }
  const recorded = answered ? ['version-question'] : [];
  // What was decided, in its own words: this is what the agent reports back, and a record's ID does not say it.
  const decided = answered ? [answered.replace(/\.$/u, '')] : [];
  // Nothing more recorded after that answer: it still stands, and is said.
  const none = () => (answered ? { status: 'recorded', recorded, remaining: openRows(packet).map((item) => itemName(item)), message: `${decided[0]}. No other decision was recorded.` }
    : { status: 'cancelled', recorded, remaining: [], message: 'No decision was recorded.' });
  // Drafts written, never recorded: where each is and what is next [SCS:REQ-020].
  const drafted = [];
  // A pin or plan amendment that changed the open code step after its summary was written [owner, 2026-11-13].
  let summaryUpdate = null;
  // A decision after which a task's step goes on (a refactor's behaviour): how the chat carries on, in the engine's words.
  let continueTask = null;
  let asked = decidable(packet).length ? await askRows(packet, ask) : { answers: [] };
  // "Check first": SFlow runs it with the time the person chose to give it, then asks again once with what it found.
  for (let round = 0; asked.check && round < 2; round += 1) {
    // A check that failed says why, in its own words (a screenshot whose build failed), not that it ran out of time.
    if (round === 1) return { status: 'cancelled', recorded, remaining: [], message: checkOf(asked.check)?.failed ? `${checkOf(asked.check).failed} Nothing was recorded.` : 'The check gave no answer in time; nothing was recorded.' };
    const shot = checkOf(asked.check);
    if (shot.kind === 'screenshot') {
      // The person's own capture at SFlow's browser (`decision screenshot`), never a check SFlow runs [owner, 2026-11-18].
      if (!screenshot) return { status: 'needs-terminal', recorded, remaining: [], command: shot.command, message: `Take the screenshot in your own terminal: ${shot.command}` };
      await show(`${shot.does}`);
      try { await screenshot(packet, shot); } catch (error) { await show(`No screenshot was taken: ${error.message}`); }
      packet = await read();
    } else {
      await show(`Checking: ${shot.label.replace(/^Check first: /u, '')} (up to ${CHECK_FIRST_SECONDS / 60} minutes; nothing is recorded).`);
      packet = await read({ probe: CHECK_FIRST_SECONDS });
    }
    await show(decisionsTable(packet));
    asked = decidable(packet).length ? await askRows(packet, ask) : { answers: [] };
  }
  if (asked.cancelled) return none();
  if (asked.refused) return { status: 'refused', recorded, remaining: [], message: refusedWords(asked.refused) };
  let { answers } = asked;
  while (answers.length) {
    const confirmed = await ask(confirmForm(packet, answers));
    if (confirmed?.action !== 'accept' || confirmed.content?.confirm !== RECORD) return none();
    try {
      const result = await record(packet, answersDocument(packet, answers));
      recorded.push(...(result.recorded ?? []).map((entry) => entry.record ?? entry.item));
      decided.push(...(result.decided ?? []).map((entry) => entry.words));
      drafted.push(...(result.drafted ?? []).map((entry) => `Drafted at ${entry.path}. ${entry.next?.words ?? ''}`.trim()));
      summaryUpdate = result.summaryUpdate?.words ?? summaryUpdate;
      continueTask = result.continueTask ?? continueTask;
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
    const item = cardRows(packet).find((row) => row.options.some((option) => option.action?.humanReview?.clauseId === current.clauseId
      && option.action.humanReview.slot === current.slot)) ?? null;
    const answer = await askUntilRight(ask, witnessForm(current, item), (content) => witnessAnswers(current, content));
    if (answer.refused) return { status: 'refused', recorded, remaining: [], message: refusedWords(answer.refused) };
    if (answer.cancelled) continue;
    if (answer.unsure) { await show(unsureWords(packet.workId)); continue; }
    // One sign-off that cannot be recorded never loses the decisions and sign-offs already recorded.
    try {
      const result = await witness(packet, current, answer);
      if (result?.record?.id) {
        recorded.push(result.record.id);
        decided.push(`${shortName(current.clauseId)} ${result.record.outcome === 'met' ? 'signed off' : 'not signed off: what is wrong is recorded'}`);
      }
    } catch (error) {
      await show(`The sign-off of ${shortName(current.clauseId)} was not recorded: ${error.message}`);
    }
    packet = await read();
  }
  const remaining = openRows(packet).map((item) => itemName(item));
  // The list as it stands after what was recorded: with nothing left that waits on this person, the Story's next step.
  return { status: recorded.length ? 'recorded' : drafted.length ? 'drafted' : 'cancelled', recorded, decided, ...(drafted.length ? { drafted } : {}), remaining,
    ...(summaryUpdate ? { summaryUpdate } : {}), ...(packet.storyNext ? { next: packet.storyNext } : {}),
    ...(continueTask ? { continueTask, instruction: continueTask.instruction } : {}),
    message: withNext(`${decided.length ? `${decided.length} decision${decided.length === 1 ? '' : 's'} recorded. ${decided.join('. ')}.` : recorded.length ? `${recorded.length} recorded.` : 'No decision was recorded.'}`
      + `${drafted.length ? ` ${drafted.join(' ')}` : ''}${remaining.length ? ` ${remaining.length} still open.` : ' All decided.'}${summaryUpdate ? ` ${summaryUpdate}` : ''}`, packet) };
}
