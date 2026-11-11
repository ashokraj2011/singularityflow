/** Resume from observed private drafts and retained evidence; never infer reviewer judgments. */
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { recordSha256 } from './records.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

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

/** How a report reaches stagingPath, for a reviewer with a terminal alone or with a file-edit tool too. */
const STAGE_ROUTE = 'Stage it with stagingProtocol.kernelStage (review-source stage <phase> --report-json \'<REPORT-JSON>\' --json, the whole JSON in one argument): it writes stagingPath even before the report is valid and returns the exact repairs; stage the repaired JSON again the same way. A host with a file-edit tool may instead write stagingPath and run stagingProtocol.check.';

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
  const workId = input.workId ?? input.binding?.workId;
  const phaseId = input.phaseId ?? input.phase ?? input.binding?.phaseId ?? input.binding?.phase;
  const readRecovery = workId && phaseId ? safeCommandGuidance({ argv: ['recover', workId,
    '--phase', phaseId, '--for-agent', '--json'] }) : null;
  if (retained.reportSha256 && retained.status !== 'stale') return { ...base, state: 'retained', complete: true,
    reportPath: retained.reportPath, reportSha256: retained.reportSha256,
    instruction: 'The review is already retained for these inputs. Report its actual findings and continuation; do not write or retain it again.' };
  let draft;
  try { draft = await readSourceReviewDraft(stagingPath, gitDirectory); }
  catch (error) { return { ...base, state: 'read-error', ...(readRecovery ? { nextAction: readRecovery } : {}), error: { code: error.code ?? 'SOURCE_REVIEW_DRAFT_READ_FAILED', message: error.message, path: stagingPath },
    instruction: 'Preserve the existing draft and report this exact read error. Do not replace or recreate the file.' }; }
  // Every route here runs with a terminal alone: a reviewer with no file-edit tool stages through the
  // CLI, which writes stagingPath and checks it. "Author the report at stagingPath" stopped one that had
  // only execute/read/view (Story anu-bin, 2026-11-11).
  if (!draft) return { ...base, state: 'author-report',
    instruction: `Author the independent report now from reportTemplate and the pinned inputs, with "binding": "from-context". ${STAGE_ROUTE} Then retain it with stagingProtocol.retain. An honest correction-required review can be retained; an unwritten report cannot. Do not relay the context command as the next step.` };
  if (draft.error) return { ...base, state: 'repair-report', error: draft.error, nextAction: protocol.check,
    instruction: `The JSON at stagingPath does not read. Stage the repaired report: ${STAGE_ROUTE} Retain it when valid.` };
  // A draft that leaves the binding to SFlow: this read is the reviewer's own context, so its binding is current.
  const report = draft.report && typeof draft.report === 'object' && !Array.isArray(draft.report)
    && (!Object.hasOwn(draft.report, 'binding') || draft.report.binding === 'from-context') ? { ...draft.report, binding: input.binding } : draft.report;
  const progress = sourceReviewCheckProgress(input, stagingPath, check(report, input), protocol);
  if (progress.state !== 'reload-context') return progress;
  // This invocation already loaded fresh inputs. Re-entering context would find the same stale
  // file forever. Keep it as an exact private backup and require new independent judgments here.
  try {
    const previousDraftPath = await preservePreviousDraft(stagingPath, gitDirectory, draft);
    return { ...base, state: 'review-changed-inputs', previousDraftPath,
      instruction: `This context is already fresh. The previous draft is preserved at previousDraftPath. Independently review the current pinned inputs and author a replacement from reportTemplate, with "binding": "from-context"; never transplant stale citations or judgments. ${STAGE_ROUTE} Then retain it. Do not request context again.` };
  } catch (error) { return { ...base, state: 'read-error', ...(readRecovery ? { nextAction: readRecovery } : {}),
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
