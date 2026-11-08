/**
 * One finding shape for every scanner, server and source [CQF Model]. Readers (src/findings/readers/)
 * turn a tool's report into these; the code step's loop, the decision list and the later feeds (M5,
 * M6) read nothing else.
 *
 * A finding's message is the tool's text: bounded, redacted, on one line, and only ever shown as data.
 * Its fingerprint is what makes two runs report "the same finding": tool, rule, file and a hash of the
 * normalised source it points at (or of what the tool gave instead), never the line number, so an edit
 * above it keeps the identity, and never the wording.
 */
import { createHash } from 'node:crypto';

import { redactDiagnosticText } from '../git-remote-diagnostics.mjs';

export const FINDING_FEEDS = Object.freeze(['security', 'tlm', 'quality']);
// Most severe first: the order every gate and summary uses.
export const FINDING_SEVERITIES = Object.freeze(['blocker', 'critical', 'high', 'medium', 'low', 'info']);
export const FINDING_KINDS = Object.freeze([
  'bug', 'vulnerability', 'hotspot', 'code-smell', 'complexity', 'duplication', 'dependency', 'end-of-life'
]);
export const FINDING_MESSAGE_MAX = 400;
// One report never yields more than this; the rest is counted, not kept.
export const MAX_FINDINGS_PER_REPORT = 2_000;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function severityRank(severity) {
  const rank = FINDING_SEVERITIES.indexOf(severity);
  return rank < 0 ? FINDING_SEVERITIES.length : rank;
}

/** The most severe of `severities`, or null. */
export function mostSevere(severities) {
  return [...severities].filter((value) => FINDING_SEVERITIES.includes(value))
    .sort((left, right) => severityRank(left) - severityRank(right))[0] ?? null;
}

/** A tool's message as data: one line, no control characters, secrets and URLs redacted, bounded. */
export function findingMessage(value) {
  const text = redactDiagnosticText(String(value ?? '')).replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return text.length <= FINDING_MESSAGE_MAX ? text : `${text.slice(0, FINDING_MESSAGE_MAX - 1)}…`;
}

/** The digest of a source snippet with its whitespace normalised, so re-indenting keeps the identity. */
export function snippetSha256(text) {
  const normalized = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return normalized ? sha256(normalized) : null;
}

/** A repository-relative path in `/` form, or null when the value names nothing inside the repository. */
export function findingPath(value) {
  const text = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//u.test(text) || text.split('/').includes('..')) return null;
  return text;
}

/**
 * The stable identity: tool, rule, file and the normalised snippet's hash for code; tool, package and
 * advisory for a dependency. Without a snippet the message stands in, with digits removed so a count
 * or a line number inside it does not move the identity.
 */
export function fingerprintFinding({ tool, rule, file, snippet = null, package: name = null, advisory = null, message = null }) {
  const parts = name || advisory
    ? ['dependency', tool, name ?? '', advisory ?? rule ?? '']
    : ['code', tool, rule ?? '', file ?? '', snippet ?? `message:${String(message ?? '').replace(/\d+/gu, '#')}`];
  return `sha256:${sha256(parts.map((part) => String(part ?? '')).join('\u0000'))}`;
}

const positive = (value) => (Number.isInteger(value) && value > 0 ? value : null);
const text = (value, maximum = 256) => (value == null || value === '' ? null : String(value).slice(0, maximum));

/**
 * A finding in the shared shape. `snippet` is the hash of the source the finding points at
 * (snippetSha256), when the reader or the caller has it; the fingerprint uses it and it is not kept.
 */
export function createFinding(fields) {
  const feed = FINDING_FEEDS.includes(fields.feed) ? fields.feed : 'quality';
  const severity = FINDING_SEVERITIES.includes(fields.severity) ? fields.severity : 'info';
  const kind = FINDING_KINDS.includes(fields.kind) ? fields.kind : 'code-smell';
  const tool = text(fields.tool, 128) ?? 'unknown';
  const rule = text(fields.rule, 256);
  const file = findingPath(fields.file);
  const line = positive(fields.line);
  const endLine = positive(fields.endLine) && (!line || fields.endLine >= line) ? fields.endLine : line;
  const message = findingMessage(fields.message);
  const fingerprint = fields.fingerprint ?? fingerprintFinding({ tool, rule, file, snippet: fields.snippet ?? null,
    package: fields.package ?? null, advisory: fields.cve ?? fields.advisory ?? null, message });
  return Object.freeze({
    id: `F-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 16)}`,
    feed, source: text(fields.source, 128) ?? tool, tool, toolVersion: text(fields.toolVersion, 64),
    rulesetSha256: /^sha256:[0-9a-f]{64}$/u.test(String(fields.rulesetSha256 ?? '')) ? fields.rulesetSha256 : null,
    rule, severity, kind, file, line, endLine,
    ...(fields.package ? { package: text(fields.package), installedVersion: text(fields.installedVersion, 64), fixedVersion: text(fields.fixedVersion, 64) } : {}),
    ...(fields.cve ? { cve: text(fields.cve, 64) } : {}),
    ...(fields.dueAt ? { dueAt: text(fields.dueAt, 32) } : {}),
    ...(fields.url ? { url: text(fields.url, 512) } : {}),
    message, fingerprint, newCode: fields.newCode === true
  });
}

/** The same finding with its tool's identity filled in where the report itself gave none. */
export function withToolIdentity(finding, { toolVersion = null, rulesetSha256 = null } = {}) {
  if ((finding.toolVersion || !toolVersion) && (finding.rulesetSha256 || !rulesetSha256)) return finding;
  return createFinding({ ...finding, toolVersion: finding.toolVersion ?? toolVersion, rulesetSha256: finding.rulesetSha256 ?? rulesetSha256 });
}

/**
 * Mark each finding new-code or existing against the lines this Story changed [CQF:REQ-042].
 * `changed` maps a path to `'all'` (a file the Story added) or to `[start, end]` line ranges. A
 * finding with no line counts when its file is the Story's own new file; otherwise only an overlap
 * with a changed range counts.
 */
export function markNewCode(findings, changed) {
  return findings.map((finding) => {
    const ranges = finding.file ? changed?.get(finding.file) : null;
    const start = finding.line;
    const end = finding.endLine ?? finding.line;
    const newCode = ranges === 'all' || (Array.isArray(ranges) && start != null
      && ranges.some(([from, to]) => start <= to && end >= from));
    return newCode === finding.newCode ? finding : Object.freeze({ ...finding, newCode });
  });
}

/** Counts by severity and kind, new code and existing apart. */
export function findingCounts(findings) {
  const counts = { total: findings.length, newCode: 0, existing: 0, bySeverity: {}, byKind: {} };
  for (const finding of findings) {
    counts[finding.newCode ? 'newCode' : 'existing'] += 1;
    counts.bySeverity[finding.severity] = (counts.bySeverity[finding.severity] ?? 0) + 1;
    counts.byKind[finding.kind] = (counts.byKind[finding.kind] ?? 0) + 1;
  }
  return counts;
}

/** Findings in a stable order: most severe first, then file, line and fingerprint. */
export function sortFindings(findings) {
  return [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity)
    || String(left.file ?? '').localeCompare(String(right.file ?? '')) || (left.line ?? 0) - (right.line ?? 0)
    || left.fingerprint.localeCompare(right.fingerprint));
}

/** One finding per fingerprint, the most severe kept, in the stable order. */
export function uniqueFindings(findings) {
  const kept = new Map();
  for (const finding of sortFindings(findings)) if (!kept.has(finding.fingerprint)) kept.set(finding.fingerprint, finding);
  return [...kept.values()];
}
