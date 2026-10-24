/**
 * Retained XPL2 snapshots [XPL2 M3, 5.1]: what each built change view needs for a later comparison.
 *
 * A snapshot is the view's comparison projection (unit IDs, paths, unit and unit-content digests,
 * source and observation states, the statement count) under its explanation-set digest, which is
 * also its identity: the same universe is retained once. It keeps no statement text, no file bytes
 * and no patch, so it can be compared with but never shown or reopened as a view. The store is this
 * checkout's (`<git dir>/singularity-flow/xpl2/snapshots/`), bounded by count, bytes and age,
 * discardable at any time, and never authority: losing it only makes a comparison unavailable.
 * Views write it as they are built; only `explain --compare` reads it.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { XPL2_COMPARISON_PROJECTION, xpl2ComparisonProjection } from './compare.mjs';

export const XPL2_SNAPSHOT_LIMITS = Object.freeze({
  count: 64,
  bytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
  retentionDays: 14
});

// A discardable local cache, not a durable record: an entry of another format is simply not read.
const SNAPSHOT_FORMAT = 'xpl2-retained-snapshot@1';
const SET_DIGEST = /^sha256:([a-f0-9]{64})$/u;
const FILE = /^([a-f0-9]{64})\.json$/u;
const DAY = 24 * 60 * 60 * 1000;

export function xpl2SnapshotDirectory(gitDirectory) {
  return path.join(gitDirectory, 'singularity-flow', 'xpl2', 'snapshots');
}

async function safeDirectory(directory, { create = false } = {}) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory).catch(() => null);
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
}

/** Every retained entry, newest first, with what its file says about itself. */
async function entries(directory) {
  if (!await safeDirectory(directory)) return [];
  const listed = [];
  for (const name of await readdir(directory)) {
    const match = FILE.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    listed.push({ hex: match[1], file, bytes: info.size, seenAt: info.mtimeMs });
  }
  return listed.sort((left, right) => right.seenAt - left.seenAt || left.hex.localeCompare(right.hex));
}

/** Expired entries go first, then the oldest past the count and byte bounds. */
async function prune(directory, now) {
  let total = 0;
  let kept = 0;
  for (const entry of await entries(directory)) {
    const expired = now - entry.seenAt > XPL2_SNAPSHOT_LIMITS.retentionDays * DAY;
    if (expired || kept >= XPL2_SNAPSHOT_LIMITS.count || total + entry.bytes > XPL2_SNAPSHOT_LIMITS.totalBytes) {
      await unlink(entry.file).catch(() => {});
      continue;
    }
    kept += 1;
    total += entry.bytes;
  }
}

/**
 * Retain one view's snapshot. A view already retained is only marked as seen again. Returns the
 * snapshot identity, or why nothing was kept; a failure to write is reported, never thrown.
 */
export async function retainXpl2Snapshot(gitDirectory, view, { now = Date.now() } = {}) {
  const projection = xpl2ComparisonProjection(view);
  const hex = SET_DIGEST.exec(String(projection?.explanationSetSha256 ?? ''))?.[1];
  if (!hex) return { id: null, retained: false, reason: 'not-applicable' };
  const id = `sha256:${hex}`;
  try {
    const directory = xpl2SnapshotDirectory(gitDirectory);
    if (!await safeDirectory(directory, { create: true })) return { id, retained: false, reason: 'source-inaccessible' };
    const file = path.join(directory, `${hex}.json`);
    const existing = await lstat(file).catch(() => null);
    if (existing?.isFile() && !existing.isSymbolicLink()) {
      await utimes(file, new Date(now), new Date(now));
      return { id, retained: true, reason: null };
    }
    const snapshot = view?.snapshot ?? {};
    const record = {
      kind: 'xpl2-retained-snapshot', format: SNAPSHOT_FORMAT, id, retainedAt: new Date(now).toISOString(),
      context: {
        workId: snapshot.workId ?? null, phase: snapshot.phase ?? null, truth: snapshot.truth ?? null,
        baseline: snapshot.baseline?.revision ?? null, capture: snapshot.compatibilityCandidateSha256 ?? null
      },
      projection
    };
    const text = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(text, 'utf8') > XPL2_SNAPSHOT_LIMITS.bytes) return { id, retained: false, reason: 'bounded-delivery' };
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      // The file time is when the universe was last seen: it orders `previous` and drives expiry.
      await utimes(file, new Date(now), new Date(now));
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    await prune(directory, now);
    return { id, retained: true, reason: null };
  } catch {
    return { id, retained: false, reason: 'source-inaccessible' };
  }
}

async function readEntry(entry) {
  try {
    const record = JSON.parse(await readFile(entry.file, 'utf8'));
    // Content-addressed: the file name, the record and its projection name the same universe.
    if (record?.kind !== 'xpl2-retained-snapshot' || record.format !== SNAPSHOT_FORMAT || record.id !== `sha256:${entry.hex}`
        || record.projection?.projection !== XPL2_COMPARISON_PROJECTION || record.projection.explanationSetSha256 !== record.id
        || !Array.isArray(record.projection.units) || !Array.isArray(record.projection.sources)) return null;
    return { ...record, seenAt: new Date(entry.seenAt).toISOString() };
  } catch { return null; }
}

/** Retained snapshots, newest seen first, without their projections. */
export async function listXpl2Snapshots(gitDirectory, { now = Date.now() } = {}) {
  const listed = [];
  for (const entry of await entries(xpl2SnapshotDirectory(gitDirectory))) {
    if (now - entry.seenAt > XPL2_SNAPSHOT_LIMITS.retentionDays * DAY) continue;
    const record = await readEntry(entry);
    if (record) listed.push({ id: record.id, retainedAt: record.retainedAt, seenAt: record.seenAt, context: record.context, units: record.projection.units.length });
  }
  return listed;
}

/**
 * Resolve `previous` or an exact snapshot ID (or a prefix of at least 12 hex digits). `previous` is
 * the most recently seen snapshot of the same Story (or of no Story) whose universe differs from the
 * current one; recency only chooses which snapshot to compare with and is never a claim about it.
 */
export async function resolveXpl2Snapshot(gitDirectory, selector, { current = null, workId = null, now = Date.now() } = {}) {
  const live = (await entries(xpl2SnapshotDirectory(gitDirectory)))
    .filter((entry) => now - entry.seenAt <= XPL2_SNAPSHOT_LIMITS.retentionDays * DAY);
  if (selector === 'previous') {
    for (const entry of live) {
      if (`sha256:${entry.hex}` === current) continue;
      const record = await readEntry(entry);
      if (record && (record.context?.workId ?? null) === (workId ?? null)) return { status: 'available', snapshot: record, retained: live.length };
    }
    return { status: 'not-found', retained: live.length };
  }
  const hex = String(selector).replace(/^sha256:/u, '');
  const matches = live.filter((entry) => entry.hex.startsWith(hex));
  if (matches.length > 1) return { status: 'ambiguous', choices: matches.slice(0, 10).map((entry) => `sha256:${entry.hex}`), retained: live.length };
  const record = matches.length ? await readEntry(matches[0]) : null;
  return record ? { status: 'available', snapshot: record, retained: live.length } : { status: 'not-found', retained: live.length };
}
