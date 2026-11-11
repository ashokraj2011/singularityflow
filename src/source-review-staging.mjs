/** Model-authored review staging is private draft storage, never an approval or retained review. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { safeSidecarTreeDirectory } from './private-sidecar.mjs';
import { CLI_PATH_CONTRACT, safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';
import { sourceReviewStagingPath } from './phase-staging-paths.mjs';
import { withSourceReviewSnapshot } from './source-review-snapshot.mjs';

export const SOURCE_REVIEW_STAGE_MAXIMUM_BYTES = 65536;

export function sourceReviewStagingProtocol(phaseId, stagingPath) {
  // kernelStage needs only a terminal, so it is the write route every reviewer has; a file-edit tool is
  // the alternative where a host has one (a reviewer with execute/read/view alone stopped, 2026-11-11).
  return { readTool: 'native-file-read', writeTool: 'kernelStage', alternativeWriteTool: 'file-edit', path: stagingPath,
    pathRule: CLI_PATH_CONTRACT,
    terminal: 'standalone-sflow-command', shellWritersAllowed: false,
    maximumReportJsonBytes: SOURCE_REVIEW_STAGE_MAXIMUM_BYTES,
    kernelStage: safeCommandGuidance({ argv: ['review-source', 'stage', phaseId, '--report-json', '<REPORT-JSON>', '--json'] }),
    check: safeCommandGuidance({ argv: ['review-source', 'check', phaseId, '--report-file', stagingPath, '--for-agent', '--json'] }),
    // --for-agent: a host cut the whole result of a submit without it (2026-11-10).
    retain: safeCommandGuidance({ argv: ['review-source', 'submit', phaseId, '--report-file', stagingPath, '--for-agent', '--json'] }),
    repositoryEditsAllowed: false, stagingIsRetention: false, retentionIsApproval: false };
}

/** Where `review-source context` keeps the binding it showed this reviewer, beside the staging file. */
export function sourceReviewContextBindingPath(stagingPath) {
  return stagingPath.replace(/\.json$/u, '.context-binding.json');
}

/** Keep the binding this context showed, so a report may say "binding": "from-context" instead of copying it. */
export async function writeSourceReviewContextBinding(root, stagingPath, binding) {
  await writeStagingFile(root, sourceReviewContextBindingPath(stagingPath), `${JSON.stringify({ schemaVersion: 1, binding })}\n`);
}

/**
 * The report with the binding its reviewer's context showed, when it omits the binding or says
 * "binding": "from-context". The binding says which inputs were reviewed (freshness, not consent), and
 * copying its hashes by hand was the slip that stopped a live review (Story anu-bin, 2026-11-11). With no
 * context read yet, the report is returned as it is, and the check sends the reviewer to read it.
 */
export async function withSourceReviewContextBinding(root, stagingPath, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return report;
  if (Object.hasOwn(report, 'binding') && report.binding !== 'from-context') return report;
  let stored = null;
  try {
    const target = sourceReviewContextBindingPath(stagingPath);
    const entry = await lstat(target).catch(() => null);
    if (entry?.isFile() && !entry.isSymbolicLink() && entry.size <= 4 * 1024 * 1024) stored = JSON.parse(await readFile(target, 'utf8'));
  } catch { stored = null; }
  return stored?.binding && typeof stored.binding === 'object' ? { ...report, binding: stored.binding } : report;
}

async function writeStagingFile(root, target, bytes) {
  const directory = await safeSidecarTreeDirectory(root, path.dirname(target), { create: true });
  const existing = await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new SingularityFlowError(
    'Review staging must be a regular unlinked file.', { code: 'SOURCE_REVIEW_REPORT_STAGING_INVALID' });
  const temporary = path.join(directory, `.review-stage-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await safeSidecarTreeDirectory(root, directory);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function stageSourceReviewReport(root, config, workflow, phaseId, reportJson) {
  root = await realpath(root);
  return withSourceReviewSnapshot(root, () => stageReport(root, config, workflow, phaseId, reportJson));
}

async function stageReport(root, config, workflow, phaseId, reportJson) {
  if (typeof reportJson !== 'string' || Buffer.byteLength(reportJson, 'utf8') > SOURCE_REVIEW_STAGE_MAXIMUM_BYTES) {
    throw new SingularityFlowError('Provide bounded JSON through --report-json (at most 64 KiB).', {
      code: 'SOURCE_REVIEW_REPORT_INVALID'
    });
  }
  let report;
  try { report = JSON.parse(reportJson); } catch (error) {
    // The reviewer's own JSON: name where it breaks, or it rewrites the whole report blind.
    throw new SingularityFlowError(`The review JSON is invalid (${error.message}); nothing was staged.`, { code: 'SOURCE_REVIEW_REPORT_INVALID' });
  }
  const { sourceReviewContext, sourceReviewInput, checkSourceReviewReport } = await import('./source-review-lifecycle.mjs');
  const phase = workflow.phases[phaseId];
  if (workflow.currentPhase !== phaseId || phase?.status !== 'in_progress') throw new SingularityFlowError(
    'Review staging requires the exact current in-progress phase.', { code: 'SOURCE_REVIEW_STAGING_NOT_ACTIVE' });
  const stagingPath = sourceReviewStagingPath(gitDir(root), workflow, phase);
  // Context enforces publication/successor integrity and reviewer independence before any write.
  const context = await sourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot: false });
  if (!context.canReview) throw new SingularityFlowError('This generation is not reviewable; nothing was staged. Preserve drafts and follow the returned author/reviewer route.', {
    code: 'SOURCE_REVIEW_STAGING_NOT_REVIEWABLE', details: { continuation: context.continuation, recovery: context.recovery ?? null }
  });
  report = await withSourceReviewContextBinding(root, stagingPath, report);
  const checked = checkSourceReviewReport(report, await sourceReviewInput(root, config, workflow, phaseId));
  // Staging is not retention: a draft that cannot be retained yet is staged too, so a reviewer with no
  // file-edit tool can check it at stagingPath and stage the repaired JSON again. Refusing to write it
  // left review-source check with no file to read (2026-11-11).
  await writeStagingFile(root, stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const progress = (await import('./source-review-progress.mjs')).sourceReviewCheckProgress({ binding: context.binding }, stagingPath, checked,
    sourceReviewStagingProtocol(phaseId, stagingPath));
  await (await import('./copilot-mutation-guard.mjs')).recordSourceReviewProgress(root,
    { workId: workflow.workItem.id, phaseId, generation: phase.generation, ...progress });
  if (!checked.retentionReady) throw new SingularityFlowError(`The review draft is staged at ${stagingPath}, but it cannot be retained yet: repair the listed fields and stage the repaired JSON again (or edit that file and check it). Nothing was retained.`, {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { ...checked, stagingPath }
  });
  return { schemaVersion: 1, resultType: 'source-review-stage', workId: workflow.workItem.id,
    phase: phaseId, generation: phase.generation, stagingPath, status: 'staged',
    effects: { privateStagingChanged: true, filesChanged: true, stateChanged: false, storyAdvanced: false,
      reviewRetained: false, submitted: false, approved: false, committed: false, pushed: false },
    retentionReady: true, evaluationStatus: checked.evaluation.status,
    commandGuidance: sourceReviewStagingProtocol(phaseId, stagingPath).check };
}
