/**
 * The office mirror's secret scanner, rule for rule, so a test can hold the repository to it. Push
 * protection on the office mirror runs it on every push and refuses any line it reports. Besides the
 * provider key shapes, its rules read plain code: a credential word, `=` or `:`, then a value of six
 * characters or more that is not a placeholder (a local named for a credential and given a random
 * UUID is one), and a credential word as a quoted string right after `?` (a check's status word).
 * Code is written so they do not match: a local takes a name without the word, a kept field takes
 * its value from a camelCase name or on the next line, a status word comes from a constant. A line
 * that has to keep the words carries the scanner's allow marker with its reason, and
 * test/no-secret-literals.test.mjs lists each such line.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORDS = ['password', 'passwd', 'pass', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'credential', 'privatekey', 'private_key'];
const CAPITALIZED = WORDS.map((word) => word[0].toUpperCase() + word.slice(1));
/** A credential word, whole: snake, kebab or UPPER case, or a camelCase part after a lower-case letter. */
const WORD = `(?:(?<![A-Za-z])(?:${[...WORDS, ...WORDS.map((word) => word.toUpperCase())].join('|')})(?![a-z])`
  + `|(?<=[a-z])(?:${CAPITALIZED.join('|')})(?![a-z]))`;

/** The provider key shapes, as the scanner writes them. */
const SHAPES = [
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/u],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/u],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/u],
  ['Private key block', /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}\s*[A-Za-z0-9+/]{20}/u],
  ['Provider API key', /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}/u],
  ['Credentials in URL', /:\/\/[^/\s:@'"`]+:[^/\s:@'"`${}<>]{4,}@/u]
];
const HEURISTICS = [
  // The office copy of this rule is cut off in the photograph after its first alternative; this is its visible part.
  ['Credential word as string literal', /\?\s*["'`](?:secret|password|passwd|pass|token)["'`]/u],
  ['Key fingerprint', /--key\s+SHA256:\S+/u]
];
/** A credential word, the rest of its name, `=` or `:`, then the value up to whitespace, a quote or `$<>{}()[],;`. */
const ASSIGNMENT = new RegExp(`${WORD}[\\w.-]*["']?\\s*[:=]\\s*["'\`]?([^\\s"'\`$<>{}()\\[\\],;]{6,})`, 'gu');
/** A value the scanner reads as no credential: a keyword or common word, `your…`, `xxx`, `***`, UPPER_CASE or camelCase. */
const PLACEHOLDER = new RegExp('^(?:true|false|null|undefined|string|number|boolean|object|function|require|process|this|new|await|async|'
  + 'return|import|export|path|input|options|value|name|text|none|required|optional|example|changeme|redacted|'
  + 'your[-_a-zA-Z]*|x{3,}|\\*+|[A-Z][A-Z0-9_]{3,}|[a-z]+(?:[A-Z][a-z]+)+)$', 'u');

export const OFFICE_SKIPPED_FILE = /\.(?:png|jpe?g|gif|ico|woff2?|zip|gz|vsix|pdf|lock|bin|exe|jar)$|package-lock\.json$/iu;
/** The scanner passes a line holding either marker, whatever else it holds. */
export const OFFICE_ALLOW_MARKER = /sflow-allow-secret|pragma: allowlist secret/u;

/** What the scanner reports for one line, ignoring an allow marker: [{ rule, value? }]. */
export function officeLineFindings(line) {
  const found = [];
  for (const [rule, pattern] of [...SHAPES, ...HEURISTICS]) if (pattern.test(line)) found.push({ rule });
  for (const match of line.matchAll(ASSIGNMENT)) {
    if (!PLACEHOLDER.test(match[1])) found.push({ rule: 'Credential assignment', value: match[1] });
  }
  return found;
}

/**
 * Every finding in a text, with its line number and whether an allow marker passes it. On a marked
 * line only what the rest of the line holds counts: the marker's own `sflow-allow-secret: <why>`
 * reads as an assignment to the scanner, and it is what passes the line.
 */
export function officeTextFindings(text) {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    const allowed = OFFICE_ALLOW_MARKER.test(line);
    const read = allowed ? line.replace(/(?:sflow-allow-secret|pragma: allowlist secret).*$/u, '') : line;
    return officeLineFindings(read).map((finding) => ({ ...finding, line: index + 1, allowed, text: line.trim().slice(0, 160) }));
  });
}

/** The files the scanner reads: every tracked file, except the skipped kinds and anything holding a NUL byte. */
export function officeScannedFiles(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  return files.flatMap((file) => {
    if (OFFICE_SKIPPED_FILE.test(file)) return [];
    let bytes;
    try { bytes = readFileSync(path.join(root, file)); } catch { return []; }
    return bytes.includes(0) ? [] : [{ file, text: bytes.toString('utf8') }];
  });
}
