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
 * On any host a question whose answer never arrived proves nothing, so it refuses nothing. Only tightens:
 * nothing here admits a command the guard would otherwise refuse. Reads and writes one private file per turn.
 */
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ANSWER_BOUND_STEPS, ANSWER_BOUND_TURNS } from './person-step-catalog.mjs';

export { ANSWER_BOUND_TURNS };
const WORD_FLAGS = Object.freeze(['reason', 'supporting-reason', 'article-reason', 'cause']);
// VS Code's two auto-replies, and any wording of the same sentence a later host uses.
const HOST_AUTO_REPLY = /the user is not available to (?:answer|respond)/iu;
const DECLINED = /^user (?:declined|cancelled|canceled|skipped|did not)/iu;
const MAX_ANSWERS = 200;

export const answerBoundStep = (step) => ANSWER_BOUND_STEPS.includes(step?.id);

const comparable = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim().replace(/[.!?;,]+$/u, '');

/** Every string a parsed answer holds, at most MAX_ANSWERS of them. */
function stringLeaves(value, found = []) {
  if (found.length >= MAX_ANSWERS) return found;
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object') for (const entry of Object.values(value)) stringLeaves(entry, found);
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
    if (value?.turnId === turnId) return value;
  } catch { /* None yet, or unreadable: this turn starts again. */ }
  return { turnId, prompt: '', asked: 0, delivered: 0, canned: 0, answers: [] };
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
  await writeLedger(file, { ...value, delivered: value.delivered + 1, canned: value.canned + Number(answer.canned),
    answers: [...value.answers, ...answer.texts].slice(-MAX_ANSWERS) });
}

/** The words a person would have to have said, from a decision command's flags: `--reason d1=TEXT` is TEXT. */
export function wordsOfCommand(options) {
  return WORD_FLAGS.flatMap((flag) => [options[flag]].flat()).filter((value) => typeof value === 'string' && value.trim())
    .map((value) => comparable(value.replace(/^d\d{1,3}=/u, '')));
}

const REFUSAL = 'PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded.';
const ROUTES = 'A person can also answer on the decisions card (sflowDecide or sflow_decide with the Story ID) or in their own terminal (singularity-flow decisions record <WORK-ID>).';

/** Why this decision command is not what the person answered in this turn, or null. `localChat`: VS Code's own chat. */
export async function unboundAnswerReason(file, record, options, { localChat = false } = {}) {
  const ledger = await readLedger(file, record.turnId);
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
}
