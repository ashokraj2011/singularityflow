/** Model-authored review staging is private draft storage, never an approval or retained review. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { safeSidecarTreeDirectory } from './private-sidecar.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { SingularityFlowError } from './util.mjs';

export const SOURCE_REVIEW_STAGE_MAXIMUM_BYTES = 65536;

export function sourceReviewStagingProtocol(phaseId, stagingPath) {
  return { readTool: 'native-file-read', writeTool: 'file-edit', path: stagingPath,
    terminal: 'standalone-sflow-command', shellWritersAllowed: false,
    kernelStage: safeCommandGuidance({ argv: ['review-source', 'stage', phaseId, '--report-json', '<REPORT-JSON>', '--json'] }),
    check: safeCommandGuidance({ argv: ['review-source', 'check', phaseId, '--report-file', stagingPath, '--json'] }),
    retain: safeCommandGuidance({ argv: ['review-source', 'submit', phaseId, '--report-file', stagingPath, '--json'] }),
    repositoryEditsAllowed: false, stagingIsRetention: false, retentionIsApproval: false };
}

export async function stageSourceReviewReport(root, config, workflow, phaseId, reportJson) {
  root = await realpath(root);
  if (typeof reportJson !== 'string' || Buffer.byteLength(reportJson, 'utf8') > SOURCE_REVIEW_STAGE_MAXIMUM_BYTES) {
    throw new SingularityFlowError('Provide bounded JSON through --report-json (at most 64 KiB).', {
      code: 'SOURCE_REVIEW_REPORT_INVALID'
    });
  }
  let report;
  try { report = JSON.parse(reportJson); } catch {
    throw new SingularityFlowError('The review JSON is invalid; no staging bytes changed.', { code: 'SOURCE_REVIEW_REPORT_INVALID' });
  }
  const { sourceReviewContext, sourceReviewInput, checkSourceReviewReport } = await import('./source-review-lifecycle.mjs');
  const phase = workflow.phases[phaseId];
  if (workflow.currentPhase !== phaseId || phase?.status !== 'in_progress') throw new SingularityFlowError(
    'Review staging requires the exact current in-progress phase.', { code: 'SOURCE_REVIEW_STAGING_NOT_ACTIVE' });
  const stagingPath = path.join(gitDir(root), 'singularity-flow', 'source-reviews',
    `${workflow.workItem.id}-${phaseId}-gen${phase.generation}.json`);
  // Context enforces publication/successor integrity and reviewer independence before any write.
  const context = await sourceReviewContext(root, config, workflow, phaseId, stagingPath);
  if (!context.canReview) throw new SingularityFlowError('This generation is not reviewable; preserve drafts and follow the returned author/reviewer route.', {
    code: 'SOURCE_REVIEW_STAGING_NOT_REVIEWABLE', details: { continuation: context.continuation, recovery: context.recovery ?? null }
  });
  const checked = checkSourceReviewReport(report, await sourceReviewInput(root, config, workflow, phaseId));
  if (!checked.retentionReady) throw new SingularityFlowError('Repair report format, citations or exact binding; no staging bytes changed.', {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked
  });
  const directory = await safeSidecarTreeDirectory(root, path.dirname(stagingPath), { create: true });
  const existing = await lstat(stagingPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1)) throw new SingularityFlowError(
    'Review staging must be a regular unlinked file.', { code: 'SOURCE_REVIEW_REPORT_STAGING_INVALID' });
  const temporary = path.join(directory, `.review-stage-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    await safeSidecarTreeDirectory(root, directory);
    await rename(temporary, stagingPath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
  return { schemaVersion: 1, resultType: 'source-review-stage', workId: workflow.workItem.id,
    phase: phaseId, generation: phase.generation, stagingPath, status: 'staged',
    effects: { privateStagingChanged: true, filesChanged: true, stateChanged: false, storyAdvanced: false,
      reviewRetained: false, submitted: false, approved: false, committed: false, pushed: false },
    retentionReady: true, evaluationStatus: checked.evaluation.status,
    commandGuidance: sourceReviewStagingProtocol(phaseId, stagingPath).check };
}
