/** Resume from observed private drafts and retained evidence; never infer reviewer judgments. */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { recordSha256 } from './records.mjs';

const MAXIMUM_BYTES = 8 * 1024 * 1024;

/** Read only the issued Git-private file, without following links or accepting special files. */
export async function readSourceReviewDraft(file, gitDirectory) {
  const relative = path.relative(gitDirectory, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Review draft escapes its issued Git directory.');
  let cursor = gitDirectory;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (info.isSymbolicLink() || (cursor !== file && !info.isDirectory())
        || (cursor === file && (!info.isFile() || info.nlink !== 1 || info.size > MAXIMUM_BYTES))) {
      throw Object.assign(new Error(`Review staging is not a bounded regular private file: ${cursor}`), { code: 'SOURCE_REVIEW_REPORT_STAGING_INVALID' });
    }
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAXIMUM_BYTES) throw new Error('Review draft changed while opening.');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > MAXIMUM_BYTES) throw new Error('Review draft grew beyond its read limit.');
    try { return { report: JSON.parse(text), raw: text }; }
    catch (error) { return { raw: text, error: { code: 'SOURCE_REVIEW_REPORT_INVALID', message: error.message } }; }
  } finally { await handle.close(); }
}

/** Preserve stale draft bytes independently of the editable staging inode, without overwriting. */
async function preservePreviousDraft(file, gitDirectory, draft) {
  const sha = createHash('sha256').update(draft.raw).digest('hex');
  const previous = path.join(path.dirname(file), `previous-review-${sha}.txt`);
  const temporary = path.join(path.dirname(file), `.previous-review-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(draft.raw); await handle.sync(); await handle.close(); handle = null;
    try { await link(temporary, previous); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readSourceReviewDraft(previous, gitDirectory);
      if (existing?.raw !== draft.raw) throw new Error('The previous review backup does not match its content address; existing files were preserved.');
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true });
  }
  return previous;
}

export function sourceReviewCheckProgress(input, stagingPath, checked, protocol) {
  const stale = checked.evaluation?.status === 'stale';
  const mappings = checked.repair?.mappingTasks?.length > 0;
  return { state: stale ? 'reload-context' : checked.retentionReady && !mappings ? 'retain-report' : 'repair-report',
    complete: false, bindingSha256: recordSha256(input.binding), stagingPath,
    instruction: checked.repair.instruction, retentionReady: checked.retentionReady,
    ...(stale ? {} : { nextAction: checked.retentionReady && !mappings ? protocol.retain : protocol.check }),
    findings: checked.findings, repair: checked.repair };
}

export async function sourceReviewProgress({ input, retained, stagingPath, gitDirectory, protocol, check }) {
  const base = { complete: false, bindingSha256: recordSha256(input.binding), stagingPath };
  if (retained.reportSha256 && retained.status !== 'stale') return { ...base, state: 'retained', complete: true,
    reportPath: retained.reportPath, reportSha256: retained.reportSha256,
    instruction: 'The review is already retained for these inputs. Report its actual findings and continuation; do not write or retain it again.' };
  let draft;
  try { draft = await readSourceReviewDraft(stagingPath, gitDirectory); }
  catch (error) { return { ...base, state: 'read-error', error: { code: error.code ?? 'SOURCE_REVIEW_DRAFT_READ_FAILED', message: error.message },
    instruction: 'Preserve the existing draft and report this exact read error. Do not replace or recreate the file.' }; }
  if (!draft) return { ...base, state: 'author-report',
    instruction: 'Author the independent report at stagingPath now using reportTemplate and the pinned inputs. Then check and retain it. An honest correction-required review can be retained; an unwritten report cannot. Do not relay the context command as the next step.' };
  if (draft.error) return { ...base, state: 'repair-report', error: draft.error, nextAction: protocol.check,
    instruction: 'Read and repair the JSON at stagingPath, preserving the existing draft. Check the changed packet and retain it when valid.' };
  const progress = sourceReviewCheckProgress(input, stagingPath, check(draft.report, input), protocol);
  if (progress.state !== 'reload-context') return progress;
  // This invocation already loaded fresh inputs. Re-entering context would find the same stale
  // file forever. Keep it as an exact private backup and require new independent judgments here.
  try {
    const previousDraftPath = await preservePreviousDraft(stagingPath, gitDirectory, draft);
    return { ...base, state: 'review-changed-inputs', previousDraftPath,
      instruction: 'This context is already fresh. The previous draft is preserved at previousDraftPath. Independently review the current pinned inputs and author a replacement from reportTemplate at stagingPath; never transplant stale citations, binding or judgments. Then check and retain it. Do not request context again.' };
  } catch (error) { return { ...base, state: 'read-error',
    error: { code: error.code ?? 'SOURCE_REVIEW_DRAFT_PRESERVATION_FAILED', message: error.message },
    instruction: 'Preserve the original staged report and report this exact preservation error; no draft was replaced.' }; }
}

/** The operation already entered: its next step is authoring/repair/retention, never entry again. */
export function sourceReviewProgressContinuation(progress, afterRetention) {
  if (progress.complete) return afterRetention;
  const action = progress.nextAction ? { ...progress.nextAction, reason: progress.instruction } : null;
  return { classification: `source-review-${progress.state}`, automaticAdvance: false,
    instruction: progress.instruction, actions: action ? [action] : [],
    nextAction: action, nextCommand: action?.command ?? null,
    nextSkill: action?.skill ?? null, copilotCommand: action?.copilotCommand ?? null };
}
