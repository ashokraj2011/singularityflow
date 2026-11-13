/** Human witness values over authenticated observations. No files, Git, command rendering or clock. */
import {canonicalJson,textDigestCapability} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
export const WITNESS_CHECKLIST=Object.freeze(['states-the-outcome','matches-the-criterion','current-for-this-change']);
const AC_ID=/^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/u;
function invalid(message,code='WITNESS_RECORD_INVALID'){return new SingularityFlowError(message,{code});}
function missingPublication(workflow,{clauseId,file,sha256,published}){return new SingularityFlowError(
  'Witness the exact evidence retained by the criterion owner before recording acceptance.',{code:'WITNESS_EVIDENCE_UNPUBLISHED',
    details:{workId:workflow.workItem?.id??null,clauseId,file,sha256,published}});}
export function witnessRecordPolicies(digests,{unpublished=missingPublication}={}){
  const {sha256Utf8}=textDigestCapability(digests),recordSha256=value=>sha256Utf8(canonicalJson(value));
function witnessContextBinding(workflow, { legacy = false } = {}) {
  return `sha256:${recordSha256({ workId: workflow.workItem?.id ?? null,
    phases: (workflow.phaseOrder ?? Object.keys(workflow.phases ?? {})).map((id) => {
      const phase = workflow.phases?.[id] ?? {};
      return { id, specification: phase.specIndex?.indexSha256 ?? null,
        plan: phase.claimMaps?.planned?.sha256 ?? null,
        candidate: phase.deliveryEvidence ? { generation: phase.generation, ...(legacy ? { commit: phase.generationCommit ?? null } : {}),
          source: phase.deliveryEvidence.sourceTreeSha256 ?? null, tests: phase.deliveryEvidence.testInputSha256 ?? null } : null };
    }) })}`;
}

/** Refuse a native review whose inspected candidate or file changed before its record is written. */
function assertWitnessReviewBinding(workflow, { expectedContext, expectedFile, actualFile, clauseId, slot, file }) {
  const digest = /^sha256:[a-f0-9]{64}$/u;
  if (expectedContext != null && (!digest.test(expectedContext) || expectedContext !== witnessContextBinding(workflow))
      || expectedFile != null && (!digest.test(expectedFile) || expectedFile !== actualFile)) {
    throw new SingularityFlowError('The candidate or evidence changed after inspection. Nothing was recorded; reopen the current human witness review.',
      { code: 'WITNESS_REVIEW_CHANGED' });
  }
  // Native review selected a still-pending slot, not a second signature on a completed review.
  const existing = expectedContext && witnessRecordResults(workflow.witnessRecords, new Map([[file, actualFile]]),
    { contextBinding: witnessContextBindings(workflow) }).find(record => record.clauseId === clauseId && record.slot === slot && record.status === 'met');
  if (existing) throw new SingularityFlowError(`${existing.recordId} already signs off ${clauseId} slot ${slot} for this evidence and candidate. No duplicate was recorded. Refresh Decisions for the remaining items.`,
    { code: 'WITNESS_ALREADY_RECORDED' });
}

/** The bindings a record may carry and still belong to this candidate: today's, and the legacy form. */
function witnessContextBindings(workflow) {
  return [witnessContextBinding(workflow), witnessContextBinding(workflow, { legacy: true })];
}
function recordWitnessWithEvidence(workflow, { clauseId, slot, file, sha256, answers = {}, reason, actor, authorityGroup, identityAssurance = null, at, plannedClaim = null }, publishedEvidence = [], contextBinding = null) {
  if(contextBinding!==null&&!/^sha256:[a-f0-9]{64}$/u.test(contextBinding))throw invalid('Bind the human review to an exact observed candidate digest.');
  if (!AC_ID.test(String(clauseId ?? ''))) throw invalid('--criterion must name one acceptance criterion, such as ORDER:AC-001.');
  if (!slot || !['inspection', 'visual'].includes(slot.method)) {
    throw invalid(`${clauseId}'s contract has no inspection or visual slot by that name; tests are witnessed by their own runs.`);
  }
  if (slot.method === 'inspection' && file !== slot.witness.path) {
    throw invalid(`${clauseId}'s slot ${slot.slot} inspects ${slot.witness.path}, not ${file}.`);
  }
  const retained = (plannedClaim?.obligations ?? (plannedClaim ? [plannedClaim] : []))
    .filter((entry) => entry.fulfillment === 'evidence');
  if (retained.length) {
    const expected = retained.flatMap((entry) => entry.expectedPaths);
    if (!expected.includes(file)) throw invalid(`${clauseId}'s retained evidence is ${expected.join(', ')}, not ${file}.`);
    const published = (publishedEvidence ?? []).filter((entry) => entry.clauseId === clauseId && entry.path === file);
    // The refusal names who published which bytes, the file's bytes now and both ways on (ws-graph, 2026-10-27).
    if (!published.length || published.some((entry) => entry.sha256 !== sha256)) {
      throw unpublished(workflow, { clauseId, file, sha256, published });
    }
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(sha256 ?? ''))) throw invalid(`${file} could not be read to bind its bytes.`);
  const unknown = Object.keys(answers).filter((item) => !WITNESS_CHECKLIST.includes(item));
  const missing = WITNESS_CHECKLIST.filter((item) => !['yes', 'no'].includes(answers[item]));
  if (unknown.length || missing.length) {
    throw invalid(`Answer every checklist item once with --confirm or --deny: ${WITNESS_CHECKLIST.join(', ')}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}.`);
  }
  const text = String(reason ?? '').trim();
  if (text.length < 10 || text.length > 1000) throw invalid('Say what you inspected in 10 to 1000 characters with --reason.', 'WITNESS_RECORD_REASON_REQUIRED');
  workflow.witnessRecords ??= [];
  const record = {
    id: `WIT-${String(workflow.witnessRecords.length + 1).padStart(3, '0')}`,
    clauseId, slot: slot.slot, method: slot.method, file, sha256,
    contextBinding: contextBinding ?? witnessContextBinding(workflow),
    ...(slot.method === 'visual' ? { target: slot.witness.target } : {}),
    checklist: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, answers[item]])),
    outcome: WITNESS_CHECKLIST.every((item) => answers[item] === 'yes') ? 'met' : 'failed',
    reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.witnessRecords.push(record);
  return record;
}
function witnessRecordResults(records = [], currentSha256 = new Map(), { contextBinding = null } = {}) {
  const bindings = new Set([contextBinding].flat());
  const latest = new Map();
  for (const record of records) latest.set(`${record.clauseId}\u0000${record.slot}`, record);
  return [...latest.values()].map((record) => {
    const base = { clauseId: record.clauseId, slot: record.slot, method: record.method, recordId: record.id, file: record.file, reviewer: record.actor };
    const what = record.method === 'inspection' ? 'inspection' : 'visual evidence';
    if (record.contextBinding && !bindings.has(record.contextBinding)) {
      return { ...base, status: 'missing', message: `The plan or code candidate changed after ${what} ${record.id}; inspect ${record.file} again for this generation.` };
    }
    if (currentSha256.get(record.file) !== record.sha256) {
      return { ...base, status: 'missing', message: `${record.file} changed after its ${what} ${record.id} for ${record.clauseId}; inspect it again.` };
    }
    if (record.outcome !== 'met') {
      const denied = Object.entries(record.checklist).filter(([, answer]) => answer !== 'yes').map(([item]) => item);
      return { ...base, status: 'failed', message: `${record.actor}'s ${what} ${record.id} found ${record.file} does not satisfy ${record.clauseId} (${denied.join(', ')}).` };
    }
    return { ...base, status: 'met', assurance: 'source-bound' };
  });
}

  return Object.freeze({witnessContextBinding,witnessContextBindings,assertWitnessReviewBinding,recordWitnessWithEvidence,witnessRecordResults});
}

/** Latest expiry over already admitted records. Presence and receipt checks belong to the caller. */
export function witnessRenewalExpiryValue(rows,phaseId,generation,mappingSha256){
  const renewal=[...(rows??[])].reverse().find(entry=>entry?.phase===phaseId&&Number(entry.generation)===Number(generation)&&entry.mappingSha256===mappingSha256);
  return renewal?.expiresAt??null;
}
/** Native-compatible renewal values over explicit prior expiry and review data. No authentication or I/O. */
export function witnessExceptionRenewalPolicies(values){
  const renewedWitnessExpiry=values?.renewedWitnessExpiry;
  if(typeof renewedWitnessExpiry!=='function')throw new SingularityFlowError('Bind the admitted previous-expiry value before constructing witness renewal rules.',{code:'ENGINE_INPUT_INVALID'});
  const MAX_REASON=1000;


/** The exception this step's current approval recorded for `mappingSha256`, or null. */
function witnessException(workflow, phaseId, mappingSha256) {
  const phase = workflow?.phases?.[phaseId];
  for (const approval of [...(phase?.approvals ?? [])].reverse()) {
    if (approval?.invalidatedAt || approval.decision !== 'approved' || Number(approval.generation) !== Number(phase.generation)) continue;
    const mapping = (approval.witnessMappings ?? []).find((entry) => entry?.mappingSha256 === mappingSha256 && entry.decision === 'exception');
    if (mapping) return { phase, approval, mapping };
  }
  return null;
}


/** Record one renewal on the aggregate; the caller checked authority. */
function recordWitnessExceptionRenewal(workflow, { phaseId, mappingSha256, expires, reason, actor, authorityGroup, identityAssurance = null, at }) {
  const found = witnessException(workflow, phaseId, mappingSha256);
  if (!found) {
    throw new SingularityFlowError(`${phaseId}'s current approval recorded no witness exception for ${mappingSha256}.`,
      { code: 'WITNESS_EXCEPTION_UNKNOWN', details: { phase: phaseId, mappingSha256 } });
  }
  const expiry = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(String(expires ?? '')) ? `${expires}T23:59:59.999Z` : String(expires ?? ''));
  if (!Number.isFinite(expiry) || expiry <= Date.parse(at)) {
    throw new SingularityFlowError('A renewed witness exception needs a future expiry: --expires YYYY-MM-DD.', { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  }
  const text = String(reason ?? '').trim();
  if (text.length < 10 || text.length > MAX_REASON) {
    throw new SingularityFlowError(`Say why the exception still stands in 10 to ${MAX_REASON} characters with --reason.`, { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  }
  workflow.witnessExceptionRenewals ??= [];
  const record = {
    id: `WXR-${String(workflow.witnessExceptionRenewals.length + 1).padStart(3, '0')}`,
    phase: phaseId, generation: Number(found.phase.generation), mappingSha256, clauseId: found.mapping.clauseId ?? null,
    previousExpiresAt: renewedWitnessExpiry(workflow, phaseId, found.phase.generation, mappingSha256) ?? found.mapping.expiresAt ?? null,
    expiresAt: new Date(expiry).toISOString(), reason: text, actor, authorityGroup, identityAssurance, at
  };
  workflow.witnessExceptionRenewals.push(record);
  return record;
}
  return Object.freeze({witnessException,recordWitnessExceptionRenewal});
}


/** Exact submitted test adequacy; callers provide byte syntax, hashing and observation time. */
export const ADEQUACY_FACETS=Object.freeze(['setup','action','assertions','boundaries','implementation']);
export function witnessMappingReviewPolicies(utf8,digests){
  if(typeof utf8?.byteLengthUtf8!=='function')throw new SingularityFlowError('Witness mapping values need explicit UTF-8 byte syntax.',{code:'ENGINE_INPUT_INVALID'});
  const byteLengthUtf8=utf8.byteLengthUtf8.bind(utf8),{sha256Utf8}=textDigestCapability(digests),recordSha256=value=>sha256Utf8(canonicalJson(value));
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const DECISIONS = new Set(['satisfied', 'exception', 'not-applicable']);
const MAX_MAPPINGS = 1000;
const MAX_REASON_BYTES = 4096;
const REVIEWED_EXECUTION_PROFILES = new Set([
  'jest-static-v2', 'vitest-static-v2', 'junit5-surefire-v2', 'junit5-gradle-v2', 'node-test-v1', 'playwright-json-v1', 'pytest-junit-v1'
]);
/** The adequacy facets a reviewer judges for each witness [E2G-014]. */


function safePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').includes('..') && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mappingCore(mapping) {
  return {
    clauseId: mapping?.clauseId,
    witnessType: mapping?.witnessType,
    executionProfile: mapping?.executionProfile,
    logicalTestId: mapping?.logicalTestId,
    sourcePath: mapping?.sourcePath,
    sourceDeclarationSha256: mapping?.sourceDeclarationSha256,
    supportSha256: mapping?.supportSha256 ?? null,
    clauseBodySha256: mapping?.clauseBodySha256,
    contractSha256: mapping?.contractSha256 ?? null,
    slot: mapping?.slot ?? null
  };
}

function adequacyOf(decision, inadequate = []) {
  if (decision === 'not-applicable') return null;
  return Object.fromEntries(ADEQUACY_FACETS.map((facet) => [facet, inadequate.includes(facet) ? 'inadequate' : 'adequate']));
}

/**
 * The reviewed decisions for every submitted proposal. `decisions` are the reviewer's explicit
 * ones; `prior` are decisions recorded by earlier approvals of the same step.
 */
function evaluateWitnessMappingReview({ mappings = [], decisions = [], prior = [], now } = {}) {
  if(now===undefined)throw new SingularityFlowError('Witness mapping values require an explicit observation time.',{code:'ENGINE_INPUT_INVALID'});
  if (!Array.isArray(mappings) || mappings.length > MAX_MAPPINGS
      || !Array.isArray(decisions) || decisions.length > MAX_MAPPINGS) {
    throw new SingularityFlowError(`Witness mapping review exceeds ${MAX_MAPPINGS} entries.`, {
      code: 'WEL_WITNESS_MAPPING_UNREVIEWED'
    });
  }
  const expected = new Map();
  const errors = [];
  for (const mapping of mappings) {
    const core = mappingCore(mapping);
    const validCore = /^[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}$/.test(core.clauseId ?? '')
      && core.witnessType === 'test'
      && REVIEWED_EXECUTION_PROFILES.has(core.executionProfile)
      && DIGEST.test(core.logicalTestId ?? '')
      && safePath(core.sourcePath)
      && DIGEST.test(core.sourceDeclarationSha256 ?? '')
      && (core.supportSha256 === null || DIGEST.test(core.supportSha256))
      && DIGEST.test(core.clauseBodySha256 ?? '')
      && (core.contractSha256 === null || DIGEST.test(core.contractSha256))
      && (core.slot === null || /^[a-z][a-z0-9-]{0,31}$/u.test(core.slot));
    if (!validCore || mapping?.mappingSha256 !== `sha256:${recordSha256(core)}` || expected.has(mapping.mappingSha256)) {
      errors.push(`invalid or repeated witness mapping '${mapping?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    expected.set(mapping.mappingSha256, mapping);
  }
  const chosen = new Map();
  for (const entry of decisions) {
    const mapping = expected.get(entry?.mappingSha256);
    if (!mapping) {
      errors.push(`unknown witness mapping '${entry?.mappingSha256 ?? '(missing)'}'`);
      continue;
    }
    if (chosen.has(entry.mappingSha256)) {
      errors.push(`witness mapping '${entry.mappingSha256}' was decided more than once`);
      continue;
    }
    if (!DECISIONS.has(entry.decision)) {
      errors.push(`witness mapping '${entry.mappingSha256}' has an invalid decision`);
      continue;
    }
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (entry.decision !== 'satisfied' && !reason) {
      errors.push(`witness mapping '${entry.mappingSha256}' requires a reason for ${entry.decision}`);
      continue;
    }
    if (byteLengthUtf8(reason) > MAX_REASON_BYTES
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
      errors.push(`witness mapping '${entry.mappingSha256}' reason is not bounded review text`);
      continue;
    }
    const inadequate = [...new Set(entry.inadequate ?? [])];
    if (entry.decision === 'exception'
        && (!inadequate.length || inadequate.some((facet) => !ADEQUACY_FACETS.includes(facet)))) {
      errors.push(`witness mapping '${entry.mappingSha256}' exception must name its inadequate facets from ${ADEQUACY_FACETS.join(', ')}`);
      continue;
    }
    let expiresAt = null;
    if (entry.decision === 'exception') {
      const parsed = Date.parse(entry.expiresAt ?? '');
      if (!Number.isFinite(parsed) || parsed <= now) {
        errors.push(`witness mapping '${entry.mappingSha256}' exception requires a future ISO expiry`);
        continue;
      }
      expiresAt = new Date(parsed).toISOString();
    }
    chosen.set(entry.mappingSha256, {
      decision: entry.decision, reason: reason || null, expiresAt,
      adequacy: adequacyOf(entry.decision, entry.decision === 'exception' ? inadequate : []), source: 'explicit'
    });
  }
  // An earlier decision on an identical proposal carries forward; a lapsed exception does not.
  const carried = new Map();
  for (const entry of prior) {
    if (!expected.has(entry?.mappingSha256) || carried.has(entry.mappingSha256) || !DECISIONS.has(entry.decision)) continue;
    if (entry.decision === 'exception' && !(Date.parse(entry.expiresAt ?? '') > now)) continue;
    carried.set(entry.mappingSha256, {
      decision: entry.decision, reason: entry.reason ?? null, expiresAt: entry.expiresAt ?? null,
      adequacy: entry.adequacy ?? adequacyOf(entry.decision), source: 'carried-forward'
    });
  }
  const reviewed = [...expected.values()].map((mapping) => ({
    mappingSha256: mapping.mappingSha256,
    clauseId: mapping.clauseId,
    clauseBodySha256: mapping.clauseBodySha256,
    logicalTestId: mapping.logicalTestId,
    sourcePath: mapping.sourcePath,
    sourceDeclarationSha256: mapping.sourceDeclarationSha256,
    slot: mapping.slot ?? null,
    ...(chosen.get(mapping.mappingSha256) ?? carried.get(mapping.mappingSha256)
      ?? { decision: 'satisfied', reason: null, expiresAt: null, adequacy: adequacyOf('satisfied'), source: 'batch' })
  }));
  reviewed.sort((left, right) => left.mappingSha256.localeCompare(right.mappingSha256));
  return Object.freeze({ valid: errors.length === 0, errors, decisions: reviewed });
}

return Object.freeze({evaluateWitnessMappingReview});
}
