/**
 * Answers to repeated local Git questions, valid for as long as the files Git answers from. `[perf]`
 *
 * A Story start asked Git about 375 questions, and about a hundred of them were questions the same
 * process had already asked: which branch is checked out (16 times), what HEAD is (11), where the
 * repository is (14), what a remote's URL is (7) and what the local configuration says (12). Each
 * one is a synchronous process of about 8 ms that blocks everything else.
 *
 * ## Why this is safe where a plain memo is not
 *
 * `read-scope.mjs` explains why a process-wide memo is wrong: `start`, `publish` and `resume` check
 * out branches and write configuration mid-run, and a memo hands them the answer from before their
 * own write. This cache never trusts an answer on its own. Each entry records the files that answer
 * comes from (`HEAD`, the branch's ref file, `packed-refs`, the configuration files, the `.git`
 * marker), and every lookup checks them again with `lstat`. Git replaces those files through a lock
 * file and a rename, so any change, by this process, a child, another program or a test, gives them
 * a new inode, size or timestamp and the entry is not used.
 *
 * Only answers Git completed are kept; an error, a signal or a timeout is never cached.
 *
 * Two things are deliberately not cached. Branch, tag and remote-tracking refs move under a running
 * command when another program fetches, and the callers that read them are deciding what to
 * publish. Object reads (`show <sha>:path`, `ls-tree <sha>`) have content that never changes, but
 * a read is also a proof that the object is present here, under this environment, now: destructive
 * readiness checks depend on that proof, and a pruned object or an alternate object store would make
 * a remembered answer a false one.
 *
 * ## When it does not apply
 *
 * Anything this module cannot prove is left to Git: a global option before the subcommand, a Git
 * environment that relocates the repository, standard input, a configuration file with `include`
 * directives, the reftable ref format, an injected process runner, and Windows hosts.
 * `SINGULARITY_FLOW_GIT_FACT_CACHE=off` turns it off.
 *
 * One assumption is made: the system-wide Git configuration (for example
 * `/opt/homebrew/etc/gitconfig`) does not change during one command. Its location is compiled into
 * Git and cannot be found without asking Git, so it is tracked only when `GIT_CONFIG_SYSTEM` names it.
 *
 * This module imports nothing but Node, so `util.mjs` can use it without growing any command's
 * static import graph.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAXIMUM_ENTRIES = 4_096;
// Answers larger than this are rare and cheap to ask for again relative to holding them.
const MAXIMUM_ANSWER_BYTES = 1024 * 1024;
const entries = new Map();
let hits = 0;

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const LOCATION_FLAGS = new Set([
  '--show-toplevel', '--absolute-git-dir', '--git-dir', '--git-common-dir', '--show-object-format',
  '--is-bare-repository', '--is-inside-work-tree', '--is-shallow-repository', '--show-prefix',
  '--show-cdup', '--path-format=absolute', '--path-format=relative'
]);
const HEAD_QUERIES = new Set([
  'branch\0--show-current',
  'rev-parse\0HEAD', 'rev-parse\0--verify\0HEAD', 'rev-parse\0--verify\0--quiet\0HEAD',
  'rev-parse\0--verify\0-q\0HEAD', 'rev-parse\0--abbrev-ref\0HEAD', 'rev-parse\0--symbolic-full-name\0HEAD',
  'symbolic-ref\0HEAD', 'symbolic-ref\0-q\0HEAD', 'symbolic-ref\0--quiet\0HEAD', 'symbolic-ref\0--short\0HEAD',
  'symbolic-ref\0-q\0--short\0HEAD', 'symbolic-ref\0--quiet\0--short\0HEAD',
  ...['HEAD^{tree}', 'HEAD^{commit}'].flatMap((name) => [
    `rev-parse\0${name}`, `rev-parse\0--verify\0${name}`, `rev-parse\0--verify\0--quiet\0${name}`, `rev-parse\0--verify\0-q\0${name}`
  ])
]);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '-l', '--list']);
const CONFIG_MODIFIERS = new Set([
  '--local', '--global', '--worktree', '--null', '-z', '--name-only', '--show-origin', '--show-scope',
  '--bool', '--int', '--bool-or-int', '--path', '--type=bool', '--type=int', '--type=path', '--type=bool-or-int'
]);
// Variables that relocate the repository or inject configuration. Present: not cached. Every other
// `GIT_*` variable (an index file, no replace objects, no lazy fetch, literal pathspecs) is part of
// the key instead, so callers with different environments never share an answer.
const RELOCATING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE'];
const KEYED = ['HOME', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES'];

function enabled(env) {
  return process.platform !== 'win32' && String(env.SINGULARITY_FLOW_GIT_FACT_CACHE ?? '').toLowerCase() !== 'off';
}

/** What kind of answer `args` asks for, or null when it is not one this module can vouch for. */
export function gitFactKind(args) {
  const [command, ...rest] = args;
  if (typeof command !== 'string' || command.startsWith('-')) return null;
  const joined = args.join('\0');
  if (HEAD_QUERIES.has(joined)) return 'head';
  if (command === 'rev-parse' && rest.length && rest.every((arg) => LOCATION_FLAGS.has(arg))) return 'location';
  if (command === 'config') {
    if (!rest.some((arg) => CONFIG_READS.has(arg))) return null;
    const flags = rest.filter((arg) => arg.startsWith('-'));
    return flags.every((arg) => CONFIG_READS.has(arg) || CONFIG_MODIFIERS.has(arg)) ? 'config' : null;
  }
  if (command === 'remote') {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '-v')) return 'config';
    if (rest[0] === 'get-url' && rest.slice(1, -1).every((arg) => arg === '--push' || arg === '--all')
      && rest.length >= 2 && !rest.at(-1).startsWith('-')) return 'config';
    return null;
  }
  return null;
}

function fingerprint(file) {
  try {
    const info = lstatSync(file, { bigint: true });
    // A main checkout's `.git` directory gains and loses lock files on every index write; only its
    // identity matters here. Files Git answers from are compared completely.
    if (info.isDirectory()) return `dir:${info.ino}`;
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'absent' : null;
  }
}

/** The checkout `cwd` is in, and its private and shared Git directories, from the filesystem. */
function checkoutOf(cwd) {
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const marker = path.join(directory, '.git');
    let info = null;
    try { info = lstatSync(marker); } catch { info = null; }
    if (info?.isDirectory()) return { root: directory, marker, gitDir: marker, commonDir: marker };
    if (info?.isFile()) {
      if (info.size > 4_096) return null;
      let pointer;
      try { pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(readFileSync(marker, 'utf8'))?.[1]; } catch { return null; }
      if (!pointer) return null;
      const gitDir = path.resolve(directory, pointer);
      let common = null;
      try { common = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim(); } catch (error) {
        if (error?.code !== 'ENOENT') return null;
      }
      return { root: directory, marker, gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir };
    }
    if (info) return null;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

function globalConfigFiles(env) {
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const files = [];
  if (env.HOME) files.push(path.join(env.HOME, '.gitconfig'));
  const xdg = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null);
  if (xdg) files.push(path.join(xdg, 'git', 'config'));
  return files;
}

function readsIncludes(file) {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) return false;
    if (info.size > 1024 * 1024) return true;
    return /^\s*\[\s*include/imu.test(readFileSync(file, 'utf8'));
  } catch { return false; }
}

/** The files `kind` answers from, or null when the answer cannot be tied to files. */
function dependencies(kind, checkout, env) {
  // Without GIT_NO_REPLACE_OBJECTS, a replace ref created mid-run changes what `HEAD^{tree}` peels to.
  const replacements = env.GIT_NO_REPLACE_OBJECTS === '1' ? []
    : [path.join(checkout.commonDir, 'refs', 'replace'), path.join(checkout.commonDir, 'packed-refs')];
  if (kind === 'location') {
    return [checkout.marker, path.join(checkout.commonDir, 'shallow'), path.join(checkout.commonDir, 'config')];
  }
  if (lstatSafe(path.join(checkout.commonDir, 'reftable'))) return null;
  if (kind === 'head') {
    const head = path.join(checkout.gitDir, 'HEAD');
    let text;
    try { text = readFileSync(head, 'utf8'); } catch { return null; }
    const ref = /^ref:\s*(refs\/\S+)\s*$/u.exec(text)?.[1];
    if (!ref) return SHA.test(text.trim()) ? [checkout.marker, head, ...replacements] : null;
    if (ref.split('/').some((part) => part === '..' || part === '')) return null;
    return [...new Set([checkout.marker, head, path.join(checkout.commonDir, ...ref.split('/')),
      path.join(checkout.commonDir, 'packed-refs'), ...replacements])];
  }
  const files = [
    path.join(checkout.commonDir, 'config'),
    path.join(checkout.gitDir, 'config.worktree'),
    ...globalConfigFiles(env),
    ...(env.GIT_CONFIG_SYSTEM ? [env.GIT_CONFIG_SYSTEM] : [])
  ];
  if (files.some(readsIncludes)) return null;
  return [checkout.marker, ...files];
}

function lstatSafe(file) {
  try { return lstatSync(file); } catch { return null; }
}

/**
 * The cache key for one `run('git', ...)` call, or null when it must go to Git.
 *
 * Every condition that could change Git's answer without changing the files above is either part
 * of the key (the arguments, the directory, and the variables that choose configuration files) or
 * a reason not to cache at all.
 */
export function gitFactRequest(args, { cwd, env = process.env, stdio = 'pipe', input, encoding = 'utf8', shell = false, injected = false }) {
  if (injected || shell || stdio !== 'pipe' || input != null || encoding !== 'utf8') return null;
  if (!enabled(env) || !Array.isArray(args)) return null;
  if (RELOCATING.some((name) => env[name] != null && env[name] !== '')) return null;
  const kind = gitFactKind(args);
  if (!kind) return null;
  const directory = path.resolve(cwd ?? process.cwd());
  const variables = [...KEYED, ...Object.keys(env).filter((name) => name.startsWith('GIT_')).sort()]
    .map((name) => `${name}=${env[name] ?? ''}`).join('\0');
  return { kind, key: `${directory}\0${variables}\0${args.join('\0')}`, directory, env };
}

/** A completed answer for `request` whose files have not changed, or null. */
export function cachedGitFact(request) {
  if (!request) return null;
  const entry = entries.get(request.key);
  if (!entry) return null;
  for (const [file, expected] of entry.files) {
    if (fingerprint(file) !== expected) {
      entries.delete(request.key);
      return null;
    }
  }
  hits += 1;
  return { status: entry.status, stdout: entry.stdout, stderr: entry.stderr, error: undefined, signal: null };
}

/** Keep Git's answer for `request` if it completed and can be tied to files that prove it current. */
export function rememberGitFact(request, result, { before = null } = {}) {
  if (!request || !result || result.error || result.signal || typeof result.stdout !== 'string') return;
  if (result.stdout.length > MAXIMUM_ANSWER_BYTES) return;
  const status = result.status;
  // Only answers Git gave: success, or the documented "nothing here" of a configuration or HEAD read.
  if (!(status === 0 || (status === 1 && (request.kind === 'config' || request.kind === 'head'))
    || (status === 2 && request.kind === 'config' && request.key.includes('\0get-url\0')))) return;
  const checkout = checkoutOf(request.directory);
  if (!checkout) return;
  const files = dependencies(request.kind, checkout, request.env);
  if (!files) return;
  const recorded = [];
  for (const file of files) {
    const value = fingerprint(file);
    if (value === null) return;
    // A file that changed while Git was answering may have been read either way: do not keep it.
    if (before && before.get(file) !== undefined && before.get(file) !== value) return;
    recorded.push([file, value]);
  }
  if (entries.size >= MAXIMUM_ENTRIES) entries.clear();
  entries.set(request.key, { files: recorded, status, stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '' });
}

/**
 * The dependency fingerprints just before Git runs, so an answer is only kept when nothing it
 * depends on changed while Git was reading it.
 */
export function gitFactSnapshot(request) {
  if (!request) return null;
  const checkout = checkoutOf(request.directory);
  if (!checkout) return null;
  const files = dependencies(request.kind, checkout, request.env);
  if (!files) return null;
  return new Map(files.map((file) => [file, fingerprint(file)]));
}

/** How many answers came from this cache in this process, for timing counters and tests. */
export function gitFactCacheHits() {
  return hits;
}

/** Forget every answer. Tests use it; nothing in the product needs to. */
export function clearGitFactCache() {
  entries.clear();
  hits = 0;
}
