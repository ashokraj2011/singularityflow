import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { scopedReadSync } from './read-scope.mjs';
import { run } from './util.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

function withoutConfiguredFilters(root, args) {
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
  const overrides = [...drivers].sort().flatMap((driver) => [
    '-c', `filter.${driver}.clean=`,
    '-c', `filter.${driver}.process=`,
    '-c', `filter.${driver}.required=false`
  ]);
  return [...overrides, ...args];
}

function fileEntry(root, relative) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: relative, type: 'missing', mode: null, object: null };
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

/**
 * Content-address the repository state without writing Git objects or invoking clean filters.
 *
 * A private index protects the real index, but `git add` still writes blobs and trees to the normal
 * object database. That made a read-only Home leave unreachable objects behind for every dirty
 * file version. This manifest reads the same three facts—HEAD, index stages, and visible bytes—using
 * plumbing commands that do not use `-w`. Paths, modes, symlink targets, deletions, untracked files,
 * index stages and submodule state all participate in the final SHA-256.
 */
export function worktreeFingerprint(root) {
  return scopedReadSync(`git.worktree-fingerprint:${root}`, () => {
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
    const indexTree = sha256(indexListing);
    // HEAD and the index listing already content-address every unchanged tracked path. Reading
    // every file again would turn one dirty README into a full-repository byte scan, so only paths
    // whose worktree state differs plus untracked paths are included in the visible-byte manifest.
    const changed = headResult.status === 0
      ? run('git', withoutConfiguredFilters(root, [
        'diff', '--no-textconv', '--name-only', '-z', 'HEAD'
      ]), { cwd: root }).stdout
      : run('git', ['ls-files', '--cached', '-z'], { cwd: root }).stdout;
    const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }).stdout;
    const paths = [...new Set([...splitNull(changed), ...splitNull(untracked)])].sort();
    const manifest = paths.map((relative) => fileEntry(root, relative));
    const workingTree = sha256(canonicalJson(manifest));
    const status = run('git', withoutConfiguredFilters(root, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
    ]), { cwd: root }).stdout;
    const trees = { headTree, indexTree, workingTree };
    return Object.freeze({
      ...trees,
      sha256: sha256(canonicalJson(trees)),
      dirty: Boolean(status),
      paths: Object.freeze(paths)
    });
  });
}
