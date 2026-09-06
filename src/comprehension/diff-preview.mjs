/** Bounded, transient patch projection for the read-only Comprehension Center. */
import { createHash } from 'node:crypto';

import { verifyRepositoryChangeSetIntegrity } from '../repository-change-set.mjs';
import { run } from '../util.mjs';

export const CMP_DIFF_PREVIEW_LIMITS = Object.freeze({
  maximumBytes: 192 * 1024,
  contextLines: 3
});

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function result(changeSet, values) {
  return Object.freeze({
    schemaVersion: 1, // schema-transient: leased IDE content; never persisted or authorized
    kind: 'comprehension-diff-preview',
    authoritative: false,
    lifecycleGate: false,
    changeSetSha256: changeSet.digest,
    ...values
  });
}

/**
 * Read one exact Git patch for the selected baseline-to-worktree interval.
 *
 * The projection deliberately excludes untracked file bodies: unlike tracked patches, they have
 * no baseline object and may contain newly created credentials. Their paths remain visible in the
 * region manifest and can be opened by an explicit editor action. Output overflow degrades this
 * optional view instead of increasing the process-wide buffer or blocking ordinary work.
 */
export function buildComprehensionDiffPreview(root, changeSet, {
  maximumBytes = CMP_DIFF_PREVIEW_LIMITS.maximumBytes,
  contextLines = CMP_DIFF_PREVIEW_LIMITS.contextLines
} = {}) {
  const integrity = verifyRepositoryChangeSetIntegrity(changeSet);
  if (!integrity.valid) {
    return result(changeSet ?? { digest: null }, {
      status: 'unavailable', reason: 'change-set-integrity-invalid', patch: null,
      patchSha256: null, bytes: 0, trackedRegions: 0, omittedUntrackedRegions: 0
    });
  }
  const trackedRegions = changeSet.entries.filter((entry) => !entry.untracked).length;
  const omittedUntrackedRegions = changeSet.entries.length - trackedRegions;
  if (!trackedRegions) {
    return result(changeSet, {
      status: changeSet.entries.length ? 'unavailable' : 'not-applicable',
      reason: changeSet.entries.length ? 'untracked-content-not-projected' : 'no-change-regions',
      patch: null, patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions
    });
  }
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1
      || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) {
    return result(changeSet, {
      status: 'unavailable', reason: 'preview-limits-invalid', patch: null,
      patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions
    });
  }
  const response = run('git', [
    'diff', '--patch', '--no-color', '--no-ext-diff', '--no-textconv',
    `--unified=${contextLines}`, '--find-renames', '--find-copies',
    '--src-prefix=a/', '--dst-prefix=b/', changeSet.base.commit, '--'
  ], { cwd: root, allowFailure: true, maxBuffer: maximumBytes + 1 });
  if (response.status !== 0 || response.error) {
    return result(changeSet, {
      status: 'unavailable',
      reason: response.error?.code === 'ENOBUFS' ? 'preview-output-limit' : 'git-diff-unavailable',
      patch: null, patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions
    });
  }
  const patch = String(response.stdout ?? '');
  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes > maximumBytes) {
    return result(changeSet, {
      status: 'unavailable', reason: 'preview-output-limit', patch: null,
      patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions
    });
  }
  return result(changeSet, {
    status: patch ? 'available' : 'unavailable',
    reason: patch ? null : 'git-diff-empty',
    patch: patch || null,
    patchSha256: patch ? sha256(Buffer.from(patch, 'utf8')) : null,
    bytes,
    trackedRegions,
    omittedUntrackedRegions
  });
}
