/**
 * What the person asked for [SCS:REQ-040 to REQ-044]: the words typed after /sf-code or /sf-phase.
 *
 * The prompt hook keeps a person's own prompt, never a subagent's task, once the diagnostic redactor has
 * removed its secrets: at most 2,000 characters a turn and 20 turns a generation, in a local record beside
 * the checkout's Git data, one file per Story step and generation (`noteTypedTurn`). Prepublish copies it
 * into the Story as "Asked for" (asked-for-records.mjs). A capability's `policy.typedFocus: off` turns
 * both off. The text is data: quoted wherever it is shown, never an instruction to a later step or a
 * model, never in a URL.
 *
 * The hook loads this module only for a /sf-code or /sf-phase prompt, and the redactor only when
 * something was typed; nothing here ever changes a hook's answer.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ASKED_FOR = Object.freeze({ characters: 2000, turns: 20 });
export const ASKED_FOR_SKILLS = Object.freeze(['sf-code', 'sflow-code', 'sf-phase', 'sflow-phase']);
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
 * The instruction a person typed into a /sf-code or /sf-phase turn, redacted and bounded, or null: a
 * subagent's task, another skill, nothing typed, or only a step word.
 */
export async function typedInstruction(payload, skill) {
  if (!ASKED_FOR_SKILLS.includes(skill) || subagentPayload(payload)) return null;
  const typed = typedArguments(payload?.prompt);
  if (!typed || NOT_AN_INSTRUCTION.test(typed)) return null;
  const { redactDiagnosticText } = await import('./git-remote-diagnostics.mjs');
  // Redacted whole before it is cut, so a cut never leaves half a secret behind.
  const characters = [...redactDiagnosticText(typed, { multiline: true }).trim()];
  if (!characters.length) return null;
  return { text: characters.slice(0, ASKED_FOR.characters).join(''), ...(characters.length > ASKED_FOR.characters ? { truncated: true } : {}) };
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

/** One turn's words in the local record of its Story step and generation; a turn past the 20th is only counted. */
export async function noteAskedFor(gitDir, { workId, phase, generation, text, truncated = false, skill, turnId, at }) {
  const subject = { workId, phase, generation };
  const file = ledgerFile(gitDir, subject);
  const ledger = await readLedger(file, subject) ?? { schema: LEDGER_SCHEMA, ...subject, turns: [], omitted: 0 };
  if (ledger.turns.some((entry) => entry.turnId === turnId)) return ledger;
  if (ledger.turns.length >= ASKED_FOR.turns) ledger.omitted = Number(ledger.omitted ?? 0) + 1;
  else ledger.turns.push({ turnId, skill, text, ...(truncated ? { truncated: true } : {}), at });
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(ledger)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return ledger;
}

/** The local record of one Story step and generation: its turns in the order typed, and how many were past the limit. */
export async function localAskedFor(gitDir, subject) {
  const ledger = await readLedger(ledgerFile(gitDir, subject), subject);
  return { turns: ledger?.turns ?? [], omitted: Number(ledger?.omitted ?? 0) };
}

/**
 * The prompt hook's part, once the turn's Story is known (copilot-mutation-guard.mjs): the typed words go
 * to the current step's generation of the Story this checkout holds, unless its capability turned it off.
 */
export async function noteTypedTurn(record, { gitDir, workflow, at = Date.now() }) {
  if (!record?.typed?.text || !gitDir || !workflow?.workItem?.id || workflow.status !== 'in_progress' || typedFocusOff(workflow)) return null;
  const phase = workflow.phases?.[workflow.currentPhase];
  if (!phase) return null;
  return noteAskedFor(gitDir, { workId: workflow.workItem.id, phase: phase.id, generation: askedForGeneration(phase),
    text: record.typed.text, truncated: record.typed.truncated === true, skill: record.skill, turnId: record.turnId, at: new Date(at).toISOString() });
}
