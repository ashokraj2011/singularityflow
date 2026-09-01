import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  COMMIT_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger, assertNormalizedRepositoryPath,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { compareText, sealRecord, sha256Bytes } from '../canonicalize.mjs';
import { pathInsideScope } from '../scope/matcher.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';

function git(root, args, { binary = false, maxBuffer = 512 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', args, {
    cwd: path.resolve(root), encoding: binary ? null : 'utf8', maxBuffer
  });
  if (result.error || result.status !== 0) {
    const stderr = binary ? Buffer.from(result.stderr ?? '').toString('utf8') : String(result.stderr ?? '');
    contractFailure(`Unable to capture exact Git source: ${(result.error?.message ?? stderr).trim() || `git ${args[0]} failed`}.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
  return result.stdout;
}

function exactIdentity(root) {
  const commit = String(git(root, ['rev-parse', 'HEAD'])).trim();
  const tree = String(git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  if (!COMMIT_PATTERN.test(commit) || !COMMIT_PATTERN.test(tree)) {
    contractFailure('Exact source requires a valid Git commit and tree identity.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
  return { commit, tree };
}

function statusPath(line) {
  const value = line.slice(3);
  const arrow = value.lastIndexOf(' -> ');
  return (arrow >= 0 ? value.slice(arrow + 4) : value)
    .replace(/^"|"$/g, '').replaceAll('\\', '/');
}

function assertClean(root, scopeManifest = null) {
  const status = String(git(root, ['status', '--porcelain=v1', '--untracked-files=all']));
  const dirty = status.split(/\r?\n/).filter(Boolean)
    .filter((line) => !scopeManifest || pathInsideScope(statusPath(line), scopeManifest));
  if (dirty.length) {
    const paths = dirty.slice(0, 20).map(statusPath);
    contractFailure(
      'A governed exact world-model build requires a clean Git worktree; capture an immutable Candidate Snapshot for dirty bytes.',
      'WMB_SOURCE_SNAPSHOT_REQUIRED',
      { dirtyPaths: paths, truncated: dirty.length > paths.length }
    );
  }
}

function treeEntries(root, revision = 'HEAD') {
  const output = String(git(root, ['ls-tree', '-r', '-z', '--full-tree', revision]));
  return output.split('\0').filter(Boolean).map((row) => {
    const tab = row.indexOf('\t');
    if (tab < 0) contractFailure('Git tree returned an invalid source entry.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    const [mode, objectType, gitObjectId] = row.slice(0, tab).split(' ');
    const relative = row.slice(tab + 1);
    if (objectType === 'commit' || mode === '160000') {
      contractFailure(
        `Exact source contains Git submodule '${relative}' without a separately pinned submodule snapshot.`,
        'WMB_SOURCE_SNAPSHOT_REQUIRED', { path: relative }
      );
    }
    if (objectType !== 'blob' || !['100644', '100755', '120000'].includes(mode)) {
      contractFailure(`Exact source contains unsupported Git entry '${relative}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED', { path: relative, mode, objectType });
    }
    return { mode, gitObjectId, path: relative };
  }).sort((left, right) => compareText(left.path, right.path));
}

function gitScopePathspecs(scopeManifest) {
  const scope = validateScopeManifest(scopeManifest);
  const include = [...scope.allowedPaths, ...scope.sharedPaths]
    .map((pattern) => `:(top,glob)${pattern}`);
  const exclude = scope.excludedPaths
    .map((pattern) => `:(top,exclude,glob)${pattern}`);
  return [...(include.length ? include : [':(top,glob)**']), ...exclude];
}

function scopedSourceCommit(root, scopeManifest) {
  const commit = String(git(root, [
    'log', '-1', '--format=%H', 'HEAD', '--', ...gitScopePathspecs(scopeManifest)
  ])).trim();
  return COMMIT_PATTERN.test(commit) ? commit : null;
}

function blobBytes(root, objectId) {
  return Buffer.from(git(root, ['cat-file', 'blob', objectId], { binary: true }));
}

function fileType(mode) {
  return mode === '120000' ? 'symlink' : 'regular';
}

export function createExactSourceSnapshot(root, {
  subjectId = path.basename(path.resolve(root)),
  lineEndingPolicy = 'preserve-source',
  scopeManifest = null
} = {}) {
  assertString(subjectId, 'Source subject ID');
  const scope = scopeManifest ? validateScopeManifest(scopeManifest) : null;
  assertClean(root, scope);
  const before = scope
    ? { commit: scopedSourceCommit(root, scope) ?? exactIdentity(root).commit }
    : exactIdentity(root);
  const files = treeEntries(root, before.commit)
    .filter((entry) => !scope || pathInsideScope(entry.path, scope))
    .map((entry) => {
      const bytes = blobBytes(root, entry.gitObjectId);
      return {
        path: entry.path,
        type: fileType(entry.mode),
        mode: entry.mode,
        contentSha256: `sha256:${sha256Bytes(bytes)}`,
        bytes: bytes.length
      };
    });
  if (scope) {
    before.tree = sha256Bytes(Buffer.from(JSON.stringify(files.map((file) => ({
      path: file.path,
      mode: file.mode,
      contentSha256: file.contentSha256
    })))));
  }
  assertClean(root, scope);
  const after = scope
    ? { commit: scopedSourceCommit(root, scope) ?? exactIdentity(root).commit, tree: before.tree }
    : exactIdentity(root);
  if (before.commit !== after.commit || before.tree !== after.tree) {
    contractFailure('Git source changed while the exact Source Snapshot was being captured.', 'WMB_SOURCE_SNAPSHOT_STALE', { before, after });
  }
  return validateSourceSnapshot(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-source-snapshot'),
    kind: 'world-model-source-snapshot',
    subject: { kind: 'repository', id: subjectId },
    revision: before,
    files,
    lineEndingPolicy,
    pathNormalization: 'posix-relative'
  }, 'sourceManifestSha256'));
}

export function validateSourceSnapshot(value) {
  assertPlainRecord(value, 'World-model Source Snapshot');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'subject', 'revision', 'files', 'lineEndingPolicy',
      'pathNormalization', 'sourceManifestSha256'
    ],
    label: 'World-model Source Snapshot'
  });
  assertSchemaKind(value, 'world-model-source-snapshot', 'World-model Source Snapshot');
  assertExactKeys(value.subject, { required: ['kind', 'id'], label: 'Source subject' });
  if (value.subject.kind !== 'repository') contractFailure("Source subject kind must be 'repository'.", 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  assertString(value.subject.id, 'Source subject ID');
  assertExactKeys(value.revision, { required: ['commit', 'tree'], label: 'Source revision' });
  assertString(value.revision.commit, 'Source commit', { pattern: COMMIT_PATTERN });
  assertString(value.revision.tree, 'Source tree', { pattern: COMMIT_PATTERN });
  if (!Array.isArray(value.files)) contractFailure('Source files must be an array.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  const paths = new Set();
  for (const [index, file] of value.files.entries()) {
    assertExactKeys(file, {
      required: ['path', 'type', 'mode', 'contentSha256', 'bytes'],
      label: `Source file ${index}`
    });
    assertNormalizedRepositoryPath(file.path, `Source file ${index} path`);
    if (paths.has(file.path)) contractFailure(`Source Snapshot repeats path '${file.path}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    paths.add(file.path);
    if (!['regular', 'symlink'].includes(file.type)) contractFailure(`Source file '${file.path}' has unsupported type.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    if (!['100644', '100755', '120000'].includes(file.mode)) contractFailure(`Source file '${file.path}' has unsupported mode.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    if ((file.mode === '120000') !== (file.type === 'symlink')) contractFailure(`Source file '${file.path}' type and mode disagree.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    assertSha256(file.contentSha256, `Source file '${file.path}' contentSha256`);
    assertInteger(file.bytes, `Source file '${file.path}' bytes`, { minimum: 0 });
  }
  assertCanonicalOrder(value.files, (file) => file.path, 'Source files');
  if (value.lineEndingPolicy !== 'preserve-source') contractFailure("Source lineEndingPolicy must be 'preserve-source'.", 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  if (value.pathNormalization !== 'posix-relative') contractFailure("Source pathNormalization must be 'posix-relative'.", 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  assertSha256(value.sourceManifestSha256, 'Source sourceManifestSha256');
  assertSelfHash(value, 'sourceManifestSha256', 'World-model Source Snapshot');
  return value;
}

export function sourceFileMap(value) {
  const snapshot = validateSourceSnapshot(value);
  return new Map(snapshot.files.map((file) => [file.path, file]));
}

export function readExactSourceFile(root, snapshotValue, relative) {
  const snapshot = validateSourceSnapshot(snapshotValue);
  const file = snapshot.files.find((entry) => entry.path === relative);
  if (!file) contractFailure(`Source Snapshot does not contain '${relative}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED', { path: relative });
  const bytes = Buffer.from(git(root, ['cat-file', 'blob', `${snapshot.revision.commit}:${relative}`], { binary: true }));
  const digest = `sha256:${sha256Bytes(bytes)}`;
  if (bytes.length !== file.bytes || digest !== file.contentSha256) {
    contractFailure(`Pinned source object for '${relative}' does not match the Source Snapshot.`, 'WMB_SOURCE_SNAPSHOT_STALE', {
      path: relative, expectedSha256: file.contentSha256, actualSha256: digest
    });
  }
  return bytes;
}

export function verifyExactSourceSnapshot(root, snapshotValue, { scopeManifest = null } = {}) {
  const snapshot = validateSourceSnapshot(snapshotValue);
  // Older callers may pin the complete repository and apply scope only while extracting.
  // A v4 build plan instead pins the scoped source projection so Story/configuration-only
  // commits do not invalidate reusable repository facts. Preserve both exact forms without
  // guessing: if the pinned snapshot contains any path outside the supplied scope, verify it
  // as a full-repository snapshot; otherwise verify the scoped projection.
  const verificationScope = scopeManifest
    && snapshot.files.every((file) => pathInsideScope(file.path, validateScopeManifest(scopeManifest)))
    ? scopeManifest
    : null;
  const current = createExactSourceSnapshot(root, {
    subjectId: snapshot.subject.id,
    lineEndingPolicy: snapshot.lineEndingPolicy,
    scopeManifest: verificationScope
  });
  if (current.sourceManifestSha256 !== snapshot.sourceManifestSha256) {
    contractFailure('Current Git source does not match the pinned Source Snapshot.', 'WMB_SOURCE_SNAPSHOT_STALE', {
      expected: snapshot.sourceManifestSha256, current: current.sourceManifestSha256
    });
  }
  return snapshot;
}
