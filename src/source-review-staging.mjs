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

/** How the report reaches stagingPath, in every route that hands it on: the file, never a shell argument. */
export const SOURCE_REVIEW_WRITE_RULE = 'Write the whole report as JSON with your file-edit tool at exactly stagingPath (create it, or edit it in place to repair it), then run stagingProtocol.check; never type the JSON into a shell argument, whose quoting breaks it.';

export function sourceReviewStagingProtocol(phaseId, stagingPath) {
  // The file is the one write route [owner, 2026-11-13]. JSON typed into a shell argument (`stage --report-json '…'`)
  // broke on a real Story: an apostrophe ended the argument twice, and the quotes of `toBe('10')` were eaten, so four
  // repairs cited text no line held. The reviewer agent declares a file-edit tool, and the guard lets a review turn
  // write only this exact file.
  return { readTool: 'native-file-read', writeTool: 'file-edit', path: stagingPath, write: SOURCE_REVIEW_WRITE_RULE,
    pathRule: CLI_PATH_CONTRACT,
    terminal: 'standalone-sflow-command', shellWritersAllowed: false, inlineJsonAllowed: false,
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

/**
 * A review the reviewer could not retain is recorded, never dropped [owner, 2026-11-13]. On a real Story the
 * reviewer staged six packets, none retained, and ended; `review-source status` then said only that no review
 * existed, and the author's turn opened a generation with its own reason. Beside the staged draft (Git-private, this
 * checkout) each check that cannot retain notes the packet it saw and why; a review turn's two repairs spent (three
 * changed packets) say so, and status reads the draft as an incomplete review with the way to finish it: a fresh
 * review turn, which resumes the draft with a new repair budget (`review-source context` starts one).
 */
export const SOURCE_REVIEW_REPAIRS = 2;
export const sourceReviewIncompletePath = (stagingPath) => stagingPath.replace(/\.json$/u, '.incomplete.json');

/** The record beside a staged draft, or null: { reason, findings, attempts, budgetSpent, at }. */
export async function readSourceReviewIncomplete(stagingPath) {
  try {
    const target = sourceReviewIncompletePath(stagingPath);
    const entry = await lstat(target).catch(() => null);
    if (!entry?.isFile() || entry.isSymbolicLink() || entry.size > 256 * 1024) return null;
    const record = JSON.parse(await readFile(target, 'utf8'));
    return record && typeof record === 'object' && Array.isArray(record.attempts) ? record : null;
  } catch { return null; }
}

/**
 * Note a checked packet: `checked` is the check's result, `reportSha256` the packet's digest. A packet that can be
 * retained clears the record; one that cannot is kept with its reason. Returns the record, or null once cleared.
 */
export async function noteSourceReviewAttempt(root, stagingPath, { phaseId, generation, checked, reportSha256 }) {
  const target = sourceReviewIncompletePath(stagingPath);
  if (checked.retentionReady) { await rm(target, { force: true }).catch(() => {}); return null; }
  const previous = await readSourceReviewIncomplete(stagingPath);
  const attempts = [...new Set([...(previous?.attempts ?? []), reportSha256].filter(Boolean))].slice(-16);
  const findings = (checked.findings ?? []).slice(0, 8).map((entry) => ({ code: entry.code ?? null, field: entry.field ?? null,
    message: String(entry.message ?? '').slice(0, 300) }));
  const record = { phase: phaseId, generation: Number(generation), at: new Date().toISOString(), attempts,
    budgetSpent: attempts.length > SOURCE_REVIEW_REPAIRS,
    reason: `${checked.findings?.length ?? 0} field${checked.findings?.length === 1 ? '' : 's'} still to repair: ${findings.slice(0, 3).map((entry) => `${entry.field ?? entry.code}: ${entry.message}`).join('; ')}`.slice(0, 900),
    findings };
  await writeStagingFile(root, target, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/** A fresh review turn: the draft and its reason stay, its repair budget starts again. */
export async function startSourceReviewTurn(root, stagingPath) {
  const previous = await readSourceReviewIncomplete(stagingPath);
  if (!previous?.attempts.length) return;
  await writeStagingFile(root, sourceReviewIncompletePath(stagingPath), `${JSON.stringify({ ...previous, attempts: [], budgetSpent: false }, null, 2)}\n`);
}

/** What a check result says when this review turn's repairs are spent: the record, the draft kept, the way on. */
export function sourceReviewBudgetSpent(phaseId, stagingPath, record) {
  if (!record?.budgetSpent) return null;
  return { recorded: true, stagingPath, reason: record.reason,
    instruction: `This review turn's ${SOURCE_REVIEW_REPAIRS} repairs are spent and the report still cannot be retained (${record.reason}). The draft stays staged at ${stagingPath} and review-source status records the review as incomplete. End this review turn with that status and the remaining fields; a fresh review turn (/sf-review-source ${phaseId}, or the reviewer started again) resumes the draft with a new repair budget. Never retry an unchanged packet.` };
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

/**
 * Inline JSON that does not reach the CLI whole: the file route instead. `review-source stage --report-json` stays
 * for older skills, but a shell argument is where a report breaks (an apostrophe in a finding, a quote in a cited
 * line), and naming only the parse error sent a reviewer to retype it inline five more times [owner, 2026-11-13].
 */
function inlineReportRefusal(why, phaseId, stagingPath) {
  const check = stagingPath ? sourceReviewStagingProtocol(phaseId, stagingPath).check : null;
  return new SingularityFlowError(`${why}; nothing was staged. JSON typed into a shell argument breaks on its quotes: write the whole report with your file-edit tool at ${stagingPath ?? 'the stagingPath review-source context returned'}, then run ${check?.command ?? `singularity-flow review-source check ${phaseId} --report-file <stagingPath> --for-agent --json`}.`, {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { stagingPath, writeRoute: 'file-edit', ...(check ? { nextAction: check } : {}) } });
}

async function stageReport(root, config, workflow, phaseId, reportJson) {
  const phase = workflow.phases[phaseId];
  const issuedPath = phase ? sourceReviewStagingPath(gitDir(root), workflow, phase) : null;
  if (typeof reportJson !== 'string' || Buffer.byteLength(reportJson, 'utf8') > SOURCE_REVIEW_STAGE_MAXIMUM_BYTES) {
    throw inlineReportRefusal('No bounded report JSON (at most 64 KiB) arrived through --report-json', phaseId, issuedPath);
  }
  let report;
  // The reviewer's own JSON: name where it breaks, and the route that cannot break that way.
  try { report = JSON.parse(reportJson); } catch (error) { throw inlineReportRefusal(`The review JSON is invalid (${error.message})`, phaseId, issuedPath); }
  const { sourceReviewContext, sourceReviewInput, checkSourceReviewReport } = await import('./source-review-lifecycle.mjs');
  if (workflow.currentPhase !== phaseId || phase?.status !== 'in_progress') throw new SingularityFlowError(
    'Review staging requires the exact current in-progress phase.', { code: 'SOURCE_REVIEW_STAGING_NOT_ACTIVE' });
  const stagingPath = issuedPath;
  // Context enforces publication/successor integrity and reviewer independence before any write.
  const context = await sourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot: false });
  if (!context.canReview) throw new SingularityFlowError('This generation is not reviewable; nothing was staged. Preserve drafts and follow the returned author/reviewer route.', {
    code: 'SOURCE_REVIEW_STAGING_NOT_REVIEWABLE', details: { continuation: context.continuation, recovery: context.recovery ?? null }
  });
  report = await withSourceReviewContextBinding(root, stagingPath, report);
  const checked = checkSourceReviewReport(report, await sourceReviewInput(root, config, workflow, phaseId));
  // Staging is not retention: a draft that cannot be retained yet is staged too, so it is repaired in place at
  // stagingPath and checked. Refusing to write it left review-source check with no file to read (2026-11-11).
  await writeStagingFile(root, stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const noted = await noteSourceReviewAttempt(root, stagingPath, { phaseId, generation: phase.generation, checked,
    reportSha256: (await import('./records.mjs')).recordSha256(report) }).catch(() => null);
  const spent = sourceReviewBudgetSpent(phaseId, stagingPath, noted);
  const progress = (await import('./source-review-progress.mjs')).sourceReviewCheckProgress({ binding: context.binding }, stagingPath, checked,
    sourceReviewStagingProtocol(phaseId, stagingPath));
  await (await import('./copilot-mutation-guard.mjs')).recordSourceReviewProgress(root,
    { workId: workflow.workItem.id, phaseId, generation: phase.generation, ...progress });
  if (!checked.retentionReady) throw new SingularityFlowError(spent ? spent.instruction : `The review draft is staged at ${stagingPath}, but it cannot be retained yet: repair the listed fields in that file with your file-edit tool, then run ${sourceReviewStagingProtocol(phaseId, stagingPath).check.command}. Nothing was retained.`, {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { ...checked, stagingPath, nextAction: sourceReviewStagingProtocol(phaseId, stagingPath).check, ...(spent ? { incomplete: spent } : {}) }
  });
  return { schemaVersion: 1, resultType: 'source-review-stage', workId: workflow.workItem.id,
    phase: phaseId, generation: phase.generation, stagingPath, status: 'staged',
    effects: { privateStagingChanged: true, filesChanged: true, stateChanged: false, storyAdvanced: false,
      reviewRetained: false, submitted: false, approved: false, committed: false, pushed: false },
    retentionReady: true, evaluationStatus: checked.evaluation.status,
    commandGuidance: sourceReviewStagingProtocol(phaseId, stagingPath).check };
}
