/** Product adapter joining REV's deterministic kernels to one active governed Story. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { gitCommonDir, identity } from '../git.mjs';
import { executeGitQuery } from '../git-query.mjs';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { readPendingPublication } from '../publication-pending.mjs';
import { recordSha256 } from '../records.mjs';
import { loadSession, validAgentSession } from '../session.mjs';
import {
  loadConfig, loadStoryAggregate, workDir
} from '../state-stores.mjs';
import {
  loadActiveSpecRecords, predecessorSpecClauses
} from '../specifications.mjs';
import { readSgosRetainedCandidate } from '../sgos/candidate-lifecycle.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosRevisionCandidateReference, verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';
import { createFeedbackAttachmentStore } from './feedback-attachment-store.mjs';
import {
  buildRevisionCriteriaBinding, buildRevisionFeedback,
  buildRevisionSpecificationDisposition
} from './contracts.mjs';
import { probeRevisionSavedState } from './current-context.mjs';
import { createRevisionLoopStore } from './loop-store.mjs';
import { assertCurrentRevisionPrecheck } from './precheck.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const CLAUSE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const INSTALLED_OPERATIONS = Object.freeze([
  'revision.code', 'artifact.revise', 'story.amend', 'story.clarify',
  'implementation.reopen', 'release.plan.revise', 'outcome.review', 'work.create'
]);
const INSTALLED_PACKAGE_ROOT = PACKAGE_ROOT;

function implementationFiles(root) {
  const selected = [];
  const walk = (relativeDirectory, accept) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Revision implementation manifest refuses symbolic link '${relative}'.`);
      }
      if (entry.isDirectory()) walk(relative, accept);
      else if (entry.isFile() && accept(relative)) selected.push(relative);
    }
  };
  // Hash the complete shipped runtime rather than a hand-maintained import list.  This is
  // deliberately conservative: any executable runtime change produces a distinct REV producer.
  walk('src', (relative) => /\.(?:mjs|json)$/u.test(relative));
  walk('schemas', (relative) => /(?:^|[\\/])revision-[^\\/]+\.schema\.json$/u.test(relative));
  for (const relative of ['package.json']) {
    const absolute = path.join(root, relative);
    if (lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Revision implementation manifest refuses symbolic link '${relative}'.`);
    }
    selected.push(relative);
  }
  return Object.freeze(selected.map((relative) => relative.split(path.sep).join('/')).sort());
}

export function revisionImplementationSha256(packageDirectory = INSTALLED_PACKAGE_ROOT) {
  const dependencyAuthorityFile = path.join(
    packageDirectory, 'src', 'revision', 'producer-lock.json');
  const dependencyAuthorityInfo = lstatSync(dependencyAuthorityFile);
  if (!dependencyAuthorityInfo.isFile() || dependencyAuthorityInfo.isSymbolicLink()) {
    throw new Error('Revision producer dependency authority is missing or unsafe.');
  }
  const dependencyAuthority = JSON.parse(readFileSync(dependencyAuthorityFile, 'utf8'));
  const authoritySchemaVersion = dependencyAuthority?.schemaVersion;
  if (authoritySchemaVersion !== 1
      || dependencyAuthority?.algorithm !== 'sha256'
      || !HASH.test(dependencyAuthority?.packageLockSha256)
      || Object.keys(dependencyAuthority).sort().join(',')
        !== 'algorithm,packageLockSha256,schemaVersion') {
    throw new Error('Revision producer dependency authority is invalid.');
  }
  const checkoutLock = path.join(packageDirectory, 'package-lock.json');
  if (existsSync(checkoutLock)) {
    const lockInfo = lstatSync(checkoutLock);
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) {
      throw new Error('Revision producer dependency lock is missing or unsafe.');
    }
    const observed = `sha256:${createHash('sha256').update(readFileSync(checkoutLock)).digest('hex')}`;
    if (observed !== dependencyAuthority.packageLockSha256) {
      throw new Error('Revision producer dependency authority does not match package-lock.json.');
    }
  }
  const digest = createHash('sha256');
  for (const relative of implementationFiles(packageDirectory)) {
    const bytes = readFileSync(path.join(packageDirectory, ...relative.split('/')));
    digest.update(Buffer.from(`${relative}\0${bytes.length}\0`, 'utf8'));
    digest.update(bytes);
  }
  return `sha256:${digest.digest('hex')}`;
}

const PRODUCER_IMPLEMENTATION_SHA256 = revisionImplementationSha256();
const PRODUCER = Object.freeze({
  id: 'singularity-flow-revision-kernel', version: '1',
  implementationSha256: PRODUCER_IMPLEMENTATION_SHA256
});

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, details });
}
export function revisionDigest(value) { return `sha256:${recordSha256(value)}`; }
function exactSha(value) {
  if (HASH.test(String(value ?? ''))) return value;
  if (/^[a-f0-9]{64}$/u.test(String(value ?? ''))) return `sha256:${value}`;
  return revisionDigest(value);
}
function phaseTask(phase) { return phaseRequiresCodeDelivery(phase) ? 'code' : 'other'; }
export function revisionProofProfile(active) {
  const selected = active.phase.proofProfile
    ?? active.workflow.resolution?.proofProfile
    ?? active.config.codeDelivery?.proofProfile
    ?? 'standard';
  return ['standard', 'high-assurance', 'regulated'].includes(selected)
    ? selected : 'standard';
}

export function revisionEffectPolicy(active) {
  const protectedPaths = [...new Set([
    ...(active.config.governance?.protectedPaths ?? []),
    ...(active.workflow.resolution?.capability?.policy?.protectedPaths ?? [])
  ].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.replace(/\/$/u, '')))]
    .sort();
  const configuredMaximum = active.phase.maximumChangedFiles;
  const maximumChangedFiles = Number.isSafeInteger(configuredMaximum)
    && configuredMaximum > 0 && configuredMaximum <= 128 ? configuredMaximum : 32;
  return Object.freeze({
    writeScope: active.phase.writeScope ?? 'source-and-artifact', maximumChangedFiles,
    protectedPaths, protectedPathsSha256: revisionDigest(protectedPaths),
    applicationPathPolicySha256: revisionDigest({
      repository: active.config.repository ?? null,
      capability: active.workflow.resolution?.capability?.policy ?? null
    }),
    externalEffectsAllowed: false
  });
}

export async function loadActiveRevisionStory(root, {
  definition = null, workflow: selectedWorkflow = null, workId = null
} = {}) {
  const session = await loadSession(root);
  const config = definition ?? await loadConfig(root);
  // Ordinary interactive entry points deliberately omit an ID so branch/worktree ownership is
  // checked by the state store. Publication can instead provide the already accepted Story
  // execution definition and aggregate; subsequent rechecks reload that same Story through its
  // accepted definition rather than interpreting it through today's mutable configuration.
  const workflow = selectedWorkflow ?? await loadStoryAggregate(root, config, workId ?? undefined);
  if (workId != null && workflow.workItem?.id !== workId) {
    fail('REV_NO_ACTIVE_WORK', `The selected Story '${workflow.workItem?.id ?? 'unknown'}' does not match '${workId}'.`);
  }
  const pendingPublication = await readPendingPublication(root, {
    kind: 'story', id: workflow.workItem.id, migrate: false
  });
  if (pendingPublication) {
    fail('REV_RECOVERY_REQUIRED',
      `Story '${workflow.workItem.id}' has an unfinished governed publication. Recover that exact publication before opening or advancing a revision interval.`, {
        recoveryStage: pendingPublication.record?.recoveryStage ?? 'publication-pending'
      });
  }
  const phaseId = workflow.currentPhase;
  const phase = workflow.phases?.[phaseId];
  if (workflow.status !== 'in_progress' || !phase) {
    fail('REV_NO_ACTIVE_WORK', 'Revision requires one active governed Story phase. Resume the Story first.');
  }
  if (!validAgentSession(config, session, workflow.workItem.id, null, phaseId)) {
    fail('REV_NO_ACTIVE_WORK', `The local session is not bound to ${workflow.workItem.id}/${phaseId}. Run singularity-flow resume ${workflow.workItem.id}.`);
  }
  if (!phaseRequiresCodeDelivery(phase)) {
    const task = phase?.generationPolicy?.task ?? phase?.generation?.task ?? 'non-code';
    fail('REV_PHASE_NOT_CODE_BEARING', `Phase '${phaseId}' is registered as '${task}', not a code-bearing task.`);
  }
  if (!['in_progress', 'rework'].includes(phase.status)) {
    fail(phase.status === 'awaiting_approval' || phase.status === 'approved'
      ? 'REV_PHASE_PUBLISHED' : 'REV_PHASE_NOT_OPEN',
    `Phase '${phaseId}' is '${phase.status}' and cannot open an implementation revision.`);
  }
  if (!Number.isSafeInteger(phase.generation) || phase.generation < 1) {
    fail('REV_PARENT_CANDIDATE_MISSING',
      `Phase '${phaseId}' has no generated implementation candidate yet. Run the registered code-generation action first.`);
  }
  return Object.freeze({ root, config, workflow, session, phaseId, phase,
    publicationRecovery: false,
    subject: Object.freeze({ workId: workflow.workItem.id, phaseId,
      phaseGeneration: phase.generation }) });
}

export async function activeRevisionClauses(active) {
  const records = await loadActiveSpecRecords(
    workDir(active.root, active.config, active.workflow.workItem.id), active.workflow);
  const clauses = predecessorSpecClauses(records, active.workflow, active.phaseId)
    .map((clause) => ({
      id: String(clause.id).toUpperCase(),
      text: String(clause.body ?? '').trim() || String(clause.anchor ?? clause.id),
      clauseSha256: exactSha(clause.bodySha256 ?? clause)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set();
  for (const clause of clauses) {
    if (!CLAUSE.test(clause.id) || seen.has(clause.id)) {
      fail('REV_BINDING_UNAVAILABLE', 'Active approved criteria are missing or ambiguous.');
    }
    seen.add(clause.id);
  }
  if (!clauses.length) {
    fail('REV_BINDING_UNAVAILABLE',
      'Revision needs at least one active approved criterion from a predecessor specification phase.');
  }
  return Object.freeze(clauses);
}

export function selectRevisionCriteria(feedbackText, clauses, explicit = []) {
  const byId = new Map(clauses.map((clause) => [clause.id.toUpperCase(), clause]));
  const requested = [...new Set(explicit.flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toUpperCase()).filter(Boolean))];
  if (requested.length) {
    const unknown = requested.filter((id) => !byId.has(id));
    if (unknown.length) fail('REV_CRITERIA_UNKNOWN', `Unknown active criterion: ${unknown.join(', ')}.`);
    return Object.freeze({ mode: 'explicit', bound: requested.map((id) => byId.get(id)),
      packet: requested.map((id) => byId.get(id)) });
  }
  const normalized = feedbackText.toUpperCase();
  const exact = clauses.filter((clause) => new RegExp(
    `(^|[^A-Z0-9._:-])${clause.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}([^A-Z0-9._:-]|$)`, 'u'
  ).test(normalized));
  if (exact.length) return Object.freeze({ mode: 'exact-id', bound: exact, packet: exact });
  const bytes = Buffer.byteLength(JSON.stringify(clauses));
  if (clauses.length > 25 || bytes > 32 * 1024) {
    fail('REV_CRITERIA_AMBIGUOUS',
      'Feedback names no exact criterion and all active criteria exceed the safe packet budget. Select --criteria <ID>.');
  }
  return Object.freeze({ mode: 'unscoped', bound: [], packet: clauses });
}

function structuredIntentConflict(feedbackText, criteria = []) {
  const text = feedbackText.trim().toLowerCase();
  const changeCue = /(?:\b(?:change|replace|set|increase|decrease|instead|rather than|should be|must be)\b|\bfrom\b.{0,80}\bto\b|[-=]>)/u;
  if (!changeCue.test(text)) return { conflict: false, uncertain: false };
  const valuePattern = /\b(?:\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|minutes?|hours?|days?|%|percent|bytes?|kb|mb|gb)?|true|false|enabled|disabled|required|optional)\b/gu;
  const feedbackValues = [...text.matchAll(valuePattern)].map((match) => match[0]);
  if (!feedbackValues.length) return { conflict: false, uncertain: false };
  const criterionText = criteria.map((item) => String(item?.text ?? '').toLowerCase()).join('\n');
  const criterionValues = new Set([...criterionText.matchAll(valuePattern)].map((match) => match[0]));
  if (!criterionValues.size) return { conflict: false, uncertain: true };
  return {
    conflict: feedbackValues.some((value) => !criterionValues.has(value)),
    uncertain: false
  };
}

/** Closed, conservative classification. Unknown language is ambiguous and never mutates code. */
export function classifyRevisionFeedback(feedbackText, requested = null, criteria = []) {
  const allowed = new Set(['implementation-change', 'specification-change', 'ambiguous', 'unrelated']);
  const text = feedbackText.trim().toLowerCase();
  const unrelated = /\b(unrelated|different story|new story|separate work)\b/u.test(text);
  const directIntentChange = /\b(amend|new requirement|change (?:the )?(?:requirement|criterion|acceptance|specification|design|architecture)|remove (?:the )?(?:required|mandatory)|replace (?:the )?(?:contract|api version|architecture))\b/u.test(text);
  const structured = structuredIntentConflict(feedbackText, criteria);
  const implementation = /\b(fix|bug|missed|missing|not handled|does not|doesn't|reuse|refactor|simplif(?:y|ied)|implementation|edge case|test|readability|performance)\b/u.test(text);
  const inferred = unrelated ? 'unrelated'
    : directIntentChange || structured.conflict ? 'specification-change'
      : structured.uncertain ? 'ambiguous'
        : implementation ? 'implementation-change' : 'ambiguous';
  const predicateId = unrelated ? 'explicit-unrelated-language'
    : directIntentChange ? 'explicit-intent-change-language'
      : structured.conflict ? 'structured-value-conflict'
        : structured.uncertain ? 'structured-value-needs-criterion-resolution'
          : implementation ? 'implementation-correction-language'
            : 'no-authoritative-disposition-predicate';
  if (requested != null) {
    if (!allowed.has(requested)) {
      fail('REV_DISPOSITION_REQUIRED', `--disposition must be one of ${[...allowed].join(', ')}.`);
    }
    if ((inferred === 'specification-change' || inferred === 'unrelated')
        && requested !== inferred) {
      fail('REV_DISPOSITION_CONFLICT',
        `Explicit disposition '${requested}' conflicts with deterministic '${inferred}' evidence.`);
    }
    return { result: requested, predicateId: 'explicit-human-disposition', human: true };
  }
  return { result: inferred, predicateId, human: false };
}

export async function readRevisionContext(active) {
  const saved = await probeRevisionSavedState(active.root, {
    config: active.config, workflow: active.workflow
  });
  const clauses = await activeRevisionClauses(active);
  let canonicalCommonGitDir;
  try { canonicalCommonGitDir = realpathSync(gitCommonDir(active.root)); }
  catch { fail('REV_CONTEXT_UNAVAILABLE', 'The selected repository has no verifiable common Git directory.'); }
  const context = {
    // Keep this byte-for-byte compatible with feedback-attachment receipts. The path itself is
    // private and never enters a record; only its digest binds evidence to this repository.
    repositorySha256: `sha256:${createHash('sha256').update(Buffer.from(canonicalCommonGitDir)).digest('hex')}`,
    headCommit: saved.headCommit,
    sourceTreeSha256: saved.sourceTreeSha256,
    configSha256: revisionDigest(active.config),
    workflowSha256: revisionDigest(active.workflow),
    approvedIntentSha256: revisionDigest(clauses.map(({ id, clauseSha256 }) => ({ id, clauseSha256 }))),
    routeContractSha256: revisionDigest({
      phaseId: active.phaseId, task: phaseTask(active.phase),
      generation: active.phase.generationPolicy ?? active.phase.generation ?? null,
      writeScope: active.phase.writeScope ?? null
    }),
    proofProfileSha256: revisionDigest({
      profile: revisionProofProfile(active)
    }),
    editorDiskIndexBaselineSha256: saved.editorDiskIndexBaselineSha256
  };
  return Object.freeze({ context: Object.freeze(context), saved, clauses });
}

const REV_STABLE_CONTEXT_FIELDS = Object.freeze([
  'repositorySha256', 'headCommit', 'configSha256', 'workflowSha256',
  'approvedIntentSha256', 'routeContractSha256', 'proofProfileSha256'
]);

/**
 * Recheck all authority fields and the complete saved editor/disk/index observation while retaining
 * the loop's source-tree identity. A revision interval is expected to change application bytes;
 * those exact bytes are admitted separately as a retained Candidate. The saved-state digest still
 * changes for every path/index/source edit, so ignoring `sourceTreeSha256` here does not create an
 * unobserved worktree window.
 */
export async function readPinnedRevisionContext(active, pinnedContext) {
  const current = await readRevisionContext(await loadActiveRevisionStory(active.root, {
    definition: active.config, workId: active.workflow.workItem.id
  }));
  for (const field of REV_STABLE_CONTEXT_FIELDS) {
    if (current.context[field] !== pinnedContext[field]) {
      fail('REV_CONTEXT_STALE', `Revision authority '${field}' changed during the interval.`);
    }
  }
  if (current.context.editorDiskIndexBaselineSha256
      !== pinnedContext.editorDiskIndexBaselineSha256) {
    fail('REV_CONTEXT_STALE', 'Saved files, index, or editor assertion changed during the interval.');
  }
  return Object.freeze(structuredClone(pinnedContext));
}

export function revisionCreator(active) {
  const observed = identity(active.root, { offline: true });
  const id = String(observed.email ?? '').trim().toLowerCase();
  if (!id || !id.includes('@')) {
    fail('REV_IDENTITY_UNAVAILABLE',
      'Guarded revision feedback requires an explicit repository Git user.email; ambient OS or cached account names are not authority.');
  }
  const security = active.config.approvalSecurity ?? {};
  const authorities = Object.values(active.config.approvalAuthorities ?? {});
  const explicitlyListed = authorities.some((authority) => (authority.members ?? [])
    .some((member) => String(member.email ?? '').trim().toLowerCase() === id));
  const permitted = explicitlyListed
    || authorities.some((authority) => authority.allowAnyGitIdentity === true)
    || (['poc', 'team'].includes(security.profile) && security.autoEnrollNewIdentities === true);
  if (!permitted) {
    fail('REV_IDENTITY_NOT_AUTHORIZED',
      `Repository governance does not permit configured-local identity '${id}' to persist revision feedback.`);
  }
  return Object.freeze({ candidate: { kind: 'human', id }, feedback: {
    kind: 'configured-local', id, name: observed.name || id
  } });
}

export function revisionFeedbackPrivacyPolicy(active) {
  const core = Object.freeze({
    id: 'guarded-local-revision-feedback-v1', storage: 'git-private-sidecar',
    access: 'active-story-phase', remoteSync: 'never', providerDispatch: false,
    aggregateTelemetryContent: false,
    governanceSha256: revisionDigest({
      approvalSecurity: active.config.approvalSecurity ?? null,
      approvalAuthorities: active.config.approvalAuthorities ?? null
    })
  });
  return Object.freeze({ ...core, policySha256: revisionDigest(core) });
}

export function assertRevisionFeedbackPrivacy(feedbackText, policy) {
  if (!policy || policy.id !== 'guarded-local-revision-feedback-v1'
      || policy.storage !== 'git-private-sidecar' || policy.remoteSync !== 'never'
      || policy.providerDispatch !== false || policy.aggregateTelemetryContent !== false) {
    fail('REV_FEEDBACK_PRIVACY_UNAVAILABLE',
      'The installed guarded local feedback privacy policy is unavailable.');
  }
  if (/(?:https?|ssh|git):\/\/[^\s/@:]+:[^\s/@]+@/iu.test(feedbackText)) {
    fail('REV_FEEDBACK_SECRET',
      'Revision feedback contains a credential-bearing URL; no durable REV effect was created.');
  }
  return policy;
}

export function buildRevisionFeedbackRecords({
  active, feedbackText, capturedAt, criteria, disposition,
  creator = revisionCreator(active)
}) {
  // The durable contract uses the byte SHA rather than the record projection.
  const exactFeedbackSha256 = `sha256:${createHash('sha256').update(feedbackText).digest('hex')}`;
  const feedback = buildRevisionFeedback({
    feedbackId: `REVFB-${exactFeedbackSha256.slice(7, 31).toUpperCase()}`,
    subject: active.subject, author: creator.feedback, text: feedbackText,
    bytes: Buffer.byteLength(feedbackText), feedbackSha256: exactFeedbackSha256,
    capturedAt, producer: PRODUCER
  });
  const binding = buildRevisionCriteriaBinding({
    subject: active.subject, feedbackSha256: feedback.feedbackSha256, mode: criteria.mode,
    criteria: criteria.bound.map((clause) => ({
      clauseId: clause.id, clauseSha256: clause.clauseSha256
    })),
    binder: { id: 'revision-criteria-binder', version: 1,
      implementationSha256: PRODUCER.implementationSha256 }, producer: PRODUCER
  });
  const humanResolution = disposition.human ? {
    decision: disposition.result, decidedBy: creator.feedback.id, decidedAt: capturedAt,
    reason: 'Explicit disposition selected for this exact revision feedback.'
  } : null;
  const dispositionRecord = buildRevisionSpecificationDisposition({
    subject: active.subject, feedbackSha256: feedback.feedbackSha256,
    bindingSha256: binding.bindingSha256,
    result: disposition.result,
    predicateResults: [{ predicateId: disposition.predicateId,
      result: disposition.result === 'ambiguous' ? 'unavailable' : 'pass' }],
    humanResolution, producer: PRODUCER
  });
  return { feedback, binding, disposition: dispositionRecord, creator };
}

export function routeInputFor({
  active, context, candidateReference, feedbackText, disposition, attachmentSet = null,
  creator = revisionCreator(active)
}) {
  const mapped = disposition.result === 'specification-change'
    ? 'approved-intent-change' : disposition.result === 'ambiguous'
      ? 'clarification' : disposition.result === 'unrelated'
        ? 'new-work' : 'implementation-change';
  return {
    context: {
      workId: active.subject.workId, phaseId: active.subject.phaseId,
      phaseGeneration: active.subject.phaseGeneration,
      ...context, phaseTask: phaseTask(active.phase), phaseStatus: active.phase.status,
      published: false, publicationRecovery: active.publicationRecovery === true,
      loopRecovery: false,
      specificationDisposition: mapped, target: { kind: 'implementation-candidate', status: 'draft' },
      parentCandidate: candidateReference, deliveryMode: active.workflow.workItem?.workType ?? null,
      proofProfile: revisionProofProfile(active),
      identity: { kind: 'configured-local', id: creator.feedback.id },
      installedOperations: [...INSTALLED_OPERATIONS]
    },
    feedbackText,
    attachmentSet
  };
}

export function revisionAttachmentStore(active) {
  return createFeedbackAttachmentStore(active.root, {
    workId: active.subject.workId,
    phaseId: active.subject.phaseId,
    phaseGeneration: active.subject.phaseGeneration
  });
}

export async function packetInputFor({
  active, candidateReference, criteria, feedbackId, feedbackRecordSha256, criteriaBindingSha256,
  specificationDispositionSha256, attachmentSet = null, attachmentStore = null
}) {
  const retained = await readSgosRetainedCandidate(active.root, candidateReference.candidateId);
  const diff = executeGitQuery(active.root, 'revision.candidate-diff', {
    baseline: candidateReference.repository.baselineCommit,
    candidateTree: candidateReference.repository.candidateTree
  });
  if (Buffer.byteLength(diff) > 32 * 1024) {
    fail('REV_PACKET_BUDGET_EXCEEDED',
      'The current Candidate diff exceeds the bounded revision packet. Narrow the implementation before revising.');
  }
  if (attachmentSet && typeof attachmentStore?.read !== 'function') {
    fail('REV_ATTACHMENT_SET_UNVERIFIED', 'Registered attachment evidence needs its governed store.');
  }
  const attachmentRenditions = attachmentSet
    ? await Promise.all(attachmentSet.attachments.map((item) =>
      attachmentStore.readObject(item.renditionSha256)))
    : [];
  const effectPolicy = revisionEffectPolicy(active);
  return {
    parentCandidate: candidateReference,
    verifyCandidate: (reference) => verifySgosRevisionCandidateReference(active.root, reference, {
      subjectId: `${active.subject.workId}:${active.subject.phaseId}`
    }),
    attachmentRenditions,
    verifyAttachmentSet: attachmentSet ? async (attachmentSetSha256) => {
      const fresh = await attachmentStore.read(attachmentSetSha256);
      return fresh?.attachmentSetSha256 === attachmentSetSha256
        && revisionDigest(fresh) === revisionDigest(attachmentSet);
    } : null,
    criteria: { items: criteria.packet.map((clause) => ({ id: clause.id, text: clause.text })) },
    feedbackId,
    feedbackRecordSha256,
    criteriaBindingSha256,
    specificationDispositionSha256,
    rules: {
      task: phaseTask(active.phase), writeScope: active.phase.writeScope ?? 'source-and-artifact',
      protectedPaths: effectPolicy.protectedPaths
    },
    diff,
    skeletons: retained.candidate.resources.map((resource) => ({
      path: resource.path, operation: resource.operation, type: resource.type
    })),
    effectPolicy, expansions: [], producer: PRODUCER
  };
}

export function revisionLoopStore(active, {
  expectedPrecheck = null, expectedPrecheckInput = null, frozenCaptureContext = null
} = {}) {
  let store;
  store = createRevisionLoopStore({
    root: active.root, ...active.subject, producer: PRODUCER,
    assertCurrentContext: async ({ scope, context }) => {
      if (revisionDigest(scope) !== revisionDigest(active.subject)) return false;
      try {
        const live = await readRevisionContext(await loadActiveRevisionStory(active.root, {
          definition: active.config, workId: active.workflow.workItem.id
        }));
        const existing = await store.read();
        const pinnedSource = existing?.context?.sourceTreeSha256 ?? live.context.sourceTreeSha256;
        if (context.sourceTreeSha256 !== pinnedSource) return false;
        for (const field of REV_STABLE_CONTEXT_FIELDS) {
          if (live.context[field] !== context[field]) return false;
        }
        // Recovery may advance only the exact context captured before freeze. The journal
        // reconciliation path handles a Candidate that was already committed before a crash;
        // an uncommitted compare-and-swap must still refuse if the visible worktree changed.
        if (frozenCaptureContext != null
            && revisionDigest(context) !== revisionDigest(frozenCaptureContext)) return false;
        return live.context.editorDiskIndexBaselineSha256
          === context.editorDiskIndexBaselineSha256;
      } catch { return false; }
    },
    verifyRetainedCandidate: async (reference) => verifySgosRevisionCandidateReference(
      active.root,
      // The journal stores a compact candidate summary. Resolve the complete reference first.
      reference.family ? reference : await sgosRevisionCandidateReference(active.root, reference.candidateId),
      { subjectId: `${active.subject.workId}:${active.subject.phaseId}` }
    ),
    verifyCurrentPrecheck: async (receipt) => {
      if (!expectedPrecheck || !expectedPrecheckInput
          || receipt.precheckSha256 !== expectedPrecheck.precheckSha256) return false;
      try {
        return assertCurrentRevisionPrecheck(receipt, expectedPrecheckInput).precheckSha256
          === expectedPrecheck.precheckSha256;
      } catch { return false; }
    }
  });
  return store;
}

export function producerIdentity() { return PRODUCER; }
