/** Exact clarification response values; no prompts, files, clock, identity discovery or persistence. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {markerQuestionHash} from './specification-markers.mjs';
import {resolvedClarificationPolicy,clarificationCheckpointState} from './phase-inputs.mjs';
export {resolvedClarificationPolicy,clarificationCheckpointState};

/** Explicit data selections; model wording and native file/flag compatibility remain adapters. */
export function clarificationOperationInput(input,operation) {
  const invalid=()=>{throw new SingularityFlowError('Select an exact Story, phase and clarification context.',{code:'ENGINE_INPUT_INVALID'});};
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!operation.inputFields.includes(key))
    ||operation.requiredFields.some(key=>!Object.hasOwn(input,key))
    ||['workId','phaseId','operationId'].some(key=>input[key]!==undefined&&!id(input[key]))
    ||input.agentId!==undefined&&input.agentId!==null&&!id(input.agentId))invalid();
  if(operation.id==='clarification.record') {
    if(!/^[a-f0-9]{64}$/u.test(input.contextSha256??'')||!Array.isArray(input.responses)||!input.responses.length||input.responses.length>10
      ||input.responses.some(response=>response?.id!==undefined&&!id(response.id))
      ||input.replace!==undefined&&typeof input.replace!=='boolean'||input.reason!==undefined&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4096)
      ||input.replace===true&&!input.reason?.trim())invalid();
    return {...input,replace:input.replace??false,reason:input.reason??null};
  }
  return {...input};
}

/** Publication checks use actual answers, never a caller's claimed readiness boolean. */
export function clarificationPublicationState(policy,record,producer='governed-agent') {
  const errors=[];
  if(policy.mode!=='off') {
    if(!record&&policy.mode==='required'&&producer==='governed-agent')errors.push('required-response-missing');
    if(record) {
      const normalized=clarificationResponseSet({phaseId:record.phase,policy,responses:record.responses});
      if(canonicalJson(normalized.responses)!==canonicalJson(record.responses))errors.push('response-values-changed');
      if(!normalized.completed||record.completed!==normalized.completed)errors.push('response-incomplete');
    }
  }
  return {mode:policy.mode,errors,ready:errors.length===0,
    checkpoint:clarificationCheckpointState(policy.mode,record?'recorded':'missing',errors.length)};
}
export function normalizeMarkerBinding(value, index) {
  if (value === undefined || value === null || value === '') return null;
  const question = typeof value === 'string' ? value : String(value.question ?? '');
  const questionHash = markerQuestionHash(
    typeof value === 'string' ? value : value.questionHash ?? value.question ?? ''
  );
  if (!questionHash) {
    throw new SingularityFlowError(`Clarification response ${index + 1} names a marker with no question text.`);
  }
  return { question: markerQuestionHash(question), questionHash };
}

export function normalizeResponse(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Clarification response ${index + 1} must be an object.`);
  }
  const question = String(value.question ?? '').trim();
  const answer = String(value.answer ?? '').trim();
  const why = String(value.why ?? '').trim();
  const status = value.status ?? 'answered';
  const blocking = value.blocking === true;
  if (!question) throw new SingularityFlowError(`Clarification response ${index + 1} requires a question.`);
  if (!answer) throw new SingularityFlowError(`Clarification response ${index + 1} requires the human answer or deferral rationale.`);
  if (!['answered', 'deferred'].includes(status)) throw new SingularityFlowError(`Clarification response ${index + 1} status must be answered or deferred.`);
  if (status === 'answered' && blocking) throw new SingularityFlowError(`Clarification response ${index + 1} cannot be both answered and blocking.`);
  const marker = normalizeMarkerBinding(value.marker, index);
  // A deferred answer is an explicit "not decided yet", so it cannot also be the thing that lets the
  // marker leave the artifact. Recording it as a resolution would let a marker be closed by saying
  // nothing about it at length.
  if (marker && status !== 'answered') {
    throw new SingularityFlowError(`Clarification response ${index + 1} resolves a clarification marker, so it must be answered rather than ${status}.`);
  }
  return {
    id: value.id ?? `Q-${String(index + 1).padStart(3, '0')}`,
    question,
    ...(why ? { why } : {}),
    answer,
    status,
    blocking,
    ...(marker ? { marker } : {}),
    ...(value.owner ? { owner: String(value.owner).trim() } : {}),
    ...(value.impact ? { impact: String(value.impact).trim() } : {})
  };
}

export function mergeResponses(previous, responses) {
  const combined = (previous ?? []).map(normalizeResponse);
  for (const value of responses) {
    const response = normalizeResponse(value, combined.length);
    const existing = combined.find(existing => existing.question === response.question
      || value?.id != null && existing.id === value.id);
    if (value?.id == null && existing) response.id = existing.id;
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(response)) throw new SingularityFlowError(
        'An existing clarification reply differs. Preserve the accepted answers; review the change before using --replace.',
        { code: 'CLARIFICATION_RESPONSE_CONFLICT', details: { questionId: existing.id } }
      );
    } else combined.push(response);
  }
  return combined;
}

export function responseArrayFromPayload(payload) {
  return Array.isArray(payload) ? payload : payload?.responses ?? payload?.questions;
}

export function answeredMarkerHashes(record) {
  return [...new Set((record?.responses ?? [])
    .map((response) => response.marker?.questionHash)
    .filter(Boolean))];
}

export function clarificationRoutes(result) {
  if (result.mode === 'off') return { 'governed-agent': 'not-applicable', other: 'not-applicable' };
  return { 'governed-agent': result.errors.length ? 'blocked' : 'ready', other: result.record && !result.errors.length ? 'bound-if-published' : 'not-required' };
}

/** Candidate reply values; context, human identity and acceptance need their concrete owners. */
export function clarificationResponseSet({phaseId,policy,previous=null,responses,replace=false}) {
  if (!Array.isArray(responses) || !responses.length) throw new SingularityFlowError('Record at least one clarification response.');
  const prior=replace?null:previous,combined=mergeResponses(prior??[],responses);
  if (combined.length > policy.maxQuestions) throw new SingularityFlowError(`Phase '${phaseId}' permits no more than ${policy.maxQuestions} clarification questions.`);
  const ids=new Set();for(const response of combined){
    if(ids.has(response.id))throw new SingularityFlowError(`Clarification response ID '${response.id}' is duplicated.`);ids.add(response.id);
  }
  return {responses:combined,completed:combined.length>0&&!combined.some(response=>response.blocking),
    reused:prior!==null&&JSON.stringify(combined)===JSON.stringify(prior)};
}
