/** Model-authored review staging is private draft storage, never an approval or retained review. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { gitDir } from './git.mjs';
import { safeSidecarTreeDirectory } from './private-sidecar.mjs';
import { CLI_PATH_CONTRACT, safeCommandGuidance } from './safe-command-guidance.mjs';
import { reviewContextWords } from './action-command-map.mjs';
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
    // No --report-file: the check and submit read this issued file themselves, so its long path is never typed again.
    // The check is `review-source stage`: it checks the staged file and returns every repair at once, so the route is
    // stage, repair, stage, submit, with no separate `review-source check` call (owner, 2026-11-25; check still works).
    check: safeCommandGuidance({ argv: ['review-source', 'stage', phaseId, '--for-agent', '--json'] }),
    // --for-agent: a host cut the whole result of a submit without it (2026-11-10).
    retain: safeCommandGuidance({ argv: ['review-source', 'submit', phaseId, '--for-agent', '--json'] }),
    repositoryEditsAllowed: false, stagingIsRetention: false, retentionIsApproval: false };
}

/** The report skeleton as the staged file holds it: every value SFlow knows, the binding left to SFlow. */
export function sourceReviewTemplateText(template) {
  return `${JSON.stringify({ ...template, binding: 'from-context' }, null, 2)}\n`;
}

/**
 * Write the report skeleton at stagingPath when nothing is staged there [owner, 2026-11-20: SFlow fills what it
 * knows]: the reviewer edits its judgments in place instead of rebuilding every source ID, clause, plan field and
 * reviewed list from a packet hundreds of kilobytes long, where each slip was a blocking finding and a spent repair. A
 * draft already there is never replaced. Returns whether it wrote the file.
 */
export async function writeSourceReviewTemplate(root, stagingPath, template) {
  if (await lstat(stagingPath).then(() => true, (error) => error.code !== 'ENOENT')) return false;
  await writeStagingFile(root, stagingPath, sourceReviewTemplateText(template));
  return true;
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
 * Note a checked packet: `checked` is the check's result, `reportSha256` the digest of the packet as the reviewer left
 * it, `writtenSha256` that of the packet SFlow wrote in its place when it set citation lines itself. A packet that can
 * be retained clears the record; one that cannot is kept with its reason. Returns the record, or null once cleared.
 * SFlow's own write is never a repair attempt [owner, 2026-11-20]: a packet it wrote, checked again unchanged, counts
 * nothing, so a spent budget never stops SFlow correcting and retaining what it can.
 */
export async function noteSourceReviewAttempt(root, stagingPath, { phaseId, generation, checked, reportSha256, writtenSha256 = null, untouched = false }) {
  const target = sourceReviewIncompletePath(stagingPath);
  if (checked.retentionReady) { await rm(target, { force: true }).catch(() => {}); return null; }
  const previous = await readSourceReviewIncomplete(stagingPath);
  const written = [...new Set([...(previous?.sflowWritten ?? []), writtenSha256].filter(Boolean))].slice(-16);
  // The skeleton SFlow wrote, checked untouched, is SFlow's packet too: never a repair attempt.
  const counted = untouched || previous?.sflowWritten?.includes(reportSha256) ? null : reportSha256;
  const attempts = [...new Set([...(previous?.attempts ?? []), counted].filter(Boolean))].slice(-16);
  const findings = (checked.findings ?? []).slice(0, 8).map((entry) => ({ code: entry.code ?? null, field: entry.field ?? null,
    message: String(entry.message ?? '').slice(0, 300) }));
  const record = { phase: phaseId, generation: Number(generation), at: new Date().toISOString(), attempts,
    ...(written.length ? { sflowWritten: written } : {}), budgetSpent: attempts.length > SOURCE_REVIEW_REPAIRS,
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

/**
 * What a check result says when this review turn's repairs are spent: the record, the draft kept, and the way on,
 * which is a fresh review turn (its context starts a new repair budget), never the same check of unchanged bytes
 * again: a new chat offered only that check, which failed the same way [owner, 2026-11-20].
 */
export function sourceReviewBudgetSpent(phaseId, stagingPath, record) {
  if (!record?.budgetSpent) return null;
  return { recorded: true, stagingPath, reason: record.reason,
    nextAction: safeCommandGuidance({ argv: reviewContextWords(phaseId) }),
    instruction: `This review turn's ${SOURCE_REVIEW_REPAIRS} repairs are spent and the report still cannot be retained (${record.reason}). The draft stays staged at ${stagingPath} and review-source status records the review as incomplete. End this review turn with that status and the remaining fields; a fresh review turn (/sf-review-source ${phaseId}, or the reviewer started again) resumes the draft with a new repair budget. Running the check is always allowed: it corrects what SFlow can and says what is left.` };
}

/**
 * SFlow sets what it knows exactly in the staged packet, in the file itself, and checks it again [owner, 2026-11-20]:
 * what the report copies from its context (plan fields, source IDs for paths, literals, the reviewed lists), a binding
 * mistyped by hand ("from-context"), a citation line whose unchanged quote is on exactly one line, and quote marks a
 * shell ate on the way in (correctSourceReviewReport). `text` is the file as read, `report` the packet as checked (its
 * binding filled from context); the file keeps its own layout and "from-context" binding, with only those values
 * replaced. Returns `{ report, checked, corrected, correctedWords, text }`, `text` the file's bytes as they now are;
 * with nothing to correct it is untouched.
 */
export async function correctStagedSourceReview(root, stagingPath, { text, report, input }) {
  const { correctSourceReviewReport, fieldTrail, withFieldValues } = await import('./source-review-lifecycle.mjs');
  const result = correctSourceReviewReport(report, input);
  if (!result.corrected.length) return { ...result, text };
  const edits = result.corrected.map((edit) => ({ ...edit, trail: fieldTrail(edit.field) }));
  const written = editedJsonText(text, withFieldValues(JSON.parse(text), result.corrected), edits);
  await writeStagingFile(root, stagingPath, written);
  return { ...result, text: written };
}

/**
 * JSON `text` with each edit's value (`{ trail, to }`) replaced where it stands, so the reviewer's file keeps its
 * layout; the whole file written again only when that would not read back as `expected` (a duplicate key, a field
 * not written yet, a key taken out or renamed).
 */
function editedJsonText(text, expected, edits) {
  const spans = edits.map((edit) => ({ span: edit.removed || edit.renamedFrom ? null : jsonValueSpan(text, edit.trail), value: JSON.stringify(edit.to) }));
  const whole = `${JSON.stringify(expected, null, 2)}\n`;
  if (spans.some((entry) => !entry.span || entry.value === undefined)) return whole;
  let edited = text;
  for (const { span: [start, end], value } of spans.sort((left, right) => right.span[0] - left.span[0])) edited = `${edited.slice(0, start)}${value}${edited.slice(end)}`;
  try { return JSON.stringify(JSON.parse(edited)) === JSON.stringify(expected) ? edited : whole; } catch { return whole; }
}

/** Where the value at `trail` (keys and indexes) is in JSON `text`, as [start, end), or null. */
function jsonValueSpan(text, trail) {
  let at = 0;
  const space = () => { while (at < text.length && ' \t\r\n'.includes(text[at])) at++; };
  const string = () => {
    if (text[at] !== '"') return false;
    for (at++; at < text.length; at++) {
      if (text[at] === '\\') at++;
      else if (text[at] === '"') { at++; return true; }
    }
    return false;
  };
  const value = () => {
    space();
    const open = text[at];
    if (open === '"') return string();
    if (open !== '{' && open !== '[') {
      const token = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u.exec(text.slice(at, at + 64));
      at += token?.[0].length ?? 0;
      return Boolean(token);
    }
    const close = open === '{' ? '}' : ']';
    at++; space();
    if (text[at] === close) { at++; return true; }
    for (;;) {
      if (open === '{') { space(); if (!string()) return false; space(); if (text[at++] !== ':') return false; }
      if (!value()) return false;
      space();
      if (text[at] === close) { at++; return true; }
      if (text[at++] !== ',') return false;
    }
  };
  for (const step of trail) {
    space();
    if (typeof step === 'number') {
      if (text[at++] !== '[') return null;
      for (let index = 0; index < step; index++) { if (!value()) return null; space(); if (text[at++] !== ',') return null; }
      continue;
    }
    if (text[at++] !== '{') return null;
    for (;;) {
      space();
      const start = at;
      if (!string()) return null;
      let key;
      try { key = JSON.parse(text.slice(start, at)); } catch { return null; }
      space();
      if (text[at++] !== ':') return null;
      if (key === step) break;
      if (!value()) return null;
      space();
      if (text[at++] !== ',') return null;
    }
  }
  space();
  const start = at;
  return value() ? [start, at] : null;
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
  return new SingularityFlowError(`${why}; nothing was written. A shell argument breaks JSON: write the report with your file-edit tool at ${stagingPath ?? 'the file context gave'}, then run ${check?.command ?? 'its check'}.`, {
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
  const { sourceReviewContext, sourceReviewInput, correctSourceReviewReport } = await import('./source-review-lifecycle.mjs');
  if (workflow.currentPhase !== phaseId || phase?.status !== 'in_progress') throw new SingularityFlowError(
    'Review staging requires the exact current in-progress phase.', { code: 'SOURCE_REVIEW_STAGING_NOT_ACTIVE',
      details: (await import('./sequence.mjs')).storyNextDetails(workflow) });
  const stagingPath = issuedPath;
  // Context enforces publication/successor integrity and reviewer independence before any write.
  const context = await sourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot: false });
  if (!context.canReview) throw new SingularityFlowError('This generation is not reviewable; nothing was staged. Preserve drafts and follow the returned author/reviewer route.', {
    code: 'SOURCE_REVIEW_STAGING_NOT_REVIEWABLE', details: { continuation: context.continuation, recovery: context.recovery ?? null }
  });
  // What the packet's own quotes fix exactly is set before it is staged, as the check sets it [owner, 2026-11-20].
  const { recordSha256 } = await import('./records.mjs');
  report = await withSourceReviewContextBinding(root, stagingPath, report);
  const given = recordSha256(report);
  const fixed = correctSourceReviewReport(report, await sourceReviewInput(root, config, workflow, phaseId));
  const { checked, corrected, correctedWords } = fixed;
  report = fixed.report;
  const correction = corrected.length ? { corrected, correctedWords } : {};
  // Staging is not retention: a draft that cannot be retained yet is staged too, so it is repaired in place at
  // stagingPath and checked. Refusing to write it left review-source check with no file to read (2026-11-11).
  await writeStagingFile(root, stagingPath, `${JSON.stringify(report, null, 2)}\n`);
  const noted = await noteSourceReviewAttempt(root, stagingPath, { phaseId, generation: phase.generation, checked,
    reportSha256: given, writtenSha256: corrected.length ? recordSha256(report) : null }).catch(() => null);
  const spent = sourceReviewBudgetSpent(phaseId, stagingPath, noted);
  const progress = (await import('./source-review-progress.mjs')).sourceReviewCheckProgress({ binding: context.binding }, stagingPath, checked,
    sourceReviewStagingProtocol(phaseId, stagingPath));
  await (await import('./copilot-mutation-guard.mjs')).recordSourceReviewProgress(root,
    { workId: workflow.workItem.id, phaseId, generation: phase.generation, ...progress });
  if (!checked.retentionReady) throw new SingularityFlowError(spent ? spent.instruction : `The review draft is staged at ${stagingPath}, but it cannot be retained yet: repair the listed fields in that file with your file-edit tool, then run ${sourceReviewStagingProtocol(phaseId, stagingPath).check.command}. Nothing was retained.`, {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: { ...checked, ...correction, stagingPath, nextAction: spent?.nextAction ?? sourceReviewStagingProtocol(phaseId, stagingPath).check, ...(spent ? { incomplete: spent } : {}) }
  });
  return { schemaVersion: 1, resultType: 'source-review-stage', workId: workflow.workItem.id,
    phase: phaseId, generation: phase.generation, stagingPath, status: 'staged',
    effects: { privateStagingChanged: true, filesChanged: true, stateChanged: false, storyAdvanced: false,
      reviewRetained: false, submitted: false, approved: false, committed: false, pushed: false },
    retentionReady: true, evaluationStatus: checked.evaluation.status, ...correction,
    commandGuidance: sourceReviewStagingProtocol(phaseId, stagingPath).check };
}
