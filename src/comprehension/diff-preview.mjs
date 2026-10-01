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

function patchSections(patch, entries) {
  const starts = [...patch.matchAll(/^diff --git /gmu)].map((match) => match.index);
  if (!starts.length || starts[0] !== 0 || starts.length !== entries.length) {
    return { status: 'unavailable', reason: 'file-section-count-mismatch', files: [] };
  }
  // Git orders sections by path, while the change set lists entries in its own order (an added
  // file has no old path and sorts first), so each entry is matched to the section whose header
  // names it. Every header must be distinct and every entry must claim exactly one section.
  const sections = new Map();
  for (const [index, patchStart] of starts.entries()) {
    const patchEnd = starts[index + 1] ?? patch.length;
    const block = patch.slice(patchStart, patchEnd);
    const header = block.slice(0, block.indexOf('\n') < 0 ? block.length : block.indexOf('\n'));
    if (sections.has(header)) return { status: 'unavailable', reason: 'file-section-identity-mismatch', files: [] };
    sections.set(header, { patchStart, patchEnd, block });
  }
  const files = [];
  for (const entry of entries) {
    const before = entry.oldPath ?? entry.newPath;
    const after = entry.newPath ?? entry.oldPath;
    const expectedHeader = `diff --git a/${before} b/${after}`;
    const section = sections.get(expectedHeader);
    if (!section) return { status: 'unavailable', reason: 'file-section-identity-mismatch', files: [] };
    sections.delete(expectedHeader);
    const { patchStart, patchEnd, block } = section;
    const hunks = [...block.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gmu)]
      .map((match) => ({
        header: match[0],
        beforeStart: Number(match[1]),
        beforeLines: match[2] == null ? 1 : Number(match[2]),
        afterStart: Number(match[3]),
        afterLines: match[4] == null ? 1 : Number(match[4])
      }));
    files.push({
      sourceChangeId: entry.changeId,
      operation: entry.status,
      pathBefore: entry.oldPath ?? null,
      pathAfter: entry.newPath ?? null,
      patchStart,
      patchEnd,
      bytes: Buffer.byteLength(block, 'utf8'),
      patchSha256: sha256(Buffer.from(block, 'utf8')),
      hunks
    });
  }
  return { status: 'available', reason: null, files };
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
  contextLines = CMP_DIFF_PREVIEW_LIMITS.contextLines,
  // Only the change regions at these repository paths, when given: a reader that needs a few files
  // need not read, or hit the byte limit on, everything else the change touched.
  paths = null
} = {}) {
  const integrity = verifyRepositoryChangeSetIntegrity(changeSet);
  if (!integrity.valid) {
    return result(changeSet ?? { digest: null }, {
      status: 'unavailable', reason: 'change-set-integrity-invalid', patch: null,
      patchSha256: null, bytes: 0, trackedRegions: 0, omittedUntrackedRegions: 0,
      fileProjectionStatus: 'unavailable', fileProjectionReason: 'change-set-integrity-invalid', files: []
    });
  }
  const selected = Array.isArray(paths) ? new Set(paths) : null;
  // A renamed file is selected by either of its paths, and both go to Git so it still pairs them.
  const trackedEntries = changeSet.entries.filter((entry) => !entry.untracked
    && (!selected || selected.has(entry.newPath) || selected.has(entry.oldPath)));
  const trackedRegions = trackedEntries.length;
  const omittedUntrackedRegions = changeSet.entries.length - changeSet.entries.filter((entry) => !entry.untracked).length;
  const pathspecs = selected
    ? [...new Set(trackedEntries.flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))].map((relative) => `:(literal)${relative}`)
    : [];
  if (!trackedRegions) {
    return result(changeSet, {
      status: changeSet.entries.length ? 'unavailable' : 'not-applicable',
      reason: changeSet.entries.length ? 'untracked-content-not-projected' : 'no-change-regions',
      patch: null, patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions,
      fileProjectionStatus: 'not-applicable', fileProjectionReason: 'no-tracked-regions', files: []
    });
  }
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1
      || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) {
    return result(changeSet, {
      status: 'unavailable', reason: 'preview-limits-invalid', patch: null,
      patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions,
      fileProjectionStatus: 'unavailable', fileProjectionReason: 'preview-limits-invalid', files: []
    });
  }
  const response = run('git', [
    '-c', 'core.quotePath=false', 'diff', '--patch', '--no-color', '--no-ext-diff', '--no-textconv',
    `--unified=${contextLines}`, '--find-renames', '--find-copies',
    '--src-prefix=a/', '--dst-prefix=b/', changeSet.base.commit, '--', ...pathspecs
  ], { cwd: root, allowFailure: true, maxBuffer: maximumBytes + 1 });
  if (response.status !== 0 || response.error) {
    return result(changeSet, {
      status: 'unavailable',
      reason: response.error?.code === 'ENOBUFS' ? 'preview-output-limit' : 'git-diff-unavailable',
      patch: null, patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions,
      fileProjectionStatus: 'unavailable', fileProjectionReason: 'patch-unavailable', files: []
    });
  }
  const patch = String(response.stdout ?? '');
  const bytes = Buffer.byteLength(patch, 'utf8');
  if (bytes > maximumBytes) {
    return result(changeSet, {
      status: 'unavailable', reason: 'preview-output-limit', patch: null,
      patchSha256: null, bytes: 0, trackedRegions, omittedUntrackedRegions,
      fileProjectionStatus: 'unavailable', fileProjectionReason: 'preview-output-limit', files: []
    });
  }
  const sections = patch ? patchSections(patch, trackedEntries) : {
    status: 'unavailable', reason: 'git-diff-empty', files: []
  };
  return result(changeSet, {
    status: patch ? 'available' : 'unavailable',
    reason: patch ? null : 'git-diff-empty',
    patch: patch || null,
    patchSha256: patch ? sha256(Buffer.from(patch, 'utf8')) : null,
    bytes,
    trackedRegions,
    omittedUntrackedRegions,
    fileProjectionStatus: sections.status,
    fileProjectionReason: sections.reason,
    files: sections.files
  });
}
