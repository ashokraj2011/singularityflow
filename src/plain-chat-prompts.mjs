/**
 * What a person asks Copilot in a repository that uses SFlow, kept [PCR:REQ-002]: every prompt, plain or `/sf-`,
 * redacted and bounded as typed words are (asked-for.mjs redactedWords), with its session, time and repository,
 * and the Story and step its checkout holds.
 *
 *   the clone's local log   <Git common directory>/singularity-flow/prompts/<day>.jsonl; it never leaves the
 *                           clone (decision 9), and `singularity-flow prompts` shows it
 *   the session's copy      its last prompt, for a refusal's line to type [PCR:REQ-011] and a secret's refusal
 *                           [PCR:REQ-003]; replaced at the session's next prompt, removed when it ends
 *
 * A prompt is never kept as typed: what looks like a secret is replaced before anything is written, and a
 * refusal names only its kind, never its value. Each entry is data, quoted wherever it is shown, never an
 * instruction to a later step or a model.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copilotModeFile } from './copilot-mode.mjs';

const LOG_ENTRY = 'sflow-prompt/v1';
const COPY_SCHEMA = 'sflow-plain-chat-turn/v1';
// One day's log stops growing here: a runaway loop of prompts cannot fill the disk.
const DAY_BYTES = 4 * 1024 * 1024;
const COPY_BYTES = 64 * 1024;
// Days kept in the clone's log; older ones are removed when a new day's file starts.
export const PROMPT_LOG_DAYS = 90;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

export const promptLogDirectory = (commonDir) => path.join(commonDir, 'singularity-flow', 'prompts');

/** The session's key, as the turn records name it: a hash, never the host's own ID. */
export function sessionKey(payload) {
  const id = payload?.sessionId ?? payload?.session_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(id)
    ? createHash('sha256').update(id).digest('hex') : null;
}

/**
 * What looks like a secret in a prompt, by its kind ("GitHub token", "private key"), or null: a value one of the
 * repository's declared environment files holds (`values`), the commit gate's secret rules, and the diagnostic
 * redactor's token shapes. Never its value. A prose word after "Bearer" is no token, so that shape is left to the
 * redaction alone.
 */
export async function promptSecret(prompt, { values = [] } = {}) {
  const text = String(prompt ?? '').slice(0, 256 * 1024);
  if (!text.trim()) return null;
  if (values.some((value) => text.includes(value))) return 'value from an environment file';
  const [{ SECRET_RULES, scanText }, { DIAGNOSTIC_SECRET_VALUES }] = await Promise.all([import('./secrets.mjs'), import('./git-remote-diagnostics.mjs')]);
  const rules = new Set(SECRET_RULES.map((rule) => rule.id));
  const found = scanText(text, { path: '<prompt>' }).find((finding) => rules.has(finding.rule) && !finding.waived);
  if (found) return found.label;
  return DIAGNOSTIC_SECRET_VALUES.filter((shape) => !shape.source.startsWith('\\bBearer'))
    .some((shape) => new RegExp(shape.source, shape.flags.replace('g', '')).test(text)) ? 'access token' : null;
}

function copyFile(payload) {
  const key = sessionKey(payload);
  return key ? path.join(path.dirname(copilotModeFile()), 'copilot-prompts', `${key}.json`) : null;
}

async function writePrivate(file, text) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if ((await lstat(path.dirname(file))).isSymbolicLink()) throw new Error('Unsafe prompt directory');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** The session's copy of its last prompt, or null. Its own session's only, and only while it is bounded. */
export async function readSessionCopy(payload) {
  const file = copyFile(payload);
  if (!file) return null;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > COPY_BYTES) return null;
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value?.schema === COPY_SCHEMA && value.session === sessionKey(payload) ? value : null;
  } catch { return null; }
}

/** Replace the session's copy; `null` removes it. Every prompt replaces it, so a refusal never quotes an earlier one. */
export async function writeSessionCopy(payload, copy) {
  const file = copyFile(payload);
  if (!file) return null;
  if (!copy) {
    await rm(file, { force: true });
    return null;
  }
  const value = { schema: COPY_SCHEMA, session: sessionKey(payload), ...copy };
  await writePrivate(file, `${JSON.stringify(value)}\n`);
  return value;
}

const today = (at) => new Date(at).toISOString().slice(0, 10);

async function pruneOldDays(directory, at) {
  const oldest = today(at - PROMPT_LOG_DAYS * 24 * 60 * 60 * 1000);
  for (const name of (await readdir(directory).catch(() => [])).filter((entry) => DAY_FILE.test(entry))) {
    if (name.slice(0, 10) < oldest) await rm(path.join(directory, name), { force: true }).catch(() => {});
  }
}

/**
 * One prompt in the clone's local log. The entry carries the session's key, never its ID, and the prompt's
 * redacted words. A day past its size is not written further; a later day starts again.
 */
export async function notePromptLog(commonDir, entry, { at = Date.now() } = {}) {
  const directory = promptLogDirectory(commonDir);
  const file = path.join(directory, `${today(at)}.jsonl`);
  const info = await lstat(file).catch(() => null);
  if (info && (!info.isFile() || info.isSymbolicLink() || info.size > DAY_BYTES)) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) return null;
  const line = { schema: LOG_ENTRY, at: new Date(at).toISOString(), ...entry };
  await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  if (!info) await pruneOldDays(directory, at);
  return line;
}

/** The clone's kept prompts, newest first; `workId` narrows them to one Story's. */
export async function readPromptLog(commonDir, { workId = null, limit = 50 } = {}) {
  const directory = promptLogDirectory(commonDir);
  const days = (await readdir(directory).catch(() => [])).filter((name) => DAY_FILE.test(name)).sort().reverse();
  const entries = [];
  for (const name of days) {
    const file = path.join(directory, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size > DAY_BYTES * 2) continue;
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value?.schema !== LOG_ENTRY || (workId && value.workId !== workId)) continue;
      entries.push(value);
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}
