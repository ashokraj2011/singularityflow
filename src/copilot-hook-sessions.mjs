/**
 * One empty file per Copilot chat SFlow's hooks saw, named by the chat's SHA-256 beside the Copilot mode file, and
 * `.latest`, touched by every hook that writes one. The prompt hook and the guard call noteHookSession (from
 * copilot-repository-boundary.mjs, so the hook path loads nothing more); copilot-chat-hooks.mjs reads them to tell a
 * chat whose hooks never ran. Machine-local, never shared, aged out after two weeks once there are many, and safe to
 * lose: the chat's next hook writes its file again.
 */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copilotModeFile } from './copilot-mode.mjs';

export const HOOK_SESSIONS_DIRECTORY = 'copilot-hook-sessions';
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const PRUNE_ABOVE = 256;
const LATEST = '.latest';

const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const digest = (value) => createHash('sha256').update(value).digest('hex');

export function hookSessionsDirectory(env = process.env, home = os.homedir()) {
  return path.join(path.dirname(copilotModeFile(env, home)), HOOK_SESSIONS_DIRECTORY);
}

function touch(file, now) {
  try { utimesSync(file, now / 1000, now / 1000); return false; } catch { /* not there yet */ }
  closeSync(openSync(file, 'a', 0o600));
  utimesSync(file, now / 1000, now / 1000);
  return true;
}

function prune(directory, now) {
  let names = [];
  try { names = readdirSync(directory); } catch { return; }
  if (names.length <= PRUNE_ABOVE) return;
  for (const name of names) {
    if (name === LATEST) continue;
    const file = path.join(directory, name);
    try { if (now - lstatSync(file).mtimeMs > KEEP_MS) rmSync(file, { force: true }); } catch { /* gone already */ }
  }
}

/** A hook saw this chat now. Never fails its caller, and true when written. */
export function noteHookSession(sessionId, { env = process.env, now = Date.now() } = {}) {
  const id = validId(sessionId);
  if (!id) return false;
  try {
    const directory = hookSessionsDirectory(env);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    touch(path.join(directory, LATEST), now);
    if (touch(path.join(directory, digest(id)), now)) prune(directory, now);
    return true;
  } catch { return false; }
}

/** Whether a hook saw this chat. */
export function hookSessionSeen(sessionId, env = process.env) {
  const id = validId(sessionId);
  if (!id) return false;
  try { lstatSync(path.join(hookSessionsDirectory(env), digest(id))); return true; } catch { return false; }
}

/** When any SFlow hook last saw a chat on this machine, or null. */
export function latestHookAt(env = process.env) {
  try { return lstatSync(path.join(hookSessionsDirectory(env), LATEST)).mtimeMs; } catch { return null; }
}
