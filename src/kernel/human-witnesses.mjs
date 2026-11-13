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
