import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BOOLEAN_OPTIONS, SingularityFlowError } from './util.mjs';
import { gitDir } from './git.mjs';
import { assertCredentialFreeRemote } from './git-remote-diagnostics.mjs';

// Ordered severities. `off` disables everything; `all` is an alias for `trace` because that is what
// people type when they want the lot.
export const LOG_LEVELS = Object.freeze({ off: -1, error: 0, warn: 1, info: 2, debug: 3, trace: 4 });
const LEVEL_ALIASES = Object.freeze({ all: 'trace', verbose: 'debug', quiet: 'error', silent: 'off', warning: 'warn' });
const LEVEL_NAMES = Object.freeze(Object.keys(LOG_LEVELS).filter((name) => name !== 'off'));

export const LOG_DIR_SEGMENTS = Object.freeze(['singularity-flow', 'logs']);
const LOG_FILE = 'activity.log';
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const MAX_VALUE_CHARS = 2000;
const REDACTION_OVERLAP_CHARS = 512;
const MAX_DEPTH = 6;
const UNSAFE_TEXT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const ASSIGNMENT_BREAKING_CONTROLS = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ZERO_WIDTH_FORMATS = /[\u200b-\u200f\u2060-\u206f\ufeff]/g;
const ANSI_ESCAPE_SEQUENCE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\r\n]*(?:\u0007|\u001b\\)?/g;

function normalizeSensitiveSyntax(value) {
  return String(value)
    .replace(ANSI_ESCAPE_SEQUENCE, '')
    .replace(ZERO_WIDTH_FORMATS, '')
    .replace(ASSIGNMENT_BREAKING_CONTROLS, '')
    .replace(/\\+(["'=:])/g, '$1');
}

function boundedRedactionInput(source, maximum, overlap, replacement) {
  const boundary = maximum + overlap;
  if (source.length <= boundary) return source;
  let start = boundary - 1;
  while (start >= 0 && !/\s/.test(source[start])) start -= 1;
  start += 1;
  let end = boundary;
  while (end < source.length && !/\s/.test(source[end])) end += 1;
  const at = source.indexOf('@', boundary);
  const colon = source.indexOf(':', start);
  return at >= boundary && at < end && colon >= start && colon < at
    ? `${source.slice(0, start)}${replacement}`
    : source.slice(0, boundary);
}

// stdout carries CLI JSON that the desktop parses, and writing log lines there has already shipped
// as a bug once. Diagnostics go to the log file and to stderr — never to fd 1.
const STDERR_FD = 2;

export function normalizeLogLevel(value, fallback = 'info') {
  const raw = String(value ?? '').trim().toLowerCase();
  const resolved = LEVEL_ALIASES[raw] ?? raw;
  return resolved in LOG_LEVELS ? resolved : fallback;
}

// Keys whose values must never reach a log file. Jira PATs, GitHub tokens, SharePoint OAuth and
// Artifactory credentials all travel next to these paths.
// `pat` means personal access token, and it used to match anywhere in a key name — so `path` and
// `paths` logged as `[redacted]`. Nothing was leaking; the cost was the opposite, a log that quietly
// withheld the most ordinary field there is. Bounded to a real token name now: `pat`, `github_pat`,
// `githubPat`, `pat-token`, while `path`, `pattern`, `patch` and `compatible` pass through.
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[-_]?key|access[-_]?key|private[-_]?key|signature|(?:^|[_.-])pat(?:$|[_.-])|[a-z]pat(?![a-z]))/i;
// Value shapes that are secrets wherever they appear, including inside free text.
const SECRET_VALUE = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,
  /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /\/\/[^/\s@:]+:[^/\s@]+@/g,
  /\b[^/\s@:]+:[^/\s@]+@[^:\s]+:[^\s]+/g
];
const SSH_USERNAME_PROTOCOLS = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);

// A string can be a valid local Git path and still contain material that must never be copied into
// a timeout replay command. For example, `./https://user:password@host/repo` is path syntax to Git,
// not a network URL, and `/tmp/ghp_...` is also a valid path. The repository trust boundary accepts
// both, so replay safety needs this additional content boundary before preserving accepted bytes.
function remoteOperandContainsSensitiveMaterial(value) {
  for (const pattern of SECRET_VALUE) {
    pattern.lastIndex = 0;
    const matched = pattern.test(value);
    pattern.lastIndex = 0;
    if (matched) return true;
  }
  const assignmentText = normalizeSensitiveSyntax(value);
  if (redactSecretAssignments(assignmentText, { allowColon: false }) !== assignmentText) return true;
  for (const match of String(value).matchAll(/((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/@\s]+)@/gi)) {
    const protocol = match[1].includes(':') ? match[1].slice(0, -2).toLowerCase() : null;
    const userInfo = match[2];
    if (protocol && SSH_USERNAME_PROTOCOLS.has(protocol)
        && !userInfo.includes(':') && !/%[0-9a-f]{2}/i.test(userInfo)) continue;
    return true;
  }
  if (/(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):[\\/]*[^/@\s:]+:[^/@\s]+@/i.test(value)) return true;
  if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)
      && /(?:^|[/\\])[^/\s@:]+:[^/\s@]+@[^/\s]+[/\\]/.test(value)) return true;
  const embeddedRemotes = value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi);
  for (const match of embeddedRemotes) {
    try { assertCredentialFreeRemote(match[0]); } catch { return true; }
  }
  return false;
}

function isSecretOptionKey(value) {
  const key = String(value).replace(/^--/, '');
  return SECRET_KEY.test(key) || /(?:selection[-_]?receipt|action[-_]?authorization)/i.test(key);
}
const REMOTE_OPTION = /^--(?:repository|repository-url|lead|lead-repository|organisation|url|target-url|output-url|document-url|jira-url|remote|source-remote|origin)$/i;
const REMOTE_FIELD = /^(?:remote|url|repository(?:url)?|repository-url|lead(?:repository|url)?|lead-repository|organisation|origin|target-url|output-url|document-url|jira-url|source-remote)$/i;
const CAPABILITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAYABLE_REMOTE_PROTOCOLS = new Set([
  'http:', 'https:', 'ssh:', 'git+ssh:', 'ssh+git:', 'git:', 'file:', 'ftp:', 'ftps:'
]);

export const REDACTED = '[redacted]';

function redactSecretAssignments(value, { allowColon = true } = {}) {
  const text = String(value);
  const parts = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const quoted = text[index] === '"' || text[index] === "'" ? text[index] : null;
    const keyStart = quoted ? index + 1 : index;
    if (!/[A-Za-z]/.test(text[keyStart] ?? '')) { index += 1; continue; }
    let keyEnd = keyStart + 1;
    while (keyEnd < text.length && /[A-Za-z0-9_.-]/.test(text[keyEnd])) keyEnd += 1;
    let separator = keyEnd;
    let quotedHeader = false;
    if (quoted) {
      if (text[separator] === quoted) separator += 1;
      else if (text[separator] === ':') quotedHeader = true;
      else { index = keyEnd; continue; }
    }
    while (separator < text.length && /\s/.test(text[separator])) separator += 1;
    if (text[separator] !== '=' && !((allowColon || quotedHeader) && text[separator] === ':')) {
      index = keyEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (valueStart < text.length && /[ \t]/.test(text[valueStart])) valueStart += 1;
    const key = text.slice(keyStart, keyEnd);
    if (!isSecretOptionKey(key)) { index = valueStart; continue; }
    const valueEnd = text.length;
    parts.push(text.slice(cursor, index), `${key}=${REDACTED}`);
    cursor = valueEnd;
    index = valueEnd;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

function redactEmbeddedUrl(value) {
  try {
    const parsed = new URL(value);
    if (!DISPLAYABLE_REMOTE_PROTOCOLS.has(parsed.protocol)) return '[redacted-remote]';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[redacted-remote]';
  }
}

function positionalReceiptIndex(argv) {
  const indexes = [];
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (passthrough) { indexes.push(index); continue; }
    if (token === '--') { passthrough = true; continue; }
    if (!token.startsWith('--')) { indexes.push(index); continue; }
    if (token.startsWith('--no-') || token.includes('=')) continue;
    const key = token.slice(2);
    if (!BOOLEAN_OPTIONS.has(key) && index + 1 < argv.length
        && !String(argv[index + 1]).startsWith('--')) index += 1;
  }
  const positionals = indexes.map((index) => String(argv[index]));
  const offset = positionals[0] === 'singularity-flow' ? 1 : 0;
  if (positionals[offset] === 'choices' && ['answer', 'status'].includes(positionals[offset + 1])) return indexes[offset + 2] ?? -1;
  if (positionals[offset] === 'initiative' && positionals[offset + 1] === 'choices'
      && ['answer', 'status'].includes(positionals[offset + 2])) return indexes[offset + 3] ?? -1;
  if (positionals[offset] === 'epic' && positionals[offset + 1] === 'review-choice'
      && ['answer', 'status'].includes(positionals[offset + 2])) return indexes[offset + 3] ?? -1;
  return -1;
}

function redactText(value) {
  const source = String(value);
  const omitted = Math.max(0, source.length - MAX_VALUE_CHARS);
  // Bound provider-controlled text before any regex or assignment scan. This keeps malformed CLI
  // arguments and legacy log records from monopolizing the CLI/extension host while preserving a
  // clear indication that content was omitted.
  let text = normalizeSensitiveSyntax(boundedRedactionInput(
    source, MAX_VALUE_CHARS, REDACTION_OVERLAP_CHARS, '[redacted-remote]'
  ));
  // A complete END marker is not required: once private-key material begins, no remainder of that
  // logical diagnostic is safe to retain (including a block truncated at the output boundary).
  text = text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi, '[redacted private key]');
  text = text.replace(/((?:Selection receipt|Action authorization)\s+['"]?)[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '$1[redacted]');
  text = text.replace(/((?:choices|action-authorizations)[\\/])[0-9a-f]{8}-[0-9a-f-]{27,}(?=\.json(?:\.consuming-[^\\/\s]+)?|\.lock|[\\/\s]|$)/gi, '$1[redacted]');
  text = text.replace(/\b[a-z][a-z0-9+.-]*::[^\r\n]*/gi, '[redacted-remote]');
  // Historical records and provider errors can carry a signed URL in ordinary prose rather than
  // a typed argv field. Keep its stable authority/path for diagnosis, never its user-info, query,
  // or fragment. Unsupported helper schemes remain completely opaque.
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/(?=[^/\s@]*:[^/\s@]*@)[^\s]+/gi,
    '[redacted-remote]');
  text = text.replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)(?=[^\s@]*:[^\s@]*@)[^\s]+/gi,
    '[redacted-remote]');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, redactEmbeddedUrl);
  text = text.replace(/(^|[\s("'=])\/\/[^\s<>"']+/g, (match, prefix) =>
    `${prefix}${redactRemoteOperand(match.slice(prefix.length))}`);
  text = text.replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)[^\s<>"']+/gi,
    (match) => redactRemoteOperand(match));
  // Git/provider errors may prefix a malformed credential-bearing remote with a local directory
  // (`/tmp/alice:password@host/repo`). It is a valid path to Git, but never safe durable prose.
  text = text.replace(/(^|[\s("'=])(?=[^\s<>"']*[\\/])(?=[^\s<>"']*[^/\\\s@:]+:[^/\\\s@]+@)[^\s<>"']+/g,
    '$1[redacted-remote]');
  text = redactSecretAssignments(text);
  text = text.replace(/\S+/g, (token) => remoteOperandContainsSensitiveMaterial(token) ? REDACTED : token);
  // URL scrubbing comes first: replacing only the user-info prefix would otherwise leave a signed
  // query or fragment behind on text that no longer looks like a URL.
  for (const pattern of SECRET_VALUE) text = text.replace(pattern, REDACTED);
  text = text.replace(UNSAFE_TEXT_CONTROLS, '[control]');
  const expansionOmitted = source.length <= MAX_VALUE_CHARS
    ? Math.max(0, text.length - MAX_VALUE_CHARS)
    : 0;
  text = text.slice(0, MAX_VALUE_CHARS);
  return omitted || expansionOmitted
    ? `${text}…[truncated ${omitted + expansionOmitted} chars]`
    : text;
}

function redactRemoteOperand(value, allowKeyedPrefix = true) {
  // Remote-consuming command paths normalize surrounding whitespace before validation. Do the
  // same here so a positional URL cannot evade classification by adding one leading space.
  const text = String(value).trim();
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(text)) return '[redacted-remote]';
  if (text.length > MAX_VALUE_CHARS) {
    const prefix = /^([A-Za-z0-9][A-Za-z0-9._-]*)=/.exec(text)?.[1];
    return prefix ? `${prefix}=[redacted-remote]` : '[redacted-remote]';
  }
  if (text.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(text)) {
    return '[redacted-remote]';
  }
  const hierarchicalSyntax = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text);
  if (!hierarchicalSyntax && remoteOperandContainsSensitiveMaterial(text)) return '[redacted-remote]';
  void allowKeyedPrefix;
  const scpWithSuffix = !text.includes('://') && !text.startsWith('//')
    && /^(?:[^/@\s]+@)?[^/:\\\s]+:.+[?#]/.test(text);
  // The engine's trust boundary is authoritative. When it accepts an operand, preserve its exact
  // normalized bytes: SSH usernames, URL case, Windows/UNC paths, and literal local `?`/`#` bytes
  // are all part of the runnable Git identity. SCP suffixes stay display-redacted by policy.
  if (!scpWithSuffix) {
    try {
      if (assertCredentialFreeRemote(text) === text) {
        return remoteOperandContainsSensitiveMaterial(text) ? '[redacted-remote]' : text;
      }
    } catch { /* rejected operands continue through the fail-closed display sanitizer */ }
  }
  if (/^[A-Za-z]:(?:\\|\/(?!\/))/.test(text)) return redactText(text);
  if (/^[^/@\s]*:[^/@\s]*@[^:\s]+:.+/.test(text)) return '[redacted-remote]';
  // WHATWG URL parsing treats `Host:path` as a URI and lower-cases `Host`, but Git treats it as
  // SCP syntax. Preserve an accepted transport byte-for-byte so timeout recovery stays runnable.
  const scpPrefix = text.slice(0, Math.max(0, text.indexOf(':'))).toLowerCase();
  if (DISPLAYABLE_REMOTE_PROTOCOLS.has(`${scpPrefix}:`) && !text.toLowerCase().startsWith(`${scpPrefix}://`)) {
    return '[redacted-remote]';
  }
  if (!text.includes('://') && !text.startsWith('//')
    && !DISPLAYABLE_REMOTE_PROTOCOLS.has(`${scpPrefix}:`)
    && /^(?:[^/@\s]+@)?[^/:\\\s]+:.+/.test(text)) {
    const suffix = text.search(/[?#]/);
    return redactText(suffix >= 0
      ? `${text.slice(0, suffix)}[redacted-url-suffix]`
      : text);
  }
  if (text.startsWith('//')) {
    const withoutSuffix = text.replace(/[?#].*$/, '');
    const match = /^\/\/([^/\s]*)(.*)$/s.exec(withoutSuffix);
    if (!match) return '[redacted-remote]';
    const authority = match[1].includes('@') ? match[1].slice(match[1].lastIndexOf('@') + 1) : match[1];
    return `//${authority}${match[2]}`;
  }
  const scpLike = /^[^/\s@]+@[^:\s]+:.+/.test(text);
  try {
    const parsed = new URL(text);
    if (parsed.protocol) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        && !DISPLAYABLE_REMOTE_PROTOCOLS.has(parsed.protocol)) return '[redacted-remote]';
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return redactText(parsed.toString());
    }
  } catch {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return '[redacted-remote]';
  }
  if (scpLike || /[?#]/.test(text)) {
    const suffix = text.search(/[?#]/);
    return redactText(suffix >= 0 ? `${text.slice(0, suffix)}[redacted-url-suffix]` : text);
  }
  return redactText(text);
}

/**
 * Project CLI arguments into a persistence-safe command shape before validation can fail.
 * Raw argv can contain a rejected credential-bearing remote, so both activity and harness logs use
 * this projection while command dispatch retains the original process arguments.
 */
export function redactCommandArgv(argv) {
  const source = Array.isArray(argv) ? argv : [];
  const projected = [];
  const pending = [];
  const receiptIndex = positionalReceiptIndex(source);
  // Projection runs before parse/validation. Once a capability-bearing option or receipt command
  // family is visible, mask UUID capabilities anywhere in the invocation even if an intervening
  // malformed option would confuse positional parsing. Rejected commands must be as safe as valid
  // commands in the durable activity log.
  const capabilityBearing = source.some((value) => {
    const token = normalizeSensitiveSyntax(String(value).slice(0, MAX_VALUE_CHARS));
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    return isSecretOptionKey(equals >= 0 ? token.slice(0, equals) : token);
  });
  const receiptFamily = source.some((value) => ['choices', 'review-choice'].includes(String(value)))
    && source.some((value) => ['answer', 'status'].includes(String(value)));
  let secretIntervened = false;
  for (const [index, raw] of source.entries()) {
    const token = String(raw);
    if (token.length > MAX_VALUE_CHARS) {
      if (pending.length > 0) {
        projected.push(pending.pop() === 'remote' ? '[redacted-remote]' : REDACTED);
        continue;
      }
      projected.push(REDACTED);
      const classificationToken = normalizeSensitiveSyntax(token.slice(0, MAX_VALUE_CHARS));
      const equals = classificationToken.indexOf('=');
      const flag = equals >= 0 ? classificationToken.slice(0, equals) : classificationToken;
      if (classificationToken.startsWith('--') && equals < 0 && isSecretOptionKey(flag)) pending.push('secret');
      if (equals < 0 && REMOTE_OPTION.test(flag)) pending.push('remote');
      continue;
    }
    const normalizedToken = normalizeSensitiveSyntax(token);
    if (normalizedToken !== token && normalizedToken.startsWith('--')) {
      const equals = normalizedToken.indexOf('=');
      const flag = equals >= 0 ? normalizedToken.slice(0, equals) : normalizedToken;
      if (isSecretOptionKey(flag)) {
        projected.push(equals >= 0 ? `${flag}=${REDACTED}` : REDACTED);
        if (equals < 0) pending.push('secret');
        continue;
      }
      if (REMOTE_OPTION.test(flag)) {
        projected.push(REDACTED);
        if (equals < 0) pending.push('remote');
        continue;
      }
    }
    if ((capabilityBearing || receiptFamily) && CAPABILITY_UUID.test(token)) {
      projected.push(REDACTED);
      continue;
    }
    if (index === receiptIndex) { projected.push(REDACTED); continue; }
    if (secretIntervened && !token.startsWith('--')) {
      projected.push(REDACTED);
      continue;
    }
    if (token === '--' && pending.includes('secret')) {
      secretIntervened = true;
      projected.push('--');
      continue;
    }
    if (pending.includes('secret') && token.startsWith('--')) {
      secretIntervened = true;
      const interveningEquals = token.indexOf('=');
      if (interveningEquals >= 0) {
        projected.push(`${token.slice(0, interveningEquals)}=${REDACTED}`);
        continue;
      }
      if (CAPABILITY_UUID.test(token.slice(2))) {
        projected.push(`--${REDACTED}`);
        continue;
      }
      projected.push(REDACTED);
      continue;
    }
    if (pending.length > 0 && !token.startsWith('--')) {
      projected.push(pending.pop() === 'secret' ? REDACTED : redactRemoteOperand(token));
      continue;
    }
    const bareEquals = !token.startsWith('--') ? token.indexOf('=') : -1;
    if (bareEquals > 0 && isSecretOptionKey(token.slice(0, bareEquals))) {
      projected.push(`${token.slice(0, bareEquals)}=${REDACTED}`);
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (token.startsWith('--') && isSecretOptionKey(flag)) {
      projected.push(equals >= 0 ? `${flag}=${REDACTED}` : token);
      if (equals < 0) pending.push('secret');
      continue;
    }
    if (REMOTE_OPTION.test(flag)) {
      projected.push(equals >= 0
        ? `${flag}=${redactRemoteOperand(token.slice(equals + 1))}`
        : token);
      if (equals < 0) pending.push('remote');
      continue;
    }
    projected.push(remoteOperandContainsSensitiveMaterial(token)
      ? REDACTED
      : (hierarchicalOrScp(token) ? redactRemoteOperand(token) : redactText(token)));
  }
  return projected;
}

function hierarchicalOrScp(value) {
  const candidate = String(value).trim();
  return candidate.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(candidate)
    || /^[^/\s@]+@[^:\s]+:.+/.test(candidate);
}

const SAFE_CONVERGENCE_DETAIL_KEYS = new Set([
  'iteration', 'path', 'allowedNext', 'unresolvedBlockers', 'projectionSha256',
  'storedSha256', 'computedSha256', 'storedBindingsSha256', 'currentBindingsSha256',
  'storedFactsSha256', 'currentFactsSha256'
]);

function safeErrorDetails(error, depth, seen) {
  if (!String(error?.code ?? '').startsWith('CONVERGENCE_')
      || !error.details || typeof error.details !== 'object' || Array.isArray(error.details)) return null;
  const selected = Object.fromEntries(Object.entries(error.details)
    .filter(([key]) => SAFE_CONVERGENCE_DETAIL_KEYS.has(key)));
  return Object.keys(selected).length ? redact(selected, depth + 1, seen) : null;
}

// Recursively strip secrets from log context. Runs before serialization, so nothing unredacted is
// ever handed to a sink.
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const details = safeErrorDetails(value, depth, seen);
    return {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
      code: value.code,
      // Only bounded convergence identifiers and digests are diagnostic-safe. Error.details across
      // the rest of the product can contain prompt text, previews, identities, or credentialed URLs,
      // so it must never be serialized wholesale merely because a caller attached it.
      ...(details == null ? {} : { details })
    };
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1, seen));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? REDACTED
        : ['argv', 'command'].includes(key) && Array.isArray(item)
          ? redactCommandArgv(item)
          : REMOTE_FIELD.test(key) && typeof item === 'string'
            ? redactRemoteOperand(item)
          : redact(item, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

export function logDirectory(gitDirectory) {
  return path.join(gitDirectory, ...LOG_DIR_SEGMENTS);
}

export function logFilePath(gitDirectory) {
  return path.join(logDirectory(gitDirectory), LOG_FILE);
}

function rotate(file, maxBytes, keep) {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    for (let index = keep - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      if (existsSync(from)) renameSync(from, `${file}.${index + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best effort: a log that cannot rotate must not break the command.
  }
}

const CONSOLE_LABEL = Object.freeze({ error: 'ERROR', warn: 'WARN ', info: 'INFO ', debug: 'DEBUG', trace: 'TRACE' });

/**
 * Events whose console presentation belongs to someone else.
 *
 * The CLI's own error handler prints a human sentence — and, for a refusal, a narrated next action —
 * immediately after `command.failed`. Echoing the raw event first said the same thing twice with a
 * timestamp in front of the worse copy. The file sink still records these in full; that is where
 * diagnosis happens, and `singularity-flow logs` is how you read them.
 */
const CONSOLE_SUPPRESSED_EVENTS = new Set(['command.failed']);

/**
 * Render one entry for stderr.
 *
 * Without `detail`, the structured context is omitted entirely. That context routinely includes the
 * whole error — message, code, and a full stack — and `JSON.stringify` put it on a single physical
 * line, so the most common beginner mistake answered with two kilobytes of wrapped JSON before the
 * sentence explaining it. The terminal gets the sentence; the log file gets the evidence.
 */
function consoleLine(entry, detail = false) {
  const context = { ...entry };
  for (const key of ['ts', 'level', 'event', 'msg']) delete context[key];
  const head = `${entry.ts} ${CONSOLE_LABEL[entry.level] ?? entry.level} ${entry.event}${entry.msg ? ` — ${entry.msg}` : ''}`;
  if (!detail || !Object.keys(context).length) return `${head}\n`;
  // Raised verbosity is a request to read the context, so format it to be read rather than parsed.
  return `${head}\n${JSON.stringify(context, null, 2).split('\n').map((line) => `  ${line}`).join('\n')}\n`;
}

/**
 * Create a logger.
 *
 * `level` gates the log file, `consoleLevel` gates stderr. They are separate on purpose: the file
 * should be verbose enough to diagnose a failure after the fact, while the terminal stays quiet
 * unless something is wrong.
 *
 * Writes are synchronous so entries survive `process.exit` and crashes — an async sink loses
 * exactly the lines that explain why a command died.
 */
export function createLogger({
  gitDirectory = null,
  level = 'info',
  consoleLevel = 'warn',
  consoleDetail = false,
  context = {},
  now = () => new Date().toISOString(),
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  write = null
} = {}) {
  const fileLevel = LOG_LEVELS[normalizeLogLevel(level)];
  const stderrLevel = LOG_LEVELS[normalizeLogLevel(consoleLevel, 'warn')];
  const file = gitDirectory ? logFilePath(gitDirectory) : null;
  let ready = false;

  function emit(levelName, event, message, detail) {
    const severity = LOG_LEVELS[levelName];
    if (severity > fileLevel && severity > stderrLevel) return;
    const entry = {
      ts: now(),
      level: levelName,
      event,
      ...(message ? { msg: redactText(String(message)) } : {}),
      ...redact({ ...context, ...(detail ?? {}) })
    };
    if (severity <= stderrLevel && (consoleDetail || !CONSOLE_SUPPRESSED_EVENTS.has(event))) {
      try { writeSync(STDERR_FD, consoleLine(entry, consoleDetail)); } catch { /* a closed stderr must not throw */ }
    }
    if (file && severity <= fileLevel) {
      try {
        if (!ready) { mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
        rotate(file, maxBytes, keep);
        (write ?? appendFileSync)(file, `${JSON.stringify(entry)}\n`);
      } catch { /* logging must never break the operation it is describing */ }
    }
    return entry;
  }

  const logger = {
    levels: { file: normalizeLogLevel(level), console: normalizeLogLevel(consoleLevel, 'warn') },
    consoleDetail,
    file,
    context,
    enabled: (levelName) => LOG_LEVELS[normalizeLogLevel(levelName)] <= Math.max(fileLevel, stderrLevel),
    child: (extra = {}) => createLogger({
      gitDirectory, level, consoleLevel, consoleDetail, context: { ...context, ...extra }, now, maxBytes, keep, write
    }),
    // Time an operation and record its outcome. A failure is logged with the elapsed time and
    // rethrown untouched, so callers keep their own error handling.
    async time(event, fn, detail = {}) {
      const started = Date.now();
      logger.debug(`${event}.start`, null, detail);
      try {
        const result = await fn();
        logger.info(`${event}.ok`, null, { ...detail, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        logger.error(`${event}.failed`, error?.message, { ...detail, durationMs: Date.now() - started, error });
        throw error;
      }
    }
  };
  for (const name of LEVEL_NAMES) {
    logger[name] = (event, message = null, detail = undefined) => emit(name, event, message, detail);
  }
  return logger;
}

// A logger that discards everything. Lets call sites take an optional logger without branching.
export const nullLogger = createLogger({ level: 'off', consoleLevel: 'off' });

export function normalizeLogging(value = {}) {
  if (value == null) return { level: 'info', console: 'warn', maxBytes: DEFAULT_MAX_BYTES, keep: DEFAULT_KEEP };
  if (typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('logging must be an object.');
  for (const key of Object.keys(value)) {
    if (!['level', 'console', 'maxBytes', 'keep'].includes(key)) throw new SingularityFlowError(`logging contains unknown field '${key}'.`);
  }
  const maxBytes = value.maxBytes ?? DEFAULT_MAX_BYTES;
  const keep = value.keep ?? DEFAULT_KEEP;
  if (!Number.isInteger(maxBytes) || maxBytes < 4096) throw new SingularityFlowError('logging.maxBytes must be an integer of at least 4096.');
  if (!Number.isInteger(keep) || keep < 1 || keep > 20) throw new SingularityFlowError('logging.keep must be an integer between 1 and 20.');
  return { level: normalizeLogLevel(value.level, 'info'), console: normalizeLogLevel(value.console, 'warn'), maxBytes, keep };
}

/**
 * Resolve the effective logging configuration. Environment wins over committed configuration so a
 * contributor can raise the level for one command without editing a governed file:
 *
 *   SINGULARITY_FLOW_LOG_LEVEL=all      both sinks
 *   SINGULARITY_FLOW_LOG_CONSOLE=debug  stderr only
 *   SINGULARITY_FLOW_DEBUG=1            everything, on screen, with context and stacks
 *
 * `consoleDetail` decides whether stderr carries the structured context at all. It is off unless the
 * caller asked for diagnostics, because the context holds whole error objects and stacks. It is not
 * a committed configuration field: turning it on is a thing you do to one invocation, not a property
 * of the repository.
 */
export function resolveLogging(definition = null, env = process.env) {
  const configured = normalizeLogging(definition?.logging ?? {});
  const debug = env.SINGULARITY_FLOW_DEBUG === '1';
  const level = env.SINGULARITY_FLOW_LOG_LEVEL
    ? normalizeLogLevel(env.SINGULARITY_FLOW_LOG_LEVEL, configured.level)
    : debug ? 'debug' : configured.level;
  // An explicit console setting always wins, including the `off` that machine-readable invocations
  // set to keep stderr clean — debugging must not be able to corrupt a JSON transport.
  const console = env.SINGULARITY_FLOW_LOG_CONSOLE
    ? normalizeLogLevel(env.SINGULARITY_FLOW_LOG_CONSOLE, configured.console)
    : env.SINGULARITY_FLOW_LOG_LEVEL ? level : debug ? 'debug' : configured.console;
  const consoleDetail = console !== 'off'
    && Boolean(debug || env.SINGULARITY_FLOW_LOG_CONSOLE || env.SINGULARITY_FLOW_LOG_LEVEL);
  return { ...configured, level, console, consoleDetail };
}

// Parse the JSON-lines log back into entries. Malformed lines are surfaced rather than dropped:
// a truncated final line is normal if a process died mid-write, and hiding it hides the crash.
export function parseLogLines(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try { return redact(JSON.parse(line)); }
      catch {
        return {
          ts: null, level: 'error', event: 'log.unreadable',
          msg: `Line ${index + 1} is not valid JSON.`,
          rawSha256: createHash('sha256').update(line).digest('hex'),
          rawBytes: Buffer.byteLength(line, 'utf8')
        };
      }
    });
}

export function filterLogEntries(entries, { level = 'trace', event = null, since = null } = {}) {
  const ceiling = LOG_LEVELS[normalizeLogLevel(level, 'trace')];
  const pattern = event ? new RegExp(event, 'i') : null;
  const from = since ? Date.parse(since) : null;
  return entries.filter((entry) => {
    if (LOG_LEVELS[entry.level] > ceiling) return false;
    if (pattern && !pattern.test(String(entry.event ?? ''))) return false;
    if (from && Number.isFinite(from) && Date.parse(entry.ts ?? '') < from) return false;
    return true;
  });
}

// Build the logger for a repository. Resolves the level from committed configuration and the
// environment, and points the file sink at the repository's Git directory so logs stay machine-local
// and are never committed. Never throws: a repository whose Git directory cannot be resolved still
// gets a working stderr logger rather than a failed command.
export function repositoryLogger(root, definition = null, { context = {}, env = process.env, gitDirectory = null } = {}) {
  const resolved = resolveLogging(definition, env);
  let directory = gitDirectory;
  if (!directory) {
    try { directory = gitDir(root); } catch { directory = null; }
  }
  return createLogger({
    gitDirectory: directory,
    level: resolved.level,
    consoleLevel: resolved.console,
    consoleDetail: resolved.consoleDetail,
    maxBytes: resolved.maxBytes,
    keep: resolved.keep,
    context
  });
}
