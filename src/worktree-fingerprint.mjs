import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { run, SingularityFlowError } from './util.mjs';

export const WORKTREE_FINGERPRINT_ALGORITHM = 'sflow-worktree-v2';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobHash(value, objectFormat) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return createHash(objectFormat)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

export function withoutConfiguredFilters(root, args, {
  env = process.env,
  fresh = false
} = {}) {
  const readOverrides = () => {
    const configured = run('git', [
      'config', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'
    ], { cwd: root, env, allowFailure: true });
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
  };
  // A safety boundary may supply a selector-sanitized environment. It must not reuse filter
  // configuration cached by an earlier ambient Git selector, so its fresh reads bypass this
  // process-local convenience cache as well as the outer fingerprint cache.
  const overrides = fresh
    ? readOverrides()
    : scopedReadSync(`git.filter-overrides:${root}`, readOverrides);
  return [...overrides, ...args];
}

function fileEntry(root, relative, {
  sparseAbsent = false,
  env = process.env,
  objectFormat = null
} = {}) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    // lstat only protects the final component.  Walk every existing ancestor first so replacing a
    // tracked directory with a symlink cannot make a fingerprint read bytes outside the checkout.
    let cursor = path.resolve(root);
    for (const segment of String(relative).replaceAll('\\', '/').split('/').slice(0, -1)) {
      cursor = path.join(cursor, segment);
      const ancestor = lstatSync(cursor);
      if (ancestor.isSymbolicLink()) {
        throw new SingularityFlowError(
          `Tracked repository path has a symbolic-link ancestor: ${relative}`,
          { code: 'WORKTREE_PATH_ESCAPE', details: { path: relative } }
        );
      }
      if (!ancestor.isDirectory()) break;
    }
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return {
      path: relative, type: sparseAbsent ? 'sparse-absent' : 'missing', mode: null, object: null
    };
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const bytes = Buffer.from(readlinkSync(absolute));
    return {
      path: relative,
      type: 'symlink',
      mode: '120000',
      object: sha256(bytes),
      ...(objectFormat ? { indexObject: gitBlobHash(bytes, objectFormat) } : {})
    };
  }
  if (stat.isFile()) {
    // Hash the bytes directly. Besides avoiding object writes, this ensures a read-only Home never
    // executes an arbitrary configured clean filter merely because the repository is dirty.
    const bytes = readFileSync(absolute);
    const object = sha256(bytes);
    return {
      path: relative,
      type: 'file',
      mode: (stat.mode & 0o111) ? '100755' : '100644',
      object,
      ...(objectFormat ? { indexObject: gitBlobHash(bytes, objectFormat) } : {})
    };
  }
  if (stat.isDirectory()) {
    // The only directory `ls-files` normally returns is a gitlink. Include both its checked-out
    // commit and dirtiness; an absent or broken submodule remains a stable, explicit value.
    const nestedHead = run('git', ['-C', relative, 'rev-parse', 'HEAD'], {
      cwd: root, env, allowFailure: true
    });
    const nestedStatus = run('git', ['status', '--porcelain=v1', '--ignore-submodules=none', '--', relative], {
      cwd: root, env, allowFailure: true
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

function hiddenWorktreeChangePaths(root) {
  const indexManifest = indexEntries(
    run('git', ['ls-files', '--stage', '-z'], { cwd: root }).stdout,
    run('git', ['ls-files', '-v', '-z'], { cwd: root }).stdout
  );
  const hidden = indexManifest.filter((entry) => entry.stage === 0
    && (entry.assumeUnchanged || entry.skipWorktree));
  return hidden.filter((entry) => {
    const current = fileEntry(root, entry.path, { sparseAbsent: entry.skipWorktree });
    if (current.type === 'sparse-absent' && entry.skipWorktree) return false;
    if (!['file', 'symlink', 'directory'].includes(current.type)) return true;
    if (current.mode !== entry.mode) return true;
    if (current.type === 'directory') return current.object !== entry.object || current.dirty === true;
    return current.object !== sha256(indexedBytes(root, entry.object));
  }).map((entry) => entry.path);
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

function indexedBytes(root, object, env = process.env) {
  const result = run('git', ['cat-file', 'blob', object], { cwd: root, env, encoding: 'buffer' });
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
export function worktreeFingerprint(root, {
  fresh = false,
  dirty = null,
  visiblePaths = null,
  env = process.env,
  exhaustive = false
} = {}) {
  const compute = () => {
    const headResult = run('git', ['rev-parse', '--verify', 'HEAD^{tree}'], {
      cwd: root,
      env,
      allowFailure: true
    });
    const headTree = headResult.status === 0
      ? headResult.stdout.trim()
      : run('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: root, env, input: '' }).stdout.trim();

    // Hashing the stage listing avoids `write-tree`, which can itself create a tree for staged
    // changes. It also remains defined for conflicted indexes because all stages are retained.
    const indexListing = run('git', ['ls-files', '--stage', '-z'], { cwd: root, env }).stdout;
    const flagsListing = run('git', ['ls-files', '-v', '-z'], { cwd: root, env }).stdout;
    const indexManifest = indexEntries(indexListing, flagsListing);
    const objectFormat = indexManifest.some((entry) => entry.object.length === 64)
      ? 'sha256' : 'sha1';
    const indexTree = sha256(canonicalJson(indexManifest));
    // HEAD and the index listing already content-address every unchanged tracked path. Reading
    // every file again would turn one dirty README into a full-repository byte scan, so only paths
    // whose worktree state differs plus untracked paths are included in the visible-byte manifest.
    const changed = visiblePaths === null && !exhaustive
      ? headResult.status === 0
        ? run('git', withoutConfiguredFilters(root, [
          'diff', '--no-textconv', '--name-only', '-z', 'HEAD'
        ], { env, fresh }), { cwd: root, env }).stdout
        : run('git', ['ls-files', '--cached', '-z'], { cwd: root, env }).stdout
      : '';
    const untracked = visiblePaths === null
      ? run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, env }).stdout
      : '';
    const stageZero = new Map(indexManifest.filter((entry) => entry.stage === 0)
      .map((entry) => [entry.path, entry]));
    const hidden = indexManifest.filter((entry) => entry.stage === 0
      && (entry.assumeUnchanged || entry.skipWorktree));
    const paths = [...new Set([
      ...(visiblePaths ?? []),
      ...(exhaustive ? [...stageZero.keys()] : []),
      ...splitNull(changed), ...splitNull(untracked), ...hidden.map((entry) => entry.path)
    ])].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const manifest = paths.map((relative) => fileEntry(root, relative, {
      sparseAbsent: Boolean(stageZero.get(relative)?.skipWorktree), env,
      objectFormat: exhaustive ? objectFormat : null
    }));
    const currentByPath = new Map(manifest.map((entry) => [entry.path, entry]));
    const hiddenChanges = hidden.filter((entry) => {
      const current = currentByPath.get(entry.path);
      if (current?.type === 'sparse-absent' && entry.skipWorktree) return false;
      if (!current || !['file', 'symlink', 'directory'].includes(current.type)) return true;
      if (current.mode !== entry.mode) return true;
      if (current.type === 'directory') return current.object !== entry.object || current.dirty === true;
      return current.object !== sha256(indexedBytes(root, entry.object, env));
    }).map((entry) => entry.path);
    const exhaustiveChanges = exhaustive ? [...stageZero.values()].filter((entry) => {
      const current = currentByPath.get(entry.path);
      if (current?.type === 'sparse-absent' && entry.skipWorktree) return false;
      if (!current || !['file', 'symlink', 'directory'].includes(current.type)) return true;
      if (entry.mode === '160000') {
        return current.type !== 'directory' || current.object !== entry.object
          || current.dirty === true;
      }
      const emulatedWindowsSymlink = process.platform === 'win32'
        && entry.mode === '120000' && current.type === 'file';
      if (current.type !== (entry.mode === '120000' ? 'symlink' : 'file')
          && !emulatedWindowsSymlink) return true;
      // Windows filesystems do not carry Git's executable bit reliably. On other platforms a
      // mode-only change is local work even when repository core.filemode=false hides it.
      if (process.platform !== 'win32' && current.mode !== entry.mode) return true;
      return current.indexObject !== entry.object;
    }).map((entry) => entry.path) : [];
    const unmergedIndex = indexManifest.some((entry) => entry.stage !== 0);
    const workingTree = sha256(canonicalJson(manifest));
    const statusDirty = dirty ?? Boolean(run('git', withoutConfiguredFilters(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
    ], { env, fresh }), { cwd: root, env }).stdout);
    const trees = {
      algorithm: exhaustive
        ? `${WORKTREE_FINGERPRINT_ALGORITHM}-exhaustive`
        : WORKTREE_FINGERPRINT_ALGORITHM,
      headTree, indexTree, workingTree
    };
    return Object.freeze({
      ...trees,
      sha256: sha256(canonicalJson(trees)),
      dirty: statusDirty || hiddenChanges.length > 0 || (exhaustive
        && (exhaustiveChanges.length > 0 || splitNull(untracked).length > 0 || unmergedIndex)),
      paths: Object.freeze(paths),
      hiddenChanges: Object.freeze(hiddenChanges),
      ...(exhaustive ? { exhaustiveChanges: Object.freeze(exhaustiveChanges) } : {}),
      diagnosticCodes: Object.freeze([
        ...(hiddenChanges.length ? ['WORKTREE_HIDDEN_CHANGE'] : []),
        ...(exhaustive && exhaustiveChanges.length ? ['WORKTREE_EXHAUSTIVE_CHANGE'] : []),
        ...(exhaustive && unmergedIndex ? ['WORKTREE_UNMERGED_INDEX'] : [])
      ])
    });
  };
  // Revision boundaries must always observe new bytes. Other read-model consumers may reuse one
  // fingerprint inside a scoped operation, but caching the coordinator's before/after values under
  // one key would make a mid-read edit invisible.
  return fresh ? compute() : scopedReadSync(`git.worktree-fingerprint:${root}`, compute);
}

/**
 * Refuse visible source changes hidden from ordinary Git diff/status by index flags.
 *
 * `assume-unchanged` and `skip-worktree` are performance hints, not governance authority.  A
 * modified file carrying either flag can otherwise be executed by tests while every generation,
 * delivery, and source-tree receipt records the old indexed blob.  Legitimately absent sparse
 * entries are not returned by `worktreeFingerprint` and therefore remain supported.
 */
export function assertNoHiddenWorktreeChanges(root, operation = 'Governed source inspection') {
  const hiddenChanges = hiddenWorktreeChangePaths(root);
  if (!hiddenChanges.length) return Object.freeze({ hiddenChanges: Object.freeze([]) });
  throw new SingularityFlowError(
    `${operation} cannot continue because Git index flags hide visible changes in: `
      + `${hiddenChanges.join(', ')}. Clear assume-unchanged/skip-worktree for these `
      + 'paths, review the resulting Git diff, and retry.',
    {
      code: 'WORKTREE_HIDDEN_CHANGE',
      details: { paths: [...hiddenChanges], diagnosticCodes: ['WORKTREE_HIDDEN_CHANGE'] }
    }
  );
}
