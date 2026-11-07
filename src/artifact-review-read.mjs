/** Canonical read-only artifact bytes, author-owned fingerprints and draft catalog. */
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { memberRoot, resolvedArtifactSet } from './artifact-sets.mjs';
import { authoredArtifactFingerprintText } from './kernel/artifact-content.mjs';
export { MANAGED_INPUTS, MANAGED_METADATA, MANAGED_METADATA_MARKER, maskBlock, authoredArtifactText, artifactTextCheckoutMatches, inspectManagedArtifactMetadata } from './kernel/artifact-content.mjs';

export function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function supportedFileIdentityPart(value) {
  if (typeof value === 'bigint') return value > 0n ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  return null;
}

/**
 * Decide whether descriptor and path metadata can safely prove that they name the same file.
 *
 * BigInt values avoid silently rounded inode/file-index values. Some Windows filesystems and
 * filter drivers nevertheless report different non-zero identities through `fstat` and `lstat`.
 * A mismatch there is therefore a request for canonical-path plus exact-byte verification, not a
 * false unsafe-path refusal. A supported mismatch remains a hard path-race signal on platforms
 * where device/inode identity is stable.
 */
export function reviewArtifactIdentityDecision(opened, rebound, { platform = process.platform } = {}) {
  const openedDev = supportedFileIdentityPart(opened?.dev);
  const openedIno = supportedFileIdentityPart(opened?.ino);
  const reboundDev = supportedFileIdentityPart(rebound?.dev);
  const reboundIno = supportedFileIdentityPart(rebound?.ino);
  if ([openedDev, openedIno, reboundDev, reboundIno].some((value) => value == null)) {
    return 'verify-bytes';
  }
  if (openedDev === reboundDev && openedIno === reboundIno) return 'match';
  return platform === 'win32' ? 'verify-bytes' : 'mismatch';
}

/** Exact bytes are the portable evidence boundary when host file identity is unavailable. */
export function reviewArtifactBytesStable(opened, rebound) {
  return Buffer.from(opened).equals(Buffer.from(rebound));
}

/**
 * Return only bytes owned by the current artifact author.
 *
 * Lifecycle metadata and approved upstream inputs can be large, but neither proves that the
 * current producer completed the artifact. Publication, recovery, manual import and host guidance
 * all use this boundary so an artifact cannot look complete on one surface and fail on another.
 */
/**
 * Accept only the exact text or its uniform LF/CRLF checkout representation. The immutable Git
 * blob and the worktree keep their distinct raw hashes. No trimming, Unicode normalization,
 * arbitrary CR removal, mixed endings, BOM or missing final newline can establish equivalence.
 */
/** Match an approved raw snapshot without relabeling either raw hash as equal. */
export function artifactSnapshotCheckoutMatches(expected, bytes) {
  if (!expected?.exists || !Buffer.isBuffer(bytes)) return false;
  const matches = value => Buffer.byteLength(value) === expected.size
    && createHash('sha256').update(value).digest('hex') === expected.sha256;
  if (matches(bytes)) return true;
  const text = bytes.toString('utf8');
  // Only lossless ordinary UTF-8 text may have a checkout representation. In particular no
  // replacement characters, binary NUL, BOM removal, trimming or arbitrary CR normalization.
  if (!Buffer.from(text, 'utf8').equals(bytes) || text.includes('\0') || text.startsWith('\uFEFF')) return false;
  const lf = text.replaceAll('\r\n', '\n');
  if (lf.includes('\r')) return false;
  const crlf = lf.replaceAll('\n', '\r\n');
  if (text !== lf && text !== crlf) return false;
  return matches(lf) || matches(crlf);
}

/** Whitespace-only padding cannot make an untouched prepared template look authored. */
export function authoredArtifactFingerprint(text) {
  return sha256(authoredArtifactFingerprintText(text));
}

export function requiredArtifactRepoPath(config, workflow, phase) {
  return `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/${phase.requiredArtifact.path}`;
}

export function unsafeReviewArtifact(label, relative, reason, cause = null) {
  const description = reason === 'symbolic-link'
    ? `${label} cannot be a symbolic link: ${relative}`
    : reason === 'non-regular-file'
      ? `${label} must be a regular file: ${relative}`
      : `${label} changed while it was being read: ${relative}`;
  return new SingularityFlowError(description, {
    code: 'REPOSITORY_PATH_UNSAFE', details: { path: relative, reason }, ...(cause ? { cause } : {})
  });
}

export function canonicalPathKey(value, platform) {
  const normalized = path.resolve(String(value));
  return platform === 'win32'
    ? normalized.replaceAll('\\', '/').toLocaleLowerCase('en-US')
    : normalized;
}

export function sameStatValue(left, right) {
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    try {
      return BigInt(left) === BigInt(right);
    } catch {
      return false;
    }
  }
  return left === right;
}

export async function reboundReviewArtifact(root, secured, openedStat, label, platform) {
  const rebound = await secureRepositoryPath(root, secured.relative, {
    label, mustExist: true, type: 'file'
  });
  if (canonicalPathKey(rebound.root, platform) !== canonicalPathKey(secured.root, platform)
      || canonicalPathKey(rebound.absolute, platform) !== canonicalPathKey(secured.absolute, platform)) {
    throw unsafeReviewArtifact(label, secured.relative, 'path-race');
  }

  // Request BigInt metadata independently of secureRepositoryPath's general-purpose Stats object.
  // This keeps large Windows file-index values exact without changing that shared API's callers.
  const entry = await lstat(rebound.absolute, { bigint: true });
  if (entry.isSymbolicLink()) throw unsafeReviewArtifact(label, secured.relative, 'symbolic-link');
  if (!entry.isFile()) throw unsafeReviewArtifact(label, secured.relative, 'non-regular-file');
  const identity = reviewArtifactIdentityDecision(openedStat, entry, { platform });
  if (identity === 'mismatch') throw unsafeReviewArtifact(label, secured.relative, 'path-race');
  return identity;
}

export async function readPinnedReviewArtifact(root, relative, label, {
  mustExist = false, platform = process.platform, maximumBytes = null
} = {}) {
  if (maximumBytes !== null && (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)) throw new TypeError('maximumBytes must be a nonnegative safe integer.');
  const secured = await secureRepositoryPath(root, relative, { label, mustExist, type: 'file' });
  if (!secured.exists) return null;
  let handle;
  try {
    handle = await open(secured.absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw unsafeReviewArtifact(label, secured.relative, 'non-regular-file');

    const beforeBinding = await reboundReviewArtifact(root, secured, before, label, platform);
    if (maximumBytes !== null && before.size > BigInt(maximumBytes)) {
      throw new SingularityFlowError(`${label} exceeds its ${maximumBytes}-byte read limit: ${relative}`, { code: 'REVIEW_ARTIFACT_TOO_LARGE' });
    }
    let bytes;
    if (maximumBytes === null) bytes = await handle.readFile();
    else {
      const buffer = Buffer.alloc(maximumBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        const next = await handle.read(buffer, count, buffer.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      if (count > maximumBytes) throw new SingularityFlowError(`${label} exceeded its read limit while reading: ${relative}`, { code: 'REVIEW_ARTIFACT_TOO_LARGE' });
      bytes = buffer.subarray(0, count);
    }
    const after = await handle.stat({ bigint: true });
    const descriptorIdentity = reviewArtifactIdentityDecision(before, after, { platform });
    const beforeMtime = before.mtimeNs ?? before.mtimeMs;
    const afterMtime = after.mtimeNs ?? after.mtimeMs;
    if (descriptorIdentity === 'mismatch' || !sameStatValue(before.size, after.size)
        || !sameStatValue(beforeMtime, afterMtime)) {
      throw unsafeReviewArtifact(label, secured.relative, 'content-race');
    }
    const afterBinding = await reboundReviewArtifact(root, secured, after, label, platform);
    return {
      bytes,
      verifyBytes: beforeBinding !== 'match'
        || descriptorIdentity !== 'match'
        || afterBinding !== 'match'
    };
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      throw unsafeReviewArtifact(label, secured.relative, 'symbolic-link', error);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read one review document without following a final symlink or trusting a path after validation.
 *
 * `secureRepositoryPath` proves the lexical and canonical repository boundary. The descriptor then
 * pins that exact regular file with `O_NOFOLLOW` where the host provides it. Stable BigInt file
 * identity closes path replacement where the host supports it. When identity is unavailable (or
 * unreliable on Windows), a second pinned read must produce exactly the same bytes before those
 * bytes can become governed review evidence.
 */
export async function readReviewArtifactBytes(root, relative, label, options = {}) {
  const opened = await readPinnedReviewArtifact(root, relative, label, options);
  if (opened == null) return null;
  if (opened.verifyBytes) {
    const rebound = await readPinnedReviewArtifact(root, relative, label, { ...options, mustExist: true });
    if (!reviewArtifactBytesStable(opened.bytes, rebound.bytes)) {
      throw unsafeReviewArtifact(label, relative, 'content-race');
    }
  }
  return opened.bytes;
}

export async function readReviewArtifact(root, relative, label) {
  const bytes = await readReviewArtifactBytes(root, relative, label);
  return bytes == null ? null : bytes.toString('utf8');
}

export function reviewableMarkdownPath(relativePath) {
  return /\.(?:md|markdown)$/i.test(String(relativePath));
}

export function aggregateReviewableFingerprint(artifacts) {
  const digest = createHash('sha256');
  for (const artifact of [...artifacts].sort((left, right) => left.path.localeCompare(right.path))) {
    // Include absent declared members as well as present ones. Adding a previously absent optional
    // review document is a draft change just as surely as editing an existing document is.
    digest.update(`${artifact.path}\0${artifact.exists ? artifact.fingerprint : '<missing>'}\n`);
  }
  return `sha256:${digest.digest('hex')}`;
}

/**
 * Catalogue the complete human-reviewable Story draft, independent of declaration order.
 *
 * This is deliberately smaller than an artifact-set catalogue: source trees, test receipts and
 * binary evidence are not prose drafts. The returned aggregate is what authoring hosts use for
 * bounded repair progress, so changing only a supporting Markdown document must change it.
 */
export async function phaseAuthoredReviewArtifacts(root, config, workflow, phase, { observeFile = null, primaryOnly = false } = {}) {
  const required = requiredArtifactRepoPath(config, workflow, phase);
  const declared = new Map([[required, { path: required, scope: 'primary' }]]);
  const set = resolvedArtifactSet(config, workflow, phase);
  // Draft-progress hints need only the primary. Publication/review keep the complete default;
  // this selection never claims that supporting documents are valid or ready for publication.
  if (set && !primaryOnly) {
    const phaseArtifactRoot = path.posix.join(
      config.workItemRoot ?? 'singularity/work-items',
      workflow.workItem.id,
      memberRoot(phase)
    );
    for (const member of set.members) {
      if (member.authority !== 'governed') continue;
      const relative = path.posix.join(phaseArtifactRoot, member.path);
      if (relative === required || member.path.endsWith('/') || !reviewableMarkdownPath(relative)) continue;
      declared.set(relative, { path: relative, scope: 'supporting' });
    }
  }

  const artifacts = [];
  for (const declaration of [...declared.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    await observeFile?.(declaration.path);
    const text = await readReviewArtifact(
      root,
      declaration.path,
      declaration.scope === 'primary' ? 'Required phase artifact' : 'Supporting review artifact'
    );
    const bytes = text == null ? null : Buffer.from(text, 'utf8');
    artifacts.push(Object.freeze({
      ...declaration,
      exists: bytes != null,
      bytes: bytes?.length ?? null,
      sha256: bytes == null ? null : sha256(bytes),
      fingerprint: bytes == null ? null : authoredArtifactFingerprint(text)
    }));
  }
  return Object.freeze({
    artifacts: Object.freeze(artifacts),
    fingerprint: aggregateReviewableFingerprint(artifacts)
  });
}

/** Pure managed-envelope inspection; shared by prepublication and independent review. */
/**
 * Whether a step artifact's bytes can carry the managed metadata comment: UTF-8 text with no NUL.
 * A PDF, DOCX or PNG artifact was read as UTF-8 and given a Markdown comment, which corrupted it on
 * publish (2026-10-29). Its step record in workflow.json already holds the same metadata, and its
 * exact bytes stay bound by the registration, review and approval digests. Pure.
 */
export function artifactBytesAreText(bytes) {
  if (bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
