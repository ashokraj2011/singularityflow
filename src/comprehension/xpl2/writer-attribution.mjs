/**
 * Who left one line, from observed writes only [XPL2 M3]. Pure.
 *
 * Every record's before and after digests were read from disk around the write, and its steps are
 * the lines those two versions differ in. Starting from the bytes that hold the line now, the
 * writes that left those exact bytes are found; the line is credited to their writer only when it
 * lies in a verified changed range of theirs (lines the tool's own arguments explain). A line
 * outside every changed range is followed back to the bytes before the write, and so on, until a
 * write changed it, the bytes before the change that holds the line are reached (the line was
 * already there), or no record left the bytes (an unrecorded change). Writes by different writers
 * that left the same bytes, or that disagree about the line, make it ambiguous. Recorded time order
 * is never used, and only records `admissible` names (made on a commit the line's history descends
 * from) take part.
 */
const MAXIMUM_DEPTH = 256;

/** The writer identity two writes must share to count as one writer. */
export function xpl2WriterKey(writer) {
  return JSON.stringify([writer?.kind ?? null, writer?.session ?? null, writer?.turn ?? null, writer?.invocation ?? null]);
}

/** Follow one line back through a write's changed ranges (last first): changed by it, or its line before it. */
function lineBefore(steps, line) {
  let at = line;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const [, beforeLines, afterStart, afterLines] = steps[index];
    if (at >= afterStart && at < afterStart + afterLines) return { changed: true };
    if (at >= afterStart + afterLines) at = at - afterLines + beforeLines;
  }
  return { changed: false, line: at };
}

const strip = (value) => (typeof value === 'string' ? value.replace(/^sha256:/u, '') : null);
const wellFormed = (file) => typeof file?.after === 'string' && typeof file.before === 'string' && Array.isArray(file.steps)
  && file.steps.every((step) => Array.isArray(step) && step.length === 4 && step.every((value) => Number.isSafeInteger(value) && value >= 0));

/**
 * `start` is `{ sha256 }`, `{ absent: true }` or `{ unknown: true }`: the bytes before the change
 * that holds the line. `end` is the SHA-256 of the bytes that hold `line` now. Returns
 * `{ status: 'attributed', writer, writes, subject }` or `{ status: 'unestablished', basis, writes }`.
 */
export function attributeLineWriter({ records = [], path, start = { unknown: true }, end, line, admissible = () => true }) {
  const writes = records.filter((record) => admissible(record)).flatMap((record) => (record.files ?? [])
    .filter((file) => file?.path === path && wellFormed(file)).map((file) => ({ record, file })));
  const result = (basis) => ({ status: 'unestablished', basis, writes: writes.length });
  if (!writes.length) return result('no-recorded-writes');
  let bytes = strip(end);
  if (!bytes) return result('no-content-digest');
  const origin = start?.sha256 ? strip(start.sha256) : start?.absent ? 'absent' : null;
  let at = line;
  const seen = new Set();
  for (let depth = 0; depth < MAXIMUM_DEPTH; depth += 1) {
    if (bytes === origin) return result('unchanged-by-recorded-writes');
    const entering = writes.filter(({ file }) => file.after === bytes);
    if (!entering.length) return result(depth ? 'recorded-writes-incomplete' : 'bytes-not-left-by-a-recorded-write');
    if (new Set(entering.map(({ record }) => xpl2WriterKey(record.writer))).size > 1) return result('several-writers');
    const traced = entering.map((write) => ({ write, ...lineBefore(write.file.steps, at) }));
    if (traced.some((entry) => entry.changed)) {
      if (!traced.every((entry) => entry.changed)) return result('several-writers');
      if (!traced.every((entry) => entry.write.file.verified === true)) return result('unverified-write');
      const chosen = [...new Map(traced.map(({ write }) => [write.record.id, write.record])).values()];
      return {
        status: 'attributed', writer: chosen[0].writer, subject: chosen[0].subject ?? null,
        writes: chosen.map((record) => ({ id: record.id, tool: record.tool, recordedAt: record.recordedAt, source: record.source })),
        recordedWrites: writes.length
      };
    }
    const next = new Set(traced.map((entry) => `${entry.write.file.before}\u0000${entry.line}`));
    if (next.size > 1) return result('several-writers');
    const [before, mapped] = [...next][0].split('\u0000');
    if (seen.has(`${before}\u0000${mapped}`)) return result('several-writers');
    seen.add(`${before}\u0000${mapped}`);
    bytes = before;
    at = Number(mapped);
  }
  return result('several-writers');
}
