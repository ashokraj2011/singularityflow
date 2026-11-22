/**
 * A file path the agent typed that is a copy slip of one SFlow returned [owner, 2026-11-20: SFlow fills what it knows].
 *
 * On the owner's Story (VS Code, /sf-code) phase entry returned the checkout as
 * `…/story-worktrees/.w-36c01dbdd0dd64e8addaee8d`; the model read a file under `…/.w-36c01dbdd0dd64e8addaee8e8dd`,
 * three characters off, and, told that a real missing file keeps its path and is never retried unchanged, stopped and
 * offered /sf-recover. A copy slip became a dead end. Now a failed native read or edit whose path SFlow never returned,
 * but which is one returned path with exactly one folder or file name mistyped (a few characters off, as a copy slip
 * is), gets that returned path back as a correction. Nothing is searched for and nothing is guessed: the correction is
 * an exact path SFlow returned (the turn's checkout, or a file it issued) with the agent's own rest of the path, and it
 * is given only when that file is there. A path SFlow did return that is missing keeps its existing rule.
 *
 * On the owner's Story again (VS Code, 2026-11-22, the verification review) SFlow issued the review report at
 * `…/raj-calc/repos/myc/.git/worktrees/-w-3d5c…/singularity-flow/source-reviews/d-story-verification-gen11.json`; the
 * reviewer read `…/raj-calc/.git/worktrees/-w-3d5c…/singularity-flow/…`, two folders dropped from the front, and
 * stopped on the same rule. So a file SFlow issued in its private `singularity-flow` folder is also given back when
 * the agent's missing path ends with that file's own tail from `singularity-flow` on, whatever came before it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { editDistanceWithin } from './text-lines.mjs';

/** Whether `given` is `wanted` copied with a slip: a few characters off a name at least six long. */
function slipped(given, wanted) {
  if (typeof given !== 'string' || given === wanted || wanted.length < 6) return false;
  const limit = Math.max(2, Math.floor(wanted.length / 8));
  return Math.abs(given.length - wanted.length) <= limit && editDistanceWithin(given, wanted, limit) <= limit;
}

/**
 * The path `attempted` stands for, or null: a returned path (`returned`, absolute) with exactly one of its folder or
 * file names mistyped in `attempted`, followed by the rest of `attempted`. Given only when `attempted` is not there and
 * the corrected file is (for a write, its folder).
 */
export function pathSlipOf(attempted, returned, { write = false, exists = existsSync } = {}) {
  if (typeof attempted !== 'string' || !path.isAbsolute(attempted) || exists(attempted)) return null;
  const given = path.resolve(attempted).split(path.sep);
  for (const known of returned ?? []) {
    if (typeof known !== 'string' || !path.isAbsolute(known)) continue;
    const wanted = path.resolve(known).split(path.sep);
    if (given.length < wanted.length) continue;
    const differ = wanted.map((segment, index) => (segment === given[index] ? null : index)).filter((index) => index !== null);
    if (differ.length !== 1 || !slipped(given[differ[0]], wanted[differ[0]])) continue;
    const corrected = path.join(path.resolve(known), ...given.slice(wanted.length));
    if (exists(corrected) || (write && exists(path.dirname(corrected)))) return corrected;
  }
  // An SFlow result (`.sflow/out/<file>`) read below another folder: the relative path a host resolved against its
  // workspace folder, which may be the main clone rather than the Story's checkout. Only that folder, only a file there.
  const at = given.findIndex((segment, index) => segment === '.sflow' && given[index + 1] === 'out');
  if (!write && at > 0 && given.length === at + 3) {
    for (const known of returned ?? []) {
      if (typeof known !== 'string' || !path.isAbsolute(known)) continue;
      const corrected = path.join(path.resolve(known), ...given.slice(at));
      if (corrected !== path.resolve(attempted) && exists(corrected)) return corrected;
    }
  }
  // A file SFlow issued in its private folder, its path rebuilt from another start: the same tail from the last
  // `singularity-flow` folder on (its purpose folder and file name), under a front that dropped, added or changed
  // folders. Only an issued file that is there, and only when exactly one returned file has that tail.
  const tailOf = (segments) => {
    const at = segments.lastIndexOf('singularity-flow');
    return at < 0 || segments.length - at < 3 ? null : segments.slice(at).join(path.sep);
  };
  const tail = tailOf(given);
  if (tail) {
    const issued = [...new Set((returned ?? []).filter((known) => typeof known === 'string' && path.isAbsolute(known))
      .map((known) => path.resolve(known)))].filter((known) => tailOf(known.split(path.sep)) === tail);
    if (issued.length === 1 && exists(issued[0])) return issued[0];
  }
  return null;
}

/**
 * What a failed native file call is told when its path was a copy slip of a returned one: `{ additionalContext,
 * pathCorrections }`, or null. `calls` are `{ paths, cwd, write }`; `returned` the paths SFlow gave this turn.
 */
export function pathSlipAnswer(calls, returned, { cwd = process.cwd(), exists = existsSync } = {}) {
  const corrections = [];
  for (const call of calls ?? []) {
    for (const target of call.paths ?? []) {
      const attempted = path.resolve(call.cwd ?? cwd, String(target));
      const issuedPath = pathSlipOf(attempted, returned, { write: call.write === true, exists });
      if (issuedPath) corrections.push({ attemptedPath: target, issuedPath, operation: call.write ? 'write' : 'read' });
    }
  }
  if (!corrections.length) return null;
  return { pathCorrections: corrections,
    additionalContext: `SFlow: ${corrections.map((entry) => `${entry.attemptedPath} is not a path SFlow returned: it is a copy slip of ${entry.issuedPath}`).join('; ')}. `
      + `This is not a missing file and not a blocker. ${corrections.length === 1 ? 'Use that exact path' : 'Use those exact paths'} once with your file tool (pathCorrections: ${JSON.stringify(corrections)}) and continue the task.` };
}
