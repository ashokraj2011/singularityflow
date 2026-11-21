/** Durable, read-only source packet and append-only review evidence for published Story generations. */
import { latestStepBefore, sourceReviewKind, stepResponsibilities } from './phase-roles.mjs';
import { upstreamIssueStates } from './upstream-routes.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { nearestKnown, valueAtField } from './text-lines.mjs';
import { matchApprovalAuthority } from './approval-authority.mjs';
import { countedRecords } from './presence/counted.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { documentOfferedToPhase } from './document-identity.mjs';
import { isLocalDocument, readLocalDocument } from './document-storage.mjs';
import { authoredArtifactText, inspectManagedArtifactMetadata } from './artifact-review-read.mjs';
import { clarificationRecordRelative } from './story-paths.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { sourceReviewAuthorConflict } from './source-review-policy.mjs';
import { sourceReviewContinuation } from './source-review-continuation.mjs';
import { phaseNeedsGeneration, storyNextDetails } from './sequence.mjs';
import { successorGenerationOpen } from './phase-generation-need.mjs';
import { generationSkillForPhase } from './code-delivery-policy.mjs';
import { documentMimeType, effectiveDocumentMimeType, extractSourceText, isTextualSource } from './source-text.mjs';
import { codeSourceId, evaluateSourceGroundedReview, sourceReviewBinding, sourceReviewScenarioIds } from './source-grounded-review.mjs';
import { derivePlannedClaimMap, extractClauses } from './specifications.mjs';
import { normalizeSourceReviewReport, sourceReviewClauseIds, sourceReviewReportSchema, sourceReviewReportTemplate, validateSourceReviewReport, sourceReviewCitationGuide, sourceReviewRepairGuide, sourceReviewCitationCorrections, sourceReviewCorrectionWords } from './source-review-contract.mjs';
import { ensureSecureRepositoryDirectory, exists, nowIso, posix, run, secureRepositoryPath, SingularityFlowError, writeJson } from './util.mjs';
import { committedSourceReviewFile, prefetchSourceReviewFiles, sharedSourceReviewInput,
  sharedSourceReviewProvenance, sourceReviewProvenanceObjects, withSourceReviewSnapshot } from './source-review-snapshot.mjs';
import { authorCommand } from './action-command-map.mjs';
import { DISPUTE_PREFIX } from './review-dispute-words.mjs';

const REVIEW_AGENT = 'sflow-source-reviewer';
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024;
// The story counts as one; the binding admits at most 100 cited sources.
const MAX_CITED_SOURCES = 100;
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function actorIdentity(actor) { return {
  name: actor?.name ?? null, email: actor?.email ?? null,
  login: actor?.login ?? actor?.githubLogin ?? null
}; }
function itemRelative(config, workId) { return posix(path.join(config.workItemRoot ?? 'singularity/work-items', workId)); }

/** A step the Story lacks, or one its review does not cover: with its steps and the Story's next action. */
export function sourceReviewStepRefusal(workflow, phaseId) {
  return workflow.phases?.[phaseId]
    ? new SingularityFlowError(`Source review applies only to a step the Story's review covers; '${phaseId}' is not one.`,
      { code: 'SOURCE_REVIEW_NOT_APPLICABLE', details: { phase: phaseId, ...storyNextDetails(workflow) } })
    : new SingularityFlowError(`Story '${workflow.workItem.id}' has no '${phaseId}' step; its steps are ${(workflow.phaseOrder ?? []).join(', ')}.`,
      { code: 'SOURCE_REVIEW_STEP_UNKNOWN', details: { requestedPhase: phaseId, ...storyNextDetails(workflow) } });
}

export function sourceReviewDirectory(root, config, workflow, phaseId) {
  if (!sourceReviewKind(workflow, phaseId)) throw sourceReviewStepRefusal(workflow, phaseId);
  const phase = workflow.phases[phaseId];
  return path.join(root, itemRelative(config, workflow.workItem.id), 'context', 'reviews',
    phaseId, `gen-${phase.generation}`);
}

/** A step reviewed only while it is the Story's current one, in progress: an earlier, later or submitted step waits for the Story's next action. */
export const sourceReviewStepNotCurrent = (workflow, phase, action) => new SingularityFlowError(
  `Source review ${action} needs '${phase.id}' to be the Story's current step, in progress; it is ${phase.status}${workflow.currentPhase && workflow.currentPhase !== phase.id ? ` and the Story is at '${workflow.currentPhase}'` : ''}.`,
  { code: 'SOURCE_REVIEW_STEP_NOT_CURRENT', details: { phase: phase.id, phaseStatus: phase.status, ...storyNextDetails(workflow) } });

function checkPublishedGeneration(workflow, phaseId) {
  const phase = workflow.phases?.[phaseId];
  if (phase && successorGenerationOpen(phase)) {
    const version = phase.generationIntent?.generation ?? phase.versionOpening?.version;
    // Writing it is its own work command's, never a skill named from the command text [OSA:REQ-021, C4].
    throw new SingularityFlowError(`Version ${version} of ${phaseId} is being written; review it after it is published.`, {
      code: 'SOURCE_REVIEW_SUCCESSOR_OPEN',
      details: { nextAction: { command: authorCommand(phaseId), skill: generationSkillForPhase(phase, workflow),
        label: `Write version ${version} of ${phaseId}, then publish it` }, phase: phaseId, version }
    });
  }
  if (!phase || !['in_progress', 'awaiting_approval', 'approved'].includes(phase.status)
      || !Number.isSafeInteger(phase.generation) || phase.generation < 1) {
    // Nothing is published to review yet: the Story's next step (writing it, or an earlier step) is the way on.
    throw new SingularityFlowError(`'${phaseId}' has no published version yet, so there is nothing to review; review it once it is published.`, {
      code: 'SOURCE_REVIEW_GENERATION_REQUIRED', details: { phase: phaseId, ...storyNextDetails(workflow) }
    });
  }
  return phase;
}

async function checkedFile(root, relative, label, expectedSha256 = null, { maxBytes = MAX_SOURCE_BYTES } = {}) {
  const secured = await secureRepositoryPath(root, relative, { label });
  if (!secured.exists || !secured.entry?.isFile()) {
    throw new SingularityFlowError(`${label} is missing or is not a regular repository file: ${relative}`, {
      code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE'
    });
  }
  let bytes = await readFile(secured.absolute);
  const committed = committedSourceReviewFile(root, relative);
  // A checkout that rewrote line endings (core.autocrlf) differs from Git only in CR bytes; the
  // committed bytes are the ones the catalog pinned, so review those.
  if (committed.status === 0 && Buffer.isBuffer(committed.stdout) && !committed.stdout.equals(bytes)
      && sameIgnoringLineEndings(committed.stdout, bytes)) bytes = committed.stdout;
  if (bytes.length > maxBytes) throw new SingularityFlowError(`${label} exceeds the review source byte limit.`, {
    code: 'SOURCE_REVIEW_INPUT_TOO_LARGE'
  });
  const digest = sha256(bytes);
  if (expectedSha256 && digest !== expectedSha256) throw new SingularityFlowError(
    `${label} changed after its pinned SHA-256 was recorded: ${relative}`, { code: 'SOURCE_REVIEW_SOURCE_CHANGED' }
  );
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)
      || !committed.stdout.equals(bytes)) throw new SingularityFlowError(
    `${label} is not present unchanged in the published Story commit: ${relative}`,
    { code: 'SOURCE_REVIEW_INPUT_UNPUBLISHED' }
  );
  return { bytes, sha256: digest, absolute: secured.absolute };
}

function sameIgnoringLineEndings(left, right) {
  const strip = (bytes) => Buffer.from(bytes.filter((byte) => byte !== 0x0d));
  return strip(left).equals(strip(right));
}

function utf8(bytes, label) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SingularityFlowError(`${label} is not valid UTF-8 and cannot be cited line by line.`, {
    code: 'SOURCE_REVIEW_INPUT_UNREADABLE'
  }); }
}

function boundedText(text, label) {
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new SingularityFlowError(
    `${label} text exceeds the review limit; provide a smaller pinned source.`, { code: 'SOURCE_REVIEW_INPUT_TOO_LARGE' }
  );
  return text;
}

function creationStoryText(root, base, relative) {
  const created = run('git', ['log', '--format=%H', '--diff-filter=A', '--reverse', '--', `${base}/workflow.json`], {
    cwd: root, allowFailure: true
  });
  const creationCommit = created.status === 0 ? created.stdout.trim().split(/\r?\n/u)[0] : null;
  if (!/^[a-f0-9]{40,64}$/u.test(creationCommit ?? '')) throw new SingularityFlowError(
    'The accepted Story creation commit is unavailable; source review cannot verify USER-STORY.md.',
    { code: 'SOURCE_REVIEW_SOURCE_UNPINNED' }
  );
  const captured = sourceReviewProvenanceObjects(root, [`${creationCommit}:${relative}`]).get(`${creationCommit}:${relative}`);
  if (captured.status !== 0 || !Buffer.isBuffer(captured.stdout)) throw new SingularityFlowError(
    'USER-STORY.md was not retained by the accepted Story creation commit.',
    { code: 'SOURCE_REVIEW_SOURCE_UNPINNED' }
  );
  return captured.stdout;
}

/**
 * The Story text and the pinned attachments offered to `phaseId`, and the attachments a reviewer
 * cannot cite: a link, a document kept on one machine, a file with no text layer (a PDF or an
 * image), one too large to cite, one with no text at all, or one past the review's source budget.
 * Those never refuse the review; each becomes a decision a person records, naming the document. A
 * document recorded before phase scope existed is offered to every phase, and a review whose
 * sources are all readable binds exactly what it bound before.
 */
async function storySources(root, config, workflow, phaseId) {
  const base = itemRelative(config, workflow.workItem.id);
  const source = await checkedFile(root, `${base}/source.json`, 'Story source', workflow.resolution?.sourceSha256 ?? null);
  const storyRelative = `${base}/USER-STORY.md`;
  const story = await checkedFile(root, storyRelative, 'Story text');
  if (!story.bytes.equals(creationStoryText(root, base, storyRelative))) {
    throw new SingularityFlowError('USER-STORY.md differs from the accepted Story creation snapshot.', {
      code: 'SOURCE_REVIEW_SOURCE_CHANGED'
    });
  }
  const sources = [{
    id: 'story', path: storyRelative,
    text: boundedText(utf8(story.bytes, 'Story text'), 'Story text'),
    originalSha256: source.sha256
  }];
  const unreadable = [];
  const visualSources = [];
  const manifestRelative = `${base}/documents.json`;
  const manifest = await secureRepositoryPath(root, manifestRelative, { label: 'Story document catalog' });
  if (!manifest.exists) return { sources, unreadable, visualSources };
  const catalog = readRecord('document-manifest',
    (await checkedFile(root, manifestRelative, 'Story document catalog')).bytes).record;
  if (catalog.workId !== workflow.workItem.id || !Array.isArray(catalog.documents)) throw new SingularityFlowError('Story document catalog is malformed.', {
    code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE'
  });
  // Software upgrades must not invalidate an existing reviewed generation just because a newer
  // reader can now inspect its sources. Preserve only the exact older read modes of a verified,
  // committed report; current source identities still bind afresh, so changed bytes remain stale.
  const retained = await readCurrentRecord(root, config, workflow, phaseId);
  const retainedReadModes = new Map((retained?.record?.report?.binding?.unreadableSources ?? [])
    .filter(entry => ['machine-local-storage', 'no-text-layer'].includes(entry.code))
    .map(entry => [entry.id, entry]));
  await prefetchSourceReviewFiles(root, catalog.documents.filter(entry => entry?.status !== 'detached'
    && documentOfferedToPhase(entry, phaseId) && !isLocalDocument(entry) && entry.type === 'file'
    && typeof entry.path === 'string' && posix(entry.path).startsWith(`${base}/inputs/`))
    .map(entry => posix(entry.path)));
  for (const document of catalog.documents.filter((entry) => entry?.status !== 'detached' && documentOfferedToPhase(entry, phaseId))) {
    const name = document.name ?? document.id;
    if (document.type === 'url') {
      unreadable.push({ id: document.id, name, code: 'external-reference', reason: `it is a link (${document.url}) with no pinned bytes` });
      continue;
    }
    const local = isLocalDocument(document);
    const formerMode = retainedReadModes.get(document.id);
    if (document.type !== 'file' || (!local && !document.path) || !SHA256.test(String(document.sha256 ?? ''))) {
      throw new SingularityFlowError(`Attachment '${document.id ?? 'unknown'}' has no pinned reviewable file bytes.`, {
        code: 'SOURCE_REVIEW_INPUT_UNREADABLE'
      });
    }
    const relative = local ? `local-document:${document.id}` : posix(document.path);
    if (!local && !relative.startsWith(`${base}/inputs/`)) throw new SingularityFlowError(
      `Attachment '${document.id}' is outside the Story input directory.`, { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' }
    );
    // An oversized attachment is a decision for a person, not a refusal of the whole review.
    let file;
    if (local) {
      const stored = await readLocalDocument(root, workflow.workItem.id, document);
      file = { bytes: stored.bytes, absolute: stored.absolutePath, sha256: document.sha256 };
    } else file = await checkedFile(root, relative, `Attachment '${document.id}'`, document.sha256,
      { maxBytes: Number.POSITIVE_INFINITY });
    if (formerMode && (local || formerMode.code === 'no-text-layer')) {
      unreadable.push({ id: document.id, name, code: formerMode.code, originalSha256: document.sha256,
        reason: 'this published generation retains its reviewed source-readability contract' });
      continue;
    }
    if (file.bytes.length > MAX_SOURCE_BYTES) {
      unreadable.push({ id: document.id, name, code: 'too-large-to-cite', originalSha256: file.sha256,
        reason: `the file is larger than the ${MAX_SOURCE_BYTES}-byte review limit` });
      continue;
    }
    let text;
    // An older record whose stored name lost its extension is typed from its original name.
    const mime = effectiveDocumentMimeType(document);
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      if (visualSources.length >= MAX_CITED_SOURCES - 1) {
        unreadable.push({ id: document.id, name, code: 'review-budget-exceeded', originalSha256: file.sha256,
          reason: `the review already admits ${MAX_CITED_SOURCES} sources including the Story` });
        continue;
      }
      visualSources.push({ id: document.id, name, path: relative, originalSha256: file.sha256,
        mimeType: mime, absolutePath: file.absolute, bytes: file.bytes.length,
        instruction: 'Use an actual native image/PDF tool to inspect these exact bytes. Record method, page/region and observations in visualSourcesReviewed; a file path is not proof of inspection. If no suitable tool is available, ask the human for a text export or help inspecting the source; never invent a reading.' });
      continue;
    }
    const typedName = local ? document.sourceName ?? relative : path.extname(relative) ? relative : (document.sourceName ?? relative);
    if (isTextualSource(mime, typedName)) text = utf8(file.bytes, `Attachment '${document.id}'`);
    else {
      const extracted = extractSourceText(file.bytes, mime);
      if (extracted.status !== 'extracted') {
        unreadable.push({ id: document.id, name, code: 'no-text-layer', originalSha256: file.sha256,
          reason: `${mime ?? 'its type'} has no text a reviewer can cite (${extracted.reason})` });
        continue;
      }
      text = extracted.text;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      unreadable.push({ id: document.id, name, code: 'too-large-to-cite', originalSha256: file.sha256,
        reason: `its text is larger than the ${MAX_TEXT_BYTES}-byte review limit` });
      continue;
    }
    // Nothing to cite: an empty file, or one whose extraction found no text.
    if (!text.trim()) {
      unreadable.push({ id: document.id, name, code: 'empty-text', originalSha256: file.sha256,
        reason: 'it has no text to cite' });
      continue;
    }
    sources.push({ id: document.id, name, path: relative, text, originalSha256: file.sha256 });
  }
  // Past the source budget, the remaining documents become decisions in catalog order.
  const cited = [sources[0]];
  let totalBytes = Buffer.byteLength(sources[0].text, 'utf8');
  for (const entry of sources.slice(1)) {
    const bytes = Buffer.byteLength(entry.text, 'utf8');
    if (cited.length + visualSources.length >= MAX_CITED_SOURCES || totalBytes + bytes > MAX_TOTAL_TEXT_BYTES) {
      unreadable.push({ id: entry.id, name: entry.name, code: 'review-budget-exceeded', originalSha256: entry.originalSha256,
        reason: `the review already cites ${cited.length + visualSources.length} sources and ${totalBytes} bytes of text, its limit` });
      continue;
    }
    cited.push(entry);
    totalBytes += bytes;
  }
  return { sources: cited.map(({ name: _name, ...entry }) => entry), unreadable, visualSources };
}

async function phaseArtifact(root, config, workflow, phaseId) {
  const phase = workflow.phases[phaseId];
  const relative = posix(path.join(itemRelative(config, workflow.workItem.id),
    phase.requiredArtifact.path));
  const registered = [...(phase.artifacts ?? [])].reverse().find((entry) => entry.path === relative);
  if (!registered?.sha256) throw new SingularityFlowError(
    `Phase '${phaseId}' has no registered review artifact SHA-256.`, { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' }
  );
  const file = await checkedFile(root, relative, `Phase '${phaseId}' artifact`, registered.sha256);
  // Bind what the author wrote, not the engine-owned envelope: submission and approval rewrite the
  // metadata block (status, commits), and a review must still describe the artifact afterwards.
  const text = utf8(file.bytes, `Phase '${phaseId}' artifact`);
  const authored = authoredArtifactText(text);
  const envelope = inspectManagedArtifactMetadata(text);
  let clarification = null;
  if (envelope.status === 'valid') {
    try { clarification = JSON.parse(envelope.leading.replace(/^<!-- singularity-flow:metadata\s*/u, '').replace(/-->\s*$/u, '')).clarification ?? null; }
    catch { throw new SingularityFlowError(`Phase '${phaseId}' artifact metadata is invalid.`, { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' }); }
  }
  // The full-file digest is display-only. It must not enter the review binding: submit/approve
  // update managed metadata without invalidating a review of unchanged authored content.
  return { path: relative, text: boundedText(authored, `Phase '${phaseId}' artifact`),
    registeredFileSha256: file.sha256, clarification };
}

/** Read only the human checkpoint pinned by this publication, never a live/later draft record. */
async function publishedClarification(root, config, workflow, phase, artifact, role) {
  const references = (phase.clarifications ?? []).filter((entry) => entry.generation === phase.generation);
  const reference = references[0] ?? null;
  const fail = () => { throw new SingularityFlowError(
    `Phase '${phase.id}' has an invalid publication-bound human clarification. Restore the exact published record before reviewing; do not rewrite the Story source.`,
    { code: 'SOURCE_REVIEW_CLARIFICATION_INVALID' }
  ); };
  if (references.length > 1 || canonicalJson(reference) !== canonicalJson(artifact.clarification)) fail();
  if (!reference) return null;
  const relative = clarificationRecordRelative(config, workflow, phase, phase.generation);
  if (reference.path !== relative || !SHA256.test(String(reference.sha256 ?? ''))
      || !SHA256.test(String(reference.promptSha256 ?? ''))) fail();
  const file = await checkedFile(root, relative, `Phase '${phase.id}' human clarification`, reference.sha256,
    { maxBytes: MAX_TEXT_BYTES });
  let record;
  try { record = readRecord('clarification-record', file.bytes).record; }
  catch { fail(); }
  const responses = record.responses;
  if (record.workId !== workflow.workItem.id || record.phase !== phase.id || record.generation !== phase.generation
      || !['required', 'when-needed'].includes(record.mode) || record.completed !== true
      || record.promptSha256 !== reference.promptSha256
      || canonicalJson(record.recordedBy) !== canonicalJson(reference.recordedBy)
      || !record.recordedBy || ![record.recordedBy.name, record.recordedBy.email, record.recordedBy.login].some((value) => typeof value === 'string' && value.trim())
      || record.recordedAt !== reference.recordedAt || !record.recordedAt || !record.agent
      || !Array.isArray(responses) || !responses.length || responses.length > 10 || responses.length !== reference.responses
      || new Set(responses.map((entry) => entry?.id)).size !== responses.length
      || responses.some((entry) => !entry || typeof entry.id !== 'string' || !entry.id.trim()
        || typeof entry.question !== 'string' || !entry.question.trim()
        || typeof entry.answer !== 'string' || !entry.answer.trim()
        || !['answered', 'deferred'].includes(entry.status) || entry.blocking === true)) fail();
  return { id: `clarification:${role}`, role, phase: phase.id, generation: phase.generation,
    path: relative, sha256: file.sha256, recordedBy: record.recordedBy, recordedAt: record.recordedAt,
    responses };
}

/** Exact source bytes and artifact bytes for an independent reviewer. This never writes. */
export async function sourceReviewInput(root, config, workflow, phaseId) {
  return sharedSourceReviewInput(root, recordSha256({ workflow, phaseId,
    workItemRoot: config.workItemRoot ?? null,
    reviewer: config.agents?.[workflow.resolution?.sourceReview?.reviewerAgent ?? REVIEW_AGENT] ?? null
  }), () => loadSourceReviewInput(root, config, workflow, phaseId));
}

async function loadSourceReviewInput(root, config, workflow, phaseId) {
  const phase = checkPublishedGeneration(workflow, phaseId);
  // Author-collision inspection still explains the honest re-author route. Retention and
  // scoped reviewer validation forbid using this diagnostic packet as independent evidence.
  if (!sourceReviewAuthorConflict(workflow, phase)) assertSourceReviewPublicationCurrent(workflow, phase);
  const reviewerAgentId = workflow.resolution?.sourceReview?.reviewerAgent ?? REVIEW_AGENT;
  const reviewerProfile = config.agents?.[reviewerAgentId];
  const reviewerAgentSha256 = reviewerProfile?.sha256;
  if (!SHA256.test(String(reviewerAgentSha256 ?? ''))
      || reviewerAgentSha256 !== workflow.resolution?.agents?.[reviewerAgentId]?.sha256
      || reviewerProfile.metadata?.['sflow-mode'] !== 'read-only-review') {
    throw new SingularityFlowError(
      `Story '${workflow.workItem.id}' has no accepted read-only reviewer '${reviewerAgentId}' agent bytes. A review cannot use a live replacement.`,
      { code: 'SOURCE_REVIEW_AGENT_NOT_PINNED' }
    );
  }
  const kind = sourceReviewKind(workflow, phaseId);
  if (kind === 'document' || kind === 'code') return stepReviewInput(root, config, workflow, phase, kind, { reviewerAgentId, reviewerAgentSha256 });
  // A plan is reviewed against the approved scope it plans: the step before it that defines it.
  const approved = kind === 'planning'
    ? latestStepBefore(workflow, phaseId, (candidate) => stepResponsibilities(workflow, candidate.id).includes('scope')) : null;
  if (kind === 'planning' && approved?.status !== 'approved') throw new SingularityFlowError(
    'Planning review requires an approved specification.', { code: 'SOURCE_REVIEW_SPEC_NOT_APPROVED', details: storyNextDetails(workflow) }
  );
  const base = itemRelative(config, workflow.workItem.id);
  await prefetchSourceReviewFiles(root, [`${base}/source.json`, `${base}/USER-STORY.md`, `${base}/documents.json`,
    `${base}/workflow.json`, posix(path.relative(root, pointerPath(root, config, workflow, phaseId))),
    ...[phase, approved].filter(Boolean).flatMap(step => [
      step.requiredArtifact?.path ? posix(path.join(base, step.requiredArtifact.path)) : null,
      ...(step.clarifications ?? []).filter(entry => entry.generation === step.generation).map(entry => entry.path)
    ])]);
  const { sources, unreadable, visualSources } = await storySources(root, config, workflow, phaseId);
  const artifact = await phaseArtifact(root, config, workflow, phaseId);
  const upstreamSpec = approved ? await phaseArtifact(root, config, workflow, approved.id) : null;
  const clarifications = [
    await publishedClarification(root, config, workflow, phase, artifact, 'current-phase'),
    ...(approved ? [await publishedClarification(root, config, workflow, approved, upstreamSpec, 'approved-scope')] : [])
  ].filter(Boolean);
  const context = {
    kind, workId: workflow.workItem.id, phase: phaseId, generation: phase.generation,
    sources, ...(visualSources.length ? { visualSources } : {}),
    ...(unreadable.length ? { unreadableSources: unreadable } : {}), artifact, ...(upstreamSpec ? { upstreamSpec } : {}),
    // What a planning finding about the approved specification is raised as [PHR:REQ-003]; not bound.
    ...(approved ? { upstreamSpecPhase: approved.id, upstreamIssues: upstreamIssueStates(workflow)
      .filter((state) => !state.supersededBy && state.issue.phase === approved.id)
      .map(({ issue, status }) => ({ id: issue.id, about: issue.about ?? '', problem: issue.problem ?? '', status })) } : {}),
    ...(clarifications.length ? { clarifications } : {}),
    authorAgentId: phase.generatedAgent ?? 'human-author', reviewerAgentId, reviewerAgentSha256,
    recovery: sourceReviewAuthorConflict(workflow, phase) ? phaseGovernanceHold(workflow, phase) : null
  };
  return { ...context, binding: sourceReviewBinding(context) };
}

/**
 * What a document or code step is reviewed against [review level 2]. A document is read against the Story and its
 * documents and the approved inputs the step reads. A code change is read file by file, as published (each file's
 * bytes must be the ones its delivery recorded), against the approved plan and scope, the tests its delivery ran
 * and the quality results it recorded.
 */
async function stepReviewInput(root, config, workflow, phase, kind, { reviewerAgentId, reviewerAgentSha256 }) {
  const phaseId = phase.id;
  const artifact = await phaseArtifact(root, config, workflow, phaseId);
  const clarifications = [await publishedClarification(root, config, workflow, phase, artifact, 'current-phase')].filter(Boolean);
  const common = { kind, workId: workflow.workItem.id, phase: phaseId, generation: phase.generation, artifact,
    ...(clarifications.length ? { clarifications } : {}),
    authorAgentId: phase.generatedAgent ?? 'human-author', reviewerAgentId, reviewerAgentSha256,
    recovery: sourceReviewAuthorConflict(workflow, phase) ? phaseGovernanceHold(workflow, phase) : null };
  if (kind === 'document') {
    const { sources, unreadable, visualSources } = await storySources(root, config, workflow, phaseId);
    const inputs = workflow.resolution?.phases?.find((entry) => entry.id === phaseId)?.inputs ?? [];
    for (const input of inputs) {
      const step = workflow.phases?.[input?.phase];
      if (!step || step.status !== 'approved' || !step.requiredArtifact?.path || sources.length >= MAX_CITED_SOURCES) continue;
      const read = await phaseArtifact(root, config, workflow, step.id);
      sources.push({ id: `input:${step.id}`, path: read.path, text: read.text });
    }
    const context = { ...common, sources, ...(visualSources.length ? { visualSources } : {}), ...(unreadable.length ? { unreadableSources: unreadable } : {}) };
    return { ...context, binding: sourceReviewBinding(context) };
  }
  const evidence = phase.deliveryEvidence ?? {};
  const sources = [];
  for (const entry of [...(evidence.paths ?? [])].filter((item) => item?.exists && ['source', 'test'].includes(item.kind))
    .sort((left, right) => left.path.localeCompare(right.path))) {
    if (sources.length >= MAX_CITED_SOURCES) break;
    const file = await checkedFile(root, entry.path, `Changed file ${entry.path}`, entry.sha256);
    let text;
    try { text = boundedText(utf8(file.bytes, `Changed file ${entry.path}`), `Changed file ${entry.path}`); } catch { continue; }
    sources.push({ id: codeSourceId(entry.path), path: entry.path, text });
  }
  // A generation that changed no source or test file is reviewed from what it published: its summary, so the review
  // can say what the delivered clauses lack instead of the step having no review at all.
  if (!sources.length) sources.push({ id: 'summary', path: artifact.path, text: artifact.text });
  const scope = latestStepBefore(workflow, phaseId, (candidate) => stepResponsibilities(workflow, candidate.id).includes('scope'));
  const plan = latestStepBefore(workflow, phaseId, (candidate) => stepResponsibilities(workflow, candidate.id).includes('plan'));
  const scopeArtifact = scope?.status === 'approved' && scope.requiredArtifact?.path ? await phaseArtifact(root, config, workflow, scope.id) : null;
  const planArtifact = plan?.status === 'approved' && plan.requiredArtifact?.path ? await phaseArtifact(root, config, workflow, plan.id) : null;
  let clauses = [];
  try { clauses = scopeArtifact ? extractClauses(scopeArtifact.text, { sourcePath: scopeArtifact.path }) : []; } catch { clauses = []; }
  let planned = null;
  if (planArtifact) {
    try {
      const claims = derivePlannedClaimMap(planArtifact.text, { clauseIds: clauses.map((clause) => clause.id), clauses }).claimMap.claims;
      planned = Object.fromEntries(Object.entries(claims).map(([id, claim]) => [id, { expectedPaths: [...(claim.expectedPaths ?? [])].sort(),
        tests: [...(claim.tests ?? [])].sort(), testDisposition: claim.testDisposition ?? 'unspecified', ...(claim.fulfillment ? { fulfillment: claim.fulfillment } : {}) }]));
    } catch { planned = null; }
  }
  // A test command that passed ran every test it holds: its tests, and each clause's bound witness, ran and passed.
  const passedRun = (evidence.preflightAttempts ?? []).some((attempt) => attempt?.status === 'passed');
  const passedTests = passedRun ? [...new Set([...(evidence.testPaths ?? []),
    ...(evidence.acceptanceCriteria?.witnesses ?? []).map((witness) => witness.testSource).filter(Boolean)])].sort() : [];
  const quality = qualityResultsForReview(evidence.qualityFindings);
  const testRuns = await gateTestRuns(root, evidence.preflightAttempts);
  const code = { deliveredClauses: planned ? Object.keys(planned).sort() : clauses.map((clause) => clause.id).sort(),
    planned, changedPaths: sources.filter((source) => source.id !== 'summary').map((source) => source.path), passedTests, quality };
  const visualSources = await plannedFileSources(root, `${itemRelative(config, workflow.workItem.id)}/evidence/`, evidence, planned, sources);
  // The second pass (step intents §12.4): what the runtime check saw of this version and the kinds of software the change
  // touches. Outside the binding, as testRuns are: a review retained before them stays current.
  const { runtimeCheck, useKinds } = await secondPassInput(root, workflow, phaseId, code.changedPaths);
  const context = { ...common, sources, code, ...(testRuns.length ? { testRuns } : {}), ...(runtimeCheck ? { runtimeCheck } : {}), ...(useKinds.length ? { useKinds } : {}),
    ...(visualSources.length ? { visualSources } : {}), ...(planArtifact ? { plan: planArtifact } : {}) };
  return { ...context, binding: sourceReviewBinding(context) };
}

/** The runtime check's capture of this version (when there is one) and the kinds of software `changedPaths` touch. */
async function secondPassInput(root, workflow, phaseId, changedPaths) {
  let runtimeCheck = null;
  try {
    const check = await import('./runtime-check.mjs');
    runtimeCheck = check.runtimeCheckForReview(await check.readRuntimeCheck(root, workflow, phaseId));
  } catch { runtimeCheck = null; }
  // The kinds a person confirmed (a small private read); the runtime check's capture names the rest.
  let useKinds = (runtimeCheck?.checks ?? []).map((check) => check.kind);
  try {
    const record = await import('./software-kind-record.mjs');
    useKinds = [...useKinds, ...record.kindsTouched(await record.recordedSoftwareKinds(root), changedPaths).map((project) => project.kind)];
  } catch { /* No record: the checklist is any code's, plus the runtime check's kinds. */ }
  return { runtimeCheck, useKinds: [...new Set(useKinds.filter(Boolean))] };
}

/**
 * Every test run SFlow made of this version at its publication, each with its counts and the Node it ran on, read from
 * the run's own record [owner, 2026-11-18]. The summary is written before them: on Story new-ash-graph it said 17 tests
 * failed on Node 26 with a rerun pending, the gate then passed 31 of 31 on Node 22, and the review, shown only the
 * changed test files, kept the summary's word as a finding that opened a version for nothing. Outside the review's
 * binding, so a review retained before them stays current.
 */
async function gateTestRuns(root, attempts) {
  const runs = [];
  for (const attempt of (Array.isArray(attempts) ? attempts : []).slice(0, 20)) {
    let record = null;
    try { record = readRecord('test-execution', (await checkedFile(root, attempt.receiptPath, 'Test run record', null, { maxBytes: 4 * 1024 * 1024 })).bytes).record; }
    catch { record = null; }
    const tests = record?.tests ?? null;
    const node = record?.environment?.toolchain?.node ?? record?.environment?.nodeVersion?.node ?? null;
    const status = String(attempt?.status ?? record?.status ?? 'unknown');
    const counts = tests ? `${tests.passed} of ${tests.discovered} tests passed, ${tests.failed} failed` : 'no test counts';
    runs.push({ commandId: String(attempt?.commandId ?? ''), attemptId: attempt?.attemptId ?? null, status, tests, node,
      words: `${attempt?.commandId} ${status}: ${counts}${node ? `, on Node ${node}` : ''}.` });
  }
  return runs;
}

// Plan rows met by a file that is not changed code: the review offers that file, or the row could never be cited.
const OFFERED_FULFILLMENT = new Set(['evidence', 'existing', 'document', 'configuration']);

/**
 * The files a delivered clause's plan row names that are not changed code, offered to the reviewer so the row can be
 * cited at all. A clause the plan proves with retained evidence (a screenshot, a PDF) is shown, not implemented: its
 * image or PDF is a visual source the reviewer inspects and attests, as a document's images are; a text file (an
 * evidence log, a document or configuration file, behaviour that already exists) is a source cited by line. Each is
 * the committed, published bytes, pinned to the digest its delivery recorded, also when an earlier version published
 * it and it is unchanged. A file that is missing or not published is not offered: the row then has nothing to cite,
 * which is the author's to correct. Rows changing product code are read from the changed files as before (an image
 * among them too), so their reviews bind what they bound. Adds the text files to `sources`; returns the visual ones.
 */
async function plannedFileSources(root, evidenceDirectory, evidence, planned, sources) {
  const fulfillment = evidence.fulfillment?.obligations ?? evidence.fulfillment;
  const recorded = new Map();
  for (const entry of Array.isArray(fulfillment) ? fulfillment : []) for (const item of entry?.paths ?? []) {
    if (item?.state === 'present' && SHA256.test(String(item.sha256 ?? ''))) recorded.set(item.path, item.sha256);
  }
  for (const item of evidence.paths ?? []) if (item?.exists && SHA256.test(String(item.sha256 ?? '')) && !recorded.has(item.path)) recorded.set(item.path, item.sha256);
  const offered = new Set(sources.map((source) => source.path));
  const visualSources = [];
  const visualType = (mimeType) => mimeType === 'application/pdf' || (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml');
  const wanted = [...new Set(Object.values(planned ?? {}).flatMap((claim) => (claim.expectedPaths ?? [])
    .filter((relative) => OFFERED_FULFILLMENT.has(claim.fulfillment) || relative.startsWith(evidenceDirectory))))].sort();
  for (const relative of wanted) {
    if (offered.has(relative) || sources.length + visualSources.length >= MAX_CITED_SOURCES) continue;
    const mimeType = documentMimeType(relative);
    const visual = visualType(mimeType);
    let file;
    try { file = await checkedFile(root, relative, `Planned file ${relative}`, recorded.get(relative) ?? null); } catch { continue; }
    if (visual) {
      visualSources.push({ id: codeSourceId(relative), name: path.posix.basename(relative), path: relative, originalSha256: file.sha256,
        mimeType, absolutePath: file.absolute, bytes: file.bytes.length,
        instruction: 'This is retained evidence the plan names for a clause. Use an actual native image/PDF tool to inspect these exact bytes. Record method, page/region and observations in visualSourcesReviewed, and attest in that clause\'s row evidence what it shows; a file path is not proof of inspection. If no suitable tool is available, ask the human for help inspecting it; never invent a reading.' });
      continue;
    }
    let text;
    try { text = boundedText(utf8(file.bytes, `Planned file ${relative}`), `Planned file ${relative}`); } catch { continue; }
    sources.push({ id: codeSourceId(relative), path: relative, text });
  }
  return visualSources;
}

/** The quality, security and secret-scan results a code review acknowledges: what still counts, is held, or could not run. */
function qualityResultsForReview(results) {
  if (!results || typeof results !== 'object') return [];
  const idOf = (value, fallback) => (/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(String(value ?? '')) ? String(value)
    : `q:${sha256(Buffer.from(String(fallback))).slice(0, 16)}`);
  const counted = new Set(results.counted ?? []);
  const findings = (results.findings ?? []).filter((entry) => counted.has(entry.fingerprint)).map((entry) => ({ id: idOf(entry.id, entry.fingerprint),
    summary: `${entry.tool ?? 'scanner'} ${entry.rule ?? ''} at ${entry.file ?? '?'}:${entry.line ?? '?'}: ${String(entry.message ?? '').slice(0, 200)}`.replace(/\s+/gu, ' ') }));
  const byFingerprint = new Map((results.findings ?? []).map((entry) => [entry.fingerprint, entry]));
  const held = (results.dependencies?.held ?? []).map((fingerprint) => byFingerprint.get(fingerprint)).filter(Boolean)
    .map((entry) => ({ id: idOf(entry.id, entry.fingerprint), summary: `${entry.package ?? 'package'}${entry.installedVersion ? `@${entry.installedVersion}` : ''} ${entry.rule ?? ''}`.trim() }));
  const unavailable = (results.unavailable ?? []).map((entry) => ({ id: idOf(`unavailable:${entry.commandId}`, entry.commandId), summary: `${entry.commandId} could not run` }));
  return [...findings, ...held, ...unavailable];
}

function assertSourceReviewPublicationCurrent(workflow, phase) {
  if (workflow.currentPhase !== phase.id || phase.status !== 'in_progress'
      || !phaseNeedsGeneration(workflow, phase)) return;
  const continuation = sourceReviewContinuation(workflow, phase);
  throw new SingularityFlowError(
    `Source review cannot retain generation ${phase.generation} while ${phase.id} generation ${continuation.targetGeneration} is being authored. Preserve the draft and follow the phase-author handoff; review only after successor publication.`,
    { code: 'SOURCE_REVIEW_SUCCESSOR_UNPUBLISHED', details: { workId: workflow.workItem.id,
      phase: phase.id, continuation, actions: continuation.actions } }
  );
}

export function sourceReviewReportPath(root, config, workflow, phaseId, reportSha256) {
  if (!SHA256.test(String(reportSha256 ?? ''))) throw new SingularityFlowError('Review report SHA-256 is invalid.');
  return path.join(sourceReviewDirectory(root, config, workflow, phaseId), `${reportSha256}.json`);
}

function pointerPath(root, config, workflow, phaseId) {
  return path.join(sourceReviewDirectory(root, config, workflow, phaseId), 'current.json');
}

function checkedRecord(value, label, family = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError(`${label} is malformed.`);
  if (family) readRecord(family, Buffer.from(JSON.stringify(value)));
  const { recordSha256: digest, ...body } = value;
  if (!SHA256.test(String(digest ?? '')) || digest !== recordSha256(body)) {
    throw new SingularityFlowError(`${label} hash is invalid.`, { code: 'SOURCE_REVIEW_RECORD_INVALID' });
  }
  return value;
}

// Review evidence is a lifecycle decision input, so a locally created or modified JSON file
// cannot become approval authority merely by appearing in the checkout. Its exact bytes must be
// present in the current governed commit, in addition to passing its own content hash.
async function readCommittedJson(root, file, label) {
  const relative = posix(path.relative(root, file));
  const secured = await secureRepositoryPath(root, relative, { label, mustExist: true, type: 'file' });
  const bytes = await readFile(secured.absolute);
  const committed = committedSourceReviewFile(root, relative);
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)
      || !committed.stdout.equals(bytes)) {
    throw new SingularityFlowError(`${label} is not retained unchanged in the current Story commit.`, {
      code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED'
    });
  }
  return JSON.parse(utf8(bytes, label));
}

// The Story record as the current commit holds it. The checkout's copy may lawfully differ: a rollover to the
// next generation changes it before anything is committed. Only the committed bytes are read, so a local edit
// can never add the lifecycle event a review record needs.
function committedStoryWorkflow(root, workflowFile) {
  const committed = committedSourceReviewFile(root, posix(path.relative(root, workflowFile)));
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)) {
    throw new SingularityFlowError('Story workflow is not in the current Story commit.', { code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED' });
  }
  return JSON.parse(utf8(committed.stdout, 'Story workflow'));
}

async function assertRetainedLifecycleEvent(root, config, workflow, record, kind, sidecarFile) {
  const workflowFile = path.join(root, itemRelative(config, workflow.workItem.id), 'workflow.json');
  const committed = committedStoryWorkflow(root, workflowFile);
  const matches = (committed.publicationProjections ?? []).filter((entry) => (
    entry?.event?.eventId === record.lifecycleEventId
  ));
  const event = matches.length === 1 ? matches[0].event : null;
  const actor = kind === 'source-grounded-review'
    ? record.provenance?.reviewerActor : record.actor;
  if (!event || event.type !== LIFECYCLE_EVENT.EVIDENCE_RECORDED
      || event.subject?.kind !== 'story' || event.subject?.id !== workflow.workItem.id
      || event.phaseId !== record.phase || event.generation !== record.generation
      || event.payload?.kind !== kind || event.payload?.reportSha256 !== record.reportSha256
      || (kind === 'source-review-disposition' && (event.payload?.findingId !== record.id
        || event.authorityGroup !== record.authorityGroup))
      || (kind === 'source-grounded-review' && event.agent !== record.provenance?.reviewerAgentId)
      || recordSha256(actorIdentity(event.actor)) !== recordSha256(actorIdentity(actor))) {
    throw new SingularityFlowError('Source review sidecar has no matching committed lifecycle event.', {
      code: 'SOURCE_REVIEW_EVENT_MISSING'
    });
  }
  // A copied sidecar cannot claim an old event. Its exact bytes and projection must have been
  // introduced together in one commit; the event must be absent from that commit's parent.
  const relative = posix(path.relative(root, sidecarFile));
  const currentBytes = await readFile(sidecarFile);
  return sharedSourceReviewProvenance(root, recordSha256({ relative, bytes: sha256(currentBytes), event }), async () => {
    const introduced = run('git', ['log', '--format=%H', '--diff-filter=A', '--', relative], {
      cwd: root, allowFailure: true
    });
    const commits = introduced.status === 0 ? introduced.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
    const first = commits.length === 1 && /^[a-f0-9]{40,64}$/u.test(commits[0]) ? commits[0] : null;
    const workflowRelative = posix(path.relative(root, workflowFile));
    const objects = first ? sourceReviewProvenanceObjects(root, [
      `${first}:${relative}`, `${first}:${workflowRelative}`, `${first}^:${workflowRelative}`
    ]) : new Map();
    const sidecarAtFirst = objects.get(`${first}:${relative}`);
    const workflowAtFirst = objects.get(`${first}:${workflowRelative}`);
    const workflowBefore = objects.get(`${first}^:${workflowRelative}`);
    let introducedProjection = null;
    let parentHasEvent = true;
    if (workflowAtFirst?.status === 0 && workflowBefore?.status === 0) {
      try {
        introducedProjection = JSON.parse(workflowAtFirst.stdout).publicationProjections
          ?.find((entry) => entry?.event?.eventId === record.lifecycleEventId) ?? null;
        parentHasEvent = Boolean(JSON.parse(workflowBefore.stdout).publicationProjections
          ?.some((entry) => entry?.event?.eventId === record.lifecycleEventId));
      } catch { /* Invalid historical workflow bytes fail closed below. */ }
    }
    if (sidecarAtFirst?.status !== 0 || !Buffer.isBuffer(sidecarAtFirst.stdout)
        || !sidecarAtFirst.stdout.equals(currentBytes)
        || !introducedProjection || parentHasEvent
        || recordSha256(introducedProjection.event) !== recordSha256(event)) {
      throw new SingularityFlowError('Source review sidecar was not introduced with its lifecycle event.', {
        code: 'SOURCE_REVIEW_EVENT_MISSING'
      });
    }
  });
}

async function readCurrentRecord(root, config, workflow, phaseId) {
  const pointerFile = pointerPath(root, config, workflow, phaseId);
  if (!(await exists(pointerFile))) return null;
  const pointer = checkedRecord(await readCommittedJson(root, pointerFile, 'Source review pointer'),
    'Source review pointer', 'source-review-pointer');
  if (!SHA256.test(String(pointer.reportSha256 ?? ''))) throw new SingularityFlowError('Source review pointer has no report SHA-256.');
  const file = sourceReviewReportPath(root, config, workflow, phaseId, pointer.reportSha256);
  const record = checkedRecord(await readCommittedJson(root, file, 'Source review record'),
    'Source review record', 'source-review-record');
  if (record.reportSha256 !== pointer.reportSha256 || recordSha256(record.report) !== record.reportSha256
      || record.phase !== phaseId || record.generation !== workflow.phases[phaseId].generation) {
    throw new SingularityFlowError('Source review record does not match its exact phase pointer.', {
      code: 'SOURCE_REVIEW_RECORD_INVALID'
    });
  }
  await assertRetainedLifecycleEvent(root, config, workflow, record, 'source-grounded-review', file);
  return { record, path: file };
}

async function readPriorGenerationRecord(root, config, workflow, phaseId) {
  const currentGeneration = workflow.phases[phaseId].generation;
  const phaseDirectory = path.dirname(sourceReviewDirectory(root, config, workflow, phaseId));
  const secured = await secureRepositoryPath(root, phaseDirectory, {
    label: 'Source review phase directory', type: 'directory'
  });
  if (!secured.exists) return null;
  const generations = (await readdir(secured.absolute, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^gen-[1-9][0-9]*$/u.test(entry.name))
    .map((entry) => Number(entry.name.slice(4)))
    .filter((generation) => Number.isSafeInteger(generation) && generation < currentGeneration)
    .sort((left, right) => right - left);
  for (const generation of generations) {
    const prior = {
      ...workflow,
      phases: { ...workflow.phases, [phaseId]: { ...workflow.phases[phaseId], generation } }
    };
    const retained = await readCurrentRecord(root, config, prior, phaseId);
    if (retained) return retained;
  }
  return null;
}

async function readDecisions(root, config, workflow, phaseId, reportSha256, { only = null } = {}) {
  const directory = path.join(sourceReviewDirectory(root, config, workflow, phaseId), 'decisions', reportSha256);
  if (!(await exists(directory))) return [];
  const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
  const decisions = [];
  for (const name of names) {
    const record = checkedRecord(await readCommittedJson(root, path.join(directory, name), 'Source review human decision'),
      'Source review human decision', 'source-review-decision');
    // A reader of one kind (a dispute) verifies only the records of that kind.
    if (only && !only(record)) continue;
    if (record.recordSha256 !== name.slice(0, -5) || record.reportSha256 !== reportSha256) {
      throw new SingularityFlowError('Source review human decision path or report binding is invalid.', {
        code: 'SOURCE_REVIEW_RECORD_INVALID'
      });
    }
    const authority = matchApprovalAuthority(
      workflow.resolution?.approvalAuthorities ?? config.approvalAuthorities,
      workflow.phases[phaseId].approvalPolicy, record.actor
    );
    if (record.decision !== 'accepted' || !String(record.reason ?? '').trim()
        || !authority.authorized || authority.authorityGroup !== record.authorityGroup
        || authority.identityAssurance !== record.identityAssurance) {
      throw new SingularityFlowError('Source review human decision is not authorized by the pinned phase policy.', {
        code: 'SOURCE_REVIEW_DECISION_UNAUTHORIZED'
      });
    }
    await assertRetainedLifecycleEvent(root, config, workflow, record, 'source-review-disposition',
      path.join(directory, name));
    // SF Guard: on a Story it requires, only a decision its approver signed disposes a finding; an
    // unsigned one is left out, so the finding stays open for a person to decide [SPEC-PSS-v1 §10.7].
    if (countedRecords(workflow, [record]).length !== 1) continue;
    decisions.push(record);
  }
  return decisions;
}

/**
 * Earlier human decisions to proceed without an unreadable document, reused while the document is
 * unchanged. The review that prompted each decision bound the document's identity (its ID, its
 * reason code and, for a file, its SHA-256), so a changed or replaced document needs a new decision.
 * Every reused decision is verified exactly as the current one is: committed with its lifecycle
 * event and authorized by the phase's pinned approval policy. One that no longer verifies is not reused.
 */
async function carriedUnreadableDecisions(root, config, workflow, phaseId, input, currentReportSha256, currentDecisions) {
  const wanted = new Map((input.binding.unreadableSources ?? []).map((entry) => [`unreadable:${entry.id}`, entry]));
  for (const decision of currentDecisions) wanted.delete(decision.id);
  if (!wanted.size) return [];
  const phaseDirectory = path.dirname(sourceReviewDirectory(root, config, workflow, phaseId));
  const secured = await secureRepositoryPath(root, phaseDirectory, {
    label: 'Source review phase directory', type: 'directory'
  });
  if (!secured.exists) return [];
  const generations = (await readdir(secured.absolute, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^gen-[1-9][0-9]*$/u.test(entry.name))
    .map((entry) => Number(entry.name.slice(4)))
    .filter((generation) => Number.isSafeInteger(generation) && generation <= workflow.phases[phaseId].generation)
    .sort((left, right) => right - left);
  const carried = [];
  for (const generation of generations) {
    if (!wanted.size) break;
    const prior = {
      ...workflow,
      phases: { ...workflow.phases, [phaseId]: { ...workflow.phases[phaseId], generation } }
    };
    const decisionsRoot = path.join(sourceReviewDirectory(root, config, prior, phaseId), 'decisions');
    if (!(await exists(decisionsRoot))) continue;
    const reports = (await readdir(decisionsRoot))
      .filter((name) => SHA256.test(name) && name !== currentReportSha256).sort();
    for (const reportSha256 of reports) {
      if (!wanted.size) break;
      let records;
      let seenBinding;
      try {
        records = await readDecisions(root, config, prior, phaseId, reportSha256);
        const reviewed = checkedRecord(await readCommittedJson(root,
          sourceReviewReportPath(root, config, prior, phaseId, reportSha256), 'Source review record'),
        'Source review record', 'source-review-record');
        seenBinding = reviewed.report?.binding;
      } catch {
        continue;
      }
      for (const record of records) {
        const entry = wanted.get(record.id);
        if (!entry) continue;
        const seen = (seenBinding?.unreadableSources ?? []).find((candidate) => `unreadable:${candidate.id}` === record.id);
        if (!seen || canonicalJson(seen) !== canonicalJson(entry)) continue;
        carried.push({ ...record, reportSha256: currentReportSha256,
          carriedFrom: { generation, reportSha256, recordSha256: record.recordSha256 } });
        wanted.delete(record.id);
      }
    }
  }
  return carried;
}

/**
 * What a person disputed on this step's reviews so far, one per finding ID, newest kept: the same finding raised again
 * keeps its id (owner, 2026-11-20). The review context shows it, and the check sets a re-raised one's ID copied with a
 * slip (normalizeSourceReviewReport reads it as input.disputedEarlier).
 */
export async function sourceReviewDisputedEarlier(root, config, workflow, phaseId) {
  return [...new Map((await earlierDisputes(root, config, workflow, phaseId).catch(() => [])).reverse()
    .map((record) => [record.finding.id, { id: record.finding.id, version: Number(record.generation), message: record.finding.message.slice(0, 600),
      ...(record.finding.check ? { check: record.finding.check } : {}), ...(record.finding.clauseId ? { clauseId: record.finding.clauseId } : {}),
      ...(record.finding.sourceId ? { sourceId: record.finding.sourceId } : {}), ...(record.finding.path ? { path: record.finding.path } : {}),
      reason: String(record.reason).slice(0, 600) }])).values()];
}

/** The reviewer's blocking findings a person may dispute: what the step's own author would correct, never one about an earlier step's output. */
export function disputableReviewFindings(report, phaseId) {
  return (Array.isArray(report?.findings) ? report.findings : []).filter((entry) => entry?.severity === 'blocking'
    && typeof entry.id === 'string' && String(entry.message ?? '').trim() && (!entry.ownerPhase || entry.ownerPhase === phaseId));
}

/** The finding a dispute keeps beside the person's reason: the reviewer's own words and where it points. */
function disputedFindingRecord(report, entry) {
  const file = (report?.binding?.sources ?? []).find((source) => source?.id === entry.sourceId)?.path ?? null;
  return { id: String(entry.id), message: String(entry.message).trim().slice(0, 2000),
    ...(entry.check ? { check: entry.check } : {}), ...(entry.clauseId ? { clauseId: entry.clauseId } : {}),
    ...(entry.sourceId ? { sourceId: entry.sourceId, ...(file ? { path: file } : {}) } : {}), ...(Number.isSafeInteger(entry.line) ? { line: entry.line } : {}) };
}

/**
 * What makes a finding on a later version "the same finding" a person disputed: the reviewer's ID, its check, its clause and
 * the file it cites, never its words (the reviewer words each review afresh). Anything else is a new finding, which blocks.
 */
const disputeIdentity = (finding) => canonicalJson({ id: String(finding?.id ?? ''), check: finding?.check ?? null,
  clauseId: finding?.clauseId ?? null, source: finding?.path ?? finding?.sourceId ?? null });

const isDispute = (record) => String(record?.id ?? '').startsWith(DISPUTE_PREFIX) && Boolean(record?.finding);
const actorName = (actor) => actor?.name ?? actor?.login ?? actor?.email ?? null;

/**
 * Every dispute recorded on this step's earlier reviews (each version's, and an earlier review of this version), newest first,
 * each verified as the review's own decisions are: committed with its event and authorized by the step's approval rules. One
 * that no longer verifies is left out, so the finding blocks again.
 */
async function earlierDisputes(root, config, workflow, phaseId, exceptReportSha256 = null) {
  const phaseDirectory = path.dirname(sourceReviewDirectory(root, config, workflow, phaseId));
  const secured = await secureRepositoryPath(root, phaseDirectory, { label: 'Source review phase directory', type: 'directory' });
  if (!secured.exists) return [];
  const generations = (await readdir(secured.absolute, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^gen-[1-9][0-9]*$/u.test(entry.name)).map((entry) => Number(entry.name.slice(4)))
    .filter((generation) => Number.isSafeInteger(generation) && generation <= workflow.phases[phaseId].generation).sort((left, right) => right - left);
  const found = [];
  for (const generation of generations) {
    const prior = { ...workflow, phases: { ...workflow.phases, [phaseId]: { ...workflow.phases[phaseId], generation } } };
    const decisionsRoot = path.join(sourceReviewDirectory(root, config, prior, phaseId), 'decisions');
    if (!(await exists(decisionsRoot))) continue;
    for (const reportSha256 of (await readdir(decisionsRoot)).filter((name) => SHA256.test(name) && name !== exceptReportSha256).sort()) {
      try { found.push(...await readDecisions(root, config, prior, phaseId, reportSha256, { only: isDispute })); } catch { /* It no longer verifies: not carried. */ }
    }
  }
  return found.sort((left, right) => Number(right.generation) - Number(left.generation) || String(right.decidedAt).localeCompare(String(left.decidedAt)));
}

/**
 * A dispute carried to this review: the reviewer raised a finding a person disputed on an earlier review again (the same
 * finding, disputeIdentity), so it shows as already disputed, with that person's reason, rather than blocking again.
 */
async function carriedDisputes(root, config, workflow, phaseId, current, currentDecisions) {
  const report = current.record.report;
  const disputed = new Set(currentDecisions.filter(isDispute).map((record) => record.id.slice(DISPUTE_PREFIX.length)));
  const wanted = new Map(disputableReviewFindings(report, phaseId).filter((entry) => !disputed.has(entry.id))
    .map((entry) => [disputeIdentity(disputedFindingRecord(report, entry)), entry]));
  if (!wanted.size) return [];
  const carried = [];
  for (const record of await earlierDisputes(root, config, workflow, phaseId, current.record.reportSha256)) {
    const entry = wanted.get(disputeIdentity(record.finding));
    if (!entry) continue;
    carried.push({ ...record, id: `${DISPUTE_PREFIX}${entry.id}`, reportSha256: current.record.reportSha256,
      carriedFrom: { generation: record.generation, reportSha256: record.reportSha256, recordSha256: record.recordSha256 } });
    wanted.delete(disputeIdentity(record.finding));
  }
  return carried;
}

/**
 * The reviewer's blocking findings on the step's published version, each with its dispute when a person disputed it (on this
 * review, or the same finding on an earlier one), for whoever may dispute one, the step's approvers and the author of its next
 * version. Read from the committed review record and verified as the status verifies it, so it reads the same while the next
 * version is being written. Null when the published version has no retained review.
 */
export async function reviewFindingDisputes(root, config, workflow, phaseId) {
  const step = workflow.phases?.[phaseId];
  if (!step || !(Number(step.generation) >= 1) || !sourceReviewKind(workflow, phaseId)) return null;
  return withSourceReviewSnapshot(root, async () => {
    const current = await readCurrentRecord(root, config, workflow, phaseId);
    if (!current) return null;
    const decisions = await readDecisions(root, config, workflow, phaseId, current.record.reportSha256);
    const disputes = new Map([...decisions.filter(isDispute), ...await carriedDisputes(root, config, workflow, phaseId, current, decisions)]
      .map((record) => [record.id.slice(DISPUTE_PREFIX.length), record]));
    const report = current.record.report;
    return { phase: phaseId, generation: current.record.generation, reportSha256: current.record.reportSha256,
      findings: disputableReviewFindings(report, phaseId).map((entry) => {
        const record = disputes.get(entry.id);
        return { ...disputedFindingRecord(report, entry), disputed: record ? { by: actorName(record.actor), reason: record.reason, at: record.decidedAt ?? null,
          ...(record.carriedFrom ? { carriedFrom: { generation: record.carriedFrom.generation } } : {}) } : null };
      }) };
  });
}

/**
 * The retained review of the step's published generation, as the author of its next one reads it: its report, or null.
 * Once the next generation is open the status no longer carries it (a successor is reviewed after its publication), and
 * a /sf-code turn opened for the review's findings had none to fix (owner, 2026-11-16). Guidance for the author, never
 * authority: the committed pointer and record, by their own hashes, without the lifecycle event check that reads the
 * Story's workflow, which the open generation's draft changes until it is published.
 */
export async function retainedReviewReport(root, config, workflow, phaseId) {
  try {
    return await withSourceReviewSnapshot(root, async () => {
      const pointerFile = pointerPath(root, config, workflow, phaseId);
      if (!(await exists(pointerFile))) return null;
      const pointer = checkedRecord(await readCommittedJson(root, pointerFile, 'Source review pointer'), 'Source review pointer', 'source-review-pointer');
      const record = checkedRecord(await readCommittedJson(root, sourceReviewReportPath(root, config, workflow, phaseId, pointer.reportSha256),
        'Source review record'), 'Source review record', 'source-review-record');
      return record.reportSha256 === pointer.reportSha256 && recordSha256(record.report) === record.reportSha256
        && record.phase === phaseId && record.generation === workflow.phases[phaseId].generation ? record.report : null;
    });
  } catch { return null; }
}

/** Read current review and decisions, then recompute all source and artifact bindings. */
export async function readSourceReviewStatus(root, config, workflow, phaseId) {
  return withSourceReviewSnapshot(root, () => loadSourceReviewStatus(root, config, workflow, phaseId));
}

async function loadSourceReviewStatus(root, config, workflow, phaseId) {
  // Status is a question: a skipped or not-yet-published step is answered, never refused.
  const step = workflow.phases?.[phaseId];
  if (step?.status === 'skipped') {
    return { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, phase: phaseId, // schema-transient
      generation: step.generation ?? 0, status: 'not-required', reason: 'step-skipped', reportPath: null, reportSha256: null,
      binding: null, pendingDispositions: [], findings: [] };
  }
  if (step && (!['in_progress', 'awaiting_approval', 'approved'].includes(step.status) || !(Number(step.generation) >= 1))) {
    return { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, phase: phaseId, // schema-transient
      generation: Number(step.generation ?? 0), status: 'not-yet-published', reportPath: null, reportSha256: null, binding: null,
      pendingDispositions: [], findings: [{ code: 'source-review-unpublished', message: 'Publish this step before its independent source review.' }],
      continuation: sourceReviewContinuation(workflow, step) };
  }
  if (step && successorGenerationOpen(step)) {
    // The next version is open: writing it comes first, by the step's own work command; the published version's review
    // is already carried into it (source-review-continuation.mjs) [OSA:REQ-021].
    const version = step.generationIntent?.generation ?? step.versionOpening?.version;
    return { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, // schema-transient
      phase: phaseId, generation: step.generation, status: 'successor-publication-required',
      reportPath: null, reportSha256: null, binding: null, pendingDispositions: [],
      findings: [{ code: 'source-review-successor-unpublished', message: `Version ${version} is being written; review it after it is published.` }],
      continuation: sourceReviewContinuation(workflow, step) };
  }
  const phase = checkPublishedGeneration(workflow, phaseId);
  if (workflow.currentPhase === phaseId && phase.status === 'in_progress'
      && phaseNeedsGeneration(workflow, phase) && !sourceReviewAuthorConflict(workflow, phase)) {
    // A new draft cannot be authenticated against the old publication or independently reviewed.
    return { schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, // schema-transient
      phase: phaseId, generation: phase.generation, status: 'successor-publication-required',
      reportPath: null, reportSha256: null, binding: null, pendingDispositions: [],
      findings: [{ code: 'source-review-successor-unpublished', message: 'Publish the prepared successor before independently reviewing it. Earlier review evidence remains preserved.' }],
      continuation: sourceReviewContinuation(workflow, phase) };
  }
  const documentReadiness = await (await import('./document-runtime.mjs')).phaseDocumentReadiness(root, config, workflow, phaseId);
  if (documentReadiness.status !== 'ready') return {
    schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, phase: phaseId,
    generation: phase.generation, status: 'documents-required', reportPath: null, reportSha256: null,
    binding: null, documentReadiness, pendingDispositions: [],
    findings: [{ code: 'DOCUMENT_REUPLOAD_REQUIRED', message: documentReadiness.instruction }],
    continuation: { actions: documentReadiness.missing.map(record => ({ ...record.commandGuidance, reason: record.instruction })) } };
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  return evaluateRetainedSourceReview(root, config, workflow, phaseId, input);
}

async function evaluateRetainedSourceReview(root, config, workflow, phaseId, input) {
  const current = await readCurrentRecord(root, config, workflow, phaseId);
  const retained = current ?? await readPriorGenerationRecord(root, config, workflow, phaseId);
  const decisions = current
    ? await readDecisions(root, config, workflow, phaseId, current.record.reportSha256) : [];
  const carried = current
    ? await carriedUnreadableDecisions(root, config, workflow, phaseId, input, current.record.reportSha256, decisions)
    : [];
  // A finding a person disputed on an earlier review, raised again: already disputed, never blocking again (owner, 2026-11-20).
  const disputes = current ? await carriedDisputes(root, config, workflow, phaseId, current, decisions) : [];
  const review = evaluateSourceGroundedReview(retained?.record.report ?? null, {
    ...input,
    reviewerAgentId: retained?.record.provenance?.reviewerAgentId ?? null,
    reviewerReadOnly: retained?.record.provenance?.readOnly === true
      && retained.record.provenance.reviewerAgentSha256 === input.reviewerAgentSha256,
    humanDispositions: [...decisions, ...carried, ...disputes].map(({ id, reportSha256, decision, reason, actor, decidedAt, carriedFrom }) => ({
      id, reportSha256, decision, reason, actor: actor.login ?? actor.email,
      ...(String(id).startsWith(DISPUTE_PREFIX) ? { by: actorName(actor), decidedAt: decidedAt ?? null, ...(carriedFrom ? { carriedFrom: { generation: carriedFrom.generation } } : {}) } : {})
    }))
  });
  const conflict = sourceReviewAuthorConflict(workflow, workflow.phases[phaseId]);
  return {
    schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, // schema-transient
    phase: phaseId, generation: input.generation, binding: input.binding,
    reportPath: retained?.path ?? null, reportSha256: retained?.record.reportSha256 ?? null,
    provenance: retained?.record.provenance ?? null,
    report: retained?.record.report ?? null, decisions,
    carriedDecisions: carried.map(({ id, reason, actor, decidedAt, carriedFrom }) => ({
      id, reason, actor: actor.login ?? actor.email ?? actor.name, decidedAt, carriedFrom
    })),
    ...review,
    continuation: sourceReviewContinuation(workflow, workflow.phases[phaseId], review),
    ...(conflict ? { status: 'author-conflict', recovery: phaseGovernanceHold(workflow, workflow.phases[phaseId]),
      findings: [{ code: 'reviewer-not-independent', message: 'The published author is the required reviewer; re-author a successor under the accepted phase author.' }, ...review.findings] } : {})
  };
}

/** Build the reviewer payload and private continuation checkpoint, without changing Story state. */
export async function sourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot = true } = {}) {
  return withSourceReviewSnapshot(root, () => loadSourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot }));
}

async function loadSourceReviewContext(root, config, workflow, phaseId, stagingPath, { snapshot = true } = {}) {
  const phase = checkPublishedGeneration(workflow, phaseId);
  const documentReadiness = await (await import('./document-runtime.mjs')).phaseDocumentReadiness(root, config, workflow, phaseId);
  if (documentReadiness.status !== 'ready') return {
    schemaVersion: 1, resultType: 'source-review-context', workId: workflow.workItem.id,
    phase: phaseId, canReview: false, status: 'documents-required', binding: null, stagingPath: null,
    documentReadiness, continuation: { actions: documentReadiness.missing.map(record => ({
      ...record.commandGuidance, reason: record.instruction })) } };
  if (workflow.currentPhase === phaseId && phase.status === 'in_progress'
      && phaseNeedsGeneration(workflow, phase) && !sourceReviewAuthorConflict(workflow, phase)) {
    return { schemaVersion: 1, resultType: 'source-review-context', workId: workflow.workItem.id, // schema-transient
      phase: phaseId, kind: sourceReviewKind(workflow, phaseId), generation: phase.generation,
      canReview: false, binding: null, stagingPath: null,
      reviewer: { activation: 'awaiting-successor-publication', setupRequired: false },
      continuation: sourceReviewContinuation(workflow, phase) };
  }
  // After publication and before the review, SFlow runs the changed software once per version (runtime-check.mjs), so the
  // reviewer reads what it saw. It never throws for what this laptop lacks; the capture names it.
  if (snapshot && globalThis.__SFLOW_EXTENSION_HOST__ !== true && sourceReviewKind(workflow, phaseId) === 'code') {
    const check = await import('./runtime-check.mjs');
    if (check.runtimeCheckAdopted(workflow)) await check.runRuntimeCheck(root, config, workflow, phaseId).catch(() => null);
  }
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  const status = await evaluateRetainedSourceReview(root, config, workflow, phaseId, input);
  if (globalThis.__SFLOW_EXTENSION_HOST__ !== true && input.visualSources?.length) await (await import('./copilot-mutation-guard.mjs')).issueMutationReadPaths(
    root, input.visualSources.map(source => source.absolutePath));
  // The runtime check's screenshots are SFlow's private files: the reviewer may open exactly these.
  const screenshots = (input.runtimeCheck?.checks ?? []).flatMap((check) => (check.screenshots ?? []).map((shot) => shot.path));
  if (globalThis.__SFLOW_EXTENSION_HOST__ !== true && screenshots.length) await (await import('./copilot-mutation-guard.mjs')).issueMutationReadPaths(root, screenshots);
  // The report's kind is what the step does (specification or planning), never the step's name:
  // the evaluator compares it with that, so a renamed or copied step's review is accepted too.
  const reportTemplate = sourceReviewReportTemplate(input);
  const conflict = sourceReviewAuthorConflict(workflow, workflow.phases[phaseId]);
  if (!conflict && stagingPath) await (await import('./copilot-mutation-guard.mjs')).issueMutationStaging(root, stagingPath, 'source-review');
  // The binding this reviewer is shown, kept so its report may say "binding": "from-context" (a read
  // the reviewer itself asked for; stage's own read and a host's card never replace it).
  if (!conflict && stagingPath && snapshot && globalThis.__SFLOW_EXTENSION_HOST__ !== true) {
    // Best effort: without it a "from-context" report is read as stale and sent back here, never accepted unbound.
    const staging = await import('./source-review-staging.mjs');
    await staging.writeSourceReviewContextBinding(root, stagingPath, input.binding).catch(() => {});
    // A fresh review turn: a draft left incomplete keeps its reason and gets a new repair budget [owner, 2026-11-13].
    await staging.startSourceReviewTurn(root, stagingPath).catch(() => {});
    // The report skeleton is the file the reviewer edits, when nothing is staged yet [owner, 2026-11-20].
    await staging.writeSourceReviewTemplate(root, stagingPath, reportTemplate).catch(() => {});
  }
  const hashView = (artifact, binding) => ({ path: artifact.path, sha256: binding.sha256,
    sha256Domain: 'authored-content', authoredContentSha256: binding.sha256,
    registeredFileSha256: artifact.registeredFileSha256,
    integrity: { status: 'verified', registeredFileMatches: true,
      comparison: 'distinct-hash-domains', message: 'The registered digest includes managed metadata; the review binds authored content. Do not compare these digests for equality.' },
    text: artifact.text });
  const stagingProtocol = !conflict && stagingPath
    ? (await import('./source-review-staging.mjs')).sourceReviewStagingProtocol(phaseId, stagingPath) : null;
  const { sourceReviewProgress, sourceReviewProgressContinuation } = await import('./source-review-progress.mjs');
  const progress = stagingProtocol ? await sourceReviewProgress({ input, retained: status, stagingPath,
    gitDirectory: (await import('./git-execution.mjs')).gitDir(root), protocol: stagingProtocol, check: checkSourceReviewReport,
    templateText: (await import('./source-review-staging.mjs')).sourceReviewTemplateText(reportTemplate) }) : null;
  const taskResume = await (await import('./workflow-task-store.mjs')).resumeWorkflowTask(root, workflow, phase, {
    role: 'source-reviewer', generation: input.generation, inputSha256: recordSha256(input.binding), review: progress,
    blocked: conflict || progress?.state === 'read-error' ? { code: conflict ? 'SOURCE_REVIEW_AUTHOR_CONFLICT' : progress.error.code,
      nextAction: progress?.nextAction ?? status.continuation?.actions?.[0] } : null
  });
  if (progress) Object.assign(progress, { operationId: taskResume.operationId, continuationBudget: taskResume.continuationBudget });
  if (progress?.previousDraftPath && globalThis.__SFLOW_EXTENSION_HOST__ !== true) await (await import('./copilot-mutation-guard.mjs'))
    .issueMutationReadPaths(root, [progress.previousDraftPath]);
  if (progress && globalThis.__SFLOW_EXTENSION_HOST__ !== true) await (await import('./copilot-mutation-guard.mjs'))
    .recordSourceReviewProgress(root, { workId: input.workId, phaseId, generation: input.generation, ...progress });
  // What a person disputed on this step's reviews so far: the same finding raised again keeps its id (owner, 2026-11-20).
  const disputedEarlier = await sourceReviewDisputedEarlier(root, config, workflow, phaseId);
  return {
    schemaVersion: 1, resultType: 'source-review-context', workId: input.workId, // schema-transient
    phase: phaseId, kind: input.kind, generation: input.generation, binding: input.binding,
    canReview: !conflict, continuation: progress ? sourceReviewProgressContinuation(progress, status.continuation) : status.continuation,
    taskResume, ...(progress ? { progress, afterRetention: status.continuation } : {}),
    authorAgentId: input.authorAgentId, requiredReviewerAgentId: input.reviewerAgentId,
    reviewerAgentSha256: input.reviewerAgentSha256,
    reviewer: { id: input.reviewerAgentId, sha256: input.reviewerAgentSha256,
      activation: conflict ? 'blocked-author-conflict' : 'automatic', sessionScope: 'review-operation',
      setupRequired: false, instructions: config.agents?.[input.reviewerAgentId]?.text ?? null },
    ...(conflict ? { recovery: phaseGovernanceHold(workflow, workflow.phases[phaseId]) } : {}),
    sources: input.sources.map((source) => ({ id: source.id, path: source.path,
      originalSha256: source.originalSha256, textSha256: sha256(Buffer.from(source.text, 'utf8')),
      text: source.text })),
    ...(input.visualSources?.length ? { visualSources: input.visualSources,
      visualGuidance: 'Inspect each exact file with a native image/PDF tool. Record actual method, page/region and observations in visualSourcesReviewed. Cite that page/region in a row attestation instead of inventing line numbers. File availability or metadata alone is not inspection. If the host cannot read it, ask the person for help or a text export; do not claim completion.' } : {}),
    ...(input.clarifications?.length ? { clarifications: input.clarifications,
      clarificationGuidance: 'Read every pinned human question/answer and acknowledge its id in clarificationsReviewed. Reconcile source wording with answered clarifications before raising a gap; deferred answers are not confirmed decisions. Clarifications may refine ambiguity but are not blanket waivers or silent intent amendments. Cite phase, generation and question id in the review rationale. If an existing artifact already follows the recorded answer, correct the review of this generation rather than demanding a new artifact just to repeat that answer. A scenario an answer shaped is mapped with a covered row to the source line that answer clarifies; never edit a clarification record.' } : {}),
    // Not for the reviewer to cite: each needs a person's recorded decision instead.
    ...(input.unreadableSources?.length ? { unreadableSources: input.unreadableSources } : {}),
    artifact: hashView(input.artifact, input.binding.artifact),
    ...(input.upstreamSpec ? { upstreamSpec: hashView(input.upstreamSpec, input.binding.upstreamSpec) } : {}),
    // A code review reads the approved plan and the delivery evidence its checks (a)-(c) are made against.
    ...(input.plan ? { plan: hashView(input.plan, input.binding.plan) } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.testRuns?.length ? { testRuns: input.testRuns } : {}),
    // What SFlow saw when it ran this version, for the second pass, check (e) [step intents §12.3, §12.4].
    ...(input.runtimeCheck ? { runtimeCheck: input.runtimeCheck } : {}),
    // A finding about that specification names this step as its ownerPhase [PHR:REQ-003].
    ...(input.upstreamSpecPhase ? { upstreamSpecPhase: input.upstreamSpecPhase } : {}),
    ...(disputedEarlier.length ? { disputedEarlier, disputedGuidance: 'A person who may decide for this step disputed each finding in disputedEarlier, with their reason. If you raise the same finding again, keep its id, check, clause and cited source: it then shows as already disputed instead of blocking. Any other problem is a new finding with its own new id.' } : {}),
    citationGuide: sourceReviewCitationGuide(input),
    reportSchema: sourceReviewReportSchema(input.kind), reportTemplate, stagingPath,
    stagingProtocol
  };
}

/** Activate only the exact accepted reviewer for this operation; never write shared session files. */
export function scopedSourceReviewerSession(input, authorSession) {
  if (!authorSession?.actor || authorSession.workId !== input.workId
      || authorSession.phaseId !== input.phase) throw new SingularityFlowError(
    'Attach the current Story phase before retaining a source review; no agent setup is required.',
    { code: 'SOURCE_REVIEW_SESSION_SCOPE_INVALID', details: { actions: [{
      command: `singularity-flow session attach ${input.workId} --json`, skill: '/sf-session',
      detail: 'Attach the exact Story and current phase, preserving its accepted author.' }] } }
  );
  if (input.authorAgentId === input.reviewerAgentId) throw new SingularityFlowError(
    'The published author is also the pinned reviewer. Re-author and publish a successor under the accepted phase author; do not relabel history or create a replacement reviewer.',
    { code: 'SOURCE_REVIEW_AUTHOR_COLLISION', details: { workId: input.workId, phase: input.phase,
      actions: input.recovery?.actions ?? [] } }
  );
  return { actor: structuredClone(authorSession.actor), workId: input.workId, phaseId: input.phase,
    agent: input.reviewerAgentId, agentSha256: input.reviewerAgentSha256 };
}

/**
 * A source written as its path (code:src/App.jsx) rather than its ID (code:src:App.jsx): the exact ID to copy.
 * "Invalid input" alone left a reviewer guessing four forms until its repairs ran out (Story anu-bin, 2026-11-11).
 */
function namedSourceIds(report, input, findings) {
  const known = [...(input.sources ?? []), ...(input.visualSources ?? [])].map((source) => source?.id).filter((id) => typeof id === 'string');
  return findings.map((entry) => {
    if (entry.code !== 'review-format-invalid' || !/(?:^sourcesReviewed\[\d+\]|\.sourceId)$/u.test(entry.field ?? '')) return entry;
    const value = valueAtField(report, entry.field);
    if (typeof value !== 'string' || !known.length) return entry;
    const near = nearestKnown(value, known);
    return near.value
      ? { ...entry, message: `${value.slice(0, 200)} is not a source ID; copy ${near.value} exactly from sources[].id.`, proposedEdit: { field: entry.field, value: near.value } }
      : { ...entry, message: `${value.slice(0, 200)} is not a source ID; copy one from sources[].id: ${near.allowed.join(', ')}${near.more ? ', …' : ''}.`, allowed: near.allowed };
  });
}

/**
 * The IDs a review report copies, by field, so a format error on one names the exact ID meant
 * [agent input repairs]. Clause IDs come from the reviewed specification, the approved one a plan
 * covers, or the clauses a code step delivers.
 */
function reviewKnownIds(input) {
  const clauseIds = sourceReviewClauseIds(input);
  return [
    { field: /(?:^rows\[\d+\]\.clauseId|^rows\[\d+\]\.clauseIds\[\d+\]|^findings\[\d+\]\.clauseId)$/u, values: clauseIds, what: 'a clause ID this review covers' },
    { field: /^qualityReviewed\[\d+\]$/u, values: (input.code?.quality ?? []).map((item) => item.id), what: 'a result ID from context.code.quality' },
    { field: /^findings\[\d+\]\.runtimeFinding$/u, values: (input.runtimeCheck?.checks ?? []).flatMap((check) => check.findings ?? []).map((entry) => entry.id), what: 'a finding ID from context.runtimeCheck' },
    { field: /^clarificationsReviewed\[\d+\]$/u, values: (input.clarifications ?? []).map((entry) => entry.id), what: 'a clarification record ID from context.clarifications' },
    ...(input.kind === 'specification' ? [{ field: /^rows\[\d+\]\.scenarioId$/u, values: [...sourceReviewScenarioIds(input.artifact?.text ?? '')], what: 'a scenario ID of the specification' }] : []),
    { field: /^reviewer\.agentId$/u, values: input.reviewerAgentId ? [input.reviewerAgentId] : [], what: 'this review\'s reviewer' }
  ].filter((entry) => entry.values.length);
}

/** Read-only format, citation and binding preflight. No reviewer authority or human decision is granted. */
export function checkSourceReviewReport(report, input) {
  const validated = validateSourceReviewReport(report, input.kind, { known: () => reviewKnownIds(input) });
  const format = { ...validated, findings: namedSourceIds(report, input, validated.findings) };
  // The pure evaluator also reads historical, malformed packets. New packets use a strict format
  // preflight first, so incidental JS errors cannot hide a field-level format error.
  const evaluation = format.status === 'ready' ? evaluateSourceGroundedReview(report, {
    ...input, reviewerReadOnly: true
  }) : null;
  // The reviewer's own copying slips (an unknown source, clause, scenario, quality result or changed path) block
  // retention with their exact repair; retained, they read as the author's gaps the author cannot close.
  const invalid = new Set(['review-contract-invalid', 'review-binding-mistyped', 'reviewer-not-independent', 'review-self-disposition',
    'quality-reviewed-unknown', 'unplanned-path-unknown', 'clause-unknown', 'scenario-unknown',
    'row-id-invalid', 'attestation-invalid', 'citation-line-invalid', 'citation-quote-invalid',
    'source-unknown', 'clause-list-invalid', 'clause-row-invalid', 'plan-row-mismatch',
    'review-finding-invalid', 'review-findings-invalid', 'sources-reviewed-invalid', 'sources-not-all-reviewed',
    'clarifications-reviewed-invalid', 'clarifications-not-all-reviewed', 'visual-sources-not-reviewed',
    'visual-inspection-invalid', 'visual-citation-invalid', 'finding-citation-missing', 'design-blocking-without-defect', 'evidence-outside-plan',
    'use-severity-mismatch', 'runtime-finding-unknown', 'runtime-finding-unanswered']);
  const bindingAndCitationFindings = evaluation?.findings.filter((entry) => invalid.has(entry.code) || entry.code === 'review-binding-stale') ?? [];
  const checked = { format, evaluation,
    retentionReady: format.status === 'ready' && evaluation.status !== 'stale' && !bindingAndCitationFindings.length,
    findings: [...format.findings, ...bindingAndCitationFindings],
    disclaimer: 'This read-only check grants no reviewer provenance, human disposition, phase submission or approval.' };
  return { ...checked, repair: sourceReviewRepairGuide(report, input, checked) };
}

/**
 * The check after SFlow sets what it knows exactly [owner, 2026-11-20]: first what the report copies from its context
 * (normalizeSourceReviewReport: plan fields, source IDs for paths, literals, clause case, renamed keys, the reviewed
 * lists), then, in the same check, a binding whose every difference is a copying slip ("binding": "from-context") and
 * what the packet's own quotes fix exactly (sourceReviewCitationCorrections). Returns `{ report, checked, corrected,
 * correctedWords }`, the report a copy with those values, `corrected` its `[{ field, from, to }]` (a context value also
 * carries `why`) and `correctedWords` that in the person's words. Judgments, findings' words and anything SFlow would
 * have to choose never change; a packet whose inputs changed (stale) is returned as it is, to be reviewed again.
 */
export function correctSourceReviewReport(report, input) {
  const { report: normalized, normalized: filled } = normalizeSourceReviewReport(report, input);
  const checked = checkSourceReviewReport(normalized, input);
  if (checked.evaluation?.status === 'stale') return { report, checked: filled.length ? checkSourceReviewReport(report, input) : checked, corrected: [], correctedWords: null };
  const slips = (checked.evaluation?.findings ?? []).find((entry) => entry.code === 'review-binding-mistyped')?.slips ?? [];
  const binding = slips.length ? [{ field: 'binding', from: `${slips.length} mistyped value${slips.length === 1 ? '' : 's'}`, to: 'from-context', why: 'binding' }] : [];
  const cited = sourceReviewCitationCorrections(normalized, input, checked);
  const corrected = [...filled, ...binding, ...cited];
  if (!corrected.length) return { report, checked, corrected, correctedWords: null };
  if (!binding.length && !cited.length) return { report: normalized, checked, corrected, correctedWords: sourceReviewCorrectionWords(corrected) };
  const next = withFieldValues(normalized, [...binding, ...cited]);
  // The file says "from-context"; the packet checked carries the binding that stands for.
  if (binding.length) next.binding = structuredClone(checked.evaluation.binding);
  return { report: next, checked: checkSourceReviewReport(next, input), corrected, correctedWords: sourceReviewCorrectionWords(corrected) };
}

/** A field selector's keys and indexes: `rows[2].tests[0].line` is ['rows', 2, 'tests', 0, 'line']. */
export const fieldTrail = (field) => String(field).split(/\.|(?=\[)/u).filter(Boolean)
  .map((part) => (/^\[\d+\]$/u.test(part) ? Number(part.slice(1, -1)) : part));

/** A copy of `value` with each `{ field, to }` set (`removed: true` takes the key out; `renamedFrom` takes the old key out first). */
export function withFieldValues(value, edits) {
  const copy = structuredClone(value);
  const parentOf = (trail) => trail.slice(0, -1).reduce((node, key) => node?.[key], copy);
  for (const { field, to, removed, renamedFrom } of edits) {
    if (renamedFrom) {
      const old = fieldTrail(renamedFrom);
      const holder = parentOf(old);
      if (holder && typeof holder === 'object' && !Array.isArray(holder)) delete holder[old.at(-1)];
    }
    const trail = fieldTrail(field);
    const parent = parentOf(trail);
    if (!parent || typeof parent !== 'object') continue;
    if (removed) { if (!Array.isArray(parent)) delete parent[trail.at(-1)]; } else parent[trail.at(-1)] = to;
  }
  return copy;
}

/** Validate reviewer session provenance before an immutable sidecar is written. */
export function evaluateSubmittedSourceReview(report, input, session) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new SingularityFlowError('Source review report must be a JSON object.', {
      code: 'SOURCE_REVIEW_REPORT_INVALID'
    });
  }
  if (session?.workId !== input.workId || session?.phaseId !== input.phase
      || session?.agent !== input.reviewerAgentId || session.agent === input.authorAgentId
      || session.agentSha256 !== input.reviewerAgentSha256) {
    throw new SingularityFlowError(
      `Retain the report through review-source submit for ${input.phase}; it scopes the accepted independent '${input.reviewerAgentId}' to that operation without changing the phase author.`,
      { code: 'SOURCE_REVIEW_INDEPENDENT_AGENT_REQUIRED' }
    );
  }
  const checked = checkSourceReviewReport(report, { ...input, reviewerAgentId: session.agent });
  const evaluation = checked.evaluation;
  if (!evaluation) throw new SingularityFlowError('Source review report format is invalid. Repair the listed fields using review-source context and check again; no review was retained.', {
    code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked
  });
  if (evaluation.status === 'stale') throw new SingularityFlowError(
    'Review input changed after the report was written. Recreate it from review-source context.',
    { code: 'SOURCE_REVIEW_BINDING_STALE', details: evaluation }
  );
  if (!checked.retentionReady) {
    throw new SingularityFlowError('Source review report has invalid fields, citations or provenance. Repair the listed fields and check again; no review was retained.', {
      code: 'SOURCE_REVIEW_REPORT_INVALID', details: checked
    });
  }
  return evaluation;
}

/** Call inside a Story publication transaction, after its lock and recovery journal exist. */
export async function retainSourceReview(root, config, workflow, phaseId, report, evaluation, session, publicationEvent) {
  assertSourceReviewPublicationCurrent(workflow, checkPublishedGeneration(workflow, phaseId));
  if (!publicationEvent?.eventId) throw new SingularityFlowError(
    'Source review report requires a lifecycle event.', { code: 'SOURCE_REVIEW_EVENT_REQUIRED' }
  );
  const directory = sourceReviewDirectory(root, config, workflow, phaseId);
  const file = sourceReviewReportPath(root, config, workflow, phaseId, evaluation.reportSha256);
  const body = {
    schemaVersion: currentSchemaVersion('source-review-record'), phase: phaseId,
    generation: workflow.phases[phaseId].generation,
    reportSha256: evaluation.reportSha256, lifecycleEventId: publicationEvent.eventId, report,
    provenance: {
      reviewerAgentId: session.agent, reviewerAgentSha256: session.agentSha256,
      reviewerActor: session.actor,
      authorAgentId: workflow.phases[phaseId].generatedAgent ?? 'human-author', readOnly: true
    },
    submittedAt: nowIso()
  };
  const record = { ...body, recordSha256: recordSha256(body) };
  await ensureSecureRepositoryDirectory(root, directory, { label: 'Source review directory' });
  if (await exists(file)) {
    const prior = checkedRecord(await readCommittedJson(root, file, 'Source review record'),
      'Source review record', 'source-review-record');
    if (recordSha256(prior.report) !== evaluation.reportSha256
        || prior.provenance?.reviewerAgentId !== session.agent
        || prior.provenance?.authorAgentId !== body.provenance.authorAgentId) throw new SingularityFlowError(
      'Existing review report path has different content.', { code: 'SOURCE_REVIEW_RECORD_INVALID' }
    );
  } else await writeJson(file, record);
  const pointerBody = { schemaVersion: currentSchemaVersion('source-review-pointer'), phase: phaseId,
    generation: workflow.phases[phaseId].generation, reportSha256: evaluation.reportSha256 };
  await writeJson(pointerPath(root, config, workflow, phaseId), {
    ...pointerBody, recordSha256: recordSha256(pointerBody)
  });
  workflow.history.push({ at: body.submittedAt, actor: session.actor?.email ?? session.actor?.name,
    agent: session.agent, event: 'source_review_submitted', phase: phaseId,
    detail: evaluation.reportSha256 });
  return { path: file, reportSha256: evaluation.reportSha256 };
}

/** Call inside a Story publication transaction with an already-authorized human Git actor. */
export async function retainSourceReviewDecision(root, config, workflow, phaseId, status, id, reason,
  actor, authority, publicationEvent) {
  const pending = status.pendingDispositions?.find((entry) => entry.id === id);
  if (!pending) throw new SingularityFlowError(`No pending source review disposition '${id}' exists.`, {
    code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING', details: storyNextDetails(workflow)
  });
  return writeHumanDecision(root, config, workflow, phaseId, { reportSha256: status.reportSha256, id, reason, actor, authority, publicationEvent });
}

/**
 * A person's dispute of the reviewer's blocking finding (owner, 2026-11-20): the review's own human decision, `dispute:<ID>`,
 * beside the review of the published version it answers, with the finding it disputes, under the same authority, event and
 * SF Guard signature as every decision on that review. `disputed` is reviewFindingDisputes' read, made in this transaction.
 * Call inside a Story publication transaction with an already-authorized human Git actor.
 */
export async function retainSourceReviewDispute(root, config, workflow, phaseId, disputed, findingId, reason, actor, authority, publicationEvent) {
  const finding = disputed?.findings?.find((entry) => entry.id === findingId);
  if (!finding || finding.disputed) throw new SingularityFlowError(`The review of version ${disputed?.generation ?? workflow.phases[phaseId]?.generation} has no blocking finding ${findingId} left to dispute.`, {
    code: 'SOURCE_REVIEW_DISPUTE_NOT_OPEN', details: storyNextDetails(workflow)
  });
  const { disputed: _none, ...kept } = finding;
  return writeHumanDecision(root, config, workflow, phaseId, { reportSha256: disputed.reportSha256, id: `${DISPUTE_PREFIX}${findingId}`,
    reason, actor, authority, publicationEvent, finding: kept });
}

async function writeHumanDecision(root, config, workflow, phaseId, { reportSha256, id, reason, actor, authority, publicationEvent, finding = null }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new SingularityFlowError(
    'A human-authored reason is required for a source review disposition.',
    { code: 'SOURCE_REVIEW_DISPOSITION_REASON_REQUIRED' }
  );
  if (!authority?.authorityGroup || !actor?.email && !actor?.login) throw new SingularityFlowError(
    'A configured, authenticated human approval authority is required for this disposition.',
    { code: 'SOURCE_REVIEW_DISPOSITION_AUTHORITY_REQUIRED' }
  );
  if (!publicationEvent?.eventId) throw new SingularityFlowError(
    'Source review human decision requires a lifecycle event.',
    { code: 'SOURCE_REVIEW_EVENT_REQUIRED' }
  );
  const directory = path.join(sourceReviewDirectory(root, config, workflow, phaseId),
    'decisions', reportSha256);
  const body = {
    // An SF Guard pin writes v2, which can keep the approver's signature; anywhere else stays v1.
    schemaVersion: workflow.resolution?.presence ? currentSchemaVersion('source-review-decision') : 1, phase: phaseId,
    generation: workflow.phases[phaseId].generation,
    reportSha256, lifecycleEventId: publicationEvent.eventId,
    id, decision: 'accepted', reason: reason.trim(),
    // A dispute keeps the exact finding it disputes, so the same finding on a later version is known for it.
    ...(finding ? { finding } : {}),
    actor: actorIdentity(actor),
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, decidedAt: nowIso()
  };
  // SF Guard (SPEC-PSS-v1 §10.7): on a Story it requires, the decision keeps its approver's signature
  // over these exact fields (the card, then one touch); a refusal names the routes and writes nothing.
  if (workflow.resolution?.presence) {
    await (await import('./presence/person-steps.mjs')).signPersonRecords(root, workflow,
      [{ label: 'Source review decision', action: 'decision.source-review', record: body }]);
  }
  const record = { ...body, recordSha256: recordSha256(body) };
  await ensureSecureRepositoryDirectory(root, directory, { label: 'Source review decision directory' });
  const file = path.join(directory, `${record.recordSha256}.json`);
  await writeJson(file, record);
  workflow.history.push({ at: body.decidedAt,
    actor: body.actor.login ?? body.actor.email ?? body.actor.name, agent: null,
    event: 'source_review_disposition', phase: phaseId, detail: `${id} ${reportSha256}` });
  return { path: file, recordSha256: record.recordSha256 };
}
