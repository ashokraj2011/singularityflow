/**
 * A short code a person types to confirm a reviewed action, never its digest [owner, 2026-11-12]. A route that
 * confirms `--confirm <DIGEST>` reads `/sf-confirm K7Q2-M8DX`: eight characters derived from the command, kept on
 * this machine with it. Typing it binds the turn to that command's digest (copilot-repository-boundary.mjs), the
 * guard admits it only as it admits the command, and `confirm <CODE>` runs it (confirm-entry.mjs); the command
 * still refuses a stale digest. Dependency-free: route building loads it on every command.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'sflow-confirm-code@1';
// Crockford's base32: no I, L, O or U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CONFIRM_CODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEPT_CODES = 400;
const CONFIRM_VALUE = /\s--confirm(?:-plan)?(?:\s+|=)(sha256:[a-f0-9]{64}|[a-z]{2,12}-[a-f0-9]{16,64}|[a-f0-9]{64})(?=\s|$)/u;
const CODE_TEXT = /(?<![0-9A-Za-z])([0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4})-([0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4})(?![0-9A-Za-z-])/gu;

/** The command as one line: `singularity-flow`, no --json/--for-agent, single spaces. */
export function confirmCommandText(command) {
  const words = String(command ?? '').trim().split(/\s+/u).filter((word) => !['--json', '--for-agent'].includes(word));
  if (words[0] === 'sflow') words[0] = 'singularity-flow';
  return words.join(' ');
}

/** The reviewed value a confirming command carries, or null. */
export function confirmValue(command) {
  return String(command ?? '').match(CONFIRM_VALUE)?.[1] ?? null;
}

/** The eight-character code of a confirming command, `XXXX-XXXX`. */
export function confirmCode(command) {
  const bytes = createHash('sha256').update(`${SCHEMA}\n${confirmCommandText(command)}`).digest();
  let bits = 0; let value = 0; let code = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5 && code.length < 8) { bits -= 5; code += ALPHABET[(value >> bits) & 31]; }
    if (code.length === 8) break;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A typed code in its one spelling (case and look-alikes folded), or null. */
export function normalizeConfirmCode(text) {
  const value = String(text ?? '').trim().toUpperCase().replace(/[IL]/gu, '1').replace(/O/gu, '0');
  return /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u.test(value) ? value : null;
}

/** The distinct codes a text carries, normalized. */
export function confirmCodesIn(text) {
  if (typeof text !== 'string' || text.length > 256 * 1024) return [];
  return [...new Set([...text.matchAll(CODE_TEXT)].map((match) => normalizeConfirmCode(`${match[1]}-${match[2]}`)).filter(Boolean))];
}

/** `SINGULARITY_FLOW_CONFIRM_CODES`, else `~/.singularity-flow/confirm-codes`: machine-local. */
export function confirmCodesRoot(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_CONFIRM_CODES || path.join(home, '.singularity-flow', 'confirm-codes'));
}

function prune(directory, now) {
  let names;
  try { names = readdirSync(directory).filter((name) => name.endsWith('.json')); } catch { return; }
  if (names.length <= KEPT_CODES) return;
  for (const name of names) {
    try { if (now - statSync(path.join(directory, name)).mtimeMs > CONFIRM_CODE_MAX_AGE_MS) rmSync(path.join(directory, name), { force: true }); }
    catch { /* Another process pruned it. */ }
  }
}

/** The code for `command`, kept with it for lookup; null when it confirms nothing. Best effort: never fails the route. */
export function rememberConfirmCommand(command, { env = process.env, now = Date.now() } = {}) {
  const text = confirmCommandText(command);
  if (!text.startsWith('singularity-flow ') || !confirmValue(text)) return null;
  const code = confirmCode(text);
  try {
    const directory = confirmCodesRoot(env);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${code}.json`);
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schema: SCHEMA, code, command: text, recordedAt: new Date(now).toISOString() })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    prune(directory, now);
  } catch { /* Refused when typed; the preview gives it again. */ }
  return code;
}

/** `{ code, command, value }` for a typed code, or null: not kept here, over a week old, or not derived from what is kept. */
export function resolveConfirmCode(typed, { env = process.env, now = Date.now() } = {}) {
  const code = normalizeConfirmCode(typed);
  if (!code) return null;
  try {
    const record = JSON.parse(readFileSync(path.join(confirmCodesRoot(env), `${code}.json`), 'utf8'));
    const command = typeof record?.command === 'string' ? record.command : '';
    const value = confirmValue(command);
    const recordedAt = Date.parse(record?.recordedAt);
    if (record?.schema !== SCHEMA || !value || !command.startsWith('singularity-flow ') || confirmCode(command) !== code
      || /[\u0000-\u001f\u007f]/u.test(command) || !Number.isFinite(recordedAt) || now - recordedAt > CONFIRM_CODE_MAX_AGE_MS) return null;
    return { code, command, value };
  } catch { return null; }
}
