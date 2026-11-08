/**
 * A suppression added on a changed line is itself a finding [CQF:REQ-044]: silencing a scanner is not
 * fixing what it found. Read from the lines this Story changed, whatever tool the marker is for, so a
 * marker for a scanner that does not run here still counts. Documentation is not read.
 */
import { createFinding, snippetSha256 } from './model.mjs';

const MARKERS = Object.freeze([
  ['NOSONAR', /\bNOSONAR\b/u],
  ['eslint-disable', /\beslint-disable(?:-next-line|-line)?\b/u],
  ['@SuppressWarnings', /@SuppressWarnings\s*\(/u],
  ['@SuppressFBWarnings', /@SuppressFBWarnings\b/u],
  ['nosec', /(?:#|\/\/)\s*#?nosec\b/iu],
  ['nosemgrep', /\bnosemgrep\b/u],
  ['codeql', /(?:\/\/|#)\s*(?:codeql|lgtm)\[/u],
  ['noqa', /#\s*noqa\b/iu],
  ['pylint: disable', /#\s*pylint:\s*disable\b/u],
  ['@ts-ignore', /@ts-(?:ignore|nocheck)\b/u],
  ['NOLINT', /\bNOLINT(?:NEXTLINE)?\b/u]
]);
const DOCUMENTATION = /\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|html?|svg|json|lock|csv)$/iu;
const MAX_LINES = 50_000;

/** The marker a line carries, or null. */
export function suppressionMarker(text) {
  for (const [name, pattern] of MARKERS) if (pattern.test(text)) return name;
  return null;
}

/**
 * Findings for the suppressions on changed lines. `changed` is storyChangedLines' map; `lineOf(path,
 * line)` reads one line of the working tree; `lineCount(path)` the number of lines of a whole new file.
 */
export function addedSuppressions(changed, { lineOf, lineCount }) {
  const findings = [];
  let read = 0;
  for (const [file, ranges] of changed) {
    if (DOCUMENTATION.test(file)) continue;
    const spans = ranges === 'all' ? [[1, lineCount(file) ?? 0]] : ranges;
    for (const [from, to] of spans) {
      for (let line = from; line <= to && read < MAX_LINES; line += 1, read += 1) {
        const text = lineOf(file, line);
        const marker = text == null ? null : suppressionMarker(text);
        if (!marker) continue;
        findings.push(createFinding({ feed: 'quality', source: 'sflow', tool: 'sflow', rule: `suppression-added:${marker}`,
          severity: 'high', kind: 'code-smell', file, line, endLine: line, snippet: snippetSha256(text), newCode: true,
          message: `A ${marker} suppression was added on a changed line. Fix what it silences instead; a person may accept the finding.` }));
      }
    }
  }
  return findings;
}
