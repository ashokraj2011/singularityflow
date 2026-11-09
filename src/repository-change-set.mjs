import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError, posix, run, secureRepositoryPath } from './util.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import {repositoryChangeSetDigest,repositoryChangeEntryOrder as entryOrder,
  withRepositoryChangeEntryIdentity as withEntryIdentity} from './engine-compatibility/node-source-policy.mjs';
export {compareRepositoryIdentity,repositoryChangeSetDigest,verifyRepositoryChangeSetIntegrity} from './engine-compatibility/node-source-policy.mjs';

const STATUS = Object.freeze({
  A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed',
  T: 'type-changed', U: 'unmerged', X: 'unknown', B: 'broken'
});

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function git(root, args, { allowFailure = false, env = process.env } = {}) {
  const result = run('git', args, { cwd: root, allowFailure, env });
  if (!allowFailure && result.status !== 0) {
    throw new SingularityFlowError((result.stderr || result.stdout).trim() || `git ${args.join(' ')} failed`);
  }
  return result;
}

export function repositoryCaseInsensitivePaths(root) {
  const value = git(root, ['config', '--bool', '--get', 'core.ignorecase'], { allowFailure: true });
  return value.status === 0 && value.stdout.trim() === 'true';
}

function normalizeRepositoryPath(value) {
  const normalized = posix(String(value ?? '')).replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new SingularityFlowError(`Git returned an invalid repository path '${value}'.`, { code: 'CHANGE_SET_PATH_INVALID' });
  }
  return normalized;
}

/** Parse `git diff --raw -z`; rename/copy records deliberately retain both endpoints. */
export function parseRawDiff(value) {
  const fields = nullFields(value);
  const entries = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = header.match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d+)?$/i);
    if (!match) throw new SingularityFlowError(`Unable to parse Git raw diff record '${header}'.`, { code: 'CHANGE_SET_PARSE_FAILED' });
    const [, oldMode, newMode, oldObject, newObject, letter, score] = match;
    const firstPath = normalizeRepositoryPath(fields[index++]);
    const secondPath = ['R', 'C'].includes(letter.toUpperCase())
      ? normalizeRepositoryPath(fields[index++])
      : null;
    entries.push({
      status: STATUS[letter.toUpperCase()] ?? 'unknown',
      similarity: score == null ? null : Number(score),
      oldPath: letter.toUpperCase() === 'A' ? null : firstPath,
      newPath: letter.toUpperCase() === 'D' ? null : (secondPath ?? firstPath),
      oldMode,
      newMode,
      oldObject: /^0+$/.test(oldObject) ? null : oldObject,
      newObject: /^0+$/.test(newObject) ? null : newObject
    });
  }
  return entries;
}

function nullFields(value) {
  return value.split('\0').filter((field) => field !== '');
}

async function currentContent(root, relative) {
  if (!relative) return null;
  const secured = await secureRepositoryPath(root, relative, {
    label: 'Repository change-set path',
    allowFinalSymlink: true
  });
  const absolute = secured.absolute;
  try {
    const info = secured.entry ?? await lstat(absolute);
    if (info.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolute));
      return { kind: 'symlink', sha256: sha256(target), bytes: target.length };
    }
    if (!info.isFile()) return { kind: 'non-regular', sha256: null, bytes: info.size };
    const bytes = await readFile(absolute);
    return { kind: 'regular-file', sha256: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', sha256: null, bytes: 0 };
    throw error;
  }
}

function untrackedMode(info) {
  if (info.isSymbolicLink()) return '120000';
  return (info.mode & 0o111) ? '100755' : '100644';
}

async function untrackedEntries(root) {
  const names = nullFields(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout);
  return Promise.all(names.map(async (name) => {
    const relative = normalizeRepositoryPath(name);
    const secured = await secureRepositoryPath(root, relative, {
      label: 'Untracked repository path',
      mustExist: true,
      allowFinalSymlink: true
    });
    const info = secured.entry;
    return {
      status: 'added', similarity: null, oldPath: null, newPath: relative,
      oldMode: '000000', newMode: untrackedMode(info), oldObject: null, newObject: null,
      untracked: true
    };
  }));
}

/**
 * Build the one baseline-to-working-state record used by code-delivery policy.
 * Git configuration cannot disable rename detection because the command pins it explicitly.
 */
export async function buildRepositoryChangeSet(root, {
  baseCommit,
  subject = null
} = {}) {
  if (!baseCommit) throw new SingularityFlowError('A baseline commit is required for a repository change set.');
  assertNoHiddenWorktreeChanges(root, 'Repository change-set capture');
  const unmerged = git(root, ['ls-files', '--unmerged', '-z'], { allowFailure: true });
  if (unmerged.status !== 0 || unmerged.stdout) {
    throw new SingularityFlowError('The repository index contains unresolved merge entries.', { code: 'CHANGE_SET_UNMERGED' });
  }
  const base = git(root, ['rev-parse', '--verify', `${baseCommit}^{commit}`], { allowFailure: true });
  if (base.status !== 0) {
    throw new SingularityFlowError(`Generation baseline commit ${baseCommit} is not available.`, { code: 'CHANGE_SET_BASELINE_UNAVAILABLE' });
  }
  const baseline = base.stdout.trim();
  const tree = git(root, ['rev-parse', `${baseline}^{tree}`]).stdout.trim();
  const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const caseInsensitivePaths = repositoryCaseInsensitivePaths(root);
  const raw = git(root, [
    'diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--find-copies',
    '--no-ext-diff', '--no-textconv', baseline, '--'
  ]).stdout;
  const parsed = [...parseRawDiff(raw), ...await untrackedEntries(root)];
  const entries = [];
  for (const entry of parsed) {
    const newContent = entry.newPath ? await currentContent(root, entry.newPath) : null;
    entries.push(withEntryIdentity({ ...entry, newContent }));
  }
  entries.sort(entryOrder);
  const core = {
    schemaVersion: currentSchemaVersion('repository-change-set'),
    kind: 'repository-change-set',
    subject,
    base: { commit: baseline, tree },
    target: { head, includesIndex: true, includesWorktree: true, includesUntracked: true, caseInsensitivePaths },
    entries
  };
  return { ...core, digest: repositoryChangeSetDigest(core) };
}

/**
 * Compare two already-materialized repository trees.
 *
 * Rework recovery uses private Git trees as exact visible-byte checkpoints. Comparing the trees
 * directly avoids borrowing the contributor's index and, importantly, treats a file that was
 * untracked at both checkpoints as the same file rather than as a deletion plus an addition.
 */
export function buildRepositoryTreeChangeSet(root, {
  baseTree,
  targetTree,
  subject = null,
  env = process.env
} = {}) {
  const resolveTree = (value, label) => {
    if (!value) throw new SingularityFlowError(`${label} tree is required for a repository tree change set.`);
    const resolved = git(root, ['rev-parse', '--verify', `${value}^{tree}`], { allowFailure: true, env });
    if (resolved.status !== 0) {
      throw new SingularityFlowError(`${label} tree ${value} is not available.`, {
        code: 'CHANGE_SET_BASELINE_UNAVAILABLE'
      });
    }
    return resolved.stdout.trim();
  };
  const baseline = resolveTree(baseTree, 'Baseline');
  const target = resolveTree(targetTree, 'Target');
  const raw = git(root, [
    'diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--find-copies',
    '--no-ext-diff', '--no-textconv', baseline, target, '--'
  ], { env }).stdout;
  const entries = parseRawDiff(raw).map((entry) => withEntryIdentity({ ...entry, newContent: null }));
  entries.sort(entryOrder);
  const core = {
    schemaVersion: currentSchemaVersion('repository-change-set'),
    kind: 'repository-tree-change-set',
    subject,
    base: { tree: baseline },
    target: {
      tree: target,
      includesIndex: false,
      includesWorktree: true,
      includesUntracked: true,
      caseInsensitivePaths: repositoryCaseInsensitivePaths(root)
    },
    entries
  };
  return { ...core, digest: repositoryChangeSetDigest(core) };
}

export {changeSetPaths,evaluateProtectedPaths,evaluateSourceBoundary} from './engine-compatibility/node-source-policy.mjs';
