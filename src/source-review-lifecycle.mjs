/** Durable, read-only source packet and append-only review evidence for published Story generations. */
import { latestStepBefore, sourceReviewKind, stepResponsibilities } from './phase-roles.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, recordSha256 } from './records.mjs';
import { matchApprovalAuthority } from './approval-authority.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { documentOfferedToPhase } from './document-identity.mjs';
import { isLocalDocument } from './document-storage.mjs';
import { authoredArtifactText } from './publication-preflight.mjs';
import { effectiveDocumentMimeType, extractSourceText, isTextualSource } from './source-text.mjs';
import { evaluateSourceGroundedReview, sourceReviewBinding } from './source-grounded-review.mjs';
import { ensureSecureRepositoryDirectory, exists, nowIso, posix, run, secureRepositoryPath, SingularityFlowError, writeJson } from './util.mjs';

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

export function sourceReviewDirectory(root, config, workflow, phaseId) {
  if (!sourceReviewKind(workflow, phaseId)) {
    throw new SingularityFlowError(`Source review applies only to a step that defines the scope or plans the claims; '${phaseId}' does neither.`);
  }
  const phase = workflow.phases?.[phaseId];
  if (!phase) throw new SingularityFlowError(`Story has no '${phaseId}' phase.`);
  return path.join(root, itemRelative(config, workflow.workItem.id), 'context', 'reviews',
    phaseId, `gen-${phase.generation}`);
}

function checkPublishedGeneration(workflow, phaseId) {
  const phase = workflow.phases?.[phaseId];
  if (!phase || !['in_progress', 'awaiting_approval', 'approved'].includes(phase.status)
      || !Number.isSafeInteger(phase.generation) || phase.generation < 1) {
    throw new SingularityFlowError(`Phase '${phaseId}' must have a published generation before source review.`, {
      code: 'SOURCE_REVIEW_GENERATION_REQUIRED'
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
  const committed = run('git', ['show', `HEAD:${relative}`], {
    cwd: root, allowFailure: true, encoding: 'buffer'
  });
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
  const captured = run('git', ['show', `${creationCommit}:${relative}`], {
    cwd: root, allowFailure: true, encoding: 'buffer'
  });
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
  const manifestRelative = `${base}/documents.json`;
  const manifest = await secureRepositoryPath(root, manifestRelative, { label: 'Story document catalog' });
  if (!manifest.exists) return { sources, unreadable };
  const catalog = readRecord('document-manifest',
    (await checkedFile(root, manifestRelative, 'Story document catalog')).bytes).record;
  if (catalog.workId !== workflow.workItem.id || !Array.isArray(catalog.documents)) throw new SingularityFlowError('Story document catalog is malformed.', {
    code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE'
  });
  for (const document of catalog.documents.filter((entry) => entry?.status !== 'detached' && documentOfferedToPhase(entry, phaseId))) {
    const name = document.name ?? document.id;
    // A review is re-checked on other machines, which do not have a machine-local document's bytes.
    if (isLocalDocument(document)) {
      unreadable.push({ id: document.id, name, code: 'machine-local-storage', originalSha256: document.sha256,
        reason: 'it is kept on one machine only' });
      continue;
    }
    if (document.type === 'url') {
      unreadable.push({ id: document.id, name, code: 'external-reference', reason: `it is a link (${document.url}) with no pinned bytes` });
      continue;
    }
    if (document.type !== 'file' || !document.path || !SHA256.test(String(document.sha256 ?? ''))) {
      throw new SingularityFlowError(`Attachment '${document.id ?? 'unknown'}' has no pinned reviewable file bytes.`, {
        code: 'SOURCE_REVIEW_INPUT_UNREADABLE'
      });
    }
    const relative = posix(document.path);
    if (!relative.startsWith(`${base}/inputs/`)) throw new SingularityFlowError(
      `Attachment '${document.id}' is outside the Story input directory.`, { code: 'SOURCE_REVIEW_INPUT_UNAVAILABLE' }
    );
    // An oversized attachment is a decision for a person, not a refusal of the whole review.
    const file = await checkedFile(root, relative, `Attachment '${document.id}'`, document.sha256,
      { maxBytes: Number.POSITIVE_INFINITY });
    if (file.bytes.length > MAX_SOURCE_BYTES) {
      unreadable.push({ id: document.id, name, code: 'too-large-to-cite', originalSha256: file.sha256,
        reason: `the file is larger than the ${MAX_SOURCE_BYTES}-byte review limit` });
      continue;
    }
    let text;
    // An older record whose stored name lost its extension is typed from its original name.
    const mime = effectiveDocumentMimeType(document);
    const typedName = path.extname(relative) ? relative : (document.sourceName ?? relative);
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
    if (cited.length >= MAX_CITED_SOURCES || totalBytes + bytes > MAX_TOTAL_TEXT_BYTES) {
      unreadable.push({ id: entry.id, name: entry.name, code: 'review-budget-exceeded', originalSha256: entry.originalSha256,
        reason: `the review already cites ${cited.length} sources and ${totalBytes} bytes of text, its limit` });
      continue;
    }
    cited.push(entry);
    totalBytes += bytes;
  }
  return { sources: cited.map(({ name: _name, ...entry }) => entry), unreadable };
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
  const authored = authoredArtifactText(utf8(file.bytes, `Phase '${phaseId}' artifact`));
  return { path: relative, text: boundedText(authored, `Phase '${phaseId}' artifact`) };
}

/** Exact source bytes and artifact bytes for an independent reviewer. This never writes. */
export async function sourceReviewInput(root, config, workflow, phaseId) {
  const phase = checkPublishedGeneration(workflow, phaseId);
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
  const { sources, unreadable } = await storySources(root, config, workflow, phaseId);
  const artifact = await phaseArtifact(root, config, workflow, phaseId);
  // A plan is reviewed against the approved scope it plans: the step before it that defines it.
  const kind = sourceReviewKind(workflow, phaseId);
  const upstreamSpec = kind === 'planning'
    ? await (async () => {
        const approved = latestStepBefore(workflow, phaseId, (candidate) => stepResponsibilities(workflow, candidate.id).includes('scope'));
        if (approved?.status !== 'approved') throw new SingularityFlowError(
          'Planning review requires an approved specification.', { code: 'SOURCE_REVIEW_SPEC_NOT_APPROVED' }
        );
        return phaseArtifact(root, config, workflow, approved.id);
      })()
    : null;
  const context = {
    kind, workId: workflow.workItem.id, phase: phaseId, generation: phase.generation,
    sources, ...(unreadable.length ? { unreadableSources: unreadable } : {}), artifact, ...(upstreamSpec ? { upstreamSpec } : {}),
    authorAgentId: phase.generatedAgent ?? 'human-author', reviewerAgentId, reviewerAgentSha256
  };
  return { ...context, binding: sourceReviewBinding(context) };
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
  const committed = run('git', ['show', `HEAD:${relative}`], {
    cwd: root, allowFailure: true, encoding: 'buffer'
  });
  if (committed.status !== 0 || !Buffer.isBuffer(committed.stdout)
      || !committed.stdout.equals(bytes)) {
    throw new SingularityFlowError(`${label} is not retained unchanged in the current Story commit.`, {
      code: 'SOURCE_REVIEW_RECORD_UNPUBLISHED'
    });
  }
  return JSON.parse(utf8(bytes, label));
}

async function assertRetainedLifecycleEvent(root, config, workflow, record, kind, sidecarFile) {
  const workflowFile = path.join(root, itemRelative(config, workflow.workItem.id), 'workflow.json');
  const committed = await readCommittedJson(root, workflowFile, 'Story workflow');
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
    throw new SingularityFlowError('Source review sidecar has no matching committed governed lifecycle event.', {
      code: 'SOURCE_REVIEW_EVENT_MISSING'
    });
  }
  // A copied sidecar cannot claim an old event. Its exact bytes and projection must have been
  // introduced together in one commit; the event must be absent from that commit's parent.
  const relative = posix(path.relative(root, sidecarFile));
  const introduced = run('git', ['log', '--format=%H', '--diff-filter=A', '--', relative], {
    cwd: root, allowFailure: true
  });
  const commits = introduced.status === 0 ? introduced.stdout.trim().split(/\r?\n/u).filter(Boolean) : [];
  const first = commits.length === 1 && /^[a-f0-9]{40,64}$/u.test(commits[0]) ? commits[0] : null;
  const sidecarAtFirst = first ? run('git', ['show', `${first}:${relative}`], {
    cwd: root, allowFailure: true, encoding: 'buffer'
  }) : null;
  const currentBytes = await readFile(sidecarFile);
  const workflowRelative = posix(path.relative(root, workflowFile));
  const workflowAtFirst = first ? run('git', ['show', `${first}:${workflowRelative}`], {
    cwd: root, allowFailure: true
  }) : null;
  const workflowBefore = first ? run('git', ['show', `${first}^:${workflowRelative}`], {
    cwd: root, allowFailure: true
  }) : null;
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
    throw new SingularityFlowError('Source review sidecar was not introduced with its governed lifecycle event.', {
      code: 'SOURCE_REVIEW_EVENT_MISSING'
    });
  }
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

async function readDecisions(root, config, workflow, phaseId, reportSha256) {
  const directory = path.join(sourceReviewDirectory(root, config, workflow, phaseId), 'decisions', reportSha256);
  if (!(await exists(directory))) return [];
  const names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort();
  const decisions = [];
  for (const name of names) {
    const record = checkedRecord(await readCommittedJson(root, path.join(directory, name), 'Source review human decision'),
      'Source review human decision', 'source-review-decision');
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

/** Read current review and decisions, then recompute all source and artifact bindings. */
export async function readSourceReviewStatus(root, config, workflow, phaseId) {
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  const current = await readCurrentRecord(root, config, workflow, phaseId);
  const retained = current ?? await readPriorGenerationRecord(root, config, workflow, phaseId);
  const decisions = current
    ? await readDecisions(root, config, workflow, phaseId, current.record.reportSha256) : [];
  const carried = current
    ? await carriedUnreadableDecisions(root, config, workflow, phaseId, input, current.record.reportSha256, decisions)
    : [];
  const review = evaluateSourceGroundedReview(retained?.record.report ?? null, {
    ...input,
    reviewerAgentId: retained?.record.provenance?.reviewerAgentId ?? null,
    reviewerReadOnly: retained?.record.provenance?.readOnly === true
      && retained.record.provenance.reviewerAgentSha256 === input.reviewerAgentSha256,
    humanDispositions: [...decisions, ...carried].map(({ id, reportSha256, decision, reason, actor }) => ({
      id, reportSha256, decision, reason, actor: actor.login ?? actor.email
    }))
  });
  return {
    schemaVersion: 1, resultType: 'source-review-status', workId: workflow.workItem.id, // schema-transient
    phase: phaseId, generation: input.generation, binding: input.binding,
    reportPath: retained?.path ?? null, reportSha256: retained?.record.reportSha256 ?? null,
    provenance: retained?.record.provenance ?? null,
    report: retained?.record.report ?? null, decisions,
    carriedDecisions: carried.map(({ id, reason, actor, decidedAt, carriedFrom }) => ({
      id, reason, actor: actor.login ?? actor.email ?? actor.name, decidedAt, carriedFrom
    })),
    ...review
  };
}

/** Build the JSON payload a reviewer authors, with no lifecycle or filesystem mutation. */
export async function sourceReviewContext(root, config, workflow, phaseId, stagingPath) {
  const input = await sourceReviewInput(root, config, workflow, phaseId);
  const reportTemplate = {
    schemaVersion: currentSchemaVersion('source-grounded-review'), resultType: 'source-grounded-review', kind: phaseId,
    binding: input.binding, reviewer: { agentId: input.reviewerAgentId, readOnly: true },
    sourcesReviewed: input.sources.map((source) => source.id), rows: [], findings: []
  };
  return {
    schemaVersion: 1, resultType: 'source-review-context', workId: input.workId, // schema-transient
    phase: phaseId, generation: input.generation, binding: input.binding,
    authorAgentId: input.authorAgentId, requiredReviewerAgentId: input.reviewerAgentId,
    reviewerAgentSha256: input.reviewerAgentSha256,
    sources: input.sources.map((source) => ({ id: source.id, path: source.path,
      originalSha256: source.originalSha256, textSha256: sha256(Buffer.from(source.text, 'utf8')),
      text: source.text })),
    // Not for the reviewer to cite: each needs a person's recorded decision instead.
    ...(input.unreadableSources?.length ? { unreadableSources: input.unreadableSources } : {}),
    artifact: { path: input.artifact.path, sha256: input.binding.artifact.sha256,
      originalSha256: input.binding.artifact.originalSha256, text: input.artifact.text },
    ...(input.upstreamSpec ? { upstreamSpec: {
      path: input.upstreamSpec.path, sha256: input.binding.upstreamSpec.sha256,
      originalSha256: input.binding.upstreamSpec.originalSha256,
      text: input.upstreamSpec.text
    } } : {}),
    reportTemplate, stagingPath
  };
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
      `Select the independent '${input.reviewerAgentId}' governed agent for ${input.phase} before submitting a review.`,
      { code: 'SOURCE_REVIEW_INDEPENDENT_AGENT_REQUIRED' }
    );
  }
  const evaluation = evaluateSourceGroundedReview(report, {
    ...input, reviewerAgentId: session.agent, reviewerReadOnly: true
  });
  if (evaluation.status === 'stale') throw new SingularityFlowError(
    'Review input changed after the report was written. Recreate it from review-source context.',
    { code: 'SOURCE_REVIEW_BINDING_STALE', details: evaluation }
  );
  if (evaluation.findings.some((entry) => ['review-contract-invalid', 'reviewer-not-independent',
    'review-self-disposition'].includes(entry.code))) {
    throw new SingularityFlowError('Reviewer report has an invalid contract or provenance.', {
      code: 'SOURCE_REVIEW_REPORT_INVALID', details: evaluation
    });
  }
  return evaluation;
}

/** Call inside a Story publication transaction, after its lock and recovery journal exist. */
export async function retainSourceReview(root, config, workflow, phaseId, report, evaluation, session, publicationEvent) {
  if (!publicationEvent?.eventId) throw new SingularityFlowError(
    'Source review report requires a governed lifecycle event.', { code: 'SOURCE_REVIEW_EVENT_REQUIRED' }
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
    code: 'SOURCE_REVIEW_DISPOSITION_NOT_PENDING'
  });
  if (typeof reason !== 'string' || !reason.trim()) throw new SingularityFlowError(
    'A human-authored reason is required for a source review disposition.',
    { code: 'SOURCE_REVIEW_DISPOSITION_REASON_REQUIRED' }
  );
  if (!authority?.authorityGroup || !actor?.email && !actor?.login) throw new SingularityFlowError(
    'A configured, authenticated human approval authority is required for this disposition.',
    { code: 'SOURCE_REVIEW_DISPOSITION_AUTHORITY_REQUIRED' }
  );
  if (!publicationEvent?.eventId) throw new SingularityFlowError(
    'Source review human decision requires a governed lifecycle event.',
    { code: 'SOURCE_REVIEW_EVENT_REQUIRED' }
  );
  const directory = path.join(sourceReviewDirectory(root, config, workflow, phaseId),
    'decisions', status.reportSha256);
  const body = {
    schemaVersion: currentSchemaVersion('source-review-decision'), phase: phaseId,
    generation: workflow.phases[phaseId].generation,
    reportSha256: status.reportSha256, lifecycleEventId: publicationEvent.eventId,
    id, decision: 'accepted', reason: reason.trim(),
    actor: actorIdentity(actor),
    authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, decidedAt: nowIso()
  };
  const record = { ...body, recordSha256: recordSha256(body) };
  await ensureSecureRepositoryDirectory(root, directory, { label: 'Source review decision directory' });
  const file = path.join(directory, `${record.recordSha256}.json`);
  await writeJson(file, record);
  workflow.history.push({ at: body.decidedAt,
    actor: body.actor.login ?? body.actor.email ?? body.actor.name, agent: null,
    event: 'source_review_disposition', phase: phaseId, detail: `${id} ${status.reportSha256}` });
  return { path: file, recordSha256: record.recordSha256 };
}
