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
 * Branch, tag and remote-tracking refs are deliberately not cached: they move under a running
 * command when another program fetches, and the callers that read them are deciding what to
 * publish.
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
 * change within 15 minutes of an answer. Its location is compiled into Git and cannot be found
 * without asking Git, so it is tracked only when `GIT_CONFIG_SYSTEM` names it, and no answer is
 * used more than 15 minutes after it was recorded. The executable that answered is part of the key
 * and fingerprinted, so another or an upgraded Git asks again.
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
 * ## The index
 *
 * `ls-files` in its cached mode (`--stage`, `-v`, `--unmerged`, plain) lists the index and
 * nothing else; a publish read the same 40,000-entry index up to 12 times. Git rewrites the index
 * only through a lock file and a rename, so an unchanged `.git/index` identity (with the
 * configuration) proves the listing unchanged. Listings that read the working tree (`--others`,
 * `--modified`, `--deleted`) always go to Git, and so does any read of another index file
 * (`GIT_INDEX_FILE`).
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
 * ## Objects
 *
 * A single object read by its full ID (`show <ID>:<path>`, a peeled `rev-parse`, `cat-file`
 * without standard input, `ls-tree`) has content that never changes, but each read was also the
 * proof that the object is present here now, which destructive readiness checks rely on. So it is
 * tied to the object store, like history: one fingerprint over every loose-object fan-out directory
 * and the pack directory. A deleted, pruned or repacked object is asked of Git again and refused as
 * before. `merge-base --is-ancestor` between two IDs is kept the same way, "not an ancestor"
 * included. A borrowed (alternates) or relocated object store is not fingerprinted, so those answers
 * go to Git, as does `show <ID>`, whose commit output depends on diff settings and attributes.
 *
 * ## Across commands in a session
 *
 * Every command is a new process. The CLI installs `git-fact-store.mjs`, which loads a
 * repository's answers the first time a command asks about it and writes new ones back when the
 * process exits, so every command in a session starts with what earlier commands proved. A stored
 * answer is checked exactly like a fresh one before it is used.
 *
 * This module imports nothing but Node, so `util.mjs` can use it without growing any command's
 * static import graph.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAXIMUM_ENTRIES = 4_096;
// Answers larger than this are rare and cheap to ask for again relative to holding them.
const MAXIMUM_ANSWER_BYTES = 1024 * 1024;
// No answer outlives this. It bounds the one input that cannot be fingerprinted: the machine-wide
// Git configuration, whose path is compiled into Git.
export const GIT_FACT_TTL_MS = 15 * 60 * 1000;
const entries = new Map();
let hits = 0;
let storeHits = 0;
// The session store (git-fact-store.mjs), when the CLI installed one.
let persistence = null;
// Fingerprint modes: every stat field, the identity alone (the .git marker), or the object store.
const FULL = 0;
const IDENTITY = 1;
const OBJECT_STORE = 2;

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
// `<object ID>:<path>` from the tree's root; `./` and `../` would make it depend on the directory.
const OBJECT_PATH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?:(?!\.{1,2}\/)(?:.+)$/u;
const PEELED = /^[0-9a-f]{40}(?:[0-9a-f]{24})?\^\{(?:tree|commit|blob)\}$/u;
const LS_TREE_FLAGS = new Set(['-r', '-z', '-d', '-t', '-l', '--long', '--name-only', '--name-status', '--object-only', '--full-tree', '--full-name']);
const LS_TREE_FORMAT = /^--format=(?:%\((?:objectmode|objecttype|objectname|objectsize(?::padded)?|path)\)|%x[0-9a-fA-F]{2}|[^%])*$/u;
// Cached-mode listing flags: the index alone answers them.
const INDEX_FLAGS = new Set(['--stage', '-s', '-z', '-v', '--unmerged', '-u', '--cached', '-c', '--full-name']);
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
// Another object directory (a scratch store, a quarantine) is not the one fingerprinted below.
const RELOCATING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_REPLACE_REF_BASE', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH'];
// DEVELOPER_DIR picks which Git Apple's /usr/bin/git shim runs.
const KEYED = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'LANG', 'LC_ALL', 'LC_MESSAGES', 'DEVELOPER_DIR'];

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
  if (command === 'merge-base') {
    return rest.length === 3 && rest[0] === '--is-ancestor' && SHA.test(rest[1]) && SHA.test(rest[2]) ? 'ancestry' : null;
  }
  if (['show', 'rev-parse', 'cat-file', 'ls-tree'].includes(command)) return objectQuery(command, rest) ? 'object' : null;
  if (command === 'ls-files') {
    const separator = rest.indexOf('--');
    return (separator < 0 ? rest : rest.slice(0, separator)).every((arg) => INDEX_FLAGS.has(arg)) ? 'index' : null;
  }
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

/**
 * A single object read by its full ID: `show <ID>:<path>`, a peeled `rev-parse`, `cat-file`
 * without standard input, or `ls-tree` with fields the objects fix. `show <ID>` is left to Git:
 * a commit's output depends on diff configuration, attributes and signatures.
 */
function objectQuery(command, rest) {
  if (command === 'show') return rest.length === 1 && OBJECT_PATH.test(rest[0]);
  if (command === 'rev-parse') {
    return rest.length >= 1 && rest.slice(0, -1).every((arg) => ['--verify', '--quiet', '-q'].includes(arg))
      && /^[0-9a-f]{40}(?:[0-9a-f]{24})?\^\{(?:tree|commit)\}$/u.test(rest.at(-1));
  }
  if (command === 'cat-file') {
    return rest.length === 2 && ['-t', '-s', '-e', '-p'].includes(rest[0])
      && (SHA.test(rest[1]) || PEELED.test(rest[1]) || OBJECT_PATH.test(rest[1]));
  }
  const separator = rest.indexOf('--');
  const before = separator < 0 ? rest : rest.slice(0, separator);
  const objects = before.filter((arg) => !arg.startsWith('-'));
  return objects.length === 1 && SHA.test(objects[0]) && before.filter((arg) => arg.startsWith('-'))
    .every((arg) => LS_TREE_FLAGS.has(arg) || /^-[rzdtl]+$/u.test(arg) || LS_TREE_FORMAT.test(arg));
}

/** The file's identity and timestamps; with OBJECT_STORE, those of every loose fan-out and the pack directory. */
function fingerprint(file, mode = FULL) {
  if (mode === OBJECT_STORE) return objectStoreFingerprint(file);
  try {
    const info = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!info) return 'absent';
    // Filesystems without stable file identities, and indirections whose targets are untracked,
    // cannot prove that a prior answer is still current.
    if (info.ino === 0n || info.isSymbolicLink()) return null;
    // The .git marker's identity matters, not index lock churn. Replacement-ref directories do
    // need timestamps to invalidate atomic updates to children without changing the directory inode.
    if (info.isDirectory()) return mode === IDENTITY ? `dir:${info.ino}`
      : `dir:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    return error?.code === 'ENOTDIR' ? 'absent' : null;
  }
}

/**
 * One value for the whole object store: deleting a loose object changes its fan-out directory and
 * a repack changes the pack directory, so an answer that proved objects present is read again.
 * The newest timestamp leads, so the session store can tell a racy (too recent) value apart.
 */
function objectStoreFingerprint(objects) {
  const digest = createHash('sha256');
  let newest = 0n;
  for (const name of [...FANOUT, 'pack']) {
    const value = fingerprint(path.join(objects, name));
    if (value === null) return null;
    digest.update(`${name}=${value}\n`);
    for (const stamp of value.split(':').slice(-2)) if (/^\d+$/u.test(stamp) && BigInt(stamp) > newest) newest = BigInt(stamp);
  }
  return `objects:${newest}:${digest.digest('hex')}`;
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

/**
 * The files `kind` answers from, each with its fingerprint mode, or null when the answer cannot be
 * tied to files.
 */
function dependencies(kind, checkout, env, platform, executable = null) {
  const configuration = [path.join(checkout.commonDir, 'config'),
    path.join(checkout.gitDir, 'config.worktree'), ...globalConfigFiles(env, platform),
    ...systemConfigFiles(env, platform)];
  if (configuration.some(readsIncludes)) return null;
  // A linked worktree's commondir pointer may change without its .git marker or HEAD changing.
  const topology = [checkout.marker, path.join(checkout.gitDir, 'commondir')];
  // Without GIT_NO_REPLACE_OBJECTS, a replace ref created mid-run changes what an object ID peels to.
  const replacements = env.GIT_NO_REPLACE_OBJECTS === '1' ? []
    : [path.join(checkout.commonDir, 'refs', 'replace'), path.join(checkout.commonDir, 'packed-refs')];
  // The Git that answers: another or an upgraded executable is asked again.
  const program = typeof executable === 'string' && path.isAbsolute(executable) ? [executable] : [];
  const files = (list) => [...new Set(list)].map((file) => [file, file === checkout.marker ? IDENTITY : FULL]);
  if (kind === 'location') {
    return files([...topology, path.join(checkout.commonDir, 'shallow'), ...configuration, ...program]);
  }
  if (kind === 'index') return files([...topology, path.join(checkout.gitDir, 'index'), ...configuration, ...program]);
  if (lstatSafe(path.join(checkout.commonDir, 'reftable'))) return null;
  // Which commits Git can see (the shallow boundary, grafts) and whether every object read is
  // still here (the object store). A borrowed object store is not fingerprinted, so its objects
  // cannot be proven present and those answers go to Git.
  let visibility = [];
  if (['history', 'object', 'ancestry'].includes(kind)) {
    if (lstatSafe(path.join(checkout.commonDir, 'objects', 'info', 'alternates'))) return null;
    visibility = [...files([path.join(checkout.commonDir, 'shallow'), path.join(checkout.commonDir, 'info', 'grafts')]),
      [path.join(checkout.commonDir, 'objects'), OBJECT_STORE]];
  }
  if (kind === 'object' || kind === 'ancestry') {
    return [...files([...topology, ...configuration, ...replacements, ...program]), ...visibility];
  }
  if (kind === 'head' || kind === 'history') {
    const head = path.join(checkout.gitDir, 'HEAD');
    let text;
    try { text = readFileSync(head, 'utf8'); } catch { return null; }
    const ref = /^ref:\s*(refs\/\S+)\s*$/u.exec(text)?.[1];
    if (!ref) return SHA.test(text.trim()) ? [...files([...topology, head, ...configuration, ...replacements, ...program]), ...visibility] : null;
    if (ref.split('/').some((part) => part === '..' || part === '')) return null;
    return [...files([...topology, head, ...configuration, path.join(checkout.commonDir, ...ref.split('/')),
      path.join(checkout.commonDir, 'packed-refs'), ...replacements, ...program]), ...visibility];
  }
  return files([...topology, ...configuration, ...program]);
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
export function gitFactRequest(args, { cwd, env = process.env, stdio = 'pipe', input, encoding = 'utf8', shell = false, injected = false, platform = process.platform, executable = null }) {
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
  // Another index file is somebody's scratch staging area; only the checkout's own index is tracked.
  if (kind === 'index' && env.GIT_INDEX_FILE) return null;
  const directory = path.resolve(cwd ?? process.cwd());
  const variables = [...KEYED, ...Object.keys(env).filter((name) => name.startsWith('GIT_')).sort()]
    .map((name) => `${name}=${env[name] ?? ''}`)
    .concat(platform === 'win32' ? [`PROGRAMDATA=${windowsVariable(env, 'PROGRAMDATA') ?? ''}`] : []).join('\0');
  return { kind, key: `${platform}\0${executable ?? ''}\0${directory}\0${variables}\0${args.join('\0')}`, directory, env, platform, executable };
}

/**
 * A completed answer for `request` whose files have not changed, or null. An answer the session
 * store kept is adopted on first use and checked exactly like one this process recorded.
 */
export function cachedGitFact(request) {
  if (!request) return null;
  let entry = entries.get(request.key);
  let fromStore = false;
  if (!entry && persistence) {
    entry = persistence.lookup(request) ?? undefined;
    if (entry) { fromStore = true; entries.set(request.key, entry); }
  }
  if (!entry) return null;
  const age = Date.now() - entry.recordedAt;
  if (!(age <= GIT_FACT_TTL_MS && age >= -60_000)) {
    entries.delete(request.key);
    return null;
  }
  for (const [file, expected, mode] of entry.files) {
    if (fingerprint(file, mode) !== expected) {
      entries.delete(request.key);
      return null;
    }
  }
  hits += 1;
  if (fromStore) storeHits += 1;
  return { status: entry.status, stdout: entry.stdout, stderr: entry.stderr, error: undefined, signal: null };
}

function keep(request, entry) {
  if (entries.size >= MAXIMUM_ENTRIES) entries.clear();
  entries.set(request.key, entry);
  persistence?.record(request, entry);
}

/** Keep Git's answer for `request` if it completed and can be tied to files that prove it current. */
export function rememberGitFact(request, result, { before = null } = {}) {
  if (!request || !result || result.error || result.signal || typeof result.stdout !== 'string') return;
  if (result.stdout.length > MAXIMUM_ANSWER_BYTES) return;
  const status = result.status;
  // Only answers Git gave: success, or the documented "nothing here" of a configuration, HEAD or
  // ancestry read.
  if (!(status === 0 || (status === 1 && ['config', 'head', 'ref-format', 'ancestry'].includes(request.kind))
    || (status === 2 && request.kind === 'config' && request.key.includes('\0get-url\0')))) return;
  const answer = { status, stdout: result.stdout, stderr: typeof result.stderr === 'string' ? result.stderr : '', recordedAt: Date.now() };
  if (request.kind === 'ref-format') return keep(request, { files: [], ...answer });
  const checkout = checkoutOf(request.directory);
  if (!checkout) return;
  const files = dependencies(request.kind, checkout, request.env, request.platform, request.executable);
  if (!files) return;
  const recorded = [];
  for (const [file, mode] of files) {
    // The value from just before Git ran: anything changed since then makes the next lookup ask again.
    const value = before?.has(file) ? before.get(file) : fingerprint(file, mode);
    if (value === null) return;
    recorded.push([file, value, mode]);
  }
  keep(request, { files: recorded, ...answer });
}

/** The dependency fingerprints just before Git runs; the answer is tied to these values. */
export function gitFactSnapshot(request) {
  if (!request || request.kind === 'ref-format') return null;
  const checkout = checkoutOf(request.directory);
  if (!checkout) return null;
  const files = dependencies(request.kind, checkout, request.env, request.platform, request.executable);
  if (!files) return null;
  return new Map(files.map(([file, mode]) => [file, fingerprint(file, mode)]));
}

/** Install the session store (git-fact-store.mjs), or remove it with null. */
export function attachGitFactPersistence(hooks) {
  persistence = hooks ?? null;
}

/** The checkout a directory is in, and the fingerprint of one dependency, for the session store. */
export { checkoutOf as gitFactCheckout, fingerprint as gitFactFingerprint };

/** How many answers in this process came from the session store. */
export function gitFactStoreHits() {
  return storeHits;
}

/** How many answers came from this cache in this process, for timing counters and tests. */
export function gitFactCacheHits() {
  return hits;
}

/** Forget every answer. Tests use it; nothing in the product needs to. */
export function clearGitFactCache() {
  entries.clear();
  hits = 0;
  storeHits = 0;
  persistence?.clear?.();
}
