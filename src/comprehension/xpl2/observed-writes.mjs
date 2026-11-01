/**
 * The observed-write store [XPL2 M3]: this checkout's `<git dir>/singularity-flow/xpl2/observed-writes/`,
 * one JSONL segment per UTC day, written by `observed-write-recorder.mjs` from the pre-tool and turn
 * hooks of explicit SFlow Copilot turns. It is bounded by day count and segment size, discardable, and never
 * authority: a lost record only leaves a line's writer unestablished. Only explain commands read it.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { XPL2_OBSERVED_WRITE_LIMITS, XPL2_OBSERVED_WRITE_READ_FORMATS, xpl2ObservedWriteDirectory } from './observed-write-recorder.mjs';

export {
  captureToolWrites, recordObservedWrite, settleToolWrites, XPL2_OBSERVED_WRITE_LIMITS, xpl2ObservedWriteDirectory
} from './observed-write-recorder.mjs';

const READ_RECORDS = 5000;
const SEGMENT = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const FULL_MARKER = /^(\d{4}-\d{2}-\d{2})\.full$/u;

/**
 * The retained records naming one of `paths`, or the Story `subject`'s phase and generation. Records
 * of another format, unreadable lines and full days are counted and contribute nothing.
 */
export async function readObservedWrites(gitDirectory, { paths = null, subject = null, now = Date.now() } = {}) {
  const directory = xpl2ObservedWriteDirectory(gitDirectory);
  const retentionDays = XPL2_OBSERVED_WRITE_LIMITS.retentionDays;
  const info = await lstat(directory).catch(() => null);
  if (!info) return { status: 'absent', records: [], dropped: 0, unreadable: 0, omitted: 0, retentionDays };
  if (!info.isDirectory() || info.isSymbolicLink()) return { status: 'inaccessible', records: [], dropped: 0, unreadable: 0, omitted: 0, retentionDays };
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const wanted = paths ? new Set(paths) : null;
  const records = [];
  let unreadable = 0;
  let dropped = 0;
  for (const name of (await readdir(directory)).sort()) {
    if ((FULL_MARKER.exec(name)?.[1] ?? '') >= cutoff) dropped += 1;
    const date = SEGMENT.exec(name)?.[1];
    if (!date || date < cutoff) continue;
    const file = path.join(directory, name);
    const entry = await lstat(file).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > XPL2_OBSERVED_WRITE_LIMITS.segmentBytes * 2) { unreadable += 1; continue; }
    for (const raw of (await readFile(file, 'utf8')).split('\n')) {
      if (!raw.trim()) continue;
      let record;
      try { record = JSON.parse(raw); } catch { unreadable += 1; continue; }
      if (record?.kind !== 'xpl2-observed-write' || !XPL2_OBSERVED_WRITE_READ_FORMATS.includes(record.format) || !Array.isArray(record.files)) { unreadable += 1; continue; }
      const matches = (wanted && record.files.some((file) => wanted.has(file?.path)))
        || (subject && record.subject?.workId === subject.workId && record.subject?.phase === subject.phase
          && record.subject?.generation != null && Number(record.subject.generation) === Number(subject.generation));
      if (matches) records.push(record);
    }
  }
  return {
    status: 'available', records: records.slice(-READ_RECORDS), dropped, unreadable, omitted: Math.max(0, records.length - READ_RECORDS), retentionDays
  };
}
