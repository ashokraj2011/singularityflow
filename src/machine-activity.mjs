/**
 * When a person last used this laptop: the gate every Git or remote job SFlow starts by itself waits behind.
 *
 * Automatic sharing and clean-up run only after the laptop has had no activity for 30 minutes [owner, 2026-11-19];
 * anything a person asks for runs at once. The stamp is this file's modification time, machine-wide. Foreground
 * commands, Copilot prompts and VS Code (edits, focus, terminals, SFlow commands) refresh it at most once a minute.
 * automatic-work.mjs adds the operating system's own idle time where reading it is cheap. Node built-ins only:
 * root dispatch and VS Code load it.
 */
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_IDLE_MINUTES = 30;
const STAMP_EVERY_MS = 60_000;

export function activityFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_ACTIVITY_FILE || path.join(home, '.singularity-flow', 'activity.json'));
}

/** Minutes of no activity before automatic Git or remote work runs (SINGULARITY_FLOW_IDLE_MINUTES); 0 waits for nothing. */
export function idleMinutes(env = process.env) {
  const value = Number(env.SINGULARITY_FLOW_IDLE_MINUTES ?? '');
  return env.SINGULARITY_FLOW_IDLE_MINUTES?.trim() && Number.isInteger(value) && value >= 0 && value <= 1440 ? value : DEFAULT_IDLE_MINUTES;
}

export function lastActivityAt(file = activityFile()) {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
}

/** Record activity now; true when written. Throttled to once a minute, and never fails its caller. */
export function noteActivity({ env = process.env, now = Date.now(), file = activityFile(env) } = {}) {
  try {
    const last = lastActivityAt(file);
    if (last !== null && last <= now && now - last < STAMP_EVERY_MS) return false;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ at: new Date(now).toISOString() })}\n`, { mode: 0o600 });
    utimesSync(file, now / 1000, now / 1000);
    return true;
  } catch { return false; }
}

/**
 * A foreground command is a person (or their Copilot) at work. A host's own calls (VS Code records what its person
 * does itself, SINGULARITY_FLOW_ACTIVITY_STAMP=off) and background replays are not.
 */
export function noteCommandActivity(env = process.env) {
  if (env.SINGULARITY_FLOW_ACTIVITY_STAMP === 'off' || env.SINGULARITY_FLOW_INDEX_REFRESH === '1') return false;
  return noteActivity({ env });
}

/**
 * `{ idle, remainingMs, lastActivityAt }` for a wait of `idleMs`. `osIdleMs` is how long the operating system has
 * seen no input, when known; the later of it and the stamp is the last activity. Nothing recorded at all is idle.
 */
export function idleState({ env = process.env, now = Date.now(), idleMs = idleMinutes(env) * 60_000,
  file = activityFile(env), osIdleMs = null } = {}) {
  const stamp = lastActivityAt(file);
  const seen = [stamp, Number.isFinite(osIdleMs) && osIdleMs >= 0 ? now - osIdleMs : null].filter(value => value !== null);
  if (!(idleMs > 0) || !seen.length) return { idle: true, remainingMs: 0, lastActivityAt: stamp };
  const quiet = now - Math.min(now, Math.max(...seen));
  return { idle: quiet >= idleMs, remainingMs: Math.max(0, idleMs - quiet), lastActivityAt: Math.max(...seen) };
}
