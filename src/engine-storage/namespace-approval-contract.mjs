/** Immutable human votes and primary-document sets; no storage or actor discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_APPROVAL_SCHEMAS,admitRecordSchemaVersion,canonicalJson,namespaceApprovalRecordProfile,namespaceApprovalWriterProfile,
  namespaceApprovalRoutingProfile,namespaceApprovalArtifactSetProfile} from '../foundation/record-schema.mjs';
import {namespacePolicyEvidenceBinding,SPECIFICATION_ANALYSIS_EVIDENCE} from './namespace-policy-contract.mjs';
import {exactObject,namespaceIdentifier,namespaceKey,namespaceRevision,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {namespaceForwardOriginValue} from './namespace-forward-contract.mjs';
export const NAMESPACE_APPROVAL_PROFILE='sflow-primary-document-approval/v1';
export const NAMESPACE_ROUTED_APPROVAL_PROFILE='sflow-primary-document-approval/v2';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
function checked(validate) {
  try{return validate();}catch(cause){throw new SingularityFlowError('The namespace approval record is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
}
function evidence(value) {
  if(contentReference(value,4_194_304).namespace!=='evidence'||value.bytes<1)throw Error('Approval needs exact shared evidence.');
}
export function namespaceApprovalBindingValue(value) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.binding,value);exactObject(value,['schemaVersion','format','generation','record']);
  if(value.format!=='sflow-namespace-phase-approval-binding/v1'||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Invalid vote binding.');
  evidence(value.record);return value;
});}
export function namespaceApprovalValue(value,{projectId,workId,phaseId}={}) {return checked(()=>{
  const profile=namespaceApprovalRecordProfile(value);
  exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256',
    'baseRevision','configuration','reviewPacket','artifactSet','actor','agentId','recordedAt','authorityGroup','selfApproval','thresholdReached','currentPhase',...(profile.routing?['routing']:[]),...(profile.forwardAmendment?['origin']:[]),...(profile.terminalEvidence?['terminalEvidence']:[])]);
  if(value.format!==profile.format||value.profile!==profile.profile||value.projectId!==projectId
    ||value.workId!==workId||value.phase!==phaseId||!digest(value.requestSha256)||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another approval binding.');
  for(const field of ['projectId','workId','phase','operationId','authorityGroup'])namespaceIdentifier(value[field]);
  if(namespaceRevision(value.baseRevision)===null)throw Error('Approval needs its original canonical revision.');
  exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
  if(contentReference(value.configuration.content).namespace!=='config')throw Error('Another configuration namespace.');
  evidence(value.reviewPacket);evidence(value.artifactSet);exactObject(value.actor,['principalId','actorKind','identity']);
  if(!same(storyActorValue(value.actor),value.actor)||value.actor.actorKind!=='human')throw Error('Approval requires a human actor.');
  if(value.agentId!==null)namespaceIdentifier(value.agentId);
  if(typeof value.selfApproval!=='boolean'||typeof value.thresholdReached!=='boolean'
    ||value.currentPhase!==null&&typeof value.currentPhase!=='string'||!value.thresholdReached&&value.currentPhase!==phaseId)throw Error('Invalid approval outcome.');
  if(value.currentPhase!==null)namespaceIdentifier(value.currentPhase);
  if(profile.routing) {
    namespaceApprovalRoutingValue(value.routing);
    if(value.thresholdReached!==(value.routing.outcome!==null)||value.routing.outcome&&value.routing.outcome.after!==phaseId)throw Error('Another routed approval outcome.');
    if(namespaceApprovalRoutingProfile(value.routing).generationBound&&value.routing.generation!==value.generation)throw Error('Another question generation.');
  }
  if(profile.forwardAmendment)namespaceForwardOriginValue(value.origin);
  if(profile.terminalEvidence){evidence(value.terminalEvidence);if(!value.thresholdReached||value.currentPhase!==null)throw Error('Terminal evidence belongs to an actual closing vote.');}
  projectEnrollmentTimestamp(value.recordedAt);return value;
});}

export function namespaceApprovalRoutingValue(value) {return checked(()=>{
  const profile=namespaceApprovalRoutingProfile(value);
  exactObject(value,['schemaVersion','format','decision','outcome','pendingKey',...(profile.generationBound?['generation']:[])]);
  if(value.format!==profile.format||profile.generationBound&&(!Number.isSafeInteger(value.generation)||value.generation<1))throw Error('Another routing format.');
  namespaceIdentifier(value.decision);
  if(value.pendingKey!==null&&(typeof value.pendingKey!=='string'||!/^[a-f0-9]{16}$/u.test(value.pendingKey)))throw Error('Invalid pending question key.');
  const outcome=value.outcome;
  if(outcome!==null) {
    const common=['decision','label','after','kind','by'];
    const keys=outcome.kind==='pause'&&outcome.reason==='ask'?[...common,'reason']
      :outcome.kind==='pause'?[...common,'reason','route','routeLabel','round','maxRounds','values','because','goal']
        :outcome.kind==='loop'?[...common,'route','routeLabel','target','round','maxRounds','values','because','goal']
          :[...common,'route','routeLabel','target','skipped','values','because'];
    exactObject(outcome,keys);namespaceIdentifier(outcome.after);
    if(outcome.decision!==value.decision||typeof outcome.label!=='string'||!outcome.label.length||outcome.label.length>2048
      ||!['next','forward','end','loop','pause'].includes(outcome.kind)
      ||outcome.by!==(outcome.kind==='pause'&&outcome.reason==='ask'?'person':'rule'))throw Error('Invalid pinned routing outcome.');
    if(outcome.kind==='pause') {if(!['ask','limit'].includes(outcome.reason))throw Error('Invalid pause reason.');}
    else {
      if(outcome.kind==='end'?outcome.target!==null:outcome.target===null)throw Error('Invalid routed target.');
      if(outcome.target!==null)namespaceIdentifier(outcome.target);
    }
    if(Object.hasOwn(outcome,'skipped')) {
      if(!Array.isArray(outcome.skipped)||new Set(outcome.skipped).size!==outcome.skipped.length)throw Error('Invalid skipped range.');
      outcome.skipped.forEach(id=>namespaceIdentifier(id));
    }
    if(Object.hasOwn(outcome,'route')) {
      namespaceIdentifier(outcome.route);if(typeof outcome.routeLabel!=='string'||!outcome.routeLabel.length||outcome.routeLabel.length>2048)throw Error('Invalid route label.');
    }
    if(Object.hasOwn(outcome,'round')&&(!Number.isSafeInteger(outcome.round)||outcome.round<1||!Number.isSafeInteger(outcome.maxRounds)||outcome.maxRounds<1))throw Error('Invalid loop round.');
  }
  if((value.pendingKey!==null)!==(outcome?.kind==='pause'))throw Error('The question key does not match the outcome.');
  namespaceJson(value);return value;
});}

/** A routing contract is explicit; ordinary approvals continue writing their original v1 bytes. */
export function namespaceApprovalRecord(value,{routing=null,terminalEvidence=null}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format','profile','routing'].some(key=>Object.hasOwn(value,key))) {
    throw new SingularityFlowError('Approval wire metadata must use its registered profile.',{code:'ENGINE_INPUT_INVALID'});
  }
  const profile=namespaceApprovalWriterProfile({routing:routing!==null,terminalEvidence:terminalEvidence!==null});
  return {schemaVersion:profile.version,format:profile.format,profile:profile.profile,...value,...(profile.routing?{routing}:{}),...(profile.terminalEvidence?{terminalEvidence}:{})};
}

export function namespaceApprovalReceiptValue(value,{projectId,workId}={}) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.receipt,value);
  exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','principalId','operationId','reviewPacketSha256','record']);
  if(value.format!=='sflow-namespace-phase-approval-receipt/v1'||value.projectId!==projectId||value.workId!==workId
    ||!Number.isSafeInteger(value.generation)||value.generation<1||!digest(value.reviewPacketSha256)
    ||typeof value.principalId!=='string'||!value.principalId.length||value.principalId.length>512||/[\u0000-\u0020\u007f]/u.test(value.principalId))throw Error('Invalid approval receipt link.');
  for(const field of ['projectId','workId','phase','operationId'])namespaceIdentifier(value[field]);
  evidence(value.record);return value;
});}
export function namespaceApprovalReceipt(value,binding) {
  namespaceApprovalBindingValue(binding);
  if(!value.routing||binding.generation!==value.generation)throw new SingularityFlowError('Another routed approval receipt generation.',{code:'ENGINE_STORAGE_CORRUPT'});
  return namespaceApprovalReceiptValue({schemaVersion:NAMESPACE_APPROVAL_SCHEMAS.receipt.currentVersion,format:'sflow-namespace-phase-approval-receipt/v1',
    projectId:value.projectId,workId:value.workId,phase:value.phase,generation:value.generation,principalId:value.actor.principalId,
    operationId:value.operationId,reviewPacketSha256:value.reviewPacket.sha256,record:binding.record},{projectId:value.projectId,workId:value.workId});
}
export function namespaceApprovalReceipts(workflow,{projectId,workId}) {return checked(()=>{
  const values=Object.hasOwn(workflow,'namespaceApprovalReceipts')?workflow.namespaceApprovalReceipts:[];
  if(!Array.isArray(values))throw Error('Invalid approval receipt inventory.');
  const seen=new Set();
  for(const value of values) {
    namespaceApprovalReceiptValue(value,{projectId,workId});if(seen.has(value.operationId))throw Error('Duplicate approval receipt.');seen.add(value.operationId);
  }
  return values;
});}
/** Shape admission only. Completeness, exceptions and authority stay with the shared policy. */
export function namespaceApprovalChecklistAnswers(value) {
  try {
    if(!Array.isArray(value)||value.length>256)throw Error('Use at most 256 article decisions.');
    for(const decision of value) {
      exactObject(decision,['article','decision'],['reason']);
      for(const key of ['article','decision'])if(typeof decision[key]!=='string'||!decision[key]||decision[key].length>256)throw Error('Name the exact article and decision.');
      if(decision.reason!==undefined&&(typeof decision.reason!=='string'||decision.reason.length>65536))throw Error('Use a bounded human-authored reason.');
    }
  }catch(cause){throw new SingularityFlowError('Checklist answers need article and decision strings, plus an optional reason.',{code:'ENGINE_INPUT_INVALID',details:{field:'checklist'},cause});}
  return value;
}
export function namespaceApprovalArtifactSetValue(value,{projectId,workId,phaseId}={}) {return checked(()=>{
  const profile=namespaceApprovalArtifactSetProfile(value);
  exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','reviewPacket','artifact',...(profile.policyChecklist?['policyChecklist']:[])]);
  if(value.format!==profile.format||value.projectId!==projectId||value.workId!==workId
    ||value.phase!==phaseId||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another artifact-set binding.');
  evidence(value.reviewPacket);exactObject(value.artifact,['sourceKey','kind','content']);sourceRelativePath(value.artifact.sourceKey);
  if(typeof value.artifact.kind!=='string'||!value.artifact.kind||value.artifact.kind.length>2048||/[\u0000-\u001f]/u.test(value.artifact.kind))throw Error('Invalid artifact kind.');
  if(contentReference(value.artifact.content).namespace!=='evidence')throw Error('An approval cannot claim device-private artifact content.');
  if(profile.policyChecklist) {
    const item=value.policyChecklist;exactObject(item,['evidence','result']);namespacePolicyEvidenceBinding(item.evidence);
    if(item.evidence.kind!==SPECIFICATION_ANALYSIS_EVIDENCE)throw new SingularityFlowError('This checklist needs its matching policy owner.',{code:'ENGINE_STORAGE_UNSUPPORTED'});
    const result=item.result;exactObject(result,['required','mode','errors','warnings','decisions'],['checklist','checklistSha256']);
    if(typeof result.required!=='boolean'||!['off','warn','enforce'].includes(result.mode)||result.required!==(result.mode==='enforce')
      ||!Array.isArray(result.errors)||result.errors.length||!Array.isArray(result.warnings)||result.warnings.some(value=>typeof value!=='string')
      ||!Array.isArray(result.decisions)||result.decisions.length>256)throw Error('Invalid human checklist outcome.');
    if(result.mode!=='off'&&(typeof result.checklist!=='string'||!digest(result.checklistSha256)))throw Error('Missing human checklist identity.');
    namespaceApprovalChecklistAnswers(result.decisions);
    namespaceJson(item);
  }
  return value;
});}
export function namespaceApprovalArtifactSetRecord(value,{policyChecklist=null}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format','policyChecklist'].some(key=>Object.hasOwn(value,key)))throw new SingularityFlowError(
    'Approval artifact-set metadata must use its registered profile.',{code:'ENGINE_INPUT_INVALID'});
  const profile=namespaceApprovalArtifactSetProfile({schemaVersion:policyChecklist===null?1:2});
  return {schemaVersion:profile.version,format:profile.format,...value,...(profile.policyChecklist?{policyChecklist}:{})};
}
export function namespaceApprovalDecision(value,binding) {
  return {decision:'approved',generation:value.generation,at:value.recordedAt,actor:value.actor.identity,principalId:value.actor.principalId,
    agent:value.agentId,approvedBy:value.actor.principalId,authorityGroup:value.authorityGroup,reviewPacketSha256:value.reviewPacket.sha256,
    artifactSetSha256:value.artifactSet.sha256,selfApproval:value.selfApproval,namespaceVote:binding};
}
