/** Immutable human votes and primary-document sets; no storage or actor discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_APPROVAL_SCHEMAS,admitRecordSchemaVersion,canonicalJson} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceKey,namespaceRevision} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {sourceRelativePath} from '../foundation/source-snapshot.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
export const NAMESPACE_APPROVAL_PROFILE='sflow-primary-document-approval/v1';
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
  admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.vote,value);
  exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256',
    'baseRevision','configuration','reviewPacket','artifactSet','actor','agentId','recordedAt','authorityGroup','selfApproval','thresholdReached','currentPhase']);
  if(value.format!=='sflow-namespace-phase-approval-vote/v1'||value.profile!==NAMESPACE_APPROVAL_PROFILE||value.projectId!==projectId
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
  projectEnrollmentTimestamp(value.recordedAt);return value;
});}
export function namespaceApprovalArtifactSetValue(value,{projectId,workId,phaseId}={}) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_APPROVAL_SCHEMAS.artifactSet,value);
  exactObject(value,['schemaVersion','format','projectId','workId','phase','generation','reviewPacket','artifact']);
  if(value.format!=='sflow-namespace-primary-approval-artifact-set/v1'||value.projectId!==projectId||value.workId!==workId
    ||value.phase!==phaseId||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another artifact-set binding.');
  evidence(value.reviewPacket);exactObject(value.artifact,['sourceKey','kind','content']);sourceRelativePath(value.artifact.sourceKey);
  if(typeof value.artifact.kind!=='string'||!value.artifact.kind||value.artifact.kind.length>2048||/[\u0000-\u001f]/u.test(value.artifact.kind))throw Error('Invalid artifact kind.');
  if(contentReference(value.artifact.content).namespace!=='evidence')throw Error('An approval cannot claim device-private artifact content.');
  return value;
});}
export function namespaceApprovalDecision(value,binding) {
  return {decision:'approved',generation:value.generation,at:value.recordedAt,actor:value.actor.identity,principalId:value.actor.principalId,
    agent:value.agentId,approvedBy:value.actor.principalId,authorityGroup:value.authorityGroup,reviewPacketSha256:value.reviewPacket.sha256,
    artifactSetSha256:value.artifactSet.sha256,selfApproval:value.selfApproval,namespaceVote:binding};
}
