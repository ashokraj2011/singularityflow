import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { run } from './util.mjs';

export const WORKTREE_FINGERPRINT_ALGORITHM = 'sflow-worktree-v2';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

export function withoutConfiguredFilters(root, args) {
  const overrides = scopedReadSync(`git.filter-overrides:${root}`, () => {
    const configured = run('git', [
      'config', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'
    ], { cwd: root, allowFailure: true });
    const drivers = new Set();
    if (configured.status === 0) {
      for (const line of configured.stdout.split(/\r?\n/).filter(Boolean)) {
        const key = line.slice(0, line.search(/\s/));
        const match = /^filter\.(.*)\.(?:clean|process|required)$/.exec(key);
        if (match?.[1]) drivers.add(match[1]);
      }
    }
    return [...drivers].sort().flatMap((driver) => [
      '-c', `filter.${driver}.clean=`,
      '-c', `filter.${driver}.process=`,
      '-c', `filter.${driver}.required=false`
    ]);
  });
  return [...overrides, ...args];
}

function fileEntry(root, relative, { sparseAbsent = false } = {}) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      path: relative, type: sparseAbsent ? 'sparse-absent' : 'missing', mode: null, object: null
    };
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return {
      path: relative,
      type: 'symlink',
      mode: '120000',
      object: sha256(Buffer.from(readlinkSync(absolute)))
    };
  }
  if (stat.isFile()) {
    // Hash the bytes directly. Besides avoiding object writes, this ensures a read-only Home never
    // executes an arbitrary configured clean filter merely because the repository is dirty.
    const object = sha256(readFileSync(absolute));
    return {
      path: relative,
      type: 'file',
      mode: (stat.mode & 0o111) ? '100755' : '100644',
      object
    };
  }
  if (stat.isDirectory()) {
    // The only directory `ls-files` normally returns is a gitlink. Include both its checked-out
    // commit and dirtiness; an absent or broken submodule remains a stable, explicit value.
    const nestedHead = run('git', ['-C', relative, 'rev-parse', 'HEAD'], {
      cwd: root, allowFailure: true
    });
    const nestedStatus = run('git', ['status', '--porcelain=v1', '--ignore-submodules=none', '--', relative], {
      cwd: root, allowFailure: true
    });
    return {
      path: relative,
      type: 'directory',
      mode: '160000',
      object: nestedHead.status === 0 ? nestedHead.stdout.trim() : null,
      dirty: nestedStatus.status === 0 ? Boolean(nestedStatus.stdout) : null
    };
  }
  return { path: relative, type: 'other', mode: String(stat.mode), object: null };
}

function indexEntries(listing, flagsListing) {
  const flags = new Map(splitNull(flagsListing).map((entry) => [entry.slice(2), entry[0]]));
  return splitNull(listing).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, object, stageText] = entry.slice(0, tab).split(' ');
    const relative = entry.slice(tab + 1);
    const tag = flags.get(relative) ?? 'H';
    return {
      path: relative,
      mode,
      object,
      stage: Number(stageText),
      assumeUnchanged: /^[a-z]$/.test(tag),
      skipWorktree: tag.toUpperCase() === 'S'
    };
  }).sort((left, right) => left.path < right.path ? -1
    : left.path > right.path ? 1 : left.stage - right.stage);
}

function indexedBytes(root, object) {
  const result = run('git', ['cat-file', 'blob', object], { cwd: root, encoding: 'buffer' });
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
}

/**
 * Content-address the repository state without writing Git objects or invoking clean filters.
 *
 * A private index protects the real index, but `git add` still writes blobs and trees to the normal
 * object database. That made a read-only Home leave unreachable objects behind for every dirty
 * file version. This manifest reads the same three facts—HEAD, index stages, and visible bytes—using
 * plumbing commands that do not use `-w`. Paths, modes, symlink targets, deletions, untracked files,
 * index stages and submodule state all participate in the final SHA-256.
 */
export function worktreeFingerprint(root, { fresh = false, dirty = null, visiblePaths = null } = {}) {
  const compute = () => {
    const headResult = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
      cwd: root,
      allowFailure: true
    });
    const headTree = headResult.status === 0
      ? headResult.stdout.trim()
      : run('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, input: '' }).stdout.trim();

    // Hashing the stage listing avoids `write-tree`, which can itself create a tree for staged
    // changes. It also remains defined for conflicted indexes because all stages are retained.
    const indexListing = run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout;
    const flagsListing = run('git', ['ls-files', '-v', '-z'], { cwd: root }).stdout;
    const indexManifest = indexEntries(indexListing, flagsListing);
    const indexTree = sha256(canonicalJson(indexManifest));
    // HEAD and the index listing already content-address every unchanged tracked path. Reading
    // every file again would turn one dirty README into a full-repository byte scan, so only paths
    // whose worktree state differs plus untracked paths are included in the visible-byte manifest.
    const changed = visiblePaths === null
      ? headResult.status === 0
        ? run('git', withoutConfiguredFilters(root, [
          'diff', '--no-textconv', '--name-only', '-z', 'HEAD'
        ]), { cwd: root }).stdout
        : run('git', ['ls-files', '--cached', '-z'], { cwd: root }).stdout
      : '';
    const untracked = visiblePaths === null
      ? run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout
      : '';
    const stageZero = new Map(indexManifest.filter((entry) => entry.stage === 0)
      .map((entry) => [entry.path, entry]));
    const hidden = indexManifest.filter((entry) => entry.stage === 0
      && (entry.assumeUnchanged || entry.skipWorktree));
    const paths = [...new Set([
      ...(visiblePaths ?? []), ...splitNull(changed), ...splitNull(untracked), ...hidden.map((entry) => entry.path)
    ])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const manifest = paths.map((relative) => fileEntry(root, relative, {
      sparseAbsent: Boolean(stageZero.get(relative)?.skipWorktree)
    }));
    const currentByPath = new Map(manifest.map((entry) => [entry.path, entry]));
    const hiddenChanges = hidden.filter((entry) => {
      const current = currentByPath.get(entry.path);
      if (current?.type === 'sparse-absent' && entry.skipWorktree) return false;
      if (!current || !['file', 'symlink', 'directory'].includes(current.type)) return true;
      if (current.mode !== entry.mode) return true;
      if (current.type === 'directory') return current.object !== entry.object || current.dirty === true;
      return current.object !== sha256(indexedBytes(root, entry.object));
    }).map((entry) => entry.path);
    const workingTree = sha256(canonicalJson(manifest));
    const statusDirty = dirty ?? Boolean(run('git', withoutConfiguredFilters(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
    ]), { cwd: root }).stdout);
    const trees = { algorithm: WORKTREE_FINGERPRINT_ALGORITHM, headTree, indexTree, workingTree };
    return Object.freeze({
      ...trees,
      sha256: sha256(canonicalJson(trees)),
      dirty: statusDirty || hiddenChanges.length > 0,
      paths: Object.freeze(paths),
      hiddenChanges: Object.freeze(hiddenChanges),
      diagnosticCodes: Object.freeze(hiddenChanges.length ? ['WORKTREE_HIDDEN_CHANGE'] : [])
    });
  };
  // Revision boundaries must always observe new bytes. Other read-model consumers may reuse one
  // fingerprint inside a scoped operation, but caching the coordinator's before/after values under
  // one key would make a mid-read edit invisible.
  return fresh ? compute() : scopedReadSync(`git.worktree-fingerprint:${root}`, compute);
}
