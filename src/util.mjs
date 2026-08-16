import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { displayWidth, padDisplay, terminalWidth, truncateDisplay } from './style.mjs';

export class SingularityFlowError extends Error {
  constructor(message, { exitCode = 1, code = null, details = null, cause = undefined } = {}) {
    super(message);
    this.name = 'SingularityFlowError';
    this.exitCode = exitCode;
    if (code) this.code = code;
    if (details != null) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      exitCode: this.exitCode,
      ...(this.code ? { code: this.code } : {}),
      ...(this.details != null ? { details: this.details } : {})
    };
  }
}

export function invariant(condition, message) {
  if (!condition) throw new SingularityFlowError(message);
}

/**
 * Map over items with bounded concurrency, preserving input order.
 *
 * The codebase had no such primitive, so every bulk operation was either a serial `for … await` or
 * a bare `Promise.all` over everything at once. The serial form is what made a world-model build
 * read and hash the whole tree four times in sequence before any model ran; the unbounded form is
 * not an option for file I/O across a large repository.
 *
 * Results come back in input order regardless of completion order, which matters wherever the
 * output feeds a hash: a snapshot whose digest depended on I/O scheduling would not be a snapshot.
 */
export async function mapLimit(items, limit, mapper) {
  const list = [...items];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(limit, list.length));
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

// Presentation primitives live in style.mjs. Imported for `table` and re-exported because every
// existing caller already reaches for its formatting helpers here.
export { displayWidth, padDisplay, terminalWidth, truncateDisplay };

/**
 * Flags that never take a value.
 *
 * Without this, `parseArgs` gave every flag the next token — so `submit --skip-checks design` set
 * `skip-checks` to `"design"` and dropped the phase, then failed with a type error naming a flag the
 * user had used correctly. The list is derived from how the code actually reads each flag
 * (`optionBoolean` and nothing else); `scripts/check.mjs` re-derives it and fails on drift, so a flag
 * that changes shape cannot silently start eating its neighbour again.
 *
 * `agent`, `confirm` and `jira` are read both ways in different commands. Ambiguous means greedy:
 * guessing wrong would swallow a real value, which is the worse failure.
 */
export const BOOLEAN_OPTIONS = Object.freeze(new Set([
  'acknowledge-self-approval', 'active', 'all', 'allow-dirty', 'apply', 'assigned-to-me',
  'assisted', 'blocking', 'check', 'churn', 'cli-only', 'clipboard', 'clone', 'concat',
  'confirm-pin-retention', 'confirm-protected', 'confirm-push-policy', 'create', 'dry-run', 'evidence',
  'fetch', 'first-run', 'force', 'from-records', 'here', 'include-prompt', 'json',
  'keep', 'local', 'markdown', 'network', 'offline', 'once',
  'opt-out', 'optional', 'parallel', 'polish', 'probe', 'push',
  'readiness', 'recap', 'record', 'record-audit', 'render-only', 'repair',
  'repair-projections', 'replace', 'replace-server', 'resume', 'set', 'sign',
  'skip-checks', 'staged', 'strict', 'terminal', 'timings', 'update', 'write',
  'yes',
  // Presentation flags introduced with the narration and output work. They are parsed here before
  // any command reads them, so they must be declared here too.
  'verbose', 'show-artifact', 'brief'
]));

export function parseArgs(argv) {
  const positionals = [];
  const options = {};
  let passthrough = false;
  const put = (key, value) => {
    if (Object.hasOwn(options, key)) options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
    else options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      put(token.slice(5), false);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals > 2) {
      put(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--') && !BOOLEAN_OPTIONS.has(key)) {
      put(key, next);
      index += 1;
    } else put(key, true);
  }
  return { positionals, options };
}

// Damerau-style edit distance, bounded so a wildly different word costs nothing to reject.
function editDistance(a, b, ceiling) {
  if (Math.abs(a.length - b.length) > ceiling) return ceiling + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitute = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const transpose = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
        ? previous[j - 2] : Infinity;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitute, transpose);
      if (current[j] < best) best = current[j];
    }
    if (best > ceiling) return ceiling + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * Rank known names by how plausibly they are what someone meant to type.
 *
 * A typo should cost one line of correction, not a search through 2,450 lines of help. Prefix
 * matches come first because that is how people abbreviate; near-spellings follow. Returns at most
 * `limit`, and nothing at all when nothing is close — a wrong guess is worse than no guess.
 */
export function nearestNames(candidate, known, { limit = 3 } = {}) {
  const needle = String(candidate ?? '').toLowerCase();
  if (!needle) return [];
  const ceiling = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  return [...new Set(known)]
    .map((name) => {
      const value = String(name).toLowerCase();
      if (value.startsWith(needle) || needle.startsWith(value)) return { name, score: -1 };
      if (value.includes(needle)) return { name, score: -0.5 };
      return { name, score: editDistance(needle, value, ceiling) };
    })
    .filter((entry) => entry.score <= ceiling)
    .sort((a, b) => a.score - b.score || String(a.name).localeCompare(String(b.name)))
    .slice(0, limit)
    .map((entry) => entry.name);
}

// Join a list the way a sentence does: commas, and one conjunction before the last item.
export function sentenceList(items, conjunction = 'or') {
  const values = items.map(String);
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} ${conjunction} ${values.at(-1)}`;
}

// Render a suggestion clause, or nothing when there is no honest suggestion to make.
export function didYouMean(candidate, known, { limit = 3 } = {}) {
  const matches = nearestNames(candidate, known, { limit });
  if (!matches.length) return '';
  return ` Did you mean ${sentenceList(matches.map((name) => `'${name}'`))}?`;
}

export function optionString(options, key, fallback = undefined) {
  const value = options[key];
  if (value === undefined || value === false) return fallback;
  if (value === true) throw new SingularityFlowError(`Option --${key} requires a value.`);
  return String(Array.isArray(value) ? value.at(-1) : value);
}

export function optionStrings(options, key) {
  const value = options[key];
  if (value === undefined || value === false) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => item === true)) throw new SingularityFlowError(`Option --${key} requires a value.`);
  return values.map(String);
}

/**
 * A name Git will accept as a ref, and a shell will not mistake for something else.
 *
 * The Git half of this rule was already written out twice — once for a workspace's default branch
 * and once for anything the gateway is handed — and two copies of a validator that reaches argv is
 * one copy too many. The leading-dash rejection is the part Git itself does not care about: `-u`
 * is a perfectly legal ref name and an option to every command that takes one.
 */
export function isGitRefName(value) {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('-')) return false;
  return /^(?![./])(?!.*(?:\.\.|@\{|[~^:?*\\[]))(?!.*\/\.)(?!.*[/.]$)[^\s\u0000-\u001f\u007f]+$/.test(value);
}

export function optionBoolean(options, key, fallback = false) {
  const value = options[key];
  if (value === undefined) return fallback;
  const actual = Array.isArray(value) ? value.at(-1) : value;
  if (typeof actual === 'boolean') return actual;
  const normalized = String(actual).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new SingularityFlowError(`Option --${key} expects a boolean.`);
}

export function optionNumber(options, key, fallback = undefined) {
  const value = optionString(options, key, fallback);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SingularityFlowError(`Option --${key} expects a number.`);
  return number;
}

/**
 * Read a required positional, or refuse with something the reader can act on.
 *
 * This is the most common way to get a refusal out of the tool — 113 call sites — and it used to say
 * only what was absent, never where it goes. The tokens already consumed are the command path, so
 * the usage line can be reconstructed exactly, and the per-command man page is one flag away.
 */
export function requirePositional(positionals, index, label) {
  if (!positionals[index]) {
    const path = positionals.slice(0, index).filter(Boolean).join(' ');
    const placeholder = `<${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}>`;
    throw new SingularityFlowError([
      `Missing ${label}.`,
      path ? `Usage: singularity-flow ${path} ${placeholder}` : null,
      positionals[0] ? `Run 'singularity-flow ${positionals[0]} --help' for details and examples.` : null
    ].filter(Boolean).join(' '), { code: 'MISSING_ARGUMENT' });
  }
  return positionals[index];
}

/**
 * Where every subprocess went, when `SINGULARITY_FLOW_SUBPROCESS_PROBE` is set.
 *
 * A read model that shells out is easy to write and hard to see: the cost is spread over call sites
 * that each look cheap. This exists because a 470 ms `gh auth status` sat inside the snapshot the
 * VS Code extension calls on every refresh, and it was found by reading the code rather than by
 * measuring — which is luck, not method. Off unless the variable is set, so it costs nothing.
 */
const subprocessProbe = new Map();

/**
 * Which call site made it, when `SINGULARITY_FLOW_SUBPROCESS_TRACE` matches. `[UXH:REQ-120]`
 *
 * The counts above say a read path fetched six times; they cannot say *from where*, and the answer
 * is what the fix depends on. The previous round resolved that by reading the code until a
 * plausible culprit appeared — which found a real one and would have been silent if the culprit had
 * been the second plausible reader instead. A stack per matching call turns the next investigation
 * back into a measurement.
 *
 * A substring of the probe key rather than a pattern: the keys are already the vocabulary the
 * report prints, so `TRACE='git fetch'` traces what the reader just saw a row for, with no second
 * syntax to learn.
 */
function traceSubprocess(key) {
  const wanted = process.env.SINGULARITY_FLOW_SUBPROCESS_TRACE;
  if (!wanted || !key.includes(wanted)) return;
  const frames = (new Error().stack ?? '').split('\n')
    // This helper, its caller in `run`, and Node's own internals are noise: the reader wants the
    // first frame that belongs to this product.
    .filter((line) => line.includes(`${path.sep}src${path.sep}`) && !line.includes(`util.mjs`))
    /**
     * Deep enough to reach the surface that asked.
     *
     * Four frames looked like plenty and stopped one short of `editor.mjs` on two of three ledger
     * reads — so the report showed a cost happening three times and could only account for one of
     * them. The question a trace exists to answer is "who wanted this", and that is the *last*
     * product frame, not the first.
     */
    .slice(0, Number(process.env.SINGULARITY_FLOW_SUBPROCESS_TRACE_DEPTH || 10))
    .map((line) => `      ${line.trim()}`);
  process.stderr.write(`\ntrace ${key}\n${frames.join('\n') || '      (no product frame)'}\n`);
}

function recordSubprocessProbe(command, args, ms) {
  // Keyed by the verb, not the whole line: `git rev-parse <sha>` and `git rev-parse HEAD` are the
  // same call for costing purposes, and per-argument keys would bury the count in cardinality.
  const key = `${command} ${String(args[0] ?? '')} ${String(args[1] ?? '')}`.trim();
  traceSubprocess(key);
  const entry = subprocessProbe.get(key) ?? { calls: 0, ms: 0 };
  subprocessProbe.set(key, { calls: entry.calls + 1, ms: entry.ms + ms });
  if (!subprocessProbe.reported) {
    subprocessProbe.reported = true;
    process.on('exit', () => {
      const rows = [...subprocessProbe.entries()].sort((a, b) => b[1].ms - a[1].ms);
      const total = rows.reduce((sum, [, value]) => sum + value.ms, 0);
      const calls = rows.reduce((sum, [, value]) => sum + value.calls, 0);
      process.stderr.write(`\nsubprocesses: ${calls} calls, ${total.toFixed(0)} ms total\n`);
      for (const [name, value] of rows) {
        process.stderr.write(`  ${String(value.calls).padStart(3)}x ${value.ms.toFixed(0).padStart(6)} ms  ${name}\n`);
      }
    });
  }
}

/**
 * Commands that reach the network, and the longest this product will wait for one.
 *
 * `gh` had no timeout anywhere across ten call sites, which is fine until the network is slow or
 * captive — and then it is not a slowdown, it is a hang. A `gh api user` behind a captive portal
 * held this repository's own test suite for thirty-two minutes with no output and no error.
 *
 * The bound lives here rather than at the call sites so it covers the ten that exist and the
 * eleventh nobody has written yet. `git` is deliberately not on this list: a fetch or a push against
 * a large repository legitimately takes minutes, and the fix for a slow clone is not a shorter
 * deadline. Any call may override with an explicit `timeoutMs`.
 */
const NETWORK_COMMANDS = new Set(['gh']);
export const NETWORK_TIMEOUT_MS = Number(process.env.SINGULARITY_FLOW_NETWORK_TIMEOUT_MS ?? 15_000);

/** The bound a command gets when the caller does not name one. Exported so it can be asserted. */
export function defaultTimeoutFor(command) {
  return NETWORK_COMMANDS.has(command) ? NETWORK_TIMEOUT_MS : undefined;
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);

/**
 * Whether this process is forbidden from reaching the network.
 *
 * `SINGULARITY_FLOW_NO_NETWORK` was set by `scripts/dx-benchmark.mjs` and read by nothing. The
 * reference fixture declares `protocol.network: "disabled"`, and `assertBaselineCandidate` refuses
 * any report that disagrees — so the guarantee was asserted end to end and enforced nowhere, and
 * every recorded number silently included however long `gh api user` happened to take. Measured
 * here: 965 ms on a cold cache, which is most of a benchmark that budgets 150.
 *
 * Read per call rather than captured at import, so a test can set it around one command.
 */
export function networkDisabled(env = process.env) {
  return TRUE.has(String(env.SINGULARITY_FLOW_NO_NETWORK ?? '').trim().toLowerCase());
}

export function run(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  allowFailure = false,
  shell = false,
  stdio = 'pipe',
  timeoutMs = defaultTimeoutFor(command),
  /**
   * Text to write to the child's stdin.
   *
   * Added because a subprocess primitive that cannot accept stdin quietly forces every
   * batch-capable Git command into a per-item loop — `git cat-file --batch` reads its work list
   * from stdin, and without this the only way to read forty blobs is forty processes. That is the
   * exact shape this read path has been paying for in three separate places.
   */
  input = undefined,
  /**
   * `utf8` for everything that is text, `buffer` for output that must be sliced by byte offset.
   *
   * `cat-file --batch` interleaves a header line with raw blob bytes and gives the length in bytes.
   * Walking that as a JavaScript string is correct only while every byte is ASCII, and silently
   * wrong the first time an entry contains a non-Latin character — so the caller that needs offsets
   * asks for bytes.
   */
  encoding = 'utf8'
} = {}) {
  /**
   * A blocked network command is refused here rather than attempted and failed.
   *
   * Reported as `blocked` alongside `timedOut` for the same reason: "we did not ask" and "we asked
   * and got nothing" are different facts, and a disclosure that collapses them tells a reader their
   * account is signed out when nobody ever checked.
   */
  if (NETWORK_COMMANDS.has(command) && networkDisabled(env)) {
    if (!allowFailure) {
      throw new SingularityFlowError(`${command} is a network command and SINGULARITY_FLOW_NO_NETWORK is set.`, { code: 'NETWORK_DISABLED' });
    }
    return { status: 1, stdout: '', stderr: '', error: undefined, timedOut: false, blocked: true };
  }
  const probe = process.env.SINGULARITY_FLOW_SUBPROCESS_PROBE ? performance.now() : 0;
  const result = spawnSync(command, args, {
    cwd, env, encoding, shell, stdio, timeout: timeoutMs,
    /**
     * Always bytes.
     *
     * `spawnSync` applies `encoding` to stdin as well as stdout, so handing it a string alongside
     * `encoding: 'buffer'` fails with "Unknown encoding: buffer" — the input is never ambiguous
     * once it is already a Buffer.
     */
    ...(input === undefined ? {} : { input: Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8') })
  });
  if (probe) recordSubprocessProbe(command, args, performance.now() - probe);
  /**
   * Buffers pass through; everything else keeps the string contract every existing caller relies on.
   *
   * A caller that asked for bytes and got `''` on failure would have to test the type before using
   * it, so the empty case is an empty Buffer rather than an empty string.
   */
  const empty = encoding === 'buffer' ? Buffer.alloc(0) : '';
  const stdout = (encoding === 'buffer' ? Buffer.isBuffer(result.stdout) : typeof result.stdout === 'string')
    ? result.stdout : empty;
  const stderr = (encoding === 'buffer' ? Buffer.isBuffer(result.stderr) : typeof result.stderr === 'string')
    ? result.stderr : empty;
  const status = result.status ?? (result.error ? 1 : 0);
  /**
   * A command that ran out of time did not answer, which is not the same as answering no.
   *
   * Callers that pass `allowFailure` treat a non-zero status as "unavailable", and for a timeout
   * that is the right handling — but the reason has to survive, or an unreachable network is
   * indistinguishable from a signed-out account in every disclosure downstream.
   */
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (result.error && !allowFailure && !timedOut) throw new SingularityFlowError(`Unable to run ${command}: ${result.error.message}`);
  if (timedOut && !allowFailure) {
    throw new SingularityFlowError(`${command} did not respond within ${timeoutMs}ms.`, { code: 'SUBPROCESS_TIMEOUT' });
  }
  if (status !== 0 && !allowFailure) {
    // `String()` rather than `.trim()` directly: in buffer mode these are Buffers, and a failure
    // message is the one place this must not throw a second, less informative error.
    const detail = String(stderr).trim() || String(stdout).trim() || `exit ${status}`;
    throw new SingularityFlowError(`${command} ${args.join(' ')} failed: ${detail}`);
  }
  return { status, stdout, stderr, error: result.error, timedOut, blocked: false };
}

/**
 * The shell a configured runner command should be handed to.
 *
 * The world-model runner is a command line a repository configures, so it genuinely needs a shell to
 * interpret. It was always `bash`, which simply is not present on a stock Windows machine — the
 * build failed there with a spawn error rather than anything explaining why. `cmd.exe` is the
 * equivalent, and `/c` is its `-c`.
 */
export function platformShell() {
  return process.platform === 'win32'
    ? { command: process.env.ComSpec || 'cmd.exe', flag: '/c' }
    : { command: 'bash', flag: '-c' };
}

export function commandExists(command) {
  const result = process.platform === 'win32'
    ? run('where', [command], { allowFailure: true })
    : run('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { allowFailure: true });
  return result.status === 0;
}

/**
 * The bytes on disk at `file`, hashed; null when the file does not exist.
 *
 * Lives here so the state store, the aggregate writer and the publication kernel all compare the
 * same thing. It is how a concurrent writer is detected: `head` only moves on a commit, and several
 * commands write governed state without committing.
 */
export function stateFingerprint(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError(`Required file not found: ${filePath}`);
    if (error instanceof SyntaxError) throw new SingularityFlowError(`Invalid JSON in ${filePath}: ${error.message}`);
    throw error;
  }
}

export async function writeAtomic(filePath, value, { mode = undefined } = {}) {
  await ensureDir(path.dirname(filePath));
  const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temp, value, {
      ...(Buffer.isBuffer(value) || value instanceof Uint8Array ? {} : { encoding: 'utf8' }),
      ...(mode == null ? {} : { mode })
    });
    await rename(temp, filePath);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

export async function writeJson(filePath, value) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(filePath, value) {
  await writeAtomic(filePath, value.endsWith('\n') ? value : `${value}\n`);
}

/** Atomically writes opaque bytes without UTF-8 conversion or newline mutation. */
export async function writeBytes(filePath, value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new SingularityFlowError('writeBytes expects a Buffer or Uint8Array.');
  }
  await writeAtomic(filePath, value);
}

export async function snapshot(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { exists: true, size: info.size, sha256: null };
    const content = await readFile(filePath);
    return { exists: true, size: info.size, sha256: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, size: 0, sha256: null };
    throw error;
  }
}

export function posix(value) {
  return value.split(path.sep).join('/');
}

export function repoRelative(root, candidate) {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SingularityFlowError(`Path is outside the repository: ${candidate}`);
  return posix(relative || '.');
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

export async function secureRepositoryPath(root, candidate, {
  label = 'Repository path',
  mustExist = false,
  type = null
} = {}) {
  const relative = repoRelative(root, candidate);
  const canonicalRoot = await realpath(path.resolve(root));
  const absolute = path.resolve(canonicalRoot, relative);
  const entry = await lstatOrNull(absolute);
  if (entry?.isSymbolicLink()) throw new SingularityFlowError(`${label} cannot be a symbolic link: ${relative}`);

  let probe = entry ? absolute : path.dirname(absolute);
  let probeEntry = entry;
  while (!probeEntry) {
    probeEntry = await lstatOrNull(probe);
    if (probeEntry) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const canonicalProbe = await realpath(probe);
  const probeRelative = path.relative(canonicalRoot, canonicalProbe);
  if (probeRelative.startsWith('..') || path.isAbsolute(probeRelative)) {
    throw new SingularityFlowError(`${label} resolves outside the repository: ${relative}`);
  }
  if (mustExist && !entry) throw new SingularityFlowError(`${label} does not exist: ${relative}`);
  if (entry && type === 'file' && !entry.isFile()) throw new SingularityFlowError(`${label} must be a regular file: ${relative}`);
  if (entry && type === 'directory' && !entry.isDirectory()) throw new SingularityFlowError(`${label} must be a directory: ${relative}`);
  return { root: canonicalRoot, relative, absolute, exists: Boolean(entry), entry };
}

export function truncate(value, max = 2000) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max)}\n… truncated …`;
}

/**
 * Render rows as a fixed-width table.
 *
 * Widths were measured with `String.length` and never bounded, so one long title pushed the table
 * past the terminal and every row wrapped into rubble, and a single CJK cell — two columns wide,
 * one code unit long — misaligned everything after it. Width is now printable width, and the table
 * is fitted to the terminal.
 *
 * Columns shrink from the widest first, and never below `min` (default 8). The first column is left
 * alone: it holds the ID or name you would copy into the next command, and a truncated identifier
 * is worse than a wrapped row.
 */
export function table(rows, columns, { width = terminalWidth(), min = 8 } = {}) {
  const natural = columns.map((column) => Math.max(
    displayWidth(column.label),
    ...rows.map((row) => displayWidth(String(row[column.key] ?? '')))
  ));
  const gutters = (columns.length - 1) * 2;
  const widths = [...natural];
  // Reclaim the overflow from the widest shrinkable column, one column at a time, so a single long
  // free-text field gives way before several short ones do.
  let overflow = widths.reduce((total, value) => total + value, 0) + gutters - width;
  while (overflow > 0) {
    let target = -1;
    for (let index = 1; index < widths.length; index += 1) {
      if (widths[index] > min && (target === -1 || widths[index] > widths[target])) target = index;
    }
    if (target === -1) break;
    const reduction = Math.min(overflow, widths[target] - min);
    widths[target] -= reduction;
    overflow -= reduction;
  }
  const line = (row) => columns
    .map((column, index) => padDisplay(truncateDisplay(String(row[column.key] ?? ''), widths[index]), widths[index]))
    .join('  ')
    .replace(/\s+$/, '');
  return [
    line(Object.fromEntries(columns.map((column) => [column.key, column.label]))),
    widths.map((value) => '-'.repeat(value)).join('  '),
    ...rows.map(line)
  ].join('\n');
}

/**
 * How this product re-emits YAML it has edited.
 *
 * One rule: an edit's diff should be the lines the edit touched, and nothing else. Governed
 * configuration lives in Git so it can be reviewed, and a diff nobody can read is a diff nobody
 * reads.
 *
 * `lineWidth: 0` disables folding. The default wraps at eighty columns, so a file full of prose —
 * the `question:` lines explaining an applicability policy, a long `writeOperations` list — comes
 * back re-wrapped, and adding one phase to one profile showed up in review as twelve hundred
 * changed lines.
 *
 * `flowCollectionPadding: false` is the lesser of two evils rather than a clean answer. These files
 * mix the two conventions — the portfolio template has 184 unpadded flow sequences `[a, b]` and 165
 * padded flow maps `{ a: b }` — and YAML controls both with one setting, so whichever way it goes
 * about a hundred and sixty lines are rewritten by any edit. Off preserves the larger group. The
 * clean fix is for the templates to pick one convention, which is a change to make deliberately
 * rather than as a side effect of an unrelated edit.
 */
export const YAML_OUTPUT = Object.freeze({ flowCollectionPadding: false, lineWidth: 0 });
