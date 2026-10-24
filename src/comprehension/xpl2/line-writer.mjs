/**
 * The observed-write question for `--subject line` [XPL2 M3]: which change put the line where it is,
 * the bytes before and after that change, and what this machine's observed writes say about it.
 *
 * Two changes can hold a line: this capture (an added or changed after-side line: the baseline's
 * bytes to the captured bytes, whose digest the capture already holds), or the commit `git blame`
 * named (its parent's bytes to its own). Committed bytes are read as a checkout writes them, so
 * line-end conversion and filters do not hide a match with bytes read from disk. A record takes part
 * only when the line's history descends from the commit it was made on. Git is read only when a
 * recorded write names the path, through the caller's typed readers (git.mjs): at most two files and
 * one ancestry check per distinct recorded commit.
 */
import { createHash } from 'node:crypto';

import { readObservedWrites } from './observed-writes.mjs';
import { attributeLineWriter } from './writer-attribution.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MAXIMUM_ANCESTRY_CHECKS = 8;

/** Which change to explain the line by, or null when neither the capture nor history places it. */
function lineChange(manifest, baselineCommit, headCommit, query, history) {
  const request = history?.request ?? null;
  if (request?.kind === 'captured-change' && query.side === 'after') {
    const region = (manifest?.regions ?? []).find((entry) => entry.location?.pathAfter === query.path);
    if (!region) return null;
    const pathBefore = region.location.pathBefore ?? null;
    return {
      span: 'captured', path: query.path, line: query.line, commit: null, descendant: headCommit,
      start: !pathBefore || region.operation === 'added' ? { absent: true } : baselineCommit ? { ref: baselineCommit, path: pathBefore } : { unknown: true },
      end: { sha256: region.location.contentAfterSha256 ?? null }
    };
  }
  const result = history?.result ?? null;
  if (request?.kind === 'baseline' && result?.commit && Number.isSafeInteger(result.originalLine) && result.filename) {
    return {
      span: 'commit', path: result.filename, line: result.originalLine, commit: result.commit, descendant: result.commit,
      start: result.previous ? { ref: result.previous.commit, path: result.previous.path } : result.boundary ? { unknown: true } : { absent: true },
      end: { ref: result.commit, path: result.filename }
    };
  }
  return null;
}

/**
 * `readBytes(revision, path)` returns a file's checkout bytes at a commit or null;
 * `isAncestor(older, newer)` answers one ancestry question.
 */
export async function readLineWriter({ manifest, baselineCommit = null, headCommit = null, gitDirectory, readBytes, isAncestor }, query, history) {
  const change = lineChange(manifest, baselineCommit, headCommit, query, history);
  if (!change) return null;
  let store;
  try { store = await readObservedWrites(gitDirectory, { paths: [change.path] }); }
  catch { store = { status: 'inaccessible', records: [] }; }
  const base = { span: change.span, commit: change.commit, path: change.path, line: change.line, store };
  if (store.status === 'inaccessible') return { ...base, status: 'unestablished', basis: 'records-unreadable', writes: 0 };
  if (!store.records.length) return { ...base, ...attributeLineWriter({ records: [], path: change.path, end: null, line: change.line }) };
  // Only records made on a commit this line's history descends from: never another branch's work.
  const heads = [...new Set(store.records.map((record) => record.head).filter((head) => typeof head === 'string'))];
  const descends = new Map();
  for (const head of heads.slice(0, MAXIMUM_ANCESTRY_CHECKS)) {
    let answer = false;
    try { answer = Boolean(change.descendant) && (head === change.descendant || isAncestor(head, change.descendant)); } catch { answer = false; }
    descends.set(head, answer);
  }
  const admissible = (record) => descends.get(record.head) === true;
  const read = (ref, file) => { try { return readBytes(ref, file); } catch { return null; } };
  // Bytes Git could not hand over (too large, or not present) are unknown, never absent.
  const startBytes = change.start.ref ? read(change.start.ref, change.start.path) : null;
  const start = change.start.ref ? (startBytes ? { sha256: sha256(startBytes) } : { unknown: true }) : change.start;
  const endBytes = change.end.ref ? read(change.end.ref, change.end.path) : null;
  const end = change.end.ref ? (endBytes ? sha256(endBytes) : null) : change.end.sha256;
  return { ...base, ...attributeLineWriter({ records: store.records, path: change.path, start, end, line: change.line, admissible }) };
}
