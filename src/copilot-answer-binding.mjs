/**
 * A chat decision carries what the person answered. In a turn that owns a person's decision, the guard
 * used to admit a command with any reason at all: "the person types every choice" was skill text, and a
 * host can answer a question itself (Autopilot, auto-reply), telling the model to choose. The post-tool
 * hook hands over each question's answer, so a decision command is held to it here.
 *
 * Each host says it differently, read from what it ships:
 * - Copilot CLI and VS Code's agent host: `toolName: 'ask_user'`, `toolResult.textResultForLlm`
 *   ("User responded: disposition=rework, reason=..."); real hook payload, session 5bc9aada.
 * - VS Code's own chat: `tool_name: 'vscode_askQuestions'`, `tool_response` holding the JSON
 *   { answers: { <header>: { selected, freeText, skipped } } } (AskQuestionsTool, VS Code 1.145). Never seen
 *   from a real run, and nothing shows its hooks see this tool, so that chat is held only to an answer that
 *   actually arrived: with none, it is left as it was.
 * On any host a question whose answer never arrived proves nothing, so it refuses nothing, except a command that
 * records a yes or no: that one needs the person's own yes or no for its row (yesNoProblem). Only tightens: nothing
 * here admits a command the guard would otherwise refuse. Reads and writes one private file per turn.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ANSWER_BOUND_STEPS, ANSWER_BOUND_TURNS, PLAN_CORRECTION_FLAGS } from './person-step-catalog.mjs';

export { ANSWER_BOUND_TURNS };
const WORD_FLAGS = Object.freeze(['reason', 'supporting-reason', 'article-reason', 'cause']);
// VS Code's two auto-replies, and any wording of the same sentence a later host uses.
const HOST_AUTO_REPLY = /the user is not available to (?:answer|respond)/iu;
const DECLINED = /^user (?:declined|cancelled|canceled|skipped|did not)/iu;
const MAX_ANSWERS = 200;

export const answerBoundStep = (step) => ANSWER_BOUND_STEPS.includes(step?.id);

const comparable = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[.!?;,]+$/u, '');

// A host's own flags beside an answer, never the person's words: VS Code's `skipped: false` read as "false" made a
// person's "rework" a No (11-17 landing check).
const ANSWER_FLAGS = new Set(['skipped', 'canceled', 'cancelled', 'canned', 'dismissed', 'timedOut', 'timedout']);
/** Every string a parsed answer holds, a form's true or false as its word, at most MAX_ANSWERS of them; a skipped entry and a host's flags give none. */
function stringLeaves(value, found = [], key = null) {
  if (found.length >= MAX_ANSWERS) return found;
  if (typeof value === 'string') found.push(value);
  else if (typeof value === 'boolean') { if (!ANSWER_FLAGS.has(key)) found.push(String(value)); }
  else if (value && typeof value === 'object' && value.skipped !== true) for (const [name, entry] of Object.entries(value)) stringLeaves(entry, found, name);
  return found;
}

/** What one question's result says the person answered, on whichever host; `canned` when the host answered instead. */
export function answerOfQuestion(payload) {
  const result = payload.toolResult ?? payload.tool_result ?? payload.tool_response ?? null;
  if (result === null) return null;
  const raw = typeof result === 'string' ? result : result.textResultForLlm ?? result.content ?? '';
  if (typeof raw !== 'string' || !raw.trim()) return { texts: [], canned: false };
  if (HOST_AUTO_REPLY.test(raw)) return { texts: [], canned: true };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const answers = parsed?.answers ?? null;
  if (answers && typeof answers === 'object') {
    return { canned: false, texts: Object.values(answers).filter((entry) => entry && !entry.skipped)
      .flatMap((entry) => [...(entry.selected ?? []), ...(entry.freeText ? [entry.freeText] : [])]).map(comparable).filter(Boolean) };
  }
  // Another JSON shape (an older or newer VS Code than 1.145): each of its words as the person gave it, never the
  // JSON text, whose escaping would make their own words read as not theirs.
  if (parsed && typeof parsed === 'object') return { canned: false, texts: stringLeaves(parsed).map(comparable).filter(Boolean) };
  const said = raw.replace(/^user (?:responded|selected|answered):?\s*/iu, '');
  return DECLINED.test(raw) ? { texts: [], canned: false } : { texts: [comparable(said)], canned: false };
}

const ledgerFile = (mutationFile) => mutationFile.replace(/\.mutation\.json$/u, '.answers.json');

async function readLedger(file, turnId) {
  try {
    const value = JSON.parse(await readFile(ledgerFile(file), 'utf8'));
    if (value?.turnId === turnId) return { replies: [], calls: 0, ...value };
  } catch { /* None yet, or unreadable: this turn starts again. */ }
  return { turnId, prompt: '', asked: 0, delivered: 0, canned: 0, answers: [], replies: [], calls: 0 };
}

async function writeLedger(file, value) {
  const target = ledgerFile(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if ((await lstat(path.dirname(target))).isSymbolicLink()) return;
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** What the person typed with the skill counts as what they said. */
export async function startAnswerLedger(file, record, prompt) {
  await writeLedger(file, { ...await readLedger(file, record.turnId), prompt: comparable(prompt).slice(0, 8000) });
}

export async function noteQuestionAsked(file, record) {
  const value = await readLedger(file, record.turnId);
  await writeLedger(file, { ...value, asked: value.asked + 1 });
}

export async function noteQuestionAnswered(file, record, payload) {
  const answer = answerOfQuestion(payload);
  if (!answer) return;
  const value = await readLedger(file, record.turnId);
  // Each question with what it asked, so a yes or no is read against the row it was asked for.
  const replies = answer.canned ? [] : repliesOfQuestion(payload).map((reply) => ({ ...reply, call: value.calls + 1 }));
  await writeLedger(file, { ...value, delivered: value.delivered + 1, canned: value.canned + Number(answer.canned),
    answers: [...value.answers, ...answer.texts].slice(-MAX_ANSWERS), replies: [...value.replies, ...replies].slice(-MAX_ANSWERS), calls: value.calls + 1 });
}

/**
 * Each question one call asked, with what the person gave for it: `ask_user` asks one ({ question } or { message }), its
 * answer a line or a form's `field=value, field=value`; `vscode_askQuestions` asks several ({ questions: [{ header,
 * question }] }), each answered under its header. A skipped one is no reply.
 */
export function repliesOfQuestion(payload) {
  let input = payload.toolArgs ?? payload.tool_input ?? payload.toolInput ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
  const result = payload.toolResult ?? payload.tool_result ?? payload.tool_response ?? null;
  const raw = typeof result === 'string' ? result : result?.textResultForLlm ?? result?.content ?? '';
  if (typeof raw !== 'string' || !raw.trim() || HOST_AUTO_REPLY.test(raw) || DECLINED.test(raw)) return [];
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (parsed?.answers && typeof parsed.answers === 'object') {
    const questions = Array.isArray(input?.questions) ? input.questions : [];
    return Object.entries(parsed.answers).filter(([, entry]) => entry && !entry.skipped).map(([header, entry]) => ({
      asked: comparable([header, questions.find((question) => question?.header === header)?.question].filter((text) => typeof text === 'string').join(' ')),
      texts: [...(entry.selected ?? []), ...(entry.freeText ? [entry.freeText] : [])].map(comparable).filter(Boolean) }));
  }
  const said = comparable(raw.replace(/^user (?:responded|selected|answered):?\s*/iu, ''));
  const asked = [input?.question, input?.message].find((text) => typeof text === 'string') ?? '';
  // Another JSON shape: each value the person gave, a form's true or false among them.
  if (parsed && typeof parsed === 'object') {
    const texts = stringLeaves(parsed).map(comparable).filter(Boolean);
    return texts.length ? [{ asked: comparable(asked), texts }] : [];
  }
  // A form's fields, each on its own, and the whole line.
  return said ? [{ asked: comparable(asked), texts: [said, ...said.split(/,\s*(?=[\w-]+=)/u).map((field) => field.replace(/^[\w-]+=/u, ''))] }] : [];
}

/** The words a person would have to have said, from a decision command's flags: `--reason d1=TEXT` is TEXT. */
export function wordsOfCommand(options) {
  return WORD_FLAGS.flatMap((flag) => [options[flag]].flat()).filter((value) => typeof value === 'string' && value.trim())
    .map((value) => comparable(value.replace(/^d\d{1,3}=/u, '')));
}

const REFUSAL = 'PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded.';
const NEVER = /(?!)/u;
const ROUTES = 'A person can also answer on the decisions card (sflowDecide or sflow_decide with the Story ID) or in their own terminal (singularity-flow decisions record <WORK-ID>).';

/**
 * Each answer-bound decision command's reason, as its own command checks it (state.mjs revalidate, upstream-issues.mjs,
 * evidence/applicability.mjs, departures.mjs, plan-amendments.mjs, scope/decisions.mjs). A reason out of range was refused
 * by the command, and a refused decision command ended the /sf-decide turn: a dead end for the person [owner, 2026-11-14].
 * Refused here, the turn asks them again. test/still-holds-in-chat.test.mjs holds these to the list's own needs.
 */
export const REASON_RULES = Object.freeze({
  'upstream-issue revalidate': { reason: [20, 1000] }, 'upstream-issue decide': { reason: [20, 1000] },
  'decision applicability': { reason: [20, 1000] }, 'decision departure': { reason: [20, 1000] },
  'decision plan': { reason: [20, 1000], 'supporting-reason': [10, 500] }, 'decision scope': { reason: [20, 1000] },
  'decision completeness': { reason: [20, 1000] }
});

function reasonLengthProblem(positionals, options) {
  for (const [flag, [minimum, maximum]] of Object.entries(REASON_RULES[positionals.slice(0, 2).join(' ')] ?? {})) {
    if (flag === 'supporting-reason' && options['add-supporting'] === undefined) continue;
    const length = String(typeof options[flag] === 'string' ? options[flag] : '').trim().length;
    if (length < minimum) return `${REFUSAL} Its --${flag} has ${length} characters, and this command takes ${minimum} to ${maximum}. Ask the person for a reason of at least ${minimum} characters, then run it again with their words; nothing else needs asking again.`;
    if (length > maximum) return `${REFUSAL} Its --${flag} has ${length} characters, and this command takes ${minimum} to ${maximum}. Ask the person for a reason of at most ${maximum} characters, then run it again with their words; nothing else needs asking again.`;
  }
  return null;
}

/**
 * What a command records as a yes or no in chat, read from the command itself [owner, 2026-11-14], or null: a "still holds"
 * row (`revalidate`: yes `unchanged`, no `return`), a departure (yes `accepted`, no `rejected`), and the one-choice items, an
 * applicability and a plan row (`only`), whose no records nothing. `names` are the words its row's question carries
 * (decision-advice.mjs yesNoOf); `ids` what names another row of the same kind; `typed` its options as the list numbers them.
 */
function yesNoCommand([command, sub, third], options, version = null) {
  const text = (flag) => [options[flag]].flat().filter((value) => typeof value === 'string');
  if (command === 'upstream-issue' && sub === 'revalidate') {
    const records = { unchanged: 'yes', return: 'no' }[options.outcome];
    return records ? { records, row: `revalidate ${text('amendment')[0]} ${third}`, names: [...text('amendment'), third], ids: /\b(?:fam|amd) \d{3,}\b/u,
      yes: ['still holds', 'it still holds'], no: ['redo', 'redo it'], typed: { yes: /\bd\d{1,3}=still-holds\b/u, no: /\bd\d{1,3}=return-step\b/u } } : null;
  }
  if (command === 'decision' && sub === 'departure') {
    const records = { accepted: 'yes', rejected: 'no' }[options.as];
    // The card asks "Keep this change (DEP-002): …?": Keep is its yes [owner, 2026-11-19].
    return records ? { records, row: `departure ${text('departure')[0]}`, names: text('departure'), ids: /\bdep \d{3,}\b/u,
      yes: ['accept', 'keep', 'keep it'], no: ['reject'], typed: { yes: /\bd\d{1,3}=accept[\w-]*/u, no: /\bd\d{1,3}=reject\b/u } } : null;
  }
  if (command === 'decision' && sub === 'applicability') return { records: 'yes', only: true, row: `applicability ${text('responsibility')[0]}`, names: text('responsibility'), yes: [], no: [] };
  // Proposing an intent amendment from chat, under SPEC-CIC switch 3 [CIC:REQ-015, owner decision 3]: only on the person's own
  // yes to its preview, their latest yes or no in this turn; a no, Not now or no answer proposes nothing. Never typed ahead.
  if (command === 'story' && sub === 'intent-amendment' && third === 'propose') {
    const file = text('file')[0] ?? '<FILE>';
    return { records: 'yes', proposal: true, row: `propose ${file}`, names: [], ids: NEVER, yes: ['propose it'], no: ['do not propose', "don't propose"],
      typed: { yes: NEVER, no: NEVER }, terminal: `singularity-flow story intent-amendment propose --work-id ${text('work-id')[0] ?? '<WORK-ID>'} --file "${file}" --reason "<why>" --authored human` };
  }
  // Starting a step's next version (`phase rollover --confirm`) in an authoring turn: only on the person's own yes to a question
  // that asks to start it, in this turn; a no, Not now, the host's own reply or no answer starts nothing [owner, 2026-11-16].
  // With `--as-question` it records the third answer, only on the person's own "No, it was just a question" to that same
  // question; it opens nothing (owner, 2026-11-18).
  if (command === 'phase' && sub === 'rollover' && typeof options.confirm === 'string') {
    const question = asQuestion(options);
    return { records: question ? 'question' : 'yes', proposal: true, successor: true, version, row: `${question ? 'question' : 'rollover'} ${third}`, names: [], ids: NEVER,
      yes: ['start it'], no: ["don't start", 'do not start'], typed: { yes: NEVER, no: NEVER }, terminal: `singularity-flow phase rollover ${third ?? '<step>'}` };
  }
  // A plan row correction [owner, 2026-11-19]: only on the person's own yes to a question that showed its exact rows, each
  // clause and what it becomes, in this turn; never another yes, and no question records nothing.
  const corrections = PLAN_CORRECTION_FLAGS.flatMap((flag) => text(flag));
  if (command === 'decision' && sub === 'plan' && corrections.length) {
    const names = [...new Set(corrections.flatMap((entry) => entry.split(/[=:,]/u)).map((word) => word.trim()).filter(Boolean)
      .map((word) => (/^[A-Za-z0-9._-]+:[A-Za-z]{2,4}-\d{3}$/u.test(word) ? word.split(':').at(-1) : word)))];
    return { records: 'yes', only: true, required: true, row: `plan correction ${names.join(' ')}`, names, yes: ['keep', 'keep it'], no: [] };
  }
  if (command === 'decision' && sub === 'plan' && (options['add-location'] !== undefined || options['add-supporting'] !== undefined)) {
    const paths = [...text('add-location').map((entry) => entry.slice(entry.indexOf('=') + 1)), ...text('add-supporting').map((entry) => entry.split('=')[0])].sort();
    return { records: 'yes', only: true, row: `plan ${paths.join(' ')}`, names: paths, yes: [], no: [] };
  }
  return null;
}

/**
 * Whether a command carries `--as-question`, read as the CLI reads it (util.mjs optionBoolean): any value but false, 0, no or
 * off. A value the CLI cannot read is held as the question too, the stricter binding (owner, 2026-11-18).
 */
export function asQuestion(options) {
  const value = [options?.['as-question']].flat().at(-1);
  return value !== undefined && !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
}

/** A question that asks to start a version: that exact one when the preview's number is known. */
const successorQuestion = (version) => new RegExp(`\\b(?:start|open|begin)\\b[^?]*\\b(?:version|generation|draft) ${Number.isSafeInteger(version) ? version : '\\d+'}\\b`, 'u');

// Hyphens and underscores read as spaces on both sides, so "fix-design" is named by "Fix design".
const named = (text) => comparable(text).replace(/[-_]+/gu, ' ');
const sideWords = (words) => new RegExp(`^(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})(?:$|\\s*[.,;:!]|\\s+[-\u2013\u2014])`, 'u');

// The version question's third answer, "No, it was just a question" (owner, 2026-11-18): its own side, never a plain No.
const JUST_A_QUESTION = /^(?:no\s*[,.;:!-]?\s*)?(?:it\s+(?:was|is)\s+|it's\s+)?(?:just|only)\s+a\s+question$/u;

/**
 * What one reply says of a yes or no: `yes`, `no`, `not-now`, `question` (the version question's "No, it was just a question"),
 * or null when it is no yes or no (a reason, say). A form's true or false field is its yes or no: asked with one, Copilot CLI
 * hands over "User responded: true", and the person was asked again.
 */
export function sideOf(reply, yesNo) {
  const yes = sideWords(['yes', 'true', ...yesNo.yes]); const no = sideWords(['no', 'false', ...yesNo.no]); const later = sideWords(['not now']);
  for (const value of reply.texts ?? []) {
    const text = typeof value === 'boolean' ? String(value) : value;
    if (later.test(text)) return 'not-now';
    if (typeof text === 'string' && JUST_A_QUESTION.test(text)) return 'question';
    if (yes.test(text)) return 'yes';
    if (no.test(text)) return 'no';
  }
  return null;
}

/**
 * The person's own yes or no for this command's row, as { reply, side }, or { problem }. Their reply to the question that
 * names the row; else, for a two-sided row, their latest yes or no that names no other row and no other row has used; else
 * what they typed with the skill. One yes or no carries one row. A one-choice item (`only`) is held only to a question that
 * names it: its no records nothing, so with none the command stands as before.
 */
function yesNoAnswer(ledger, yesNo) {
  const replies = ledger.replies.map((reply, index) => ({ reply, index, side: sideOf(reply, yesNo) }))
    .filter((entry) => entry.side && (!entry.reply.usedBy || entry.reply.usedBy === yesNo.row));
  // A proposal stands only on the answer to a question that asked whether to propose it, never on another yes; a next
  // version only on one that asked to start that exact version ("Start version 2 of Code to fix the review's findings?"),
  // its number the one the preview proposed [OSA §7.1, REQ-030].
  if (yesNo.proposal) return replies.filter((entry) => (yesNo.successor ? successorQuestion(yesNo.version) : /\bpropose\b/u)
    .test(named(entry.reply.asked))).at(-1) ?? { problem: 'none' };
  const names = (entry) => yesNo.names.length && yesNo.names.every((word) => named(entry.reply.asked).includes(named(word)));
  // A one-choice item reads only a question that names it, never one about an amendment or a departure.
  const mine = replies.filter((entry) => names(entry) && !(yesNo.only && /\b(?:fam|amd|dep) \d{3,}\b/u.test(named(entry.reply.asked))));
  if (mine.length) return mine.at(-1);
  // A row that must be shown before it is kept (a plan row correction) stands on no other answer.
  if (yesNo.required) return { problem: 'none' };
  if (yesNo.only) return null;
  const free = replies.filter((entry) => !yesNo.ids.test(named(entry.reply.asked)));
  const last = free.at(-1);
  if (last) {
    // Several rows answered in one form, and nothing says which answer is this one's.
    const sides = new Set(free.filter((entry) => entry.reply.call === last.reply.call).map((entry) => entry.side));
    return sides.size > 1 ? { problem: 'ambiguous' } : last;
  }
  const typed = ['yes', 'no'].filter((side) => yesNo.typed[side].test(ledger.prompt));
  return typed.length === 1 ? { side: typed[0], reply: null } : { problem: typed.length ? 'ambiguous' : 'none' };
}

function yesNoProblem(ledger, yesNo, { localChat = false } = {}) {
  const found = yesNoAnswer(ledger, yesNo);
  if (!found) return null;
  if (yesNo.proposal) return proposalProblem(found, ledger, yesNo, { localChat });
  const records = yesNo.records === 'yes' ? 'Yes' : 'No';
  // VS Code's own chat may never hand this hook the answer: asking again would meet this refusal again.
  if (found.problem === 'none' && localChat && !ledger.delivered) {
    return `${REFUSAL} This chat's answers do not reach SFlow, so a yes or no for this row cannot be recorded here; do not ask again in this chat. The person answers it on the decisions card (sflowDecide or sflow_decide with the Story ID) or in their own terminal (singularity-flow decisions record <WORK-ID>); go on to the next item.`;
  }
  if (found.problem === 'none' && yesNo.required) {
    return `${REFUSAL} A plan row correction is kept only on the person's own answer to a question that shows its exact rows (${yesNo.names.join(', ')}), and none in this turn did. Ask them once, naming each clause and what it becomes (Keep, Not now), with your question tool (ask_user; in VS Code, vscode_askQuestions), then run it with their words. ${ROUTES}`;
  }
  if (found.problem === 'none') {
    return `${REFUSAL} This command records a yes or no for one row, and the person gave none for it in this turn. Ask them that row's yes-or-no question (Yes, No, Not now) with your question tool (ask_user; in VS Code, vscode_askQuestions), then run the command of the answer they chose with their words. ${ROUTES}`;
  }
  if (found.problem === 'ambiguous') {
    return `${REFUSAL} The person answered several rows yes and no together, and nothing says which answer is this row's. Ask them this row's question on its own (Yes, No, Not now), then run the command of the answer they chose. ${ROUTES}`;
  }
  if (found.side === 'not-now') return `${REFUSAL} The person chose Not now for this row: record nothing for it, and go on to the next item.`;
  if (found.side !== yesNo.records) {
    return `${REFUSAL} The person answered ${found.side === 'yes' ? 'Yes' : 'No'} for this row, and this command records ${records}. Run the command of the answer they gave${yesNo.only ? ' (No records nothing)' : ''}, or ask them again if you are not sure; never record the other answer for them.`;
  }
  return null;
}

/**
 * Why an intent amendment may not be proposed yet [owner decision 3, 2026-11-14]: the person has not said yes to its preview
 * in this turn, said no or Not now, or their answers do not reach SFlow in this chat (VS Code's own chat), where they propose
 * it in their own terminal. Each names what to do next in this same turn; none decides or acknowledges anything.
 */
function proposalProblem(found, ledger, yesNo, { localChat }) {
  if (yesNo.successor) return successorProblem(found, ledger, yesNo, { localChat });
  if (found.problem === 'none' && localChat && !ledger.delivered) {
    return `${REFUSAL} This chat's answers do not reach SFlow, so the person's yes to proposing it cannot be read here; do not ask again in this chat. They propose it in their own terminal, with their reason: ${yesNo.terminal}`;
  }
  if (found.problem === 'none') {
    return `${REFUSAL} An intent amendment is proposed only on the person's own yes. Show them its preview in plain words (what changes, how big it is and why, what is redone, what is kept, who decides), ask "Propose it?" (Yes, No) with your question tool (ask_user; in VS Code, vscode_askQuestions), and run it again only after their Yes, with their own words as --reason.`;
  }
  if (found.problem === 'ambiguous') return `${REFUSAL} The person answered yes and no together; ask "Propose it?" on its own (Yes, No), and propose only after their Yes.`;
  if (found.side === 'not-now' || found.side === 'no') return `${REFUSAL} The person did not say yes to proposing it: propose nothing, and tell them the draft stays where it is.`;
  return null;
}

/**
 * Why a step's next version may not start yet: the person has not said yes to starting it in this turn, said no or Not now,
 * or their answers do not reach SFlow in this chat. Each names what to do next; none starts anything [owner, 2026-11-16].
 */
function successorProblem(found, ledger, yesNo, { localChat }) {
  if (yesNo.records === 'question') return questionProblem(found, ledger, yesNo, { localChat });
  const theirs = `They can start it themselves: the preview's /sf-confirm code, or in their own terminal ${yesNo.terminal}, which asks them.`;
  if (found.problem === 'none' && localChat && !ledger.delivered) {
    return `${REFUSAL} This chat's answers do not reach SFlow, so the person's yes to starting the next version cannot be read here; do not ask again in this chat. ${theirs}`;
  }
  if (found.problem === 'none') {
    return `${REFUSAL} Starting the step's next version is the person's yes, never this turn's. Ask them the preview's question, which names version ${Number.isSafeInteger(yesNo.version) ? yesNo.version : 'N'} ("Start version ${Number.isSafeInteger(yesNo.version) ? yesNo.version : 'N'} of …?"; Yes, No), with your question tool (ask_user; in VS Code, vscode_askQuestions), and run it again only after their Yes. ${theirs}`;
  }
  if (found.problem === 'ambiguous') return `${REFUSAL} The person answered yes and no together; ask "Start version N?" on its own (Yes, No), and start it only after their Yes.`;
  if (found.side !== 'yes') return `${REFUSAL} The person did not say yes to starting the next version: start nothing, and tell them the published version stays as it is.`;
  return null;
}

/**
 * Why the version question's third answer may not be recorded: the person did not answer "No, it was just a question" to
 * that exact question in this turn. Each names what to do next; none opens or records anything (owner, 2026-11-18).
 */
function questionProblem(found, ledger, yesNo, { localChat }) {
  const card = 'They can also answer it on the decisions card (sflowDecide or sflow_decide with the Story ID), which offers the same three answers.';
  if (found.problem === 'none' && localChat && !ledger.delivered) {
    return `${REFUSAL} This chat's answers do not reach SFlow, so the person's answer cannot be read here; do not ask again in this chat. ${card}`;
  }
  if (found.problem === 'none') {
    return `${REFUSAL} That it was just a question is the person's own answer, never this turn's. Ask them the preview's question ("Start version ${Number.isSafeInteger(yesNo.version) ? yesNo.version : 'N'} of …?"; Yes, No, No, it was just a question) with your question tool (ask_user; in VS Code, vscode_askQuestions), and run this only after they answer "No, it was just a question". ${card}`;
  }
  if (found.problem === 'ambiguous') return `${REFUSAL} The person gave more than one answer together; ask the version question on its own, and record it only after their "No, it was just a question".`;
  if (found.side !== 'question') return `${REFUSAL} The person did not answer that it was just a question: record nothing for it. Run the command of the answer they gave, or ask them again if you are not sure.`;
  return null;
}

/**
 * Why this decision command is not what the person answered in this turn, or null. `localChat`: VS Code's own chat.
 * `positionals` name the command, so its reason's length and a yes or no it records are checked too [owner, 2026-11-14].
 */
export async function unboundAnswerReason(file, record, options, { localChat = false, positionals = [], version = null } = {}) {
  const length = reasonLengthProblem(positionals, options);
  if (length) return length;
  const ledger = await readLedger(file, record.turnId);
  const yesNo = yesNoCommand(positionals, options, version);
  const sided = yesNo ? yesNoProblem(ledger, yesNo, { localChat }) : null;
  if (sided) return sided;
  // A next version stands on the person's yes to its exact proposal, whose confirmation binds any --reason it carries; an
  // authoring turn keeps none of the words typed with its skill [SCS:REQ-040], so they are not read here.
  const words = yesNo?.successor ? null : await (async () => {
    // A question whose answer never reached this hook proves nothing either way, so it refuses nothing.
    if (!ledger.delivered && (localChat || ledger.asked)) return null;
    const said = [...ledger.answers, ledger.prompt].filter(Boolean);
    const words = wordsOfCommand(options);
    if (!ledger.answers.length && !words.every((text) => ledger.prompt.includes(text))) {
      return ledger.canned
        ? `${REFUSAL} The host answered the question itself ("the user is not available"), so no person has decided this. Do not choose for them: ask again when they are here, then run it with their own words. ${ROUTES}`
        : `${REFUSAL} No person answered a question in this turn, so this decision has nobody's word behind it. Ask them with your question tool (ask_user; in VS Code, vscode_askQuestions), then run it with their own words. ${ROUTES}`;
    }
    if (!ledger.answers.length && !words.length && ledger.prompt.split(' ').length < 3) {
      return `${REFUSAL} No person answered a question in this turn, so this decision has nobody's word behind it. Ask them with your question tool (ask_user; in VS Code, vscode_askQuestions), then run it. ${ROUTES}`;
    }
    const unsaid = words.filter((text) => !said.some((answer) => answer.includes(text)));
    return unsaid.length ? `${REFUSAL} This command's reason is not what the person answered. Run it again with exactly their words; their answer stands and they need not be asked again. Words not from them: "${unsaid[0].slice(0, 120)}".` : null;
  })();
  if (words) return words;
  // The yes or no it rests on now carries this row, and no other.
  const found = yesNo ? yesNoAnswer(ledger, yesNo) : null;
  if (found?.reply && found.reply.usedBy !== yesNo.row) {
    await writeLedger(file, { ...ledger, replies: ledger.replies.map((reply, index) => (index === found.index ? { ...reply, usedBy: yesNo.row } : reply)) });
  }
  return null;
}

/** The person's yes that starts `version` in this turn, as the host delivered it: `{ asked, texts }`, or null. */
export async function successorReply(file, record, version, step = null) {
  const ledger = await readLedger(file, record.turnId);
  const found = yesNoAnswer(ledger, yesNoCommand(['phase', 'rollover', step], { confirm: 'x' }, version));
  return found?.reply && found.side === 'yes' ? { asked: found.reply.asked, texts: found.reply.texts } : null;
}
