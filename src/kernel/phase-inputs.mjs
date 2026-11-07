/** Pure accepted-input selection and human-checkpoint policy. No native record or artifact I/O. */
import {SingularityFlowError} from '../foundation/failures.mjs';

export function workflowInputsMode(workflow) {
  return workflow.resolution?.inputsMode ?? 'off';
}

export function resolvedPhaseInputs(workflow, phase) {
  return workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id)?.inputs ?? phase.inputs ?? [];
}

export function approvedInputPhases(workflow, phase) {
  if (!workflow || !phase || workflowInputsMode(workflow) === 'off') return [];
  return [...new Set(resolvedPhaseInputs(workflow, phase)
    .map((entry) => typeof entry === 'string' ? entry : entry?.phase).filter(Boolean))];
}

/** The native input audit condition, shared by the writer and the operation receipt. */
export function phaseInputsAuditRequired(workflow, phase) {
  return phase.kind === 'skill' || (workflowInputsMode(workflow) !== 'off' && Boolean(resolvedPhaseInputs(workflow, phase).length));
}

/** Body-free bindings only. Rendering, remote files and human command guidance belong to hosts. */
export function phaseInputsManifest(binding, facts) {
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
  const text = value => typeof value === 'string' && value.length > 0;
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const digest = value => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/u.test(value);
  const nullable = (check, value) => value === null || check(value);
  const key = value => text(value) && !value.startsWith('/') && !/^[a-zA-Z]:/u.test(value) && !value.includes('\\')
    && !value.split('/').some(part => !part || part === '.' || part === '..');
  const bad = () => { throw new SingularityFlowError('The phase-input port returned invalid or differently bound facts.', { code: 'ENGINE_PORT_RESULT_INVALID' }); };
  if (!exact(facts, ['workId','phase','generation','dryRun','mode','renderedSha256','artifact','audit','auditRecorded','generationOpened','records','errorCount','warningCount','remoteWarningCount','remoteOutputCount'])
    || facts.workId !== binding.workId || facts.phase !== binding.phase || facts.generation !== binding.generation
    || facts.dryRun !== binding.dryRun || !['off','record','enforce'].includes(facts.mode)
    || !nullable(digest, facts.renderedSha256) || typeof facts.auditRecorded !== 'boolean' || typeof facts.generationOpened !== 'boolean'
    || ['errorCount','warningCount','remoteWarningCount','remoteOutputCount'].some(field => !count(facts[field]))
    || !binding.dryRun && facts.errorCount > 0 || binding.dryRun && (facts.auditRecorded || facts.generationOpened || facts.remoteOutputCount > 0)
    || facts.auditRecorded !== (!binding.dryRun && binding.auditRequired) || !Array.isArray(facts.records)) bad();
  const artifact = facts.artifact, audit = facts.audit;
  if (!exact(artifact, ['key','sha256','bytes','managedSha256','managedMatchesRendered']) || artifact.key !== binding.artifactKey
    || !key(artifact.key) || !nullable(digest, artifact.sha256) || !nullable(count, artifact.bytes)
    || !nullable(digest, artifact.managedSha256) || !nullable(value => typeof value === 'boolean', artifact.managedMatchesRendered)
    || binding.dryRun && (artifact.sha256 !== null || artifact.bytes !== null || artifact.managedSha256 !== null || artifact.managedMatchesRendered !== null)
    || !binding.dryRun && (!digest(artifact.sha256) || !count(artifact.bytes))) bad();
  if (audit !== null && (!exact(audit, ['key','sha256','generation']) || !key(audit.key) || !digest(audit.sha256) || !count(audit.generation))) bad();
  if (facts.auditRecorded && (!audit || audit.generation !== binding.generation) || binding.dryRun && audit !== null) bad();
  for (const record of facts.records) {
    if (!exact(record, ['phase','key','optional','status','producerStatus','generation','approvedSha256','observedSha256','bytes','maximumBytes','maximumSummaryBytes','truncated','representation','brief','output','receipt','selectedClauses'])
      || !text(record.phase) || !nullable(key, record.key) || typeof record.optional !== 'boolean'
      || record.status !== 'captured' && !INPUT_FINDING_STATUSES.has(record.status)
      || !text(record.producerStatus) || !count(record.generation) || !nullable(digest, record.approvedSha256)
      || !nullable(digest, record.observedSha256) || !count(record.bytes) || !nullable(text, record.output)
      || !nullable(count, record.maximumBytes) || !nullable(count, record.maximumSummaryBytes) || typeof record.truncated !== 'boolean'
      || record.selectedClauses !== null && (!Array.isArray(record.selectedClauses) || !record.selectedClauses.every(text))) bad();
    const representation = record.representation, receipt = record.receipt;
    if (record.brief !== null && (!exact(record.brief, ['key','sha256']) || !key(record.brief.key) || !digest(record.brief.sha256))) bad();
    if (representation !== null && (!exact(representation, ['kind','sha256','bytes','complete','expansionHandle'])
      || !['full','fallback-whole','summary','clauses','truncated'].includes(representation.kind)
      || !digest(representation.sha256) || !count(representation.bytes) || typeof representation.complete !== 'boolean'
      || representation.complete !== (!record.truncated && ['full','fallback-whole'].includes(representation.kind))
      || (representation.kind === 'truncated' ? !record.truncated : representation.kind !== 'clauses' && record.truncated)
      || representation.kind === 'summary' && record.brief === null
      || !nullable(text, representation.expansionHandle))) bad();
    if (receipt !== null && (!exact(receipt, ['generation','packetSha256','evidenceCommit','submittedSha256','approvedSha256','submittedBundleSha256','bundleSha256','acceptance'])
      || !count(receipt.generation) || !digest(receipt.packetSha256) || !text(receipt.evidenceCommit)
      || !digest(receipt.submittedSha256) || !digest(receipt.approvedSha256)
      || !nullable(digest, receipt.submittedBundleSha256) || !nullable(digest, receipt.bundleSha256)
      || !['human-approved','policy-approved'].includes(receipt.acceptance))) bad();
    if (receipt !== null && (!record.output || receipt.generation !== record.generation || receipt.approvedSha256 !== record.observedSha256)
      || record.status === 'captured' && record.output !== null && receipt === null) bad();
    if (record.status === 'captured' && (!record.key || record.producerStatus !== 'approved'
      || !record.observedSha256 || record.observedSha256 !== record.approvedSha256 || !representation)) bad();
  }
  return { schemaVersion: 1, contract: 'sflow-phase-input-manifest/v1', workId: binding.workId, phase: binding.phase,
    generation: binding.generation, dryRun: binding.dryRun, mode: facts.mode, ready: facts.errorCount === 0,
    renderedSha256: facts.renderedSha256, artifact, audit: audit ? { ...audit,
      forPreparedGeneration: audit.generation === binding.generation, recordedInThisOperation: facts.auditRecorded } : null,
    records: facts.records, errorCount: facts.errorCount, warningCount: facts.warningCount,
    remoteWarningCount: facts.remoteWarningCount, remoteOutputCount: facts.remoteOutputCount,
    authoringCompleted: false, publicationReadinessInspected: false, finalBindingChecked: false,
    humanReviewRecorded: false, approvalRecorded: false };
}

const CLARIFICATION_MODES=new Set(['off','when-needed','required']);
const DEFAULT_MAX_QUESTIONS=5;
export const MARKER_MODES=Object.freeze(['off','warn','block']);

export function markerPolicy(value) {
  const mode = typeof value === 'string' ? value : value?.mode ?? 'off';
  if (!MARKER_MODES.includes(mode)) {
    throw new SingularityFlowError(`clarification.markers.mode must be one of ${MARKER_MODES.join(', ')}; got '${mode}'.`);
  }
  return { mode };
}

export function normalizeClarificationPolicy(value = {}) {
  if (value == null) value = {};
  if (typeof value === 'string') value = { mode: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('clarification must be an object or mode string.');
  }
  for (const key of Object.keys(value)) {
    // `markers` is the marker policy, pinned separately from the conversational mode above
    // [SPK:REQ-064]: one governs whether the agent asks questions, the other governs what happens
    // to an unanswered `[NEEDS CLARIFICATION: ...]` left in the artifact.
    if (!['mode', 'maxQuestions', 'topics', 'markers'].includes(key)) {
      throw new SingularityFlowError(`clarification contains unknown field '${key}'.`);
    }
  }
  const mode = value.mode ?? 'off';
  if (!CLARIFICATION_MODES.has(mode)) {
    throw new SingularityFlowError('clarification.mode must be off, when-needed, or required.');
  }
  const maxQuestions = value.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 10) {
    throw new SingularityFlowError('clarification.maxQuestions must be an integer from 1 through 10.');
  }
  const topics = value.topics ?? [];
  if (!Array.isArray(topics) || topics.some((topic) => typeof topic !== 'string' || !topic.trim())) {
    throw new SingularityFlowError('clarification.topics must contain non-empty strings.');
  }
  const normalizedTopics = [...new Set(topics.map((topic) => topic.trim()))];
  if (normalizedTopics.length !== topics.length) {
    throw new SingularityFlowError('clarification.topics must not contain duplicates.');
  }
  return { mode, maxQuestions, topics: normalizedTopics, markers: markerPolicy(value.markers) };
}

export function clarificationCheckpointState(mode,recordState,errorCount) {
  const missing=recordState==='missing';
  const stage=mode==='off'?'off':missing?mode==='required'?'derive-questions':'assess-ambiguity'
    :errorCount?'inspect-binding':'complete';
  return {stage,questioningAllowed:['derive-questions','assess-ambiguity'].includes(stage),requiresHumanResponse:stage==='derive-questions'};
}

export function inputFindingSeverity(mode, optional, status) {
  // A decision may skip a producer only when every phase still reached reads it optionally, so a
  // skipped optional input is expected; a required one is an error the decision should have refused.
  if (status === 'captured' || (optional && ['missing', 'unapproved', 'skipped'].includes(status))) return null;
  return mode === 'enforce' ? 'error' : 'warning';
}

const INPUT_FINDING_STATUSES = new Set(['skipped','missing','unapproved','hash_mismatch','brief_missing','brief_invalid','expansion_missing','receipt_missing','receipt_invalid']);

export function inputReadinessFindings(result) {
  return (result?.records ?? [])
    .filter((record) => inputFindingSeverity(result.mode, record.optional, record.status) === 'error'
      && INPUT_FINDING_STATUSES.has(record.status))
    .map((record) => ({
      phase: record.phase,
      path: record.repositoryPath ?? record.path ?? null,
      status: record.status,
      producerStatus: record.producerStatus ?? null,
      approvedSha256: record.approvedSha256 ?? null,
      sha256: record.sha256 ?? null,
      // Changed or deleted bytes of an approved producer can be put back exactly; anything else
      // (an unapproved producer, a missing brief or receipt) needs that producer's own route.
      restorable: ['hash_mismatch', 'missing'].includes(record.status)
        && record.producerStatus === 'approved' && Boolean(record.approvedSha256)
    }));
}
