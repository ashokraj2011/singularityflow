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
 * directives, the reftable ref format, and an injected process runner.
 * `SINGULARITY_FLOW_GIT_FACT_CACHE=off` turns it off.
 *
 * One assumption is made: the system-wide Git configuration (for example
 * `/opt/homebrew/etc/gitconfig`, or `etc\gitconfig` under a Git for Windows installation) does not
 * change during one command. Its location is compiled into Git and cannot be found without asking
 * Git, so it is tracked only when `GIT_CONFIG_SYSTEM` names it.
 *
 * ## Windows
 *
 * Every Git process is several times dearer on Windows, so configuration answers are reused there
 * too. Git for Windows finds its files differently, and each place it may read is fingerprinted:
 * with HOME unset it takes HOMEDRIVE+HOMEPATH when that directory exists, else USERPROFILE, so
 * both are tracked; and it also reads the machine-wide `%PROGRAMDATA%\Git\config`, which is
 * tracked and checked for `include` directives like the others. Variable names are
 * case-insensitive there (`ProgramData`); two spellings with different values decline the cache.
 *
 * `check-ref-format` checks a name as a string, with no repository or file behind it, so its
 * answer (valid or not) is kept outright, except a `--branch` name that refers to the reflog.
 *
 * ## History from HEAD
 *
 * Phase commands ask which commit created a Story file, and whether it changed since, with
 * `git log -- <path>` 3 to 20 times per command, often the same question several times. Each one
 * walks the whole history, so on a 30,000-commit repository it costs about 110 ms (280 ms without a
 * commit graph), and the cost grows with the repository's age rather than the Story's. The answer is
 * fixed by the commits reachable from HEAD, and those are immutable and cannot be pruned while HEAD
 * reaches them, so it is kept like a HEAD answer: tied to HEAD, its branch ref, `packed-refs`, the
 * replacement refs and the configuration, plus the shallow boundary, grafts and alternates, which
 * change which commits Git sees. Unlike a HEAD answer it was also a proof that every commit and tree
 * it walked is present, so it is tied to the object store too: each loose-object fan-out directory
 * and the pack directory. Any object written, deleted or repacked asks Git again; a lost object is
 * refused exactly as before. Only HEAD (implicit or literal) is accepted as the starting point,
 * never another ref or an object name, and only flags whose output the commits alone decide:
 * no date limits, no relative or abbreviated formats (an abbreviated hash grows with the object
 * count), no `--follow`.
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
const REF_FORMAT_FLAGS = new Set(['--branch', '--allow-onelevel', '--no-allow-onelevel', '--refspec-pattern']);
const FANOUT = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));
const HISTORY_FLAGS = new Set(['--reverse', '--full-history', '--first-parent', '--no-merges', '-z']);
// Commit fields the commits fix: full hashes, parents, tree, subject, body, and literal or hex text.
const HISTORY_FORMAT = /^--(?:format|pretty=format):(?:%[HPTsbB%n]|%x[0-9a-fA-F]{2}|[^%])*$/u;
const CONFIG_MODIFIERS = new Set([
  '--local', '--global', '--worktree', '--null', '-z', '--name-only', '--show-origin', '--show-scope',
  '--bool', '--int', '--bool-or-int', '--path', '--type=bool', '--type=int', '--type=path', '--type=bool-or-int'
]);
// Variables that relocate the repository or inject configuration. Present: not cached. Every other
// `GIT_*` variable (an index file, no replace objects, no lazy fetch, literal pathspecs) is part of
// the key instead, so callers with different environments never share an answer.
const RELOCATING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE'];
const KEYED = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES'];

function enabled(env) {
  return String(env.SINGULARITY_FLOW_GIT_FACT_CACHE ?? '').toLowerCase() !== 'off';
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
  if (command === 'check-ref-format') {
    const names = rest.filter((arg) => !arg.startsWith('-'));
    // `--branch @{-1}` resolves through the reflog; every other name is checked as a string.
    return names.length === 1 && !names[0].includes('@{')
      && rest.filter((arg) => arg.startsWith('-')).every((arg) => REF_FORMAT_FLAGS.has(arg)) ? 'ref-format' : null;
  }
  if (command === 'log') return historyQuery(rest) ? 'history' : null;
  if (command === 'remote') {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '-v')) return 'config';
    if (rest[0] === 'get-url' && rest.slice(1, -1).every((arg) => arg === '--push' || arg === '--all')
      && rest.length >= 2 && !rest.at(-1).startsWith('-')) return 'config';
    return null;
  }
  return null;
}

/** `git log [flags] [HEAD] -- <paths>` with flags whose output only the commits decide. */
function historyQuery(rest) {
  const separator = rest.indexOf('--');
  if (separator < 0 || separator === rest.length - 1) return false;
  const before = rest.slice(0, separator);
  if (before.filter((arg) => arg === 'HEAD').length > 1) return false;
  return before.every((arg) => arg === 'HEAD' || HISTORY_FLAGS.has(arg)
    || /^--diff-filter=[ACDMRTUXB]+$/u.test(arg) || /^--max-count=\d+$/u.test(arg)
    || HISTORY_FORMAT.test(arg.replace(/^--format=/u, '--format:')));
}

function fingerprint(file, identityOnly = false) {
  try {
    const info = lstatSync(file, { bigint: true });
    // Filesystems without stable file identities, and indirections whose targets are untracked,
    // cannot prove that a prior answer is still current.
    if (info.ino === 0n || info.isSymbolicLink()) return null;
    // The .git marker's identity matters, not index lock churn. Replacement-ref directories do
    // need timestamps to invalidate atomic updates to children without changing the directory inode.
    if (info.isDirectory()) return identityOnly ? `dir:${info.ino}`
      : `dir:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
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

/** A Windows variable by any spelling: null when absent, undefined when two spellings disagree. */
function windowsVariable(env, name) {
  const values = [...new Set(Object.keys(env).filter((key) => key.toUpperCase() === name)
    .map((key) => env[key]).filter(Boolean))];
  return values.length === 1 ? values[0] : values.length ? undefined : null;
}

/**
 * The user-level configuration files Git may read. With HOME unset, Git for Windows takes
 * HOMEDRIVE+HOMEPATH when that directory exists (often a network share) and USERPROFILE otherwise;
 * both are fingerprinted, since a spare fingerprint costs one stat and a missed one a stale answer.
 */
function globalConfigFiles(env, platform) {
  if (env.GIT_CONFIG_GLOBAL) return [env.GIT_CONFIG_GLOBAL];
  const homes = env.HOME ? [env.HOME] : platform === 'win32'
    ? [env.HOMEDRIVE && env.HOMEPATH ? path.join(env.HOMEDRIVE, env.HOMEPATH) : null, env.USERPROFILE].filter(Boolean)
    : [];
  const files = [];
  for (const home of homes) {
    files.push(path.join(home, '.gitconfig'));
    if (!env.XDG_CONFIG_HOME) files.push(path.join(home, '.config', 'git', 'config'));
  }
  if (env.XDG_CONFIG_HOME) files.push(path.join(env.XDG_CONFIG_HOME, 'git', 'config'));
  return [...new Set(files)];
}

/** Machine-wide files that can be located: GIT_CONFIG_SYSTEM, and Git for Windows' ProgramData file. */
function systemConfigFiles(env, platform) {
  const files = env.GIT_CONFIG_SYSTEM ? [env.GIT_CONFIG_SYSTEM] : [];
  const programData = platform === 'win32' ? windowsVariable(env, 'PROGRAMDATA') : null;
  if (programData) files.push(path.join(programData, 'Git', 'config'));
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
function dependencies(kind, checkout, env, platform) {
  const configuration = [path.join(checkout.commonDir, 'config'),
    path.join(checkout.gitDir, 'config.worktree'), ...globalConfigFiles(env, platform),
    ...systemConfigFiles(env, platform)];
  if (configuration.some(readsIncludes)) return null;
  // A linked worktree's commondir pointer may change without its .git marker or HEAD changing.
  const topology = [checkout.marker, path.join(checkout.gitDir, 'commondir')];
  // Without GIT_NO_REPLACE_OBJECTS, a replace ref created mid-run changes what `HEAD^{tree}` peels to.
  const replacements = env.GIT_NO_REPLACE_OBJECTS === '1' ? []
    : [path.join(checkout.commonDir, 'refs', 'replace'), path.join(checkout.commonDir, 'packed-refs')];
  if (kind === 'location') {
    return [...topology, path.join(checkout.commonDir, 'shallow'), ...configuration];
  }
  if (lstatSafe(path.join(checkout.commonDir, 'reftable'))) return null;
  if (kind === 'head' || kind === 'history') {
    const head = path.join(checkout.gitDir, 'HEAD');
    // Which commits Git can see from HEAD (the shallow boundary, grafts, borrowed object stores),
    // and whether they are all still here: deleting a loose object changes its fan-out directory
    // and a repack changes the pack directory, so a lost object is read again and refused.
    const visibility = kind === 'history' ? ['shallow', path.join('info', 'grafts'), path.join('objects', 'info', 'alternates'),
      path.join('objects', 'pack'), ...FANOUT.map((name) => path.join('objects', name))]
      .map((relative) => path.join(checkout.commonDir, relative)) : [];
    let text;
    try { text = readFileSync(head, 'utf8'); } catch { return null; }
    const ref = /^ref:\s*(refs\/\S+)\s*$/u.exec(text)?.[1];
    if (!ref) return SHA.test(text.trim()) ? [...topology, head, ...configuration, ...replacements, ...visibility] : null;
    if (ref.split('/').some((part) => part === '..' || part === '')) return null;
    return [...new Set([...topology, head, ...configuration, path.join(checkout.commonDir, ...ref.split('/')),
      path.join(checkout.commonDir, 'packed-refs'), ...replacements, ...visibility])];
  }
  return [...topology, ...configuration];
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
export function gitFactRequest(args, { cwd, env = process.env, stdio = 'pipe', input, encoding = 'utf8', shell = false, injected = false, platform = process.platform }) {
  if (injected || shell || stdio !== 'pipe' || input != null || encoding !== 'utf8') return null;
  if (!enabled(env) || !Array.isArray(args)) return null;
  // Git for Windows treats environment names case-insensitively. Decline ambiguous aliases
  // instead of normalizing caller-owned authority and accidentally sharing two different reads.
  if (platform === 'win32' && Object.keys(env).some((name) =>
    /^(?:git_|home$|userprofile$|homedrive$|homepath$|xdg_config_home$)/iu.test(name)
      && name !== name.toUpperCase())) return null;
  if (platform === 'win32' && windowsVariable(env, 'PROGRAMDATA') === undefined) return null;
  if (RELOCATING.some((name) => env[name] != null && env[name] !== '')) return null;
  const kind = gitFactKind(args);
  if (!kind) return null;
  const directory = path.resolve(cwd ?? process.cwd());
  const variables = [...KEYED, ...Object.keys(env).filter((name) => name.startsWith('GIT_')).sort()]
    .map((name) => `${name}=${env[name] ?? ''}`)
    .concat(platform === 'win32' ? [`PROGRAMDATA=${windowsVariable(env, 'PROGRAMDATA') ?? ''}`] : []).join('\0');
  return { kind, key: `${platform}\0${directory}\0${variables}\0${args.join('\0')}`, directory, env, platform };
}

/** A completed answer for `request` whose files have not changed, or null. */
export function cachedGitFact(request) {
  if (!request) return null;
  const entry = entries.get(request.key);
  if (!entry) return null;
  for (const [file, expected, identityOnly] of entry.files) {
    if (fingerprint(file, identityOnly) !== expected) {
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
  if (!(status === 0 || (status === 1 && ['config', 'head', 'ref-format'].includes(request.kind))
    || (status === 2 && request.kind === 'config' && request.key.includes('\0get-url\0')))) return;
  if (request.kind === 'ref-format') {
    if (entries.size >= MAXIMUM_ENTRIES) entries.clear();
    entries.set(request.key, { files: [], status, stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '' });
    return;
  }
  const checkout = checkoutOf(request.directory);
  if (!checkout) return;
  const files = dependencies(request.kind, checkout, request.env, request.platform);
  if (!files) return;
  const recorded = [];
  for (const file of files) {
    const identityOnly = file === checkout.marker;
    const value = fingerprint(file, identityOnly);
    if (value === null) return;
    // A file that changed while Git was answering may have been read either way: do not keep it.
    if (before && before.get(file) !== undefined && before.get(file) !== value) return;
    recorded.push([file, value, identityOnly]);
  }
  if (entries.size >= MAXIMUM_ENTRIES) entries.clear();
  entries.set(request.key, { files: recorded, status, stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '' });
}

/**
 * The dependency fingerprints just before Git runs, so an answer is only kept when nothing it
 * depends on changed while Git was reading it.
 */
export function gitFactSnapshot(request) {
  if (!request || request.kind === 'ref-format') return null;
  const checkout = checkoutOf(request.directory);
  if (!checkout) return null;
  const files = dependencies(request.kind, checkout, request.env, request.platform);
  if (!files) return null;
  return new Map(files.map((file) => [file, fingerprint(file, file === checkout.marker)]));
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
