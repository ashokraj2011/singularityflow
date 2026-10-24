/**
 * The observed-write question for `--subject line` [XPL2 M3]: which change put the line where it is,
 * the bytes before and after that change, and what this machine's observed writes say about it.
 *
 * Two changes can hold a line: this capture (an added or changed after-side line: the baseline's
 * bytes to the captured bytes, whose digest the capture already holds), or the commit `git blame`
 * named (its parent's bytes to its own). Git is read only when a recorded write names the path,
 * once, for at most two blobs, through the caller's `readBlobs` (the typed reader in git.mjs); with
 * no record nothing more is read.
 */
import { createHash } from 'node:crypto';

import { readObservedWrites } from './observed-writes.mjs';
import { attributeLineWriter } from './writer-attribution.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Which change to explain the line by, or null when neither the capture nor history places it. */
function lineChange(manifest, baselineCommit, query, history) {
  const request = history?.request ?? null;
  if (request?.kind === 'captured-change' && query.side === 'after') {
    const region = (manifest?.regions ?? []).find((entry) => entry.location?.pathAfter === query.path);
    if (!region) return null;
    const pathBefore = region.location.pathBefore ?? null;
    return {
      span: 'captured', path: query.path, line: query.line, commit: null,
      start: !pathBefore || region.operation === 'added' ? { absent: true } : baselineCommit ? { ref: baselineCommit, path: pathBefore } : { unknown: true },
      end: { sha256: region.location.contentAfterSha256 ?? null }
    };
  }
  const result = history?.result ?? null;
  if (request?.kind === 'baseline' && result?.commit && Number.isSafeInteger(result.originalLine) && result.filename) {
    return {
      span: 'commit', path: result.filename, line: result.originalLine, commit: result.commit,
      start: result.previous ? { ref: result.previous.commit, path: result.previous.path } : result.boundary ? { unknown: true } : { absent: true },
      end: { ref: result.commit, path: result.filename }
    };
  }
  return null;
}

export async function readLineWriter({ manifest, baselineCommit = null, gitDirectory, readBlobs }, query, history) {
  const change = lineChange(manifest, baselineCommit, query, history);
  if (!change) return null;
  let store;
  try { store = await readObservedWrites(gitDirectory, { paths: [change.path] }); }
  catch { store = { status: 'inaccessible', records: [] }; }
  const base = { span: change.span, commit: change.commit, path: change.path, line: change.line, store };
  if (store.status === 'inaccessible') return { ...base, status: 'unestablished', basis: 'records-unreadable', writes: 0 };
  if (!store.records.length) return { ...base, ...attributeLineWriter({ records: [], path: change.path, end: null, line: change.line }) };
  const requests = [
    change.start.ref ? { key: 'start', ref: change.start.ref, path: change.start.path } : null,
    change.end.ref ? { key: 'end', ref: change.end.ref, path: change.end.path } : null
  ].filter(Boolean);
  let blobs = new Map();
  try { blobs = requests.length ? readBlobs(requests) : new Map(); } catch { blobs = new Map(); }
  // Bytes Git could not hand over (too large, or not present) are unknown, never absent.
  const start = change.start.ref ? (blobs.has('start') ? { sha256: sha256(blobs.get('start')) } : { unknown: true }) : change.start;
  const end = change.end.ref ? (blobs.has('end') ? sha256(blobs.get('end')) : null) : change.end.sha256;
  return { ...base, ...attributeLineWriter({ records: store.records, path: change.path, start, end, line: change.line }) };
}
