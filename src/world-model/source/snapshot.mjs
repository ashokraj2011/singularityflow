import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gitCommonDir } from '../../git.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar } from '../../private-sidecar.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  COMMIT_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger, assertNormalizedRepositoryPath,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { canonicalJson, compareText, sealRecord, sha256, sha256Bytes } from '../canonicalize.mjs';
import { pathInsideScope } from '../scope/matcher.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';

const CANDIDATE_RECORD_MAXIMUM_BYTES = 16 * 1024 * 1024;
const CANDIDATE_REF_PREFIX = 'refs/singularity-flow/world-model-candidates';

function git(root, args, {
  binary = false, maxBuffer = 512 * 1024 * 1024, input = undefined, env = undefined,
  allowFailure = false
} = {}) {
  const result = spawnSync('git', args, {
    cwd: path.resolve(root), encoding: binary ? null : 'utf8', maxBuffer, input,
    ...(env ? { env: { ...process.env, ...env } } : {})
  });
  if (result.error || (result.status !== 0 && !allowFailure)) {
    const stderr = binary ? Buffer.from(result.stderr ?? '').toString('utf8') : String(result.stderr ?? '');
    contractFailure(`Unable to capture exact Git source: ${(result.error?.message ?? stderr).trim() || `git ${args[0]} failed`}.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
  return allowFailure ? result : result.stdout;
}

function repositoryIdentity(root) {
  const commonDirectory = realpathSync(gitCommonDir(root));
  const objectFormat = String(git(root, ['rev-parse', '--show-object-format'])).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    contractFailure(`Unsupported Git object format '${objectFormat}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
  return sha256({ kind: 'git-repository-object-store', commonDirectory, objectFormat });
}

function candidateReference(sourceManifestSha256) {
  assertSha256(sourceManifestSha256, 'Candidate Snapshot reference');
  return `${CANDIDATE_REF_PREFIX}/${sourceManifestSha256.slice('sha256:'.length)}`;
}

function candidateRecordPath(root, sourceManifestSha256) {
  assertSha256(sourceManifestSha256, 'Candidate Snapshot reference');
  return path.join(
    gitCommonDir(root), 'singularity-flow', 'world-model-candidates', 'v4', 'snapshots',
    `${sourceManifestSha256.slice('sha256:'.length)}.json`
  );
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

function listedCandidatePaths(root, scopeManifest) {
  const scope = validateScopeManifest(scopeManifest);
  const tracked = String(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0').filter(Boolean).map((value) => value.replaceAll('\\', '/'));
  const modes = new Map();
  for (const row of String(git(root, ['ls-files', '-s', '-z'])).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    if (tab < 0) contractFailure('Git index returned an invalid Candidate Snapshot entry.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    const [mode] = row.slice(0, tab).split(' ');
    modes.set(row.slice(tab + 1).replaceAll('\\', '/'), mode);
  }
  const unique = new Set();
  const values = [];
  for (const relative of tracked) {
    assertNormalizedRepositoryPath(relative, 'Candidate Snapshot path');
    if (!pathInsideScope(relative, scope) || unique.has(relative)) continue;
    unique.add(relative);
    values.push({ path: relative, indexMode: modes.get(relative) ?? null });
  }
  return values.sort((left, right) => compareText(left.path, right.path));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function assertRealCandidateAncestors(canonicalRoot, relative) {
  let cursor = canonicalRoot;
  for (const segment of relative.split('/').slice(0, -1)) {
    cursor = path.join(cursor, segment);
    const info = lstatSync(cursor, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      contractFailure(
        `Candidate Snapshot path '${relative}' traverses a symbolic link or non-directory ancestor.`,
        'WMB_SOURCE_PATH_UNSAFE', { path: relative }
      );
    }
  }
}

function candidateFileBytes(root, relative, indexMode) {
  const canonicalRoot = realpathSync(path.resolve(root));
  assertRealCandidateAncestors(canonicalRoot, relative);
  const absolute = path.resolve(canonicalRoot, ...relative.split('/'));
  const rebound = path.relative(canonicalRoot, absolute);
  if (rebound === '..' || rebound.startsWith(`..${path.sep}`) || path.isAbsolute(rebound)) {
    contractFailure(`Candidate Snapshot path '${relative}' escapes the repository.`, 'WMB_SOURCE_PATH_UNSAFE', { path: relative });
  }
  let entry;
  try { entry = lstatSync(absolute, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null; // A tracked deletion is represented by omission.
    throw error;
  }
  if (entry.isSymbolicLink() || indexMode === '120000') {
    contractFailure(
      `Candidate Snapshot refuses symbolic link '${relative}'; commit and review the link target first.`,
      'WMB_SOURCE_PATH_UNSAFE', { path: relative }
    );
  }
  if (indexMode === '160000' || !entry.isFile()) {
    contractFailure(
      `Candidate Snapshot refuses unsupported repository entry '${relative}'.`,
      'WMB_SOURCE_SNAPSHOT_REQUIRED', { path: relative, mode: indexMode }
    );
  }
  let descriptor;
  let handle;
  try {
    handle = openSync(absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(handle, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(entry, opened)) {
      contractFailure(`Candidate source '${relative}' changed identity while it was opened.`, 'WMB_SOURCE_SNAPSHOT_STALE', { path: relative });
    }
    const bytes = readFileSync(handle);
    const afterHandle = fstatSync(handle, { bigint: true });
    const afterPath = lstatSync(absolute, { bigint: true });
    if (!sameFileIdentity(opened, afterHandle) || !sameFileIdentity(opened, afterPath)) {
      contractFailure(`Candidate source '${relative}' changed while its bytes were captured.`, 'WMB_SOURCE_SNAPSHOT_STALE', { path: relative });
    }
    const executable = (Number(opened.mode & 0o111n) !== 0);
    const mode = executable ? '100755' : '100644';
    descriptor = { bytes, mode };
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      contractFailure(`Candidate Snapshot path '${relative}' is a symbolic link.`, 'WMB_SOURCE_PATH_UNSAFE', { path: relative });
    }
    throw error;
  } finally {
    if (handle != null) closeSync(handle);
  }
  return descriptor;
}

function captureCandidatePass(root, scopeManifest, { writeObjects }) {
  const files = [];
  for (const listed of listedCandidatePaths(root, scopeManifest)) {
    const captured = candidateFileBytes(root, listed.path, listed.indexMode);
    if (!captured) continue;
    const objectId = String(git(root, [
      'hash-object', ...(writeObjects ? ['-w'] : []), '--stdin'
    ], { input: captured.bytes })).trim();
    if (!COMMIT_PATTERN.test(objectId)) {
      contractFailure(`Git did not return a valid object identity for '${listed.path}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    }
    files.push({
      path: listed.path,
      type: 'regular',
      mode: captured.mode,
      contentSha256: `sha256:${sha256Bytes(captured.bytes)}`,
      bytes: captured.bytes.length,
      objectId
    });
  }
  return files;
}

function candidateTree(root, files) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'sflow-wmb-candidate-index-'));
  const indexPath = path.join(temporary, 'index');
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    git(root, ['read-tree', '--empty'], { env });
    for (const file of files) {
      git(root, ['update-index', '--add', '--cacheinfo', `${file.mode},${file.objectId},${file.path}`], { env });
    }
    const tree = String(git(root, ['write-tree'], { env })).trim();
    if (!COMMIT_PATTERN.test(tree)) contractFailure('Git did not create a valid Candidate Snapshot tree.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    return tree;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function candidateCommit(root, tree, baseRevision, candidateSha256) {
  const timestamp = String(git(root, ['show', '-s', '--format=%ct', baseRevision.commit])).trim();
  if (!/^[0-9]+$/.test(timestamp)) contractFailure('Candidate Snapshot base revision has no valid timestamp.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  const identity = {
    GIT_AUTHOR_NAME: 'Singularity Flow Candidate Snapshot',
    GIT_AUTHOR_EMAIL: 'candidate-snapshot@singularity-flow.invalid',
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_NAME: 'Singularity Flow Candidate Snapshot',
    GIT_COMMITTER_EMAIL: 'candidate-snapshot@singularity-flow.invalid',
    GIT_COMMITTER_DATE: `@${timestamp} +0000`
  };
  const commit = String(git(root, [
    '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', baseRevision.commit,
    '-m', `[world-model][candidate] ${candidateSha256}`
  ], { env: identity })).trim();
  if (!COMMIT_PATTERN.test(commit)) contractFailure('Git did not create a valid Candidate Snapshot commit.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  return commit;
}

function candidateIdentity({ repositorySha256, baseRevision, scopeManifestSha256, files }) {
  return sha256({
    kind: 'world-model-candidate-source', version: 1,
    repositorySha256, baseRevision, scopeManifestSha256,
    files: files.map(({ path: relative, type, mode, contentSha256, bytes, objectId }) => ({
      path: relative, type, mode, contentSha256, bytes, objectId
    }))
  });
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

/**
 * Explicitly capture dirty in-scope working-tree bytes as a private immutable Git authority.
 *
 * The source is read twice with no-follow file descriptors. Only an identical second pass is
 * admitted, and the resulting blobs are anchored by a deterministic private commit/ref before the
 * content-addressed record is returned. Ordinary builds never call this function implicitly.
 */
export async function captureCandidateSourceSnapshot(root, {
  subjectId = path.basename(path.resolve(root)),
  lineEndingPolicy = 'preserve-source',
  scopeManifest,
  captureInterlock = null
} = {}) {
  assertString(subjectId, 'Source subject ID');
  const scope = validateScopeManifest(scopeManifest);
  const before = exactIdentity(root);
  const repositorySha256 = repositoryIdentity(root);
  const first = captureCandidatePass(root, scope, { writeObjects: true });
  // The interlock is an injectable acceptance-test seam: production callers omit it. Running it
  // between the two complete passes proves that a mutation at the widest capture window is caught
  // by the same comparison used for real filesystem races.
  if (captureInterlock != null) {
    if (typeof captureInterlock !== 'function') {
      contractFailure('Candidate Snapshot capture interlock must be a function.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
    }
    await captureInterlock();
  }
  const second = captureCandidatePass(root, scope, { writeObjects: false });
  const after = exactIdentity(root);
  if (before.commit !== after.commit || before.tree !== after.tree
      || canonicalJson(first) !== canonicalJson(second)) {
    contractFailure(
      'Repository source changed while the immutable Candidate Snapshot was being captured.',
      'WMB_SOURCE_SNAPSHOT_STALE', { before, after }
    );
  }
  const candidateSha256 = candidateIdentity({
    repositorySha256,
    baseRevision: before,
    scopeManifestSha256: scope.scopeSha256,
    files: first
  });
  const tree = candidateTree(root, first);
  const commit = candidateCommit(root, tree, before, candidateSha256);
  const sourceSnapshot = validateSourceSnapshot(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-source-snapshot'),
    kind: 'world-model-source-snapshot',
    subject: { kind: 'repository', id: subjectId },
    revision: { commit, tree },
    authority: {
      kind: 'candidate-snapshot',
      repositorySha256,
      baseRevision: before,
      scopeManifestSha256: scope.scopeSha256,
      candidateSha256
    },
    files: first,
    lineEndingPolicy,
    pathNormalization: 'posix-relative'
  }, 'sourceManifestSha256'));
  const reference = candidateReference(sourceSnapshot.sourceManifestSha256);
  const resolved = git(root, ['rev-parse', '--verify', '--quiet', reference], {
    maxBuffer: 1024 * 1024, allowFailure: true
  });
  const current = resolved.status === 0 ? String(resolved.stdout).trim() : '';
  if (current && current !== commit) {
    contractFailure('Candidate Snapshot reference conflicts with an existing immutable source.', 'WMB_SOURCE_SNAPSHOT_TAMPERED', {
      reference, expectedCommit: commit, actualCommit: current
    });
  }
  if (!current) git(root, ['update-ref', reference, commit]);
  await writeImmutablePrivateSidecar(
    root,
    candidateRecordPath(root, sourceSnapshot.sourceManifestSha256),
    Buffer.from(canonicalJson(sourceSnapshot), 'utf8'),
    { maximumBytes: CANDIDATE_RECORD_MAXIMUM_BYTES }
  );
  return verifyExactSourceSnapshot(root, sourceSnapshot, { scopeManifest: scope });
}

function validateCandidateAuthority(snapshot) {
  const authority = snapshot.authority;
  if (!authority) return null;
  assertExactKeys(authority, {
    required: [
      'kind', 'repositorySha256', 'baseRevision', 'scopeManifestSha256', 'candidateSha256'
    ],
    label: 'Candidate Snapshot authority'
  });
  if (authority.kind !== 'candidate-snapshot') {
    contractFailure(`Unknown Source Snapshot authority '${authority.kind}'.`, 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
  assertSha256(authority.repositorySha256, 'Candidate repositorySha256');
  assertExactKeys(authority.baseRevision, {
    required: ['commit', 'tree'], label: 'Candidate base revision'
  });
  assertString(authority.baseRevision.commit, 'Candidate base commit', { pattern: COMMIT_PATTERN });
  assertString(authority.baseRevision.tree, 'Candidate base tree', { pattern: COMMIT_PATTERN });
  assertSha256(authority.scopeManifestSha256, 'Candidate scopeManifestSha256');
  assertSha256(authority.candidateSha256, 'Candidate candidateSha256');
  const actual = candidateIdentity({
    repositorySha256: authority.repositorySha256,
    baseRevision: authority.baseRevision,
    scopeManifestSha256: authority.scopeManifestSha256,
    files: snapshot.files
  });
  if (actual !== authority.candidateSha256) {
    contractFailure('Candidate Snapshot identity does not match its exact source projection.', 'WMB_SOURCE_SNAPSHOT_TAMPERED', {
      expected: authority.candidateSha256, actual
    });
  }
  return authority;
}

/** Resolve only a content-addressed private Candidate Snapshot; arbitrary paths are never read. */
export async function loadCandidateSourceSnapshot(root, reference, { scopeManifest = null } = {}) {
  const match = /^(?:sha256:|sfref:source-snapshot:)?(?<digest>[a-f0-9]{64})$/.exec(String(reference ?? '').trim());
  if (!match) {
    contractFailure(
      'Candidate Snapshot must be an exact sha256 reference returned by `wm snapshot`.',
      'WMB_SOURCE_SNAPSHOT_REQUIRED'
    );
  }
  const digest = `sha256:${match.groups.digest}`;
  const bytes = await readPrivateSidecar(root, candidateRecordPath(root, digest), {
    maximumBytes: CANDIDATE_RECORD_MAXIMUM_BYTES
  });
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (error) {
    contractFailure('Candidate Snapshot record is not valid canonical JSON.', 'WMB_SOURCE_SNAPSHOT_TAMPERED', { cause: error.message });
  }
  const snapshot = validateSourceSnapshot(value);
  if (snapshot.sourceManifestSha256 !== digest || !snapshot.authority) {
    contractFailure('Candidate Snapshot reference does not match the stored exact source.', 'WMB_SOURCE_SNAPSHOT_TAMPERED', {
      expected: digest, actual: snapshot.sourceManifestSha256
    });
  }
  return verifyExactSourceSnapshot(root, snapshot, { scopeManifest });
}

export function validateSourceSnapshot(value) {
  assertPlainRecord(value, 'World-model Source Snapshot');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'subject', 'revision', 'files', 'lineEndingPolicy',
      'pathNormalization', 'sourceManifestSha256'
    ],
    optional: ['authority'],
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
      optional: ['objectId'],
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
    if (file.objectId != null) assertString(file.objectId, `Source file '${file.path}' objectId`, { pattern: COMMIT_PATTERN });
  }
  assertCanonicalOrder(value.files, (file) => file.path, 'Source files');
  if (value.lineEndingPolicy !== 'preserve-source') contractFailure("Source lineEndingPolicy must be 'preserve-source'.", 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  if (value.pathNormalization !== 'posix-relative') contractFailure("Source pathNormalization must be 'posix-relative'.", 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  assertSha256(value.sourceManifestSha256, 'Source sourceManifestSha256');
  assertSelfHash(value, 'sourceManifestSha256', 'World-model Source Snapshot');
  const authority = validateCandidateAuthority(value);
  if (authority) {
    for (const file of value.files) {
      if (file.type !== 'regular' || !file.objectId) {
        contractFailure(
          `Candidate Snapshot file '${file.path}' must be a regular file with an exact Git object identity.`,
          'WMB_SOURCE_SNAPSHOT_REQUIRED', { path: file.path }
        );
      }
    }
  } else if (value.files.some((file) => file.objectId != null)) {
    contractFailure('Commit Source Snapshot files cannot carry Candidate object identities.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  }
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
  const object = snapshot.authority ? file.objectId : `${snapshot.revision.commit}:${relative}`;
  const bytes = Buffer.from(git(root, ['cat-file', 'blob', object], { binary: true }));
  const digest = `sha256:${sha256Bytes(bytes)}`;
  if (bytes.length !== file.bytes || digest !== file.contentSha256) {
    contractFailure(`Pinned source object for '${relative}' does not match the Source Snapshot.`, 'WMB_SOURCE_SNAPSHOT_STALE', {
      path: relative, expectedSha256: file.contentSha256, actualSha256: digest
    });
  }
  return bytes;
}

function verifyCandidateSnapshot(root, snapshot, scopeManifest) {
  const authority = validateCandidateAuthority(snapshot);
  if (!authority) contractFailure('Source is not a Candidate Snapshot.', 'WMB_SOURCE_SNAPSHOT_REQUIRED');
  if (repositoryIdentity(root) !== authority.repositorySha256) {
    contractFailure(
      'Candidate Snapshot belongs to a different Git repository object store.',
      'WMB_SOURCE_SNAPSHOT_TAMPERED', { expected: authority.repositorySha256 }
    );
  }
  if (scopeManifest) {
    const scope = validateScopeManifest(scopeManifest);
    if (scope.scopeSha256 !== authority.scopeManifestSha256
        || snapshot.files.some((file) => !pathInsideScope(file.path, scope))) {
      contractFailure(
        'Candidate Snapshot does not bind the requested exact Scope Manifest.',
        'WMB_SCOPE_MISMATCH', {
          expected: authority.scopeManifestSha256, actual: scope.scopeSha256
        }
      );
    }
  }
  const reference = candidateReference(snapshot.sourceManifestSha256);
  const resolved = git(root, ['rev-parse', '--verify', '--quiet', reference], { allowFailure: true });
  const commit = resolved.status === 0 ? String(resolved.stdout).trim() : '';
  if (commit !== snapshot.revision.commit) {
    contractFailure(
      'Candidate Snapshot immutable Git reference is missing or does not bind its exact commit.',
      'WMB_SOURCE_SNAPSHOT_TAMPERED', { reference, expected: snapshot.revision.commit, actual: commit || null }
    );
  }
  const actualTree = String(git(root, ['rev-parse', `${snapshot.revision.commit}^{tree}`])).trim();
  if (actualTree !== snapshot.revision.tree) {
    contractFailure('Candidate Snapshot commit does not bind its declared exact tree.', 'WMB_SOURCE_SNAPSHOT_TAMPERED');
  }
  const entries = treeEntries(root, snapshot.revision.commit);
  const exact = entries.map((entry) => {
    const bytes = blobBytes(root, entry.gitObjectId);
    return {
      path: entry.path,
      type: fileType(entry.mode),
      mode: entry.mode,
      contentSha256: `sha256:${sha256Bytes(bytes)}`,
      bytes: bytes.length,
      objectId: entry.gitObjectId
    };
  });
  if (canonicalJson(exact) !== canonicalJson(snapshot.files)) {
    contractFailure(
      'Candidate Snapshot Git tree does not reproduce its path, mode, object, and content hashes.',
      'WMB_SOURCE_SNAPSHOT_TAMPERED'
    );
  }
  return snapshot;
}

export function verifyExactSourceSnapshot(root, snapshotValue, { scopeManifest = null } = {}) {
  const snapshot = validateSourceSnapshot(snapshotValue);
  if (snapshot.authority) return verifyCandidateSnapshot(root, snapshot, scopeManifest);
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
