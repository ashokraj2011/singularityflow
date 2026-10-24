/**
 * Who left one line, from observed writes only [XPL2 M3]. Pure.
 *
 * A line is attributed to a writer only when the recorded writes explain the file exactly: starting
 * from the bytes before the change that introduced the line (the capture's baseline, or a commit's
 * parent) or from a whole-file write, each verified write turns the bytes before it into the bytes
 * after it, and the last one left the bytes that hold the line now. The line is then followed back
 * through each write's changed line ranges to the write that changed it last. Recorded time order
 * is never used; every history the digests allow is followed, and the line is attributed only when
 * all of them name one writer. Anything less says precisely why it is not.
 */
const MAXIMUM_PATHS = 64;
const MAXIMUM_DEPTH = 256;

/** The writer identity two writes must share to count as one writer. */
export function xpl2WriterKey(writer) {
  return JSON.stringify([writer?.kind ?? null, writer?.session ?? null, writer?.turn ?? null, writer?.invocation ?? null]);
}

/** Follow one line back through a write's steps (last first): written by it, or its line before it. */
function lineBefore(steps, line) {
  let at = line;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const [, beforeLines, afterStart, afterLines] = steps[index];
    if (at >= afterStart && at < afterStart + afterLines) return { written: true };
    if (at >= afterStart + afterLines) at = at - afterLines + beforeLines;
  }
  return { written: false, line: at };
}

const strip = (value) => (typeof value === 'string' ? value.replace(/^sha256:/u, '') : null);

/**
 * `start` is `{ sha256 }`, `{ absent: true }` or `{ unknown: true }`; `end` the SHA-256 of the bytes
 * holding `line` now. Returns `{ status: 'attributed', writer, writes, subject }` or
 * `{ status: 'unestablished', basis, writes }`.
 */
export function attributeLineWriter({ records = [], path, start = { unknown: true }, end, line }) {
  const writes = records.flatMap((record) => (record.files ?? [])
    .filter((file) => file?.path === path).map((file) => ({ record, file })));
  const result = (basis) => ({ status: 'unestablished', basis, writes: writes.length });
  if (!writes.length) return result('no-recorded-writes');
  const target = strip(end);
  if (!target) return result('no-content-digest');
  const into = (bytes) => writes.filter(({ file }) => file.after === bytes);
  if (!into(target).length) return result('bytes-not-left-by-a-recorded-write');
  const verified = writes.filter(({ file }) => file.verified === true && Array.isArray(file.steps)
    && file.steps.every((step) => Array.isArray(step) && step.length === 4 && step.every(Number.isSafeInteger)));
  const origin = start?.sha256 ? strip(start.sha256) : start?.absent ? 'absent' : null;
  // Bytes the verified writes reach from the starting bytes; a whole-file write anchors itself.
  const reached = new Set(origin ? [origin] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const { file } of verified) {
      if ((file.full || reached.has(file.before)) && !reached.has(file.after)) { reached.add(file.after); grew = true; }
    }
  }
  if (!reached.has(target)) {
    return result(into(target).every(({ file }) => file.verified !== true) ? 'unverified-write' : 'recorded-writes-incomplete');
  }
  const outcomes = [];
  let explored = 0;
  const walk = (bytes, at, depth, seen) => {
    if (bytes === origin) { outcomes.push({ kind: 'start' }); return; }
    if (++explored > MAXIMUM_PATHS || depth > MAXIMUM_DEPTH) { outcomes.push({ kind: 'bounded' }); return; }
    const entering = into(bytes);
    // Another write that left the same bytes is another explanation of them, checked or not.
    if (entering.some(({ file }) => file.verified !== true)) outcomes.push({ kind: 'unverified' });
    for (const write of entering.filter((entry) => verified.includes(entry) && (entry.file.full || reached.has(entry.file.before)))) {
      const traced = lineBefore(write.file.steps, at);
      if (traced.written) { outcomes.push({ kind: 'written', write }); continue; }
      // A whole-file write wrote every line it left; a line past them means the records disagree.
      if (write.file.full) { outcomes.push({ kind: 'inconsistent' }); continue; }
      const key = `${write.file.before}:${traced.line}`;
      if (seen.has(key)) { outcomes.push({ kind: 'bounded' }); continue; }
      walk(write.file.before, traced.line, depth + 1, new Set([...seen, key]));
    }
  };
  walk(target, line, 0, new Set());
  if (outcomes.some((outcome) => outcome.kind === 'unverified')) return result('unverified-write');
  const written = outcomes.filter((outcome) => outcome.kind === 'written');
  if (outcomes.some((outcome) => outcome.kind === 'inconsistent')) return result('recorded-writes-incomplete');
  if (outcomes.some((outcome) => outcome.kind === 'bounded')) return result('several-writers');
  if (outcomes.some((outcome) => outcome.kind === 'start')) return result(written.length ? 'several-writers' : 'unchanged-by-recorded-writes');
  const writers = new Set(written.map((outcome) => xpl2WriterKey(outcome.write.record.writer)));
  if (writers.size !== 1) return result('several-writers');
  const chosen = [...new Map(written.map((outcome) => [outcome.write.record.id, outcome.write.record])).values()];
  return {
    status: 'attributed',
    writer: chosen[0].writer,
    subject: chosen[0].subject ?? null,
    writes: chosen.map((record) => ({ id: record.id, tool: record.tool, recordedAt: record.recordedAt, source: record.source })),
    recordedWrites: writes.length
  };
}
