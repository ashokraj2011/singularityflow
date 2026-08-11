import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { SingularityFlowError } from './util.mjs';
import { gitDir } from './git.mjs';

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
const MAX_DEPTH = 6;

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
  /\bAIza[A-Za-z0-9_-]{30,}\b/g
];

export const REDACTED = '[redacted]';

function redactText(value) {
  let text = value;
  for (const pattern of SECRET_VALUE) text = text.replace(pattern, REDACTED);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…[truncated ${text.length - MAX_VALUE_CHARS} chars]` : text;
}

// Recursively strip secrets from log context. Runs before serialization, so nothing unredacted is
// ever handed to a sink.
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: value.stack ? redactText(value.stack) : undefined, code: value.code };
  }
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1, seen));
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
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
      try { return JSON.parse(line); }
      catch { return { ts: null, level: 'error', event: 'log.unreadable', msg: `Line ${index + 1} is not valid JSON.`, raw: line.slice(0, 200) }; }
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
