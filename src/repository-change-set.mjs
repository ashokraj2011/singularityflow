import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { currentSchemaVersion } from './schema-migrations.mjs';
import { SingularityFlowError, posix, run } from './util.mjs';

const STATUS = Object.freeze({
  A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed',
  T: 'type-changed', U: 'unmerged', X: 'unknown', B: 'broken'
});

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function git(root, args, { allowFailure = false } = {}) {
  const result = run('git', args, { cwd: root, allowFailure });
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

function nullFields(value) {
  return value.split('\0').filter((field) => field !== '');
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

async function currentContent(root, relative) {
  if (!relative) return null;
  const absolute = path.join(root, relative);
  try {
    const info = await lstat(absolute);
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
    const info = await lstat(path.join(root, relative));
    return {
      status: 'added', similarity: null, oldPath: null, newPath: relative,
      oldMode: '000000', newMode: untrackedMode(info), oldObject: null, newObject: null,
      untracked: true
    };
  }));
}

function entryOrder(left, right) {
  return (left.oldPath ?? '').localeCompare(right.oldPath ?? '')
    || (left.newPath ?? '').localeCompare(right.newPath ?? '')
    || left.status.localeCompare(right.status);
}

function entryCore(entry) {
  const { changeId, ...core } = entry;
  return core;
}

function withEntryIdentity(entry) {
  return { ...entry, changeId: sha256(canonicalJson(entryCore(entry))) };
}

export function repositoryChangeSetDigest(changeSet) {
  const { digest: _digest, ...core } = changeSet ?? {};
  return sha256(canonicalJson(core));
}

export function verifyRepositoryChangeSetIntegrity(changeSet) {
  const entryFailures = (changeSet?.entries ?? []).filter((entry) =>
    entry.changeId !== sha256(canonicalJson(entryCore(entry))));
  return {
    valid: Boolean(changeSet)
      && changeSet.digest === repositoryChangeSetDigest(changeSet)
      && entryFailures.length === 0,
    digest: repositoryChangeSetDigest(changeSet),
    entryFailures: entryFailures.map((entry) => entry.changeId ?? null)
  };
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

export function changeSetPaths(changeSet, { bothEndpoints = true } = {}) {
  const paths = [];
  for (const entry of changeSet?.entries ?? []) {
    if (bothEndpoints && entry.oldPath) paths.push(entry.oldPath);
    if (entry.newPath) paths.push(entry.newPath);
  }
  return [...new Set(paths)].sort();
}

function pathMatches(candidate, guard, { caseInsensitive = false } = {}) {
  const pathValue = posix(candidate);
  const guardValue = posix(guard).replace(/\/$/, '');
  const [left, right] = caseInsensitive
    ? [pathValue.toLocaleLowerCase('en-US'), guardValue.toLocaleLowerCase('en-US')]
    : [pathValue, guardValue];
  return left === right || left.startsWith(`${right}/`);
}

export function evaluateProtectedPaths(changeSet, guards = [], options = {}) {
  const comparison = {
    caseInsensitive: options.caseInsensitive ?? changeSet?.target?.caseInsensitivePaths ?? false
  };
  const violations = [];
  for (const entry of changeSet?.entries ?? []) {
    for (const endpoint of ['oldPath', 'newPath']) {
      const candidate = entry[endpoint];
      const guard = candidate && guards.find((value) => pathMatches(candidate, value, comparison));
      if (guard) violations.push({ changeId: entry.changeId, endpoint, path: candidate, guard, status: entry.status });
    }
  }
  return { valid: violations.length === 0, violations };
}

export function evaluateSourceBoundary(changeSet, boundary, {
  allowedPath = () => true,
  phaseId = 'unknown'
} = {}) {
  if (boundary === 'unrestricted') return { valid: true, violations: [] };
  if (boundary !== 'test-automation') {
    throw new SingularityFlowError(`Unknown source boundary '${boundary}' for phase '${phaseId}'.`);
  }
  const violations = [];
  for (const entry of changeSet?.entries ?? []) {
    for (const endpoint of ['oldPath', 'newPath']) {
      const candidate = entry[endpoint];
      if (candidate && !allowedPath(candidate)) {
        violations.push({ changeId: entry.changeId, endpoint, path: candidate, status: entry.status });
      }
    }
  }
  return { valid: violations.length === 0, violations };
}
