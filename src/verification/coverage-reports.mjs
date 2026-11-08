/**
 * Coverage reports [CQF:REQ-030, REQ-031]: what a test command's own coverage report says ran, read
 * beside its test report and kept with its attempt.
 *
 * SFlow never adds a coverage flag to a command, because that would change its pin: a report is read
 * only when the command already writes one, at the path it names (`coverage: { format, path }`) or at
 * a usual tool's usual place. A report that was there before the run and that the run did not write
 * is an earlier run's, and is never read as this one's. Four forms are read: lcov, Cobertura, JaCoCo
 * and Istanbul JSON. What a run measured is narrowed, when it ran, to the lines the Story changed
 * since its base, so a later reader needs neither the code nor the report to say what ran.
 * Loaded only when a test command runs or a run is read.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { documentationLanguage } from '../code-documentation.mjs';
import { sfGuardChangeSet } from '../git.mjs';
import { isTestAutomationPath } from '../source-boundary.mjs';
import { posix, secureRepositoryPath, writeAtomicExclusive } from '../util.mjs';

export const COVERAGE_FORMATS = Object.freeze(['lcov', 'cobertura', 'jacoco', 'istanbul-json']);
/** Where the usual tools write their report, read when a command names none. */
export const DEFAULT_COVERAGE_REPORTS = Object.freeze([
  { format: 'lcov', path: 'coverage/lcov.info' },
  { format: 'cobertura', path: 'coverage/cobertura-coverage.xml' },
  { format: 'jacoco', path: 'target/site/jacoco/jacoco.xml' },
  { format: 'jacoco', path: 'build/reports/jacoco/test/jacocoTestReport.xml' },
  { format: 'cobertura', path: 'coverage.xml' },
  { format: 'istanbul-json', path: 'coverage/coverage-final.json' }
].map(Object.freeze));
export const COVERAGE_LIMITS = Object.freeze({ reportBytes: 8 * 1024 * 1024, files: 1000, sourceBytes: 2 * 1024 * 1024 });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fileStamp(absolute) {
  try {
    const info = await lstat(absolute);
    return info.isFile() ? { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino } : null;
  } catch { return null; }
}

/** The reports a run of `command` may write, each with what is there now: compared after the run. */
export async function coverageReportsBefore(executionRoot, command) {
  const candidates = command?.coverage ? [command.coverage] : DEFAULT_COVERAGE_REPORTS;
  return Promise.all(candidates.map(async (candidate) => ({
    format: candidate.format, path: candidate.path, before: await fileStamp(path.resolve(executionRoot, candidate.path))
  })));
}

// ---------------------------------------------------------------------------------------------
// Readers. Each returns `[{ file, sources, lines: Map<line, hits> }]` in the report's own paths.

function addHits(lines, line, hits) {
  if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits)) return;
  lines.set(line, Math.max(lines.get(line) ?? 0, Math.max(0, hits)));
}

function readLcov(text) {
  const entries = [];
  let current = null;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) { current = { file: line.slice(3), sources: [], lines: new Map() }; entries.push(current); }
    else if (line.startsWith('DA:') && current) {
      const [number, hits] = line.slice(3).split(',');
      addHits(current.lines, Number(number), Number(hits));
    } else if (line === 'end_of_record') current = null;
  }
  if (!entries.length && text.trim()) throw new Error('no SF: record');
  return entries;
}

const ATTRIBUTES = new Map();
const attribute = (tag, name) => {
  if (!ATTRIBUTES.has(name)) ATTRIBUTES.set(name, new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u'));
  const found = ATTRIBUTES.get(name).exec(tag);
  return found ? xmlText(found[1] ?? found[2]) : null;
};
const xmlText = (value) => String(value).replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/giu, (whole, name) => {
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[name.toLowerCase()];
  if (named) return named;
  const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
});

// Cobertura (coverage.py, Istanbul's cobertura reporter, many others): each class names its file,
// relative to one of the report's <source> folders; its lines carry their hits.
function readCobertura(text) {
  if (!/<coverage[\s>]/u.test(text)) throw new Error('no <coverage> element');
  const sources = [...text.matchAll(/<source>([^<]*)<\/source>/gu)].map((match) => xmlText(match[1]).trim()).filter(Boolean);
  const entries = new Map();
  for (const found of text.matchAll(/<class\b([^>]*?)(\/?)>([\s\S]*?)(?:<\/class>|(?=<class\b))/gu)) {
    const file = attribute(found[1], 'filename');
    if (!file) continue;
    if (!entries.has(file)) entries.set(file, { file, sources, lines: new Map() });
    const { lines } = entries.get(file);
    for (const line of found[3].matchAll(/<line\b([^>]*)\/?>/gu)) addHits(lines, Number(attribute(line[1], 'number')), Number(attribute(line[1], 'hits')));
  }
  return [...entries.values()];
}

// JaCoCo: each source file is named inside its package's folder; a line ran when it covered an instruction.
function readJacoco(text) {
  if (!/<report[\s>]/u.test(text)) throw new Error('no <report> element');
  const entries = [];
  for (const pkg of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/gu)) {
    const folder = attribute(pkg[1], 'name') ?? '';
    for (const source of pkg[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/gu)) {
      const name = attribute(source[1], 'name');
      if (!name) continue;
      const lines = new Map();
      for (const line of source[2].matchAll(/<line\b([^>]*)\/?>/gu)) {
        const covered = Number(attribute(line[1], 'ci') ?? 0);
        const missed = Number(attribute(line[1], 'mi') ?? 0);
        if (covered > 0 || missed > 0) addHits(lines, Number(attribute(line[1], 'nr')), covered);
      }
      entries.push({ file: folder ? `${folder}/${name}` : name, sources: [], lines });
    }
  }
  return entries;
}

// Istanbul's coverage-final.json (nyc, Jest, Vitest's v8 and istanbul providers): statements by line.
function readIstanbul(text) {
  const report = JSON.parse(text);
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('not an object of files');
  return Object.entries(report).map(([key, value]) => {
    const lines = new Map();
    if (value?.l && typeof value.l === 'object') for (const [line, hits] of Object.entries(value.l)) addHits(lines, Number(line), Number(hits));
    for (const [id, location] of Object.entries(value?.statementMap ?? {})) addHits(lines, Number(location?.start?.line), Number(value?.s?.[id]));
    return { file: String(value?.path ?? key), sources: [], lines };
  });
}

const READERS = Object.freeze({ lcov: readLcov, cobertura: readCobertura, jacoco: readJacoco, 'istanbul-json': readIstanbul });

/** The files one report names and the hits of each executable line, in the report's own paths. */
export function readCoverageReport(format, bytes) {
  const reader = READERS[format];
  if (!reader) throw new Error(`no reader for ${format}`);
  return reader(Buffer.from(bytes).toString('utf8'));
}

/**
 * Each report entry under the repository-relative path it names, as best its form allows. An absolute
 * path is read against the checkout it ran in; a relative one against the command's folder or a
 * Cobertura source; a JaCoCo package path is matched by its end against the changed files.
 */
function reportIndex(entries, { repositoryRoots, workingDirectory }) {
  const exact = new Map();
  const loose = [];
  const add = (key, lines) => {
    const merged = exact.get(key) ?? new Map();
    for (const [line, hits] of lines) merged.set(line, Math.max(merged.get(line) ?? 0, hits));
    exact.set(key, merged);
  };
  for (const entry of entries) {
    const file = posix(entry.file).replace(/^file:\/\//u, '');
    const candidates = [];
    if (path.posix.isAbsolute(file) || /^[A-Za-z]:\//u.test(file)) candidates.push(file);
    else {
      // A relative Cobertura source is the tool's own folder's, as a bare path is.
      for (const source of entry.sources.map(posix)) candidates.push(path.posix.isAbsolute(source) ? path.posix.join(source, file) : path.posix.join(workingDirectory, source, file));
      candidates.push(path.posix.join(workingDirectory, file));
    }
    let placed = false;
    for (const candidate of candidates) {
      const absolute = path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//u.test(candidate);
      const relative = absolute ? repositoryRoots.map((base) => (candidate.startsWith(`${base}/`) ? candidate.slice(base.length + 1) : null)).find(Boolean) : path.posix.normalize(candidate);
      if (relative && !relative.startsWith('../')) { add(relative, entry.lines); placed = true; break; }
    }
    if (!placed) loose.push({ file, lines: entry.lines });
  }
  return (relative) => {
    if (exact.has(relative)) return exact.get(relative);
    // A package path (JaCoCo) or a path from another checkout ends with the changed file's own end.
    const ends = [...exact.entries(), ...loose.map((entry) => [entry.file, entry.lines])]
      .filter(([key]) => relative.endsWith(`/${key}`) || key.endsWith(`/${relative}`));
    return ends.length === 1 ? ends[0][1] : null;
  };
}

// ---------------------------------------------------------------------------------------------
// The lines a Story changed.

/** Added lines by file, in the new file's coordinates, from a zero-context patch. */
export function changedLinesFromPatch(patch) {
  const changed = new Map();
  let current = null;
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^"(.*)"$/u, '$1');
      current = target === '/dev/null' ? null : target.replace(/^b\//u, '');
      if (current && !changed.has(current)) changed.set(current, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] == null ? 1 : Number(hunk[2]);
      for (let offset = 0; offset < count; offset += 1) changed.get(current).add(start + offset);
    }
  }
  return changed;
}

/** `[1, 2, 3, 7]` → `'1-3,7'`. */
export function lineRanges(lines) {
  const sorted = [...lines].sort((left, right) => left - right);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(',');
}

/** `'1-3,7'` → `Set {1, 2, 3, 7}`. */
export function rangeLines(text) {
  const lines = new Set();
  for (const part of String(text ?? '').split(',').filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (Number.isInteger(from) && Number.isInteger(to) && to >= from && to - from < 1_000_000) for (let line = from; line <= to; line += 1) lines.add(line);
  }
  return lines;
}

const underRoots = (relative, roots) => !roots?.length || roots.some((root) => root === '.' || relative === root || relative.startsWith(`${root.replace(/\/$/u, '')}/`));
const isSourceFile = (relative) => Boolean(documentationLanguage(relative)) && !isTestAutomationPath(relative)
  && !relative.startsWith('singularity/') && !relative.startsWith('.sflow/');

/**
 * The Story's changed lines in `codeRoot` since `base` that a report measured: per file, the changed
 * lines it marks executable, which of them ran, and the changed source files it does not name at all.
 * Lines it does not list (blank, comments) are not code and do not count. Below the command's roots only.
 */
async function changedLineMeasure(index, { codeRoot, base, affectedRoots }) {
  const { patch, untracked } = sfGuardChangeSet(codeRoot, base);
  const changed = changedLinesFromPatch(patch);
  // A new file counts whole; only source or a file the report names is read, so an untracked build folder costs nothing.
  for (const relative of untracked.slice(0, COVERAGE_LIMITS.files * 10)) {
    if (changed.has(relative) || !underRoots(relative, affectedRoots) || !(isSourceFile(relative) || index(relative))) continue;
    try {
      const bytes = await readFile(path.join(codeRoot, ...relative.split('/')));
      if (bytes.length > COVERAGE_LIMITS.sourceBytes || bytes.includes(0)) continue;
      const count = bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0);
      changed.set(relative, new Set(Array.from({ length: count }, (_, offset) => offset + 1)));
    } catch { /* gone or unreadable: not measured */ }
  }
  const files = [];
  for (const [relative, lines] of [...changed.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!lines.size || !underRoots(relative, affectedRoots)) continue;
    const measured = index(relative);
    if (!measured) {
      if (isSourceFile(relative)) files.push({ path: relative, inReport: false, executable: 0, covered: 0, coveredLines: '', uncoveredLines: '' });
      continue;
    }
    const executable = [...lines].filter((line) => measured.has(line));
    const covered = executable.filter((line) => measured.get(line) > 0);
    const uncovered = executable.filter((line) => !(measured.get(line) > 0));
    files.push({ path: relative, inReport: true, executable: executable.length, covered: covered.length,
      coveredLines: lineRanges(covered), uncoveredLines: lineRanges(uncovered) });
    if (files.length >= COVERAGE_LIMITS.files) break;
  }
  return files;
}

/**
 * After a run: the coverage report it wrote, with what it says about the Story's changed lines, or
 * `{ status: 'not-measured', reason }` when the only report there is an earlier run's or cannot be
 * read, or null when there is none. `before` is coverageReportsBefore's answer. Never throws: coverage
 * is shown, and a run is judged by its tests as before [CQF:REQ-034].
 */
export async function capturedCoverage(executionRoot, before, { startedAt = null, codeRoot = null, base = null, workingDirectory = '.', affectedRoots = [] } = {}) {
  const startMs = Date.parse(startedAt ?? '');
  const stale = [];
  for (const candidate of before ?? []) {
    const sourcePath = posix(path.posix.join(posix(workingDirectory || '.'), candidate.path));
    const absolute = path.resolve(executionRoot, candidate.path);
    const now = await fileStamp(absolute);
    if (!now) continue;
    // Not written by this run: the same file as before it started, or older than its start.
    const same = candidate.before && candidate.before.mtimeMs === now.mtimeMs && candidate.before.size === now.size && candidate.before.ino === now.ino;
    if (same || (Number.isFinite(startMs) && now.mtimeMs + 1000 < startMs)) { stale.push(sourcePath); continue; }
    const notMeasured = (reason) => ({ status: 'not-measured', format: candidate.format, sourcePath, reason });
    if (now.size > COVERAGE_LIMITS.reportBytes) return notMeasured(`${sourcePath} is larger than ${COVERAGE_LIMITS.reportBytes / 1024 / 1024} MiB`);
    try {
      const contents = await readFile(absolute);
      const entries = readCoverageReport(candidate.format, contents);
      const summary = { status: 'measured', format: candidate.format, sourcePath,
        lines: { executable: entries.reduce((total, entry) => total + entry.lines.size, 0),
          covered: entries.reduce((total, entry) => total + [...entry.lines.values()].filter((hits) => hits > 0).length, 0) } };
      if (codeRoot && base) {
        // The checkout it ran in, as given and as the file system names it (macOS /var is /private/var).
        const repositoryRoots = [...new Set([posix(codeRoot), posix(await realpath(codeRoot).catch(() => codeRoot))])];
        try {
          summary.changed = { base, files: await changedLineMeasure(reportIndex(entries, { repositoryRoots, workingDirectory: posix(workingDirectory || '.') }), { codeRoot, base, affectedRoots }) };
        } catch (error) { summary.changed = { base, unavailable: String(error?.message ?? error).slice(0, 200) }; }
      }
      return { ...summary, contents, sha256: sha256(contents), bytes: contents.length };
    } catch (error) {
      return notMeasured(`${sourcePath} could not be read as ${candidate.format}: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  return stale.length ? { status: 'not-measured', sourcePath: stale[0], reason: `${stale.join(', ')} was not written by this run, so it is an earlier run's` } : null;
}

// ---------------------------------------------------------------------------------------------
// Kept with the attempt (verification/attempts.mjs), in the same private storage as its test reports.

/** The Story-relative, content-addressed path of one coverage report, beside the test reports [CQF:REQ-030]. */
export function coverageReportPath(itemRelative, digest, format) {
  const extension = format === 'lcov' ? '.info' : ['cobertura', 'jacoco'].includes(format) ? '.xml' : '.bin';
  return posix(path.join(itemRelative, 'context', 'code-delivery', 'tests', 'raw', `${digest}${extension}`));
}

async function keepBytes(staging, digest, bytes) {
  try { await writeAtomicExclusive(path.join(staging, 'raw', digest), bytes, { mode: 0o600 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
}

/**
 * What a run's attempt records of its coverage report, its bytes kept privately with the test reports
 * until the step's next gate admits them. A report the run did not write, or that could not be read, is
 * recorded as not measured with why.
 */
export async function keptCoverage(staging, itemRelative, coverage) {
  if (coverage.status !== 'measured') return { status: 'not-measured', ...(coverage.sourcePath ? { sourcePath: coverage.sourcePath } : {}), reason: coverage.reason };
  const { contents, sha256: digest, bytes, ...summary } = coverage;
  await keepBytes(staging, digest, contents);
  return { ...summary, report: { path: coverageReportPath(itemRelative, digest, coverage.format), sha256: digest, bytes } };
}

/** A kept coverage report's bytes, from private storage or the Story, checked against its address; null when gone. */
export async function coverageReportBytes(root, staging, report) {
  for (const read of [() => readFile(path.join(staging, 'raw', report.sha256)), async () => {
    const secured = await secureRepositoryPath(root, report.path, { label: 'Coverage report' });
    return secured.exists ? readFile(secured.absolute) : null;
  }]) {
    const bytes = await read().catch(() => null);
    if (bytes && sha256(bytes) === report.sha256) return bytes;
  }
  return null;
}

/** A reused run's coverage, its bytes kept again for this step; one no longer here keeps what it said, without its bytes. */
export async function reusedCoverage(root, staging, coverage) {
  const bytes = await coverageReportBytes(root, staging, coverage.report);
  if (!bytes) return { ...coverage, report: null };
  await keepBytes(staging, coverage.report.sha256, bytes);
  return coverage;
}
