/**
 * Every read and every write goes through the CLI. The extension never imports `src/*.mjs`.
 *
 * That is a deliberate constraint rather than an accident of packaging. The engine's guarantee is
 * that state re-derives from Git; a second in-process caller with its own copy of the rules is
 * exactly how two surfaces start disagreeing about what an Epic's status is. The desktop app proved
 * the shape works — this is a port of apps/desktop/electron/cli-runner.mjs, with the parts that were
 * Electron-specific corrected rather than carried over.
 *
 * Deliberately kept dependency-free and free of any `vscode` import, so it can be unit-tested in a
 * plain Node process against a fake spawn.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Lifecycle snapshots include branch cataloguing and deterministic governance checks. */
export const CLI_TIMEOUT_MS = 120_000;
export const SNAPSHOT_TIMEOUT_MS = 120_000;
/** `wm build` runs a model over a whole repository and legitimately takes minutes. */
export const WORLD_MODEL_TIMEOUT_MS = 15 * 60_000;
/** Remote capability authority may establish or review configuration on a very large monorepo. */
export const CAPABILITY_AUTHORITY_TIMEOUT_MS = 15 * 60_000;
/** Workspace materialization may consume several independently bounded Git clone/fetch waves. */
export const WORKSPACE_MUTATION_TIMEOUT_MS = 30 * 60_000;
/** Starting governed work may fetch, materialize, commit, and publish several repositories. */
export const WORK_START_TIMEOUT_MS = 15 * 60_000;
/** Submission may run repository-native compile and browser suites; keep it above the seeded POC budget. */
export const VALIDATION_TIMEOUT_MS = 30 * 60_000;
/** Governed image/PDF previews may carry a 25 MiB document encoded as base64. */
const MAX_OUTPUT_BYTES = 40 * 1024 * 1024;
const MAX_DISPLAY_ARG_CHARS = 2_000;
const MAX_DISPLAY_ERROR_CHARS = 8 * 1024;
const DISPLAY_REDACTION_OVERLAP_CHARS = 1024;
const DISPLAY_UNSAFE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const DISPLAY_UNSAFE_CONTROLS_GLOBAL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const DISPLAY_ASSIGNMENT_BREAKING_CONTROLS_GLOBAL = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e]/g;
const DISPLAY_ZERO_WIDTH_FORMATS_GLOBAL = /[\u200b-\u200f\u2060-\u206f\ufeff]/g;
const DISPLAY_ANSI_ESCAPE_SEQUENCE_GLOBAL = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?|\u001b\][^\u0007\r\n]*(?:\u0007|\u001b\\)?/g;

function displayNormalizeSensitiveSyntax(value: string): string {
  return value
    .replace(DISPLAY_ANSI_ESCAPE_SEQUENCE_GLOBAL, '')
    .replace(DISPLAY_ZERO_WIDTH_FORMATS_GLOBAL, '')
    .replace(DISPLAY_ASSIGNMENT_BREAKING_CONTROLS_GLOBAL, '')
    .replace(/\\+(["'=:])/g, '$1');
}

function displayBoundedRedactionInput(source: string): string {
  const boundary = MAX_DISPLAY_ERROR_CHARS + DISPLAY_REDACTION_OVERLAP_CHARS;
  if (source.length <= boundary) return source;
  let start = boundary - 1;
  while (start >= 0 && !/\s/.test(source[start]!)) start -= 1;
  start += 1;
  let end = boundary;
  while (end < source.length && !/\s/.test(source[end]!)) end += 1;
  const at = source.indexOf('@', boundary);
  const colon = source.indexOf(':', start);
  return at >= boundary && at < end && colon >= start && colon < at
    ? `${source.slice(0, start)}[redacted-remote]`
    : source.slice(0, boundary);
}

// Kept as a packaged snapshot because the extension deliberately does not import engine modules.
// A parity test compares it with util.mjs so a new engine boolean cannot silently shift a receipt.
export const DISPLAY_BOOLEAN_OPTIONS = new Set([
  'archive-readiness', 'allow-unavailable-verification',
  'accept-bundled-conflicts', 'accept-partial', 'acknowledge-self-approval', 'acknowledge-unprotected', 'active', 'adopt-current-interval', 'adopt-existing', 'all', 'allow-dirty', 'allow-model', 'apply', 'assigned-to-me', 'ast',
  'assisted', 'auto', 'automatic', 'blocking', 'check', 'churn', 'cli-only', 'clipboard', 'clone', 'concat',
  'confirm-pin-retention', 'confirm-protected', 'confirm-push-policy', 'create', 'dry-run', 'evidence',
  'diagnose-only', 'drop-local', 'fetch', 'first-run', 'force', 'forget-only', 'for-start', 'from-records', 'gate-recovery', 'here', 'include-prompt', 'initialize', 'intake', 'json',
  'include-existing', 'independent', 'isolated-worktree',
  'keep', 'local', 'local-only', 'make-lead', 'markdown', 'migrate-legacy', 'network', 'offline', 'once', 'open', 'performance', 'plan-only',
  'opt-out', 'optional', 'parallel', 'polish', 'preview', 'probe', 'propose', 'push',
  'quick', 'raw', 'readiness', 'rebuild', 'recap', 'record', 'record-audit', 'recover', 'refresh', 'release', 'render-only', 'repair', 'repair-on-fault', 'restore-remote', 'run',
  'repair-projections', 'replace', 'replace-server', 'resume', 'set', 'sign', 'solo',
  'semantic', 'shadow', 'skip-checks', 'smart-detect', 'staged', 'stale', 'strict', 'terminal', 'timings', 'today', 'update', 'write',
  'yes', 'verbose', 'show-artifact', 'brief'
]);

const DISPLAY_SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|api[-_]?key|access[-_]?key|private[-_]?key|signature|(?:^|[_.-])pat(?:$|[_.-])|[a-z]pat(?![a-z]))/i;
function displayIsSecretOptionKey(value: string): boolean {
  const key = value.replace(/^--/, '');
  return DISPLAY_SECRET_KEY.test(key) || /(?:selection[-_]?receipt|action[-_]?authorization)/i.test(key);
}
const DISPLAY_REMOTE_OPTION = /^--(?:repository|repository-url|lead|lead-repository|organisation|url|target-url|output-url|document-url|jira-url|remote|source-remote|origin)$/i;
const DISPLAY_CAPABILITY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPLAYABLE_REMOTE_PROTOCOLS = new Set([
  'http:', 'https:', 'ssh:', 'git+ssh:', 'ssh+git:', 'git:', 'file:', 'ftp:', 'ftps:'
]);

// Git accepts arbitrary path-form remotes. Do not mistake that acceptance for permission to echo a
// token-shaped path or a path containing an embedded URL into the output channel/recovery command.
function displayRemoteContainsSensitiveMaterial(value: string): boolean {
  for (const match of value.matchAll(/((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/@\s]+)@/gi)) {
    const protocol = match[1]?.includes(':') ? match[1].slice(0, -2).toLowerCase() : null;
    const userInfo = match[2] ?? '';
    if (protocol && ['ssh:', 'git+ssh:', 'ssh+git:'].includes(protocol)
        && !userInfo.includes(':') && !/%[0-9a-f]{2}/i.test(userInfo)) continue;
    return true;
  }
  if (/\b(?:ghp_|github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/i.test(value)
      || /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/i.test(value)
      || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value)
      || /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(value)
      || /\bAIza[A-Za-z0-9_-]{30,}\b/.test(value)
      || /(?:^|[/\\])[^/\s@:]+:[^/\s@]+@[^:\s]+:[^\s]+/.test(value)
      || /(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):[\\/]*[^/@\s:]+:[^/@\s]+@/i.test(value)
      || (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value)
        && /(?:^|[/\\])[^/\s@:]+:[^/\s@]+@[^/\s]+[/\\]/.test(value))
      || (() => {
        const assignmentText = displayNormalizeSensitiveSyntax(value);
        return displayRedactSecretAssignments(assignmentText, { allowColon: false }) !== assignmentText;
      })()) {
    return true;
  }
  for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)) {
    if (!displayRemoteIsAccepted(match[0])) return true;
  }
  return false;
}

function displayRedactSecretAssignments(value: string, { allowColon = true } = {}): string {
  const text = value;
  const parts: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const quoted = text[index] === '"' || text[index] === "'" ? text[index] : null;
    const keyStart = quoted ? index + 1 : index;
    if (!/[A-Za-z]/.test(text[keyStart] ?? '')) { index += 1; continue; }
    let keyEnd = keyStart + 1;
    while (keyEnd < text.length && /[A-Za-z0-9_.-]/.test(text[keyEnd]!)) keyEnd += 1;
    let separator = keyEnd;
    let quotedHeader = false;
    if (quoted) {
      if (text[separator] === quoted) separator += 1;
      else if (text[separator] === ':') quotedHeader = true;
      else { index = keyEnd; continue; }
    }
    while (separator < text.length && /\s/.test(text[separator]!)) separator += 1;
    if (text[separator] !== '=' && !((allowColon || quotedHeader) && text[separator] === ':')) {
      index = keyEnd;
      continue;
    }
    let valueStart = separator + 1;
    while (valueStart < text.length && /[ \t]/.test(text[valueStart]!)) valueStart += 1;
    const key = text.slice(keyStart, keyEnd);
    if (!displayIsSecretOptionKey(key)) { index = valueStart; continue; }
    const valueEnd = text.length;
    parts.push(text.slice(cursor, index), `${key}=[redacted]`);
    cursor = valueEnd;
    index = valueEnd;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(cursor));
  return parts.join('');
}

function displayRemoteIsAccepted(value: string): boolean {
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('-')
      || /^[a-z][a-z0-9+.-]*::/i.test(value)
      || /^[^/@\s]*:[^/@\s]*@[^:\s]+:.+/.test(value)) return false;
  const hierarchicalSyntax = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value);
  const userInfo = /^((?:[a-z][a-z0-9+.-]*:)?\/\/)([^/@\s]+)@/i.exec(value);
  const userInfoProtocol = userInfo?.[1]?.includes(':')
    ? userInfo[1].slice(0, -2).toLowerCase() : null;
  if (userInfo && (userInfo[2]?.includes(':') === true
      || /%[0-9a-f]{2}/i.test(userInfo[2] ?? '')
      || userInfoProtocol == null || !['ssh:', 'git+ssh:', 'ssh+git:'].includes(userInfoProtocol))) return false;
  if (hierarchicalSyntax && /[?#]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (hierarchicalSyntax && !DISPLAYABLE_REMOTE_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.password || (parsed.username
      && !['ssh:', 'git+ssh:', 'ssh+git:'].includes(parsed.protocol))) return false;
    return !(hierarchicalSyntax && Boolean(parsed.search || parsed.hash));
  } catch {
    return !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  }
}

function displayRemoteOperand(value: string, allowKeyedPrefix = true): string {
  const normalized = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(normalized) || normalized.startsWith('-') || /^[a-z][a-z0-9+.-]*::/i.test(normalized)
      || /^[^/@\s]*:[^/@\s]*@[^:\s]+:.+/.test(normalized)) return '[redacted-remote]';
  if (normalized.length > MAX_DISPLAY_ARG_CHARS) {
    const prefix = /^([A-Za-z0-9][A-Za-z0-9._-]*)=/.exec(normalized)?.[1];
    return prefix ? `${prefix}=[redacted-remote]` : '[redacted-remote]';
  }
  void allowKeyedPrefix;
  const scpWithSuffix = !normalized.includes('://') && !normalized.startsWith('//')
    && /^(?:[^/@\s]+@)?[^/:\\\s]+:.+[?#]/.test(normalized);
  if (!scpWithSuffix && displayRemoteIsAccepted(normalized)) {
    return displayRemoteContainsSensitiveMaterial(normalized) ? '[redacted-remote]' : normalized;
  }
  if (/^[A-Za-z]:(?:\\|\/(?!\/))/.test(normalized)) return normalized;
  const scpPrefix = normalized.slice(0, Math.max(0, normalized.indexOf(':'))).toLowerCase();
  if (DISPLAYABLE_REMOTE_PROTOCOLS.has(`${scpPrefix}:`) && !normalized.toLowerCase().startsWith(`${scpPrefix}://`)) {
    return '[redacted-remote]';
  }
  if (!normalized.includes('://') && !normalized.startsWith('//')
    && !DISPLAYABLE_REMOTE_PROTOCOLS.has(`${scpPrefix}:`)
    && /^(?:[^/@\s]+@)?[^/:\\\s]+:.+/.test(normalized)) {
    const suffix = normalized.search(/[?#]/);
    return suffix >= 0
      ? `${normalized.slice(0, suffix)}[redacted-url-suffix]`
      : normalized;
  }
  if (normalized.startsWith('//')) {
    const withoutSuffix = normalized.replace(/[?#].*$/, '');
    const match = /^\/\/([^/\s]*)(.*)$/s.exec(withoutSuffix);
    if (!match) return '[redacted-remote]';
    const authority = match[1]!.includes('@')
      ? match[1]!.slice(match[1]!.lastIndexOf('@') + 1) : match[1]!;
    return `//${authority}${match[2]}`;
  }
  try {
    const parsed = new URL(normalized);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)
      && !DISPLAYABLE_REMOTE_PROTOCOLS.has(parsed.protocol)) return '[redacted-remote]';
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return '[redacted-remote]';
  }
  const suffix = normalized.search(/[?#]/);
  return suffix >= 0 ? `${normalized.slice(0, suffix)}[redacted-url-suffix]` : normalized;
}

function positionalReceiptIndex(argv: readonly string[]): number {
  const indexes: number[] = [];
  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (passthrough) { indexes.push(index); continue; }
    if (token === '--') { passthrough = true; continue; }
    if (!token.startsWith('--')) { indexes.push(index); continue; }
    if (token.startsWith('--no-') || token.includes('=')) continue;
    // Receipt command families accept presentation booleans only. Treat every other option as a
    // value-taking pair so an option value can never be mistaken for the live receipt positional.
    if (!DISPLAY_BOOLEAN_OPTIONS.has(token.slice(2)) && index + 1 < argv.length
        && !String(argv[index + 1]).startsWith('--')) index += 1;
  }
  const positionals = indexes.map((index) => String(argv[index]));
  const offset = positionals[0] === 'singularity-flow' ? 1 : 0;
  if (positionals[offset] === 'choices' && ['answer', 'status'].includes(positionals[offset + 1] ?? '')) return indexes[offset + 2] ?? -1;
  if (positionals[offset] === 'initiative' && positionals[offset + 1] === 'choices'
      && ['answer', 'status'].includes(positionals[offset + 2] ?? '')) return indexes[offset + 3] ?? -1;
  if (positionals[offset] === 'epic' && positionals[offset + 1] === 'review-choice'
      && ['answer', 'status'].includes(positionals[offset + 2] ?? '')) return indexes[offset + 3] ?? -1;
  return -1;
}

export function redactCliArgsForDisplay(argv: readonly string[]): string[] {
  const safe: string[] = [];
  const pending: Array<'secret' | 'remote'> = [];
  const receiptIndex = positionalReceiptIndex(argv);
  // This projection precedes command validation. Mask capability-shaped UUIDs conservatively when
  // any secret option or receipt family is present, including malformed invocations where an
  // intervening option would otherwise shift the positional parser.
  const capabilityBearing = argv.some((value) => {
    const token = displayNormalizeSensitiveSyntax(String(value).slice(0, MAX_DISPLAY_ARG_CHARS));
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    return displayIsSecretOptionKey(equals >= 0 ? token.slice(0, equals) : token);
  });
  const receiptFamily = argv.some((value) => ['choices', 'review-choice'].includes(String(value)))
    && argv.some((value) => ['answer', 'status'].includes(String(value)));
  let secretIntervened = false;
  for (const [index, raw] of argv.entries()) {
    const token = String(raw);
    if (token.length > MAX_DISPLAY_ARG_CHARS || DISPLAY_UNSAFE_CONTROLS.test(token)) {
      if (pending.length > 0) {
        safe.push(pending.pop() === 'remote' ? '[redacted-remote]' : '[redacted]');
        continue;
      }
      safe.push('[redacted]');
      const classificationToken = displayNormalizeSensitiveSyntax(token.slice(0, MAX_DISPLAY_ARG_CHARS));
      const equals = classificationToken.indexOf('=');
      const flag = equals >= 0 ? classificationToken.slice(0, equals) : classificationToken;
      if (classificationToken.startsWith('--') && equals < 0 && displayIsSecretOptionKey(flag)) pending.push('secret');
      if (equals < 0 && DISPLAY_REMOTE_OPTION.test(flag)) pending.push('remote');
      continue;
    }
    if ((capabilityBearing || receiptFamily) && DISPLAY_CAPABILITY_UUID.test(token)) {
      safe.push('[redacted]');
      continue;
    }
    if (index === receiptIndex) { safe.push('[redacted]'); continue; }
    if (secretIntervened && !token.startsWith('--')) { safe.push('[redacted]'); continue; }
    if (token === '--' && pending.includes('secret')) {
      secretIntervened = true;
      safe.push('--');
      continue;
    }
    if (pending.includes('secret') && token.startsWith('--')) {
      secretIntervened = true;
      const interveningEquals = token.indexOf('=');
      if (interveningEquals >= 0) {
        safe.push(`${token.slice(0, interveningEquals)}=[redacted]`);
        continue;
      }
      if (DISPLAY_CAPABILITY_UUID.test(token.slice(2))) {
        safe.push('--[redacted]');
        continue;
      }
      safe.push('[redacted]');
      continue;
    }
    if (pending.length > 0 && !token.startsWith('--')) {
      safe.push(pending.pop() === 'secret' ? '[redacted]' : displayRemoteOperand(token));
      continue;
    }
    const bareEquals = !token.startsWith('--') ? token.indexOf('=') : -1;
    if (bareEquals > 0 && displayIsSecretOptionKey(token.slice(0, bareEquals))) {
      safe.push(`${token.slice(0, bareEquals)}=[redacted]`);
      continue;
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (token.startsWith('--') && displayIsSecretOptionKey(flag)) {
      safe.push(equals >= 0 ? `${flag}=[redacted]` : token);
      if (equals < 0) pending.push('secret');
      continue;
    }
    if (DISPLAY_REMOTE_OPTION.test(flag)) {
      safe.push(equals >= 0 ? `${flag}=${displayRemoteOperand(token.slice(equals + 1))}` : token);
      if (equals < 0) pending.push('remote');
      continue;
    }
    const normalized = token.trim();
    const remoteShaped = normalized.startsWith('//')
      || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
      || /^[^/\s@]+@[^:\s]+:.+/.test(normalized);
    const assignmentText = displayNormalizeSensitiveSyntax(token);
    if (displayRemoteContainsSensitiveMaterial(token)
      || (!remoteShaped && displayRedactSecretAssignments(assignmentText) !== assignmentText)) {
      safe.push('[redacted]');
      continue;
    }
    safe.push(remoteShaped
      ? displayRemoteOperand(normalized) : token.replace(/[\u0000-\u001f\u007f]/g, '[control]'));
  }
  return safe;
}

/** Render a command without exposing rejected registry entries or credentials in VS Code output. */
export function formatCliArgsForDisplay(argv: readonly string[]): string {
  return redactCliArgsForDisplay(argv).join(' ');
}

/** Bound and scrub provider/CLI prose before it reaches an extension error or Output channel. */
function safeDisplayDiagnosticText(value: unknown): string {
  const source = String(value ?? '');
  const omitted = Math.max(0, source.length - MAX_DISPLAY_ERROR_CHARS);
  let text = displayNormalizeSensitiveSyntax(displayBoundedRedactionInput(source))
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi, '[redacted private key]')
    .replace(/\b[a-z][a-z0-9+.-]*::[^\r\n]*/gi, '[redacted-remote]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?=[^/\s@]*:[^/\s@]*@)[^\s]+/gi, '[redacted-remote]')
    .replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)(?=[^\s@]*:[^\s@]*@)[^\s]+/gi,
      '[redacted-remote]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (remote) => displayRemoteOperand(remote))
    .replace(/\b(?:https?|ssh|git\+ssh|ssh\+git|git|file|ftp|ftps):(?!\/\/)[^\s<>"']+/gi,
      '[redacted-remote]')
    .replace(/\b[^/\s@:]+:[^/\s@]+@[^\s<>"']+/g, '[redacted-remote]')
    .replace(/(^|[\s("'=])(?=[^\s<>"']*[\\/])(?=[^\s<>"']*[^/\\\s@:]+:[^/\\\s@]+@)[^\s<>"']+/g,
      '$1[redacted-remote]');
  text = displayRedactSecretAssignments(text)
    .replace(/\b(?:ghp_|github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/gi, '[redacted]')
    .replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/gi, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, '[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, '[redacted]');
  text = text.replace(/\S+/g,
    (token) => displayRemoteContainsSensitiveMaterial(token) ? '[redacted]' : token);
  text = text.replace(DISPLAY_UNSAFE_CONTROLS_GLOBAL, ' ');
  text = text.slice(0, MAX_DISPLAY_ERROR_CHARS);
  return omitted ? `${text}…[truncated ${omitted} chars]` : text;
}

function cliArgsAreReplaySafe(argv: readonly string[]): boolean {
  const projected = redactCliArgsForDisplay(argv);
  return projected.length === argv.length
    && projected.every((value, index) => value === String(argv[index]));
}

/** Remote Git launched by the extension must never wait for an invisible credential prompt. */
function nonInteractiveGitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
}

/**
 * Remote Git that does not stop the extension host.
 *
 * The two network calls on the repository-resolution path — an `ls-remote` bounded at 30 seconds and
 * a `fetch` bounded at 120 — were `spawnSync`, so their bounds described how long VS Code could be
 * frozen rather than how long the operation could take. A slow or unreachable remote is exactly when
 * this path runs: it is the narrow-clone recovery, reached only after both local authorities are
 * missing. `validateRepositoryDirectory` is already `async` and already awaits its filesystem checks,
 * so nothing here needed the synchrony.
 *
 * Local Git inspection uses the same asynchronous process boundary. Ref discovery and object reads
 * are batched, so repositories with thousands of remote-tracking refs cannot freeze the extension
 * host or launch one child per ref.
 */
export type RemoteGitFailure = 'ref-absent' | 'timeout' | 'network-unavailable'
  | 'authentication-required' | 'git-unavailable' | 'fetch-failed' | 'cancelled' | 'output-overflow';
export interface RemoteGitResult {
  status: number | null;
  stdout: string;
  failure: RemoteGitFailure | null;
}
export type RemoteGitRunner = (
  args: string[],
  options: { cwd: string; timeout: number; signal?: AbortSignal; spawnImpl?: typeof spawn }
) => Promise<RemoteGitResult>;

const PROCESS_TERMINATION_DEADLINE_MS = 2_000;
const PROCESS_TERMINATION_GRACE_MS = 250;
const TASKKILL_ATTEMPT_MS = 750;

function windowsSystemTool(name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) throw new TypeError('Unsafe Windows system-tool name.');
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.WINDIR;
  // `path.win32.isAbsolute` also accepts root-relative, UNC, and device paths. System tools are a
  // machine trust boundary, so accept only an explicit local drive identity such as C:\\Windows.
  if (root && /^[a-z]:[\\/]/i.test(root)) {
    const target = path.win32.join(root, 'System32', name);
    const comSpec = process.env.ComSpec || process.env.COMSPEC;
    if (comSpec && (name.toLowerCase() === 'cmd.exe')
        && path.win32.normalize(comSpec).toLowerCase() !== target.toLowerCase()) {
      throw new TypeError('Windows ComSpec does not identify SystemRoot\\System32\\cmd.exe.');
    }
    return target;
  }
  throw new TypeError(`Windows cannot resolve trusted ${name} without SystemRoot or WINDIR.`);
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('close', closedListener);
      resolve(closed);
    };
    const closedListener = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once('close', closedListener);
  });
}

/** Run Windows' descendant-aware terminator and observe its exit instead of assuming spawn means success. */
function runTaskkill(pid: number, force: boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let killer: ChildProcess | undefined;
    const finish = (killed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(killed);
    };
    const timer = setTimeout(() => {
      try { killer?.kill('SIGKILL'); } catch { /* best effort for the supervisor itself */ }
      finish(false);
    }, Math.max(1, timeoutMs));
    try {
      killer = spawn(windowsSystemTool('taskkill.exe'), ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
        windowsHide: true, stdio: 'ignore'
      });
    } catch {
      finish(false);
      return;
    }
    killer.once('error', () => finish(false));
    killer.once('close', (code) => finish(code === 0));
  });
}

async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs = TASKKILL_ATTEMPT_MS
): Promise<boolean> {
  if (child.pid && process.platform === 'win32') {
    const killed = await runTaskkill(child.pid, signal === 'SIGKILL', timeoutMs);
    if (killed) return true;
    // A missing/non-zero/timed-out taskkill must not be treated as cleanup. Direct termination is
    // weaker than `/T`, but is the last bounded fallback available to the extension host.
    try { return child.kill(signal); } catch { return false; }
  }
  if (child.pid) {
    try { process.kill(-child.pid, signal); return true; } catch { /* fall through */ }
  }
  try { return child.kill(signal); } catch { return false; }
}

/**
 * Quiesce a child tree before its caller reports timeout/cancellation, but settle independently of
 * `close` even when a broken child or pipe-holding descendant never emits it.
 */
async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + PROCESS_TERMINATION_DEADLINE_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  const gracefulClose = waitForChildClose(child, Math.min(PROCESS_TERMINATION_GRACE_MS, remaining()));
  await signalProcessTree(child, 'SIGTERM', Math.min(TASKKILL_ATTEMPT_MS, Math.max(1, remaining())));
  if (await gracefulClose) return true;

  const forcedClose = waitForChildClose(child, remaining());
  await signalProcessTree(child, 'SIGKILL', Math.min(TASKKILL_ATTEMPT_MS, Math.max(1, remaining())));
  if (await forcedClose) return true;

  // Do not let an uncooperative close event defeat the independent settlement deadline.
  try { child.kill('SIGKILL'); } catch { /* already gone or inaccessible */ }
  return false;
}

/** A bounded, cancellable, non-interactive remote Git boundary for the extension host. */
export const remoteGit: RemoteGitRunner = async (args, options) => new Promise((resolve) => {
  const outputLimit = 1024 * 1024;
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let settled = false;
  let child: ChildProcess | undefined;
  let stoppingFailure: RemoteGitFailure | null = null;
  const finish = (result: RemoteGitResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    resolve(result);
  };
  const stop = (failure: RemoteGitFailure) => {
    if (settled || stoppingFailure) return;
    stoppingFailure = failure;
    if (!child) return finish({ status: null, stdout: '', failure });
    const settle = () => finish({ status: null, stdout: '', failure });
    void terminateProcessTree(child).then(settle, settle);
  };
  const cancel = () => stop('cancelled');
  const timer = setTimeout(() => stop('timeout'), options.timeout);
  try {
    child = (options.spawnImpl ?? spawn)('git', args, {
      cwd: options.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: nonInteractiveGitEnvironment()
    });
  } catch {
    clearTimeout(timer);
    return resolve({ status: null, stdout: '', failure: 'git-unavailable' });
  }
  if (options.signal?.aborted) return cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (stoppingFailure) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) return stop('output-overflow');
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stoppingFailure) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) stop('output-overflow');
    else stderr += chunk.toString('utf8');
  });
  child.once('error', () => {
    if (!stoppingFailure) finish({ status: null, stdout: '', failure: 'git-unavailable' });
  });
  child.once('close', (code) => {
    if (stoppingFailure) return;
    let failure: RemoteGitFailure | null = null;
    if (code !== 0) {
      failure = /authentication failed|could not read username|terminal prompts disabled|credential/i.test(stderr)
        ? 'authentication-required'
        : /could not resolve host|connection (?:timed out|refused)|network is unreachable|unable to access/i.test(stderr)
          ? 'network-unavailable'
          : /couldn't find remote ref|remote ref does not exist/i.test(stderr)
            ? 'ref-absent'
            : 'fetch-failed';
    }
    finish({ status: code, stdout: code === 0 ? stdout : '', failure });
  });
});

export type LocalGitFailure = 'timeout' | 'cancelled' | 'git-unavailable' | 'output-overflow';
export interface LocalGitResult {
  status: number | null;
  stdout: Buffer;
  stderr: string;
  failure: LocalGitFailure | null;
}
export type LocalGitRunner = (
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    signal?: AbortSignal;
    input?: Buffer | string | null;
    spawnImpl?: typeof spawn;
  }
) => Promise<LocalGitResult>;

/** Local repository inspection shares the same non-blocking, bounded process boundary as remotes. */
export const localGit: LocalGitRunner = async (args, options) => new Promise((resolve) => {
  const outputLimit = 32 * 1024 * 1024;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stoppingFailure: LocalGitFailure | null = null;
  const finish = (result: LocalGitResult) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    resolve(result);
  };
  const stop = (failure: LocalGitFailure) => {
    if (settled || stoppingFailure) return;
    stoppingFailure = failure;
    if (!child) return finish({ status: null, stdout: Buffer.alloc(0), stderr: '', failure });
    const settle = () => finish({
      status: null, stdout: Buffer.alloc(0), stderr: '', failure
    });
    void terminateProcessTree(child).then(settle, settle);
  };
  const cancel = () => stop('cancelled');
  if (options.signal?.aborted) return cancel();
  try {
    child = (options.spawnImpl ?? spawn)('git', args, {
      cwd: options.cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: nonInteractiveGitEnvironment()
    });
  } catch {
    return finish({ status: null, stdout: Buffer.alloc(0), stderr: '', failure: 'git-unavailable' });
  }
  timer = setTimeout(() => stop('timeout'), options.timeout);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const collect = (target: Buffer[], chunk: Buffer) => {
    if (stoppingFailure) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) return stop('output-overflow');
    target.push(chunk);
  };
  child.stdout?.on('data', (chunk: Buffer) => collect(stdoutChunks, chunk));
  child.stderr?.on('data', (chunk: Buffer) => collect(stderrChunks, chunk));
  child.once('error', () => {
    if (!stoppingFailure) finish({
      status: null, stdout: Buffer.alloc(0), stderr: '', failure: 'git-unavailable'
    });
  });
  child.once('close', (code) => {
    if (!stoppingFailure) finish({
      status: code,
      stdout: code === 0 ? Buffer.concat(stdoutChunks) : Buffer.alloc(0),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      failure: null
    });
  });
  if (options.input == null) child.stdin?.end();
  else child.stdin?.end(options.input);
});

/*
 * Constructors assign their fields explicitly rather than using TypeScript parameter properties.
 * Parameter properties are the one common syntax that cannot be *stripped* — they emit assignments —
 * so avoiding them keeps every module here runnable under `node --experimental-strip-types`. That is
 * what lets the tests exercise this code directly, with no build step and no bundler in the loop.
 */
export class LegacyControlRootError extends Error {
  readonly code = 'SINGULARITY_FLOW_LEGACY_CONTROL_ROOT';
  readonly repository: string;
  readonly legacyRoot: string;
  constructor(repository: string, legacyRoot: string) {
    super(`This repository uses the former ${legacyRoot}/ control folder. Migrate it to the visible singularity/ folder before opening it.`);
    this.name = 'LegacyControlRootError';
    this.repository = repository;
    this.legacyRoot = legacyRoot;
  }
}

export class UninitializedRepositoryError extends Error {
  readonly code = 'SINGULARITY_FLOW_UNINITIALIZED_REPOSITORY';
  readonly repository: string;
  constructor(repository: string) {
    super("This folder is not initialized with Singularity Flow. Open the folder containing singularity/workflow.yml, or run 'singularity-flow init' there first.");
    this.name = 'UninitializedRepositoryError';
    this.repository = repository;
  }
}

export class RepositoryAuthorityUnavailableError extends Error {
  readonly code = 'SINGULARITY_FLOW_AUTHORITY_UNAVAILABLE';
  readonly repository: string;
  readonly failures: ReadonlyArray<{ remote: string; operation: 'ls-remote' | 'fetch' | 'verify'; reason: string }>;
  constructor(repository: string, failures: Array<{ remote: string; operation: 'ls-remote' | 'fetch' | 'verify'; reason: string }>) {
    super('Singularity Flow configuration may exist on a governed remote branch, but its authority could not be read or verified. Check network and Git credentials, then retry; do not initialize over the existing authority.');
    this.name = 'RepositoryAuthorityUnavailableError';
    this.repository = repository;
    this.failures = Object.freeze(failures.map((entry) => Object.freeze({ ...entry })));
  }
}

/** A non-zero exit carrying the CLI's own message, so callers can show it verbatim. */
export class CliError extends Error {
  readonly code = 'SINGULARITY_FLOW_CLI_ERROR';
  readonly exitCode: number | null;
  readonly stderr: string;
  /** Structured stdout returned with a deliberate non-zero status, when the command provided it. */
  readonly result: unknown;
  constructor(message: string, exitCode: number | null, stderr: string, result: unknown = null) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.result = result;
  }
}

function terminalQuote(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * One pasteable command for the terminal native to the host running VS Code.
 *
 * Every argument is quoted, including values supplied by intake. Besides making spaces survive,
 * this prevents a title containing `$()`, a backtick, `#`, or a single quote from becoming shell
 * syntax when somebody follows timeout recovery. Secrets are never CLI arguments; they remain in
 * the child environment supplied from SecretStorage.
 */
export function terminalCommand(
  repository: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtime: { executable: string; cli: string } | null = null
): string {
  // The extension commonly runs the engine bundled inside the VSIX, where no `singularity-flow`
  // launcher exists on PATH. A timeout recovery advertised as exact must therefore carry the same
  // executable and CLI path that were actually spawned. Keep the launcher form only as the public
  // helper's backwards-compatible default for manually constructed commands.
  const invocation = runtime
    ? [runtime.executable, runtime.cli, ...args]
    : ['singularity-flow', ...args];
  const quoted = invocation.map((argument) => terminalQuote(argument, platform)).join(' ');
  if (platform === 'win32') {
    return `Set-Location -LiteralPath ${terminalQuote(repository, platform)}; & ${quoted}`;
  }
  return `cd ${terminalQuote(repository, platform)} && ${quoted}`;
}

/** A timeout carries the exact invocation so every UI can offer deterministic recovery. */
export class CliTimeoutError extends Error {
  readonly code = 'SINGULARITY_FLOW_CLI_TIMEOUT';
  readonly timeoutMs: number;
  readonly terminalCommand: string | null;
  readonly summary: string;
  constructor(timeoutMs: number, command: string | null) {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const summary = `The Singularity Flow CLI did not finish within ${seconds} seconds. `
      + 'The interrupted operation may have retained recoverable transaction state.';
    super(command
      ? `${summary}\n\nRun this exact command from a terminal:\n${command}`
      : `${summary}\n\nThis invocation carried ephemeral authorization and cannot be safely replayed. Return to Continue safely and authorize a fresh action.`);
    this.name = 'CliTimeoutError';
    this.timeoutMs = timeoutMs;
    this.terminalCommand = command;
    this.summary = summary;
  }
}

interface GitBatchObject {
  oid: string;
  type: string;
  content: Buffer;
}

interface GitTreeEntry {
  mode: string;
  oid: string;
}

const LOCAL_GIT_TIMEOUT_MS = 15_000;
const REMOTE_PROBE_CONCURRENCY = 4;

interface RemoteProbePool {
  result(index: number): Promise<RemoteGitResult | undefined>;
  stop(): void;
  done: Promise<void>;
}

function startRemoteProbePool(
  remotes: readonly string[],
  probe: (remote: string, signal: AbortSignal) => Promise<RemoteGitResult>,
  signal?: AbortSignal
): RemoteProbePool {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', relayAbort, { once: true });

  const slots = remotes.map(() => {
    let resolve!: (result: RemoteGitResult | undefined) => void;
    const promise = new Promise<RemoteGitResult | undefined>((complete) => { resolve = complete; });
    return { promise, resolve, settled: false };
  });
  let cursor = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    controller.abort();
  };
  const worker = async () => {
    while (!stopped && !controller.signal.aborted) {
      const index = cursor;
      const remote = remotes[index];
      if (!remote) return;
      cursor += 1;
      let result: RemoteGitResult;
      try { result = await probe(remote, controller.signal); }
      catch { result = { status: null, stdout: '', failure: 'fetch-failed' }; }
      const slot = slots[index]!;
      slot.settled = true;
      slot.resolve(result);
      if (result.failure === 'cancelled' || controller.signal.aborted) stop();
    }
  };
  const workers = Array.from(
    { length: Math.min(REMOTE_PROBE_CONCURRENCY, remotes.length) },
    () => worker()
  );
  const done = Promise.all(workers).then(() => {
    signal?.removeEventListener('abort', relayAbort);
    for (const slot of slots) {
      if (!slot.settled) {
        slot.settled = true;
        slot.resolve(undefined);
      }
    }
  });
  return {
    result: (index) => slots[index]?.promise ?? Promise.resolve(undefined),
    stop,
    done
  };
}

function parseBatchObjects(expressions: readonly string[], output: Buffer): Map<string, GitBatchObject | null> {
  const parsed = new Map<string, GitBatchObject | null>();
  let offset = 0;
  for (const expression of expressions) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) return new Map();
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (/ (?:missing|ambiguous)$/.test(header)) {
      parsed.set(expression, null);
      continue;
    }
    const match = /^([0-9a-f]{40,64}) ([a-z]+) (\d+)$/.exec(header);
    if (!match) return new Map();
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size >= output.length) return new Map();
    const content = output.subarray(offset, offset + size);
    offset += size;
    if (output[offset] !== 0x0a) return new Map();
    offset += 1;
    parsed.set(expression, { oid: match[1]!, type: match[2]!, content });
  }
  return parsed;
}

async function batchObjects(
  root: string,
  expressions: readonly string[],
  runner: LocalGitRunner,
  signal?: AbortSignal
): Promise<Map<string, GitBatchObject | null>> {
  if (!expressions.length) return new Map();
  const result = await runner(['cat-file', '--batch'], {
    cwd: root,
    timeout: LOCAL_GIT_TIMEOUT_MS,
    signal,
    input: `${expressions.join('\n')}\n`
  });
  return result.status === 0 ? parseBatchObjects(expressions, result.stdout) : new Map();
}

/** Parse Git's binary tree-object format without launching one `ls-tree` process per ref. */
function parseTreeObject(object: GitBatchObject): Map<string, GitTreeEntry> | null {
  if (object.type !== 'tree') return null;
  const oidBytes = object.oid.length / 2;
  const entries = new Map<string, GitTreeEntry>();
  let offset = 0;
  while (offset < object.content.length) {
    const space = object.content.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : object.content.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + oidBytes > object.content.length) return null;
    const mode = object.content.subarray(offset, space).toString('ascii');
    const name = object.content.subarray(space + 1, nul).toString('utf8');
    const oid = object.content.subarray(nul + 1, nul + 1 + oidBytes).toString('hex');
    if (!name || entries.has(name)) return null;
    entries.set(name, { mode, oid });
    offset = nul + 1 + oidBytes;
  }
  return entries;
}

function validDestinationRef(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.endsWith('/') || ref.endsWith('.') || ref === '@') return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//')) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)) return false;
  return ref.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

interface StateMirrorCandidate {
  ref: string;
  manifest: any;
  root: GitBatchObject;
}

async function verifiedStateCandidate(
  root: string,
  candidates: readonly StateMirrorCandidate[],
  runner: LocalGitRunner,
  signal?: AbortSignal
): Promise<boolean> {
  const treeObjects = new Map<string, GitBatchObject | null>();
  for (const candidate of candidates) treeObjects.set(candidate.root.oid, candidate.root);
  const parsedTrees = new Map<string, Map<string, GitTreeEntry> | null>();
  const entriesFor = (treeObject: GitBatchObject): Map<string, GitTreeEntry> | null => {
    if (parsedTrees.has(treeObject.oid)) return parsedTrees.get(treeObject.oid) ?? null;
    const entries = parseTreeObject(treeObject);
    parsedTrees.set(treeObject.oid, entries);
    return entries;
  };

  const requestedPaths = new Map<StateMirrorCandidate, string[]>();
  for (const candidate of candidates) requestedPaths.set(candidate, Object.keys(candidate.manifest.assets));

  const resolve = (candidate: StateMirrorCandidate, relative: string): GitTreeEntry | null | undefined => {
    let treeOid = candidate.root.oid;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const treeObject = treeObjects.get(treeOid);
      if (treeObject === undefined) return undefined;
      if (treeObject === null) return null;
      const entries = entriesFor(treeObject);
      if (!entries) return null;
      const part = parts[index];
      if (!part) return null;
      const entry = entries.get(part);
      if (!entry) return null;
      if (index === parts.length - 1) return entry;
      if (entry.mode !== '40000' && entry.mode !== '040000') return null;
      treeOid = entry.oid;
    }
    return null;
  };

  // Fetch each unique directory tree once per depth, across every state ref. Process count follows
  // path depth rather than ref count; ordinary mirrors finish in three small batch processes.
  for (let depth = 0; depth < 32; depth += 1) {
    const missing = new Set<string>();
    for (const [candidate, paths] of requestedPaths) {
      for (const relative of paths) {
        let treeOid = candidate.root.oid;
        const parts = relative.split('/');
        for (let index = 0; index < parts.length - 1; index += 1) {
          const treeObject = treeObjects.get(treeOid);
          if (treeObject === undefined) { missing.add(treeOid); break; }
          if (treeObject === null) break;
          const part = parts[index];
          if (!part) break;
          const entry = entriesFor(treeObject)?.get(part);
          if (!entry || (entry.mode !== '40000' && entry.mode !== '040000')) break;
          treeOid = entry.oid;
        }
        // The loop resolves directory entries. Its last successful step leaves `treeOid` pointing
        // at the directory that contains the requested file, which has not necessarily been read
        // yet (for `singularity/workflow.yml`, this is the `singularity` tree itself).
        if (treeObjects.get(treeOid) === undefined) missing.add(treeOid);
      }
    }
    if (!missing.size) break;
    const fetched = await batchObjects(root, [...missing], runner, signal);
    for (const oid of missing) treeObjects.set(oid, fetched.get(oid) ?? null);
  }

  // Git object identity and mode bind the receipt to the tree, while SHA-256 binds the receipt to
  // the exact bytes SFlow will mount. Read every unique asset blob through one final batch instead
  // of trusting two manifest fields that could be stale in the same way.
  const blobOids = new Set<string>();
  for (const [candidate, paths] of requestedPaths) {
    for (const relative of paths) {
      const entry = resolve(candidate, relative);
      if (entry) blobOids.add(entry.oid);
    }
  }
  const blobObjects = await batchObjects(root, [...blobOids], runner, signal);

  return candidates.some((candidate) => requestedPaths.get(candidate)!.every((relative) => {
    const descriptor = candidate.manifest.assets[relative];
    const entry = resolve(candidate, relative);
    const blob = entry ? blobObjects.get(entry.oid) : null;
    return entry != null
      && descriptor?.sha256 === candidate.manifest.files[relative]
      && /^[0-9a-f]{40,64}$/.test(descriptor?.object ?? '')
      && /^100(?:644|755)$/.test(descriptor?.mode ?? '')
      && entry.oid === descriptor.object
      && entry.mode === descriptor.mode
      && blob?.type === 'blob'
      && createHash('sha256').update(blob.content).digest('hex') === candidate.manifest.files[relative];
  }));
}

async function localAuthorityAvailable(
  root: string,
  runner: LocalGitRunner,
  signal?: AbortSignal
): Promise<boolean> {
  const refsResult = await runner([
    'for-each-ref', '--format=%(refname)',
    'refs/remotes/*/sflow/config', 'refs/heads/sflow/config',
    'refs/remotes/*/state', 'refs/heads/state'
  ], { cwd: root, timeout: LOCAL_GIT_TIMEOUT_MS, signal });
  if (refsResult.status !== 0) return false;
  const refs = refsResult.stdout.toString('utf8').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const configRefs = refs.filter((ref) => ref === 'refs/heads/sflow/config' || ref.endsWith('/sflow/config'));
  const stateRefs = refs.filter((ref) => ref === 'refs/heads/state' || ref.endsWith('/state'));
  const expressions = [
    ...configRefs.map((ref) => `${ref}:singularity/workflow.yml`),
    ...stateRefs.flatMap((ref) => [
      `${ref}:configuration/manifest.json`, `${ref}:singularity/workflow.yml`, `${ref}^{tree}`
    ])
  ];
  const objects = await batchObjects(root, expressions, runner, signal);
  if (configRefs.some((ref) => objects.get(`${ref}:singularity/workflow.yml`)?.type === 'blob')) return true;

  const candidates: StateMirrorCandidate[] = [];
  for (const ref of stateRefs) {
    const manifestObject = objects.get(`${ref}:configuration/manifest.json`);
    const workflowObject = objects.get(`${ref}:singularity/workflow.yml`);
    const rootObject = objects.get(`${ref}^{tree}`);
    if (!manifestObject || !workflowObject || !rootObject || rootObject.type !== 'tree') continue;
    try {
      const manifest = JSON.parse(manifestObject.content.toString('utf8'));
      const files = manifest?.files;
      const valid = manifest?.format === 'singularity-flow-configuration-mirror/v2'
        && manifest?.layout === 'canonical-paths'
        && manifest?.source?.branch === 'sflow/config'
        && /^[0-9a-f]{40,64}$/.test(manifest?.source?.commit ?? '')
        && files != null && typeof files === 'object' && !Array.isArray(files)
        && files['singularity/workflow.yml']
          === createHash('sha256').update(workflowObject.content).digest('hex');
      if (!valid) continue;
      if (manifest.assets == null) return true;
      if (typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) continue;
      const assetPaths = Object.keys(manifest.assets).sort();
      if (JSON.stringify(assetPaths) !== JSON.stringify(Object.keys(files).sort())) continue;
      if (assetPaths.some((relative) => {
        const parts = relative.split('/');
        return parts.length > 32 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
          || !(relative.startsWith('singularity/') || relative.startsWith('.github/agents/'))
          || !/^[0-9a-f]{64}$/.test(files[relative] ?? '');
      })) continue;
      candidates.push({ ref, manifest, root: rootObject });
    } catch { /* another ref may carry a valid authority */ }
  }
  return candidates.length > 0 && await verifiedStateCandidate(root, candidates, runner, signal);
}

/**
 * Refuse anything that is not a real Git working tree with a real control directory.
 *
 * Every symbolic-link check here is load-bearing: the extension resolves artifact paths relative to
 * this root, and a symlinked control directory is how a path inside the workspace comes to point
 * outside it. Ported unchanged in intent from the desktop, which had the same exposure.
 */
export async function validateRepositoryDirectory(
  repository: string,
  options: { remoteRunner?: RemoteGitRunner; localRunner?: LocalGitRunner; signal?: AbortSignal } = {}
): Promise<string> {
  const resolved = path.resolve(repository || '');
  const canonical = await realpath(resolved).catch(() => null);
  const root = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || !root?.isDirectory()) throw new Error('The selected folder does not exist or is not a directory.');

  const git = await lstat(path.join(canonical, '.git')).catch(() => null);
  if (!git) throw new Error(`The selected folder is not a Git repository: ${resolved}`);
  if (git.isSymbolicLink()) throw new Error(`The selected repository has unsafe symbolic-link Git metadata: ${canonical}`);

  const runLocal = options.localRunner ?? localGit;
  const probe = await runLocal(['rev-parse', '--show-toplevel'], {
    cwd: canonical, timeout: LOCAL_GIT_TIMEOUT_MS, signal: options.signal
  });
  const topLevelText = probe.stdout.toString('utf8').trim();
  if (probe.status !== 0 || !topLevelText) {
    throw new Error(`The selected folder is not a valid Git working tree: ${canonical}`);
  }
  const topLevel = await realpath(topLevelText).catch(() => null);
  if (!topLevel || topLevel !== canonical) {
    throw new Error(`Open the Git repository root instead of a nested directory: ${canonical}`);
  }

  const control = await lstat(path.join(canonical, 'singularity')).catch(() => null);
  if (control?.isSymbolicLink()) throw new Error(`The singularity control directory cannot be a symbolic link: ${canonical}`);
  const workflow = await lstat(path.join(canonical, 'singularity', 'workflow.yml')).catch(() => null);
  if (workflow?.isSymbolicLink()) throw new Error(`The Singularity Flow workflow cannot be a symbolic link: ${canonical}`);
  if (!workflow?.isFile()) {
    for (const legacyRoot of ['.singularity', '.sdlc']) {
      const legacyControl = await lstat(path.join(canonical, legacyRoot)).catch(() => null);
      if (legacyControl?.isSymbolicLink()) throw new Error(`The former ${legacyRoot} control directory cannot be a symbolic link: ${canonical}`);
      const legacyWorkflow = await lstat(path.join(canonical, legacyRoot, 'workflow.yml')).catch(() => null);
      const legacyConfig = await lstat(path.join(canonical, legacyRoot, 'config.json')).catch(() => null);
      if (legacyWorkflow?.isSymbolicLink() || legacyConfig?.isSymbolicLink()) {
        throw new Error(`Former Singularity Flow configuration files cannot be symbolic links: ${canonical}/${legacyRoot}`);
      }
      if (legacyWorkflow?.isFile() || legacyConfig?.isFile()) throw new LegacyControlRootError(canonical, legacyRoot);
    }
    if (await localAuthorityAvailable(canonical, runLocal, options.signal)) return canonical;

    // A narrow clone (for example `--single-branch main`) has not copied either governed
    // namespace. Refresh only the exact authority ref into the normal remote-tracking namespace;
    // never checkout it and never touch HEAD, the index, or application files.
    const remotes = await runLocal(['remote'], {
      cwd: canonical, timeout: LOCAL_GIT_TIMEOUT_MS, signal: options.signal
    });
    const names = remotes.status === 0 ? remotes.stdout.toString('utf8').split(/\r?\n/)
      .map((entry) => entry.trim()).filter(Boolean)
      .sort((left, right) => (left === 'origin' ? -1 : 0) - (right === 'origin' ? -1 : 0)
        || left.localeCompare(right)) : [];
    const runRemote = options.remoteRunner ?? remoteGit;
    const failures: Array<{ remote: string; operation: 'ls-remote' | 'fetch' | 'verify'; reason: string }> = [];
    let responsiveRemotes = 0;
    let authorityAdvertised = false;
    const advertise = (remote: string, signal = options.signal) => runRemote([
        'ls-remote', '--heads', '--', remote, 'refs/heads/sflow/config', 'refs/heads/state'
      ], { cwd: canonical, timeout: 30_000, signal });
    const useAdvertisement = async (
      remote: string,
      advertised: RemoteGitResult
    ): Promise<'continue' | 'valid' | 'cancelled'> => {
      if (advertised.status !== 0) {
        failures.push({ remote, operation: 'ls-remote', reason: advertised.failure ?? `exit-${advertised.status}` });
        return advertised.failure === 'cancelled' ? 'cancelled' : 'continue';
      }
      responsiveRemotes += 1;
      const branches = new Set(advertised.stdout.split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[1]).filter(Boolean));
      for (const authorityBranch of ['sflow/config', 'state']) {
        if (!branches.has(`refs/heads/${authorityBranch}`)) continue;
        authorityAdvertised = true;
        const destination = `refs/remotes/${remote}/${authorityBranch}`;
        if (!validDestinationRef(destination)) {
          failures.push({ remote, operation: 'verify', reason: `invalid-ref-${authorityBranch}` });
          continue;
        }
        const fetched = await runRemote([
          'fetch', '--quiet', '--no-tags', '--force', '--', remote,
          `+refs/heads/${authorityBranch}:${destination}`
        ], { cwd: canonical, timeout: 120_000, signal: options.signal });
        if (fetched.status === 0
          && await localAuthorityAvailable(canonical, runLocal, options.signal)) return 'valid';
        failures.push({
          remote,
          operation: fetched.status === 0 ? 'verify' : 'fetch',
          reason: fetched.status === 0 ? `invalid-${authorityBranch}-authority` : fetched.failure ?? `exit-${fetched.status}`
        });
        if (fetched.failure === 'cancelled') return 'cancelled';
      }
      if (options.signal?.aborted) {
        failures.push({ remote, operation: 'ls-remote', reason: 'cancelled' });
        return 'cancelled';
      }
      return 'continue';
    };

    // `origin` is authoritative by convention and is therefore observed and consumed first. Only
    // when it cannot provide a valid authority do we inventory the remaining remotes. Their network
    // waits run through a small cancellable pool; results are still consumed in sorted order so the
    // chosen authority and user-facing failure order cannot depend on response timing.
    const origin = names[0] === 'origin' ? names[0] : null;
    const additional = origin ? names.slice(1) : names;
    if (origin) {
      const outcome = await useAdvertisement(origin, await advertise(origin, options.signal));
      if (outcome === 'valid') return canonical;
      if (outcome === 'cancelled') {
        throw new RepositoryAuthorityUnavailableError(canonical, failures);
      }
    }

    if (options.signal?.aborted && additional.length) {
      await useAdvertisement(additional[0]!, { status: null, stdout: '', failure: 'cancelled' });
    } else {
      const pool = startRemoteProbePool(additional, advertise, options.signal);
      let validAuthority = false;
      try {
        for (let index = 0; index < additional.length; index += 1) {
          const advertised = await pool.result(index);
          if (!advertised) break;
          const outcome = await useAdvertisement(additional[index]!, advertised);
          if (outcome === 'valid') { validAuthority = true; break; }
          if (outcome === 'cancelled') break;
        }
      } finally {
        // A deterministic winner or cancellation makes every later observation irrelevant. Abort
        // and await their bounded tree cleanup before returning, so no probe survives validation.
        pool.stop();
        await pool.done;
      }
      if (validAuthority) return canonical;
    }
    if (failures.length && (responsiveRemotes < names.length || authorityAdvertised)) {
      throw new RepositoryAuthorityUnavailableError(canonical, failures);
    }
    throw new UninitializedRepositoryError(canonical);
  }
  return canonical;
}

/**
 * Resolve the repository-wide Git directory shared by a checkout and all of its linked worktrees.
 *
 * The caller supplies a repository root that has already passed `validateRepositoryDirectory`.
 * Resolve this through Git rather than parsing the worktree's `.git` file in the extension host:
 * the latter points at a worktree-private administrative directory, while Auto records deliberately
 * live in the common directory. Both returned directories are canonicalized and their relationship
 * is checked before the path is used as a watcher authority. There is deliberately no fallback to
 * the process directory, home directory, or an adjacent repository.
 */
export async function validatedRepositoryGitCommonDirectory(
  repository: string,
  options: { localRunner?: LocalGitRunner; signal?: AbortSignal } = {}
): Promise<string> {
  if (!repository || !path.isAbsolute(repository)) {
    throw new Error('An explicit absolute repository root is required to resolve its Git common directory.');
  }
  const canonicalRepository = await realpath(repository).catch(() => null);
  if (!canonicalRepository) throw new Error('The selected repository cannot resolve its Git common directory.');
  const runLocal = options.localRunner ?? localGit;
  const probe = await runLocal(['rev-parse', '--absolute-git-dir', '--git-common-dir'], {
    cwd: canonicalRepository, timeout: LOCAL_GIT_TIMEOUT_MS, signal: options.signal
  });
  const lines = probe.stdout.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
  if (probe.status !== 0 || lines.length !== 2 || lines.some((line) => line.includes('\0'))) {
    throw new Error(`The selected repository cannot resolve its Git common directory: ${canonicalRepository}`);
  }
  const gitDirectoryCandidate = path.resolve(canonicalRepository, lines[0]!);
  const commonDirectoryCandidate = path.resolve(canonicalRepository, lines[1]!);
  const metadataPath = path.join(canonicalRepository, '.git');
  const [metadataStat, gitDirectoryStat, commonDirectoryStat] = await Promise.all([
    lstat(metadataPath).catch(() => null),
    lstat(gitDirectoryCandidate).catch(() => null),
    lstat(commonDirectoryCandidate).catch(() => null)
  ]);
  if (!metadataStat || metadataStat.isSymbolicLink()
      || !gitDirectoryStat?.isDirectory() || gitDirectoryStat.isSymbolicLink()
      || !commonDirectoryStat?.isDirectory() || commonDirectoryStat.isSymbolicLink()) {
    throw new Error(`The selected repository has unsafe Git common-directory metadata: ${canonicalRepository}`);
  }
  const [gitDirectory, commonDirectory] = await Promise.all([
    realpath(gitDirectoryCandidate), realpath(commonDirectoryCandidate)
  ]);
  let declaredGitDirectory: string | null = null;
  if (metadataStat.isDirectory()) {
    declaredGitDirectory = await realpath(metadataPath).catch(() => null);
  } else if (metadataStat.isFile() && metadataStat.size <= 4_096) {
    const declaration = await readFile(metadataPath, 'utf8').catch(() => '');
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(declaration);
    declaredGitDirectory = match
      ? await realpath(path.resolve(canonicalRepository, match[1]!)).catch(() => null)
      : null;
  }
  if (declaredGitDirectory !== gitDirectory) {
    throw new Error(`The selected repository returned an unrelated Git directory: ${canonicalRepository}`);
  }
  const worktreesDirectory = path.join(commonDirectory, 'worktrees');
  const relativeWorktreeDirectory = path.relative(worktreesDirectory, gitDirectory);
  const isLinkedWorktreeDirectory = relativeWorktreeDirectory.length > 0
    && relativeWorktreeDirectory !== '..'
    && !relativeWorktreeDirectory.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativeWorktreeDirectory);
  if (gitDirectory !== commonDirectory && !isLinkedWorktreeDirectory) {
    throw new Error(`The selected repository returned an unrelated Git common directory: ${canonicalRepository}`);
  }
  return commonDirectory;
}

/**
 * The sentence a person should read, out of everything the CLI wrote to stderr.
 *
 * The engine logs a structured line — timestamp, level, the whole error serialized as JSON with a
 * stack trace — and then prints the human sentence after it. Taking stderr whole meant every screen
 * that reports a failure showed the log line: a wall of JSON where a sentence belonged, with the
 * actual explanation somewhere in the middle of it.
 *
 * So the explicit `Singularity Flow error:` line wins wherever it appears, and structured log lines
 * are dropped rather than shown. Anything else is passed through, because an unrecognised message is
 * still better than none.
 */
export function humanError(stderr: string): string {
  try {
    const structured = JSON.parse(stderr.trim()) as {
      rendered?: { headline?: unknown };
      error?: { message?: unknown; diagnosticAction?: { command?: unknown } };
      next?: Array<{ command?: unknown }>;
    };
    const headline = String(structured.rendered?.headline ?? structured.error?.message ?? '').trim();
    const diagnostic = String(structured.error?.diagnosticAction?.command ?? '').trim();
    const next = String(structured.next?.find((entry) => entry?.command)?.command ?? '').trim();
    if (headline) {
      const safeHeadline = safeDisplayDiagnosticText(headline);
      if (diagnostic) return `${safeHeadline}\nDiagnose: ${safeDisplayDiagnosticText(diagnostic)}`;
      if (next) return `${safeHeadline}\nNext: ${safeDisplayDiagnosticText(next)}`;
      return safeHeadline;
    }
  } catch { /* ordinary terminal diagnostics continue through the line-oriented path */ }
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const stated = lines.filter((line) => line.startsWith('Singularity Flow error:'));
  if (stated.length) return safeDisplayDiagnosticText(
    stated.at(-1)!.replace(/^Singularity Flow error:\s*/, '')
  );
  // A structured line starts with an ISO timestamp and a level; nothing a reader wants is in it that
  // is not also in the sentence beside it.
  const readable = lines.filter((line) =>
    !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG)\b/.test(line));
  return safeDisplayDiagnosticText(readable.join('\n').trim());
}

export type OutputStream = 'stdout' | 'stderr';

export interface CliCommandTiming {
  schemaVersion: 2;
  event: 'dx.vscode-command-timing';
  command: string;
  commandClass: 'read' | 'mutation' | 'unknown';
  startedAt: string;
  durationMs: number;
  outcome: 'success' | 'error' | 'cancelled';
  cancelled: boolean;
  exitCode: number | null;
  fallback: 'none';
  stages: { spawnMs: number };
}

export interface InvokeOptions {
  executable: string;
  cli: string;
  repository: string;
  args: string[];
  input?: string | null;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
  onOutput?: (text: string, stream: OutputStream) => void;
  commandClass?: 'read' | 'mutation' | 'unknown';
  /** Completion telemetry is separate from the child process' stdout/stderr stream. */
  onTiming?: (event: CliCommandTiming) => void;
  /** Aborting a run the user cancelled, or that a newer refresh has superseded. */
  signal?: AbortSignal;
}

/**
 * Run the CLI once and resolve its parsed `--json` output.
 *
 * Rejects rather than resolving a failure value: a caller that forgets to check a status field
 * silently renders wrong governance state, and there is no safe default for "did this approval
 * happen". The error carries the CLI's own message so it can be shown without rewording.
 */
export function invokeCli<T = unknown>(options: InvokeOptions): Promise<T> {
  const {
    executable, cli, repository, args, input = null, json = true,
    env = process.env, timeoutMs = CLI_TIMEOUT_MS, spawnImpl = spawn, onOutput, onTiming,
    commandClass = 'unknown', signal
  } = options;

  const startedAt = process.hrtime.bigint();
  const startedAtWall = new Date().toISOString();
  return new Promise<T>((resolve, reject) => {
    let child: ChildProcess | undefined;
    // Keep every decoded chunk once and join once at completion. Repeated `output += chunk` copies
    // all output received so far on every event, which turns a large snapshot into quadratic work
    // and briefly retains several complete copies in the extension host.
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let outputBytes = 0;
    let settled = false;
    let timingReported = false;
    let timer: NodeJS.Timeout | undefined;
    let pendingFailure: { error: Error; outcome: CliCommandTiming['outcome']; cancelled: boolean } | null = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const reportTiming = (
      outcome: CliCommandTiming['outcome'], exitCode: number | null, cancelled = false
    ) => {
      if (timingReported) return;
      timingReported = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      try {
        onTiming?.({
          schemaVersion: 2,
          event: 'dx.vscode-command-timing',
          command: args[0] ?? 'command',
          commandClass,
          startedAt: startedAtWall,
          durationMs,
          outcome,
          cancelled,
          exitCode,
          fallback: 'none',
          stages: { spawnMs: durationMs }
        });
      } catch { /* diagnostic only */ }
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown, outcome: CliCommandTiming['outcome'] = 'error', cancelled = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      reportTiming(outcome, child?.exitCode ?? null, cancelled);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const terminate = (error: Error, outcome: CliCommandTiming['outcome'], cancelled = false) => {
      if (settled || pendingFailure) return;
      pendingFailure = { error, outcome, cancelled };
      if (!child) return fail(error, outcome, cancelled);
      // Do not reject while taskkill/process-group cleanup is still in progress. The supervisor has
      // its own hard deadline, so a child that never emits `close` cannot strand this Promise.
      const settle = () => {
        const failure = pendingFailure;
        if (failure) fail(failure.error, failure.outcome, failure.cancelled);
      };
      void terminateProcessTree(child).then(settle, settle);
    };
    function onAbort() {
      terminate(new Error('The Singularity Flow command was cancelled.'), 'cancelled', true);
    }

    if (signal?.aborted) return fail(new Error('The Singularity Flow command was cancelled.'), 'cancelled', true);

    const collect = (target: string[], chunk: Buffer, stream: OutputStream): void => {
      if (pendingFailure) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate(new Error('The Singularity Flow CLI returned too much data to display.'), 'error');
        return;
      }
      const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
      if (text) target.push(text);
    };

    try {
      child = spawnImpl(executable, [cli, ...args], {
        cwd: repository,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      return fail(error);
    }

    timer = setTimeout(() => {
      const recoveryCommand = cliArgsAreReplaySafe(args) ? terminalCommand(
        repository, args, process.platform, { executable, cli }
      ) : null;
      terminate(new CliTimeoutError(
        timeoutMs,
        recoveryCommand
      ), 'error');
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => { collect(stdoutChunks, chunk, 'stdout'); });
    child.stderr?.on('data', (chunk: Buffer) => { collect(stderrChunks, chunk, 'stderr'); });
    child.on('error', (error) => {
      if (!pendingFailure) fail(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      // The termination supervisor also observes `close` and owns settlement for a timeout or
      // cancellation. Reporting here could beat a still-running Windows taskkill process.
      if (pendingFailure) return;
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) stdoutChunks.push(stdoutTail);
      if (stderrTail) stderrChunks.push(stderrTail);
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      // Provider and hook output is untrusted and may split a credential across arbitrary child
      // chunks (`pass` + `word=value`). Buffering already occurs for parsing, so publish only the
      // bounded, scrubbed streams once their complete lexical context is available. Raw bytes never
      // reach VS Code's Output channel. An observer that throws must not take the command down.
      try {
        if (stdout) onOutput?.(safeDisplayDiagnosticText(stdout), 'stdout');
        if (stderr) onOutput?.(safeDisplayDiagnosticText(stderr), 'stderr');
      } catch { /* diagnostic observer only */ }
      if (code !== 0) {
        let result: unknown = null;
        if (json && stdout.trim()) {
          try { result = JSON.parse(stdout); } catch { /* the original text remains the diagnostic */ }
        }
        const structuredStatus = result && typeof result === 'object' && 'status' in result
          ? String((result as { status?: unknown }).status ?? '').trim()
          : '';
        const message = humanError(stderr)
          || (structuredStatus
            ? `The Singularity Flow command reported ${structuredStatus}.`
            : safeDisplayDiagnosticText(stdout.trim()))
          || `The Singularity Flow CLI exited with ${code}.`;
        return fail(new CliError(message, code, safeDisplayDiagnosticText(stderr), result));
      }
      if (!json) {
        reportTiming('success', code);
        return succeed({ output: stdout.trim() } as T);
      }
      try {
        const value = JSON.parse(stdout) as T;
        reportTiming('success', code);
        succeed(value);
      } catch {
        fail(new Error(`The CLI returned data this extension could not read: ${safeDisplayDiagnosticText(stdout.slice(0, 500))}`));
      }
    });

    if (input == null) child.stdin?.end();
    else child.stdin?.end(input, 'utf8');
  });
}
