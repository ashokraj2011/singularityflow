/** Bounded, local recovery copies. Never stages, commits, stashes or overwrites working files. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { changedFiles, gitCommonDir, gitDir, head, branch } from './git.mjs';
import { recordSha256, canonicalJson } from './records.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar } from './private-sidecar.mjs';
import { requiredArtifactRepoPath } from './publication-preflight.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { z } from 'zod';

const MAX_FILES = 512; const MAX_FILE_BYTES = 16 * 1024 * 1024; const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const digest = value => `sha256:${recordSha256(value)}`;
const fail = (message, code = 'PHASE_CHECKPOINT_UNAVAILABLE') => { throw new SingularityFlowError(message,
  { code, details: { preserved: true, automaticDiscard: false, retrySkill: '/sf-recover' } }); };
const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 2048
  && !path.isAbsolute(value) && !/\\|[\x00-\x1f\x7f]|(?:^|\/)\.\.(?:\/|$)|^\.git(?:\/|$)/iu.test(value)
  && !/^[A-Za-z]:/u.test(value);
const storageOptions = { enforceWindowsAcl: true };
const blobSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const checkpointSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal('phase-checkpoint'),
  workId: z.string().min(1), phaseId: z.string().min(1), generation: z.number().int().nonnegative(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/u),
  files: z.array(z.discriminatedUnion('kind', [
    z.object({ path: z.string().refine(safeRelative), kind: z.literal('file'), blob: blobSchema,
      bytes: z.number().int().min(0).max(MAX_FILE_BYTES), mode: z.number().int().nonnegative() }).strict(),
    z.object({ path: z.string().refine(safeRelative), kind: z.literal('missing'), blob: z.null(),
      bytes: z.literal(0), mode: z.null() }).strict()
  ])).max(MAX_FILES),
  index: z.object({ blob: blobSchema, bytes: z.number().int().min(0).max(MAX_INDEX_BYTES) }).strict(),
  totalBytes: z.number().int().min(0).max(MAX_TOTAL_BYTES)
}).strict().refine(record => new Set(record.files.map(file => file.path)).size === record.files.length
  && record.files.reduce((total, file) => total + file.bytes, 0) === record.totalBytes);
async function storage(root, workflow, phase) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'phase-checkpoints',
    digest({ checkout: await realpath(root), workId: workflow.workItem.id, phaseId: phase.id }).slice(7));
}
async function fileCopy(absolute, maximumBytes) {
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximumBytes) fail('Recovery copy requires a bounded ordinary file; preserve the original for owner review.');
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail('File changed while checkpoint opened.', 'PHASE_CHECKPOINT_STALE');
    const buffer = Buffer.alloc(Math.min(maximumBytes + 1, before.size + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!result.bytesRead) break; offset += result.bytesRead;
    }
    const after = await handle.stat(); const rebound = await lstat(absolute);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.mode !== after.mode || rebound.dev !== opened.dev || rebound.ino !== opened.ino) fail('File changed during checkpoint capture.', 'PHASE_CHECKPOINT_STALE');
    return { bytes: buffer.subarray(0, offset), mode: before.mode };
  } finally { await handle.close(); }
}

/** Capture index plus all dirty paths, not a full repository clone or an application-source scan. */
export async function createPhaseCheckpoint(root, config, workflow, phase) {
  if (workflow.currentPhase !== phase.id || workflow.status !== 'in_progress'
      || !['in_progress', 'awaiting_approval'].includes(phase.status)
      || branch(root) !== workflow.workItem.branch) fail('Select the current Story checkout before preserving its work.');
  const directory = await storage(root, workflow, phase);
  const revision = head(root); const dirty = changedFiles(root);
  const paths = [...new Set([...dirty, ...(phase.requiredArtifact?.path
    ? [requiredArtifactRepoPath(config, workflow, phase)] : [])])].sort();
  if (paths.length > MAX_FILES || paths.some(value => !safeRelative(value))) fail('The checkpoint exceeds its path bound or includes unsafe paths. Original files were not changed.');
  const copies = []; let total = 0;
  for (const relative of paths) {
    // Validate ancestors even for missing files; never follow a symlink into another repository.
    const safe = await secureRepositoryPath(root, relative, { label: 'Phase recovery copy' });
    let info;
    try { info = await lstat(safe.absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      copies.push({ path: relative, kind: 'missing', blob: null, bytes: 0, mode: null }); continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) fail('Linked or non-file changes require owner review. No work was removed.');
    const copied = await fileCopy(safe.absolute, MAX_FILE_BYTES);
    total += copied.bytes.length;
    if (total > MAX_TOTAL_BYTES) fail('Dirty work exceeds the recovery-copy byte bound. Preserve it with a reviewed external backup; no files were removed.');
    const blob = digest({ bytes: copied.bytes.toString('base64') });
    copies.push({ path: relative, kind: 'file', blob, bytes: copied.bytes.length, mode: copied.mode });
    await writeImmutablePrivateSidecar(root, path.join(directory, 'blobs', blob.slice(7)), copied.bytes,
      { ...storageOptions, maximumBytes: MAX_FILE_BYTES });
  }
  const indexPath = path.join(gitDir(root), 'index');
  const index = await fileCopy(indexPath, MAX_INDEX_BYTES);
  const indexBlob = digest({ bytes: index.bytes.toString('base64') });
  await writeImmutablePrivateSidecar(root, path.join(directory, 'blobs', indexBlob.slice(7)), index.bytes,
    { ...storageOptions, maximumBytes: MAX_INDEX_BYTES });
  const reboundIndex = await fileCopy(indexPath, MAX_INDEX_BYTES);
  if (head(root) !== revision || canonicalJson(changedFiles(root)) !== canonicalJson(dirty)
      || !index.bytes.equals(reboundIndex.bytes)) fail('The checkout moved during preservation. Review and capture again; originals were not changed.', 'PHASE_CHECKPOINT_STALE');
  // Re-read captured paths too: an edit to an already-dirty path does not change Git's path list.
  for (const copy of copies) {
    const safe = await secureRepositoryPath(root, copy.path, { label: 'Phase recovery copy' });
    if (copy.kind === 'missing') {
      try { await lstat(safe.absolute); fail('A missing path was created during capture.', 'PHASE_CHECKPOINT_STALE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      const fresh = await fileCopy(safe.absolute, MAX_FILE_BYTES);
      if (digest({ bytes: fresh.bytes.toString('base64') }) !== copy.blob || fresh.mode !== copy.mode) {
        fail('Authored bytes or file mode changed during preservation.', 'PHASE_CHECKPOINT_STALE');
      }
    }
  }
  const core = { schemaVersion: 1, kind: 'phase-checkpoint', workId: workflow.workItem.id,
    phaseId: phase.id, generation: phase.generationIntent?.generation ?? phase.generation ?? 0,
    head: revision, files: copies, index: { blob: indexBlob, bytes: index.bytes.length }, totalBytes: total };
  const id = `PCP-${digest(core).slice(7)}`;
  await writeImmutablePrivateSidecar(root, path.join(directory, `${id}.json`), Buffer.from(canonicalJson(core)),
    { ...storageOptions, maximumBytes: 1024 * 1024 });
  return { id, workId: core.workId, phaseId: core.phaseId, files: copies.length, totalBytes: total,
    localFilesChanged: true, workingTreeChanged: false, indexChanged: false, stateChanged: false,
    preserved: ['dirty working-tree files', 'Git index', 'published generations', 'approval history'],
    next: `singularity-flow appeal checkpoint-show ${id} --work-id ${core.workId} --phase ${phase.id} --json` };
}

/** Verified paths for manual recovery. No worktree or index replacement is automatic. */
export async function inspectPhaseCheckpoint(root, workflow, phase, id) {
  if (!/^PCP-[a-f0-9]{64}$/u.test(id ?? '')) fail('Choose an exact retained checkpoint ID.');
  const directory = await storage(root, workflow, phase);
  const bytes = await readPrivateSidecar(root, path.join(directory, `${id}.json`),
    { ...storageOptions, maximumBytes: 1024 * 1024 });
  let record;
  try { record = checkpointSchema.parse(JSON.parse(bytes.toString('utf8'))); }
  catch { fail('Recovery-copy manifest is malformed. No originals were changed.', 'PHASE_CHECKPOINT_INTEGRITY'); }
  if (canonicalJson(record) !== bytes.toString('utf8') || `PCP-${digest(record).slice(7)}` !== id
      || record.kind !== 'phase-checkpoint' || record.workId !== workflow.workItem.id || record.phaseId !== phase.id
      || !Array.isArray(record.files) || record.files.length > MAX_FILES) fail('Recovery-copy manifest could not be authenticated.', 'PHASE_CHECKPOINT_INTEGRITY');
  const verifyBlob = async (blob, maximumBytes, expectedBytes) => {
    if (!/^sha256:[a-f0-9]{64}$/u.test(blob ?? '')) fail('Recovery-copy object identity is invalid.', 'PHASE_CHECKPOINT_INTEGRITY');
    const sourcePath = path.join(directory, 'blobs', blob.slice(7));
    const data = await readPrivateSidecar(root, sourcePath, { ...storageOptions, maximumBytes });
    if (data.length !== expectedBytes || digest({ bytes: data.toString('base64') }) !== blob) fail('Recovery-copy bytes changed.', 'PHASE_CHECKPOINT_INTEGRITY');
    return sourcePath;
  };
  const files = [];
  for (const entry of record.files) {
    if (!safeRelative(entry.path)) fail('Recovery-copy path is unsafe.', 'PHASE_CHECKPOINT_INTEGRITY');
    files.push({ ...entry, recoveryCopy: entry.kind === 'file' ? await verifyBlob(entry.blob, MAX_FILE_BYTES, entry.bytes) : null });
  }
  return { id, ...record, files, index: { ...record.index, recoveryCopy: await verifyBlob(record.index.blob, MAX_INDEX_BYTES, record.index.bytes) },
    automaticRestore: false, mutates: false,
    guidance: 'Review the recovery copies against current files. Restore only explicitly selected authored files in a human-reviewed operation. Do not replace approved evidence or the Git index automatically.' };
}
