/**
 * What the person asked for [SCS:REQ-040 to REQ-044]: the words typed after a step's writer (/sf-code, /sf-phase or a
 * configured author such as /sf-scenario-check, writing-aliases.mjs ASKED_FOR_SKILLS), and in a
 * repository whose Story checkout it is, a plain chat's prompt, marked so (copilot-plain-chat.mjs [PCR:REQ-002]). A plain
 * chat's prompt waits to be accounted for only once its turn changed the work (`markAskedForChanged`, [PCR:REQ-012]).
 *
 * The prompt hook keeps a person's own prompt, never a subagent's task, once the diagnostic redactor has
 * removed its secrets: at most 2,000 characters a turn and 20 turns a generation, in a local record beside
 * the checkout's Git data, one file per Story step and generation (`noteTypedTurn`). Prepublish copies it
 * into the Story as "Asked for" (asked-for-records.mjs). A capability's `policy.typedFocus: off` turns
 * both off. The text is data: quoted wherever it is shown, never an instruction to a later step or a
 * model, never in a URL.
 *
 * The hook loads this module only for a writer's prompt, and the redactor only when
 * something was typed; nothing here ever changes a hook's answer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ASKED_FOR = Object.freeze({ characters: 2000, turns: 20 });
const LEDGER_SCHEMA = 'sflow-asked-for/v1';
const LEDGER_BYTES = 512 * 1024;
// A bare step word or Work ID says which step to run, not what to build: there is nothing to account for.
const NOT_AN_INSTRUCTION = /^(?:context|stage|check|status|show|preview|prepare|publish|continue|resume|[A-Z][A-Z0-9]*-\d+)$/iu;

/** Whether a prompt payload is a subagent's task: hosts name the agent that runs it. */
export function subagentPayload(payload) {
  return [payload?.agentId, payload?.agent_id].some((value) => value != null && value !== '');
}

/** What was typed after the skill's name, from a typed `/sf-…` line or a host's expanded skill context; null when nothing was. */
export function typedArguments(prompt) {
  if (typeof prompt !== 'string') return null;
  const bounded = prompt.slice(0, 256 * 1024);
  const trimmed = bounded.trim();
  const text = trimmed.startsWith('/') ? trimmed.replace(/^\/\S+\s*/u, '')
    : bounded.match(/\bARGUMENTS:\s*([^]*?)\s*<\/skill-context>/u)?.[1];
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

/**
 * Typed words as they may be kept: the diagnostic redactor's pass, then every shape the commit gate's secret
 * rules find (an access key ID or a provider key the redactor alone let through), then cut at 2,000
 * characters. Redacted whole before it is cut, so a cut never leaves half a secret behind. Null when nothing is left.
 */
export async function redactedWords(typed) {
  const [{ redactDiagnosticText }, { SECRET_RULES }] = await Promise.all([import('./git-remote-diagnostics.mjs'), import('./secrets.mjs')]);
  let text = redactDiagnosticText(typed, { multiline: true });
  for (const rule of SECRET_RULES) {
    text = text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match, group) => {
      if (rule.accept && !rule.accept(typeof group === 'string' ? group : match)) return match;
      return rule.id === 'assigned-secret' && typeof group === 'string' ? match.replace(group, '[REDACTED]') : '[REDACTED]';
    });
  }
  const characters = [...text.trim()];
  if (!characters.length) return null;
  return { text: characters.slice(0, ASKED_FOR.characters).join(''), ...(characters.length > ASKED_FOR.characters ? { truncated: true } : {}) };
}

/**
 * The instruction a person typed into a writer's turn (/sf-code, /sf-phase, a configured author), redacted and bounded, or null: a
 * subagent's task, another skill, nothing typed, or only a step word.
 */
export async function typedInstruction(payload, skill) {
  // The turns are the alias table's (writing-aliases.mjs ASKED_FOR_SKILLS), already loaded by the hook that calls this.
  const { ASKED_FOR_SKILLS } = await import('./writing-aliases.mjs');
  if (!ASKED_FOR_SKILLS.includes(skill) || subagentPayload(payload)) return null;
  const typed = typedArguments(payload?.prompt);
  if (!typed || NOT_AN_INSTRUCTION.test(typed)) return null;
  return redactedWords(typed);
}

/** Whether the Story's capability turned recording off: its pinned policy says `typedFocus: off`. */
export const typedFocusOff = (workflow) => workflow?.resolution?.capability?.policy?.typedFocus === 'off';

/** The generation a turn's words belong to: the step's open one, else the one it makes next. */
export function askedForGeneration(phase) {
  if (phase?.generationIntent?.status === 'open' && Number.isSafeInteger(Number(phase.generationIntent.generation))) return Number(phase.generationIntent.generation);
  const counters = [phase?.generation, phase?.generationHighWatermark].map((value) => Number(value ?? 0)).filter(Number.isSafeInteger);
  return Math.max(0, ...counters) + 1;
}

function ledgerFile(gitDir, { workId, phase, generation }) {
  const key = createHash('sha256').update(`${workId}\u0000${phase}\u0000${generation}`).digest('hex');
  return path.join(gitDir, 'singularity-flow', 'asked-for', `${key}.json`);
}

async function readLedger(file, subject) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LEDGER_BYTES) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.schema === LEDGER_SCHEMA && value.workId === subject.workId && value.phase === subject.phase
      && value.generation === subject.generation && Array.isArray(value.turns) ? value : null;
  } catch { return null; }
}

async function writeLedger(file, ledger) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// A change or an addition, asked for: a clause that starts with one of these verbs, after any polite or wanting frame.
const CHANGE_VERBS = 'add|adjust|align|allow|apply|avoid|build|bump|cache|center|change|clean|convert|correct|cover|create|delete|disable|display|document|downgrade|drop|enable|ensure'
  + '|expose|extract|filter|fix|format|generate|guard|handle|hide|implement|improve|include|increase|decrease|introduce|keep|limit|load|log|make|merge|migrate|mock|move|paginate'
  + '|put|raise|reduce|refactor|remove|rename|render|reorder|replace|restore|return|reuse|revert|rewrite|rework|save|send|set|show|simplify|skip|sort|split|store|style|support'
  + '|switch|translate|tweak|undo|update|upgrade|use|validate|wire|wrap|write';
const FRAME = /^(?:(?:please|pls|kindly|also|now|and|then|so|but|just|ok(?:ay)?|instead|go ahead and|make sure (?:to|you)|can you|could you|would you|will you|you (?:should|must|need to)|(?:i|we) (?:want|need|would like|'d like)(?: you)? to|let'?s|let us)[\s,]+)*/iu;
const CHANGE_START = new RegExp(`^(?:(?:don'?t|do not|never|stop)\\s+\\S|(?:${CHANGE_VERBS})\\b)`, 'iu');
const CHANGE_MODAL = /\b(?:should|must|needs? to|has to|have to|ought to)\s+(?:not\s+)?(?:be|have|show|use|say|return|work|display|look|appear|include|accept|reject|handle|support|stay|match|read|go|point|open|close|run|call|live)\b|\binstead of\b/iu;
// A status note: what the person did or saw, or a bare acknowledgement.
const STATUS = /^(?:(?:i|we)(?:'ve|'d| have| had)?\s+(?:just\s+|already\s+|now\s+|also\s+)?(?:run|read|set up)\b|(?:(?:i|we)(?:'ve|'d| have| had)?\s+)?(?:just\s+|already\s+|now\s+|also\s+)?(?:done|did|finished|completed|ran|re-?ran|logged|installed|reinstalled|configured|fixed|tried|updated|restarted|started|pushed|pulled|merged|committed|signed|verified|checked|tested|cleared|rebuilt|authenticated|created|added|deleted|removed|changed|saved|approved|reviewed|seen|looked|got)\b|(?:it|that|this|everything|all)(?:'s| is| was| has been| looks)\s+(?:now\s+)?(?:done|fixed|working|installed|set up|configured|ready|running|passing|green|merged|pushed|fine|good|ok)\b|(?:(?:ok(?:ay)?|done|thanks|thank you|thx|great|cool|got it|sounds good|fine|yes|yep|no|nope|sure|works)\b[\s,.!]*)+$)/iu;
// A line a terminal printed: a prompt, a tool's own prefix, a log level, a stack frame, a URL, a path, a count or a rule.
const OUTPUT_LINE = /^\s*(?:[$%#>❯➜λ]\s|(?:npm|yarn|pnpm)\s+(?:err!|warn|notice|info|http|error|verb)(?=[\s:]|$)|(?:error|warn(?:ing)?|info|debug|notice|fatal|trace|err!)(?::|\]|!)|\[(?:error|warn(?:ing)?|info|debug)\]|at\s+\S.*:\d+(?::\d+)?\)?\s*$|[✓✔✗✖×•ℹ⚠→▶]\s|\d{1,4}[:\-/.]\d{1,2}[:\-/.]\d|https?:\/\/\S+\s*$|(?:[~.]|[A-Za-z]:)?\/[\w.-]+\/\S*:\d+|(?:added|removed|changed|audited) \d+ packages?\b|(?:up to date|logged in on|signed in as|done in \d|press enter)\b|(?:pass|fail|ok|not ok)\s+\S+\.(?:test|spec)\.|node:internal|[-=+*_]{3,}|\s{4,}\S|\u001b\[)/iu;

/**
 * What typed words are [owner, 2026-11-18, office laptop: "I have done npm login" and pasted terminal output were
 * held as requests]: `request`, a change or an addition asked for; `note`, a status note ("I have done npm login"), an
 * acknowledgement or what a terminal printed; `unsure`, anything else (a question, an instruction that changes nothing
 * plainly). Only a request or an unsure one waits for an account; an unsure one the person can call "not a request" with
 * one click on the Decide card. Words only, never a model's reading.
 */
export function typedKind(text) {
  const lines = String(text ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return 'note';
  const printed = lines.filter((line) => OUTPUT_LINE.test(line));
  const said = lines.filter((line) => !OUTPUT_LINE.test(line));
  const clauses = said.flatMap((line) => line.split(/[.!?;:]+(?:\s|$)|,\s+(?:and\s+|then\s+|but\s+|so\s+)?|\s+(?:and then|and|then|but|so)\s+/u)).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.some((clause) => CHANGE_START.test(clause.replace(FRAME, '')) || CHANGE_MODAL.test(clause))) return 'request';
  // Mostly what a terminal printed, or only status notes: nothing is asked.
  if (printed.length && printed.length >= said.length) return 'note';
  return clauses.length && clauses.every((clause) => STATUS.test(clause)) ? 'note' : 'unsure';
}

/**
 * Whether an entry waits to be accounted for in a code step [SCS:REQ-042]: what was typed after /sf-code or
 * /sf-phase does, unless it is a note (typedKind); a plain chat's prompt [PCR:REQ-012] only once its turn changed something.
 */
export const needsAccount = (entry) => (entry?.plainChat !== true || entry.changed === true) && typedKind(entry?.text) !== 'note';

/**
 * Whether two typed instructions say the same thing: the same words, however they were spaced. A plain chat's prompt
 * is never the same instruction as one typed after /sf-code: it waits for an account only once its turn changed the work.
 */
export const sameInstruction = (one, other) => (one?.plainChat === true) === (other?.plainChat === true) && one?.plainChat !== true
  && String(one?.text ?? '').replace(/\s+/gu, ' ').trim() === String(other?.text ?? '').replace(/\s+/gu, ' ').trim();

/**
 * One turn's words in the local record of its Story step and generation; a turn past the 20th is only counted.
 * A plain chat's prompts [PCR:REQ-002] are counted apart, so questions never crowd out an instruction. The same words
 * typed again for the same step and version (a turn that ended before it made the change, typed once more) are the
 * instruction already kept, never a second one to account for (daily run, 2026-11-17).
 */
export async function noteAskedFor(gitDir, { workId, phase, generation, text, truncated = false, skill, turnId, at, plainChat = false }) {
  const subject = { workId, phase, generation };
  const file = ledgerFile(gitDir, subject);
  const ledger = await readLedger(file, subject) ?? { schema: LEDGER_SCHEMA, ...subject, turns: [], omitted: 0 };
  if (ledger.turns.some((entry) => entry.turnId === turnId || sameInstruction(entry, { text, plainChat }))) return ledger;
  if (ledger.turns.filter((entry) => (entry.plainChat === true) === plainChat).length >= ASKED_FOR.turns) ledger.omitted = Number(ledger.omitted ?? 0) + 1;
  else ledger.turns.push({ turnId, skill, text, ...(truncated ? { truncated: true } : {}), ...(plainChat ? { plainChat: true } : {}), at });
  await writeLedger(file, ledger);
  return ledger;
}

/**
 * A plain chat's turn changed the work under `policy.plainChatEdits: record` [PCR:REQ-012]: its prompt now
 * waits to be accounted for like typed words. Null when the local record does not hold that turn.
 */
export async function markAskedForChanged(gitDir, subject, turnId) {
  const file = ledgerFile(gitDir, subject);
  const ledger = await readLedger(file, subject);
  const entry = ledger?.turns.find((candidate) => candidate.turnId === turnId);
  if (!entry || entry.changed === true) return entry ?? null;
  entry.changed = true;
  await writeLedger(file, ledger);
  return entry;
}

/** The local record of one Story step and generation: its turns in the order typed, and how many were past the limit. */
export async function localAskedFor(gitDir, subject) {
  const ledger = await readLedger(ledgerFile(gitDir, subject), subject);
  return { turns: ledger?.turns ?? [], omitted: Number(ledger?.omitted ?? 0) };
}

/**
 * What the person typed for the step's next version that still waits to be accounted for, in the order typed; none when the
 * Story's capability turned recording off. The edit guard reads it once per turn, so its permission asks the change's version
 * question as the entry does (requested-successor.mjs requestedChanges adds the step's eligibility). A turn the Story already
 * keeps waits for nothing: the person said it was just a question (asked-for-records.mjs answerAsQuestion), so no version is
 * asked for it again (owner, 2026-11-18).
 */
export async function waitingWords(gitDir, workflow, phase) {
  if (typedFocusOff(workflow)) return [];
  const local = await localAskedFor(gitDir, { workId: workflow.workItem.id, phase: phase.id, generation: askedForGeneration(phase) });
  const kept = new Set((workflow.askedFor ?? []).filter((entry) => entry.phase === phase.id).map((entry) => entry.turn));
  return local.turns.filter((turn) => needsAccount(turn) && !kept.has(turn.turnId) && typeof turn.text === 'string' && turn.text.trim()).map((turn) => turn.text);
}

/**
 * The prompt hook's part, once the turn's Story is known (copilot-mutation-guard.mjs): the typed words go
 * to the current step's generation of the Story this checkout holds, unless its capability turned it off.
 */
export async function noteTypedTurn(record, { gitDir, workflow, at = Date.now() }) {
  if (!record?.typed?.text || !gitDir || !workflow?.workItem?.id || workflow.status !== 'in_progress' || typedFocusOff(workflow)) return null;
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!phase) return null;
  // `/sf-code <step> [what to change]`: the step is the explicit target, never what the person asked for; only the rest is
  // kept, and a step word alone keeps nothing (alias-matrix.md finding 7) [OSA:REQ-027].
  const { workCommandArguments } = await import('./writing-aliases.mjs');
  const { focus } = workCommandArguments(record.typed.text, workflow.phaseOrder ?? Object.keys(workflow.phases ?? {}));
  if (!focus) return null;
  return noteAskedFor(gitDir, { workId: workflow.workItem.id, phase: phase.id, generation: askedForGeneration(phase),
    text: focus, truncated: record.typed.truncated === true, skill: record.skill, turnId: record.turnId, at: new Date(at).toISOString() });
}
