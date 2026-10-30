/**
 * Exact-object Git plumbing for capability configuration changes.
 *
 * A capability proposal is re-applied onto the current authority value by value
 * (src/capability-value-replay.mjs), never by a textual Git merge. This module only reads the exact
 * objects that decision needs and writes the resulting blobs, tree and commit: `diff --raw` between
 * two commits, one blob batch, `hash-object`, a temporary index, `write-tree` and `commit-tree`.
 * It never runs `merge`, `merge-tree`, `clone` or a branch checkout, and it never writes the index
 * of the repository it reads from.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { run, SingularityFlowError } from './util.mjs';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MODE = /^(?:000000|100644|100755|120000|160000)$/u;
const MAXIMUM_DIFF_BYTES = 16 * 1024 * 1024;
const MAXIMUM_BLOB_BYTES = 32 * 1024 * 1024;

function fail(message, code = 'CAPABILITY_CONFIGURATION_OBJECTS_UNAVAILABLE', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function git(root, args, env, extra = {}) {
  return run('git', args, { cwd: root, env, maxBuffer: MAXIMUM_DIFF_BYTES, ...extra });
}

function objectId(value, label) {
  const text = String(value ?? '').trim();
  if (!OBJECT_ID.test(text)) fail(`${label} is not an exact Git object.`);
  return text;
}

/**
 * Every path whose blob or mode differs between two exact commits, with both sides' modes and
 * object IDs. `null` stands for an absent side. Renames are two paths, never one moved record.
 */
export function configurationTreeChanges(root, from, to, { env = process.env } = {}) {
  const output = git(root, [
    'diff', '--raw', '--no-renames', '--no-ext-diff', '--no-abbrev', '-z',
    objectId(from, 'Configuration base'), objectId(to, 'Configuration revision'), '--'
  ], env).stdout;
  const fields = output.split('\0');
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index];
    const relative = fields[index + 1];
    if (!header && !relative) break;
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMT])$/u.exec(header);
    if (!match || !relative || !MODE.test(match[1]) || !MODE.test(match[2])) {
      fail('Git produced an unreadable configuration change list.');
    }
    const side = (mode, oid) => mode === '000000' ? null : { mode, oid: objectId(oid, relative) };
    changes.push({ path: relative, before: side(match[1], match[3]), after: side(match[2], match[4]) });
  }
  return changes;
}

/** Exact blob bytes, read locally in one batch; a missing object is never fetched implicitly. */
export function readConfigurationObjects(root, objectIds, { env = process.env } = {}) {
  return readLocalGitBlobs(root, objectIds, {
    env, maximumBytes: MAXIMUM_BLOB_BYTES, maximumObjectBytes: MAXIMUM_BLOB_BYTES,
    code: 'CAPABILITY_CONFIGURATION_OBJECTS_UNAVAILABLE', label: 'Capability configuration objects'
  });
}

/**
 * The tree of `base` with each change applied: `{ path, mode, oid }` keeps an existing object,
 * `{ path, mode, bytes }` writes a new blob, `{ path, mode: null }` removes the path. The index is
 * temporary and private; the repository's own index and working tree are untouched.
 */
export function configurationCandidateTree(root, base, changes, { env = process.env } = {}) {
  const zero = '0'.repeat(objectId(base, 'Configuration base').length);
  const records = changes.map((change) => {
    if (change.mode == null) return `0 ${zero}\t${change.path}`;
    if (!MODE.test(change.mode) || change.mode === '000000') fail(`Configuration change '${change.path}' has no valid mode.`);
    const oid = change.bytes != null
      ? objectId(git(root, ['hash-object', '-w', '--stdin'], env, { input: change.bytes }).stdout, change.path)
      : objectId(change.oid, change.path);
    return `${change.mode} ${oid}\t${change.path}`;
  });
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sflow-configuration-index-'));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: path.join(directory, 'index') };
    git(root, ['read-tree', base], indexEnv);
    if (records.length) {
      git(root, ['update-index', '-z', '--index-info'], indexEnv, { input: `${records.join('\0')}\0` });
    }
    return objectId(git(root, ['write-tree'], indexEnv).stdout, 'Configuration candidate tree');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The exact tree of one exact commit. */
export function configurationCommitTree(root, commit, { env = process.env } = {}) {
  return objectId(git(root, ['rev-parse', '--verify', `${objectId(commit, 'Configuration commit')}^{tree}`], env).stdout,
    'Configuration tree');
}

/** One commit object for an exact tree and exact parents; no hook, merge or index is involved. */
export function commitConfigurationTree(root, {
  tree, parents, message, configArgs = [], sign = false, env = process.env, allowFailure = false
}) {
  const result = git(root, [
    ...configArgs, 'commit-tree', objectId(tree, 'Configuration tree'),
    ...parents.flatMap((parent) => ['-p', objectId(parent, 'Configuration parent')]),
    ...(sign ? ['-S'] : []), '-m', message
  ], env, { allowFailure });
  if (allowFailure && result.status !== 0) return null;
  return objectId(result.stdout, 'Configuration commit');
}

/** Move one ref by compare-and-swap; `expected` null means the ref must not exist. */
export function moveConfigurationRef(root, ref, commit, expected, { env = process.env } = {}) {
  git(root, ['update-ref', ref, objectId(commit, 'Configuration commit'),
    ...(expected === undefined ? [] : [expected ?? '0'.repeat(commit.length)])], env);
}

/**
 * Make an existing disposable checkout show exactly `treeish` (index and files), or show HEAD
 * again. Used only for validating a value-level candidate before its commit exists.
 */
export function showConfigurationTree(root, treeish, { env = process.env } = {}) {
  git(root, ['read-tree', '--reset', '-u', treeish], env);
}

/**
 * A private object store for one capability edit: no clone, no remote-tracking negotiation and no
 * application repository. `remote` is the invocation's frozen transport alias; the authority
 * commit is transferred by the caller's remote boundary.
 */
export function initializeConfigurationObjectStore(root, { remote, objectFormat = 'sha1', env = process.env }) {
  git(root, ['init', '--quiet', '--template=', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []), '--', root], env);
  git(root, ['remote', 'add', 'origin', remote], env);
}

/**
 * Project one exact authority commit into the store's own directory: `branch` names it, the index
 * is read from its tree, and its files are written from exact blobs. Nothing is cloned and no
 * branch is checked out; the directory holds only the authority's configuration files. Returns
 * the exact commit projected.
 */
export function projectConfigurationCommit(root, revision, { branch, env = process.env }) {
  const exact = objectId(git(root, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], env).stdout,
    'Configuration authority');
  git(root, ['update-ref', `refs/heads/${branch}`, exact], env);
  git(root, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], env);
  git(root, ['read-tree', exact], env);
  git(root, ['checkout-index', '--all', '--force', '--quiet', '-u'], env);
  return exact;
}

/**
 * The proposal commit for a projected edit: the staged tree on `baseCommit`, named by `branch`.
 * Same tree, parent, author and message as `git switch -c` followed by `git commit -m`.
 */
export function commitProjectedConfiguration(root, { baseCommit, branch, message, author, env = process.env }) {
  const tree = objectId(git(root, ['write-tree'], env).stdout, 'Configuration proposal tree');
  const commit = commitConfigurationTree(root, {
    tree, parents: [baseCommit], message, env,
    configArgs: ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`]
  });
  git(root, ['update-ref', `refs/heads/${branch}`, commit, '0'.repeat(commit.length)], env);
  git(root, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], env);
  return commit;
}
