/** Namespace review packets name immutable publication proof, without a Git source-commit fiction. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_SUBMISSION_SCHEMAS,namespaceSubmissionRecordProfile,namespaceSubmissionWriterProfile,admitRecordSchemaVersion,phasePublicationBindingValue,namespaceSourceReviewRecordProfile,canonicalJson} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceRevision,namespaceKey,namespaceJson} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
import {phaseCheckEvidenceBinding} from './namespace-phase-check-contract.mjs';
export const NAMESPACE_SUBMISSION_PROFILE='sflow-primary-document-submission/v1';
export const NAMESPACE_SUBMISSION_DECISION_PROFILE='sflow-primary-document-submission/v2';
export const NAMESPACE_CHECKED_SUBMISSION_PROFILE='sflow-primary-document-submission/v3';
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
function checked(validate) {
  try{return validate();}catch(cause){throw new SingularityFlowError('The namespace submission record is invalid.',{cause,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED','ENGINE_STORAGE_UNSUPPORTED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
}
export function namespaceSubmissionBindingValue(value) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_SUBMISSION_SCHEMAS.binding,value);
  exactObject(value,['schemaVersion','format','generation','record']);
  if(value.format!=='sflow-namespace-phase-submission-binding/v1'||!Number.isSafeInteger(value.generation)||value.generation<1
    ||contentReference(value.record,4_194_304).namespace!=='evidence'||value.record.bytes<1)throw Error('Invalid submission binding.');
  return value;
});}
export function namespaceSubmissionValue(value,{projectId,workId,phaseId}={}) {return checked(()=>{
  const profile=namespaceSubmissionRecordProfile(value);
  exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256','baseRevision',
    'configuration','publication','actor','agentId','submittedAt',...(profile.routing?['routing']:[]),...(profile.checks?['checks']:[]),...(profile.sourceReview?['sourceReview']:[])]);
  if(value.format!==profile.format||value.profile!==profile.profile||value.projectId!==projectId
    ||value.workId!==workId||value.phase!==phaseId||!digest(value.requestSha256)||!Number.isSafeInteger(value.generation)||value.generation<1)throw Error('Another submission binding.');
  for(const key of ['projectId','workId','phase','operationId'])namespaceIdentifier(value[key]);
  if(namespaceRevision(value.baseRevision)===null)throw Error('Submission requires a canonical Story revision.');
  exactObject(value.configuration,['key','content']);namespaceKey(value.configuration.key);
  if(contentReference(value.configuration.content).namespace!=='config')throw Error('Another configuration namespace.');
  phasePublicationBindingValue(value.publication);
  if(value.publication.generation!==value.generation)throw Error('The publication generation differs.');
  exactObject(value.actor,['principalId','actorKind','identity']);
  if(canonicalJson(storyActorValue(value.actor))!==canonicalJson(value.actor))throw Error('Another actor representation.');
  if(value.agentId!==null)namespaceIdentifier(value.agentId);
  projectEnrollmentTimestamp(value.submittedAt);
  if(profile.routing&&(!profile.checks||value.routing!==null))namespaceSubmissionRoutingValue(value.routing);
  if(profile.checks&&(!profile.sourceReview||value.checks!==null))phaseCheckEvidenceBinding(value.checks);
  if(profile.sourceReview)namespaceSubmittedSourceReview(value.sourceReview,{phaseId,generation:value.generation});
  return value;
});}

function inputValues(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.values(value).some(item=>typeof item!=='string'&&typeof item!=='number'
    ||typeof item==='number'&&!Number.isFinite(item)))throw Error('Decision values must be recorded strings or finite numbers.');
  namespaceJson(value);
}
export function namespaceSubmissionRoutingValue(value) {return checked(()=>{
  admitRecordSchemaVersion(NAMESPACE_SUBMISSION_SCHEMAS.routing,value);
  exactObject(value,['schemaVersion','format','decision','record','reused']);
  if(value.format!=='sflow-namespace-submission-routing/v1'||!Array.isArray(value.reused))throw Error('Invalid routing evidence.');
  namespaceIdentifier(value.decision);
  if(value.record!==null) {
    admitRecordSchemaVersion(NAMESPACE_SUBMISSION_SCHEMAS.input,value.record);
    exactObject(value.record,['schemaVersion','decision','values','recordedAt','recordedBy']);namespaceIdentifier(value.record.decision);
    if(value.record.decision!==value.decision||typeof value.record.recordedBy!=='string'||!value.record.recordedBy.length
      ||value.record.recordedBy.length>512||/[\u0000-\u0020\u007f]/u.test(value.record.recordedBy))throw Error('Invalid recorded input identity.');
    projectEnrollmentTimestamp(value.record.recordedAt);inputValues(value.record.values);
  }
  const decisions=new Set();
  for(const source of value.reused) {
    exactObject(source,['decision','phase','generation','values','packet']);namespaceIdentifier(source.decision);namespaceIdentifier(source.phase);
    if(decisions.has(source.decision)||!Number.isSafeInteger(source.generation)||source.generation<1
      ||contentReference(source.packet,4_194_304).namespace!=='evidence'||source.packet.bytes<1)throw Error('Invalid or duplicate reused input source.');
    decisions.add(source.decision);inputValues(source.values);
  }
  namespaceJson(value);return value;
});}

/** Explicit writer profiles keep decision-free v1 bytes unchanged. They do not migrate old packets. */
export function namespaceSubmissionRecord(value,{routing=null,checks=null,sourceReview=null}={}) {
  if(!value||typeof value!=='object'||Array.isArray(value)||['schemaVersion','format','profile','routing','checks','sourceReview'].some(key=>Object.hasOwn(value,key))) {
    throw new SingularityFlowError('Submission wire metadata must come from its registered profile.',{code:'ENGINE_INPUT_INVALID'});
  }
  const profile=namespaceSubmissionWriterProfile({routing:routing!==null,checks:checks!==null,sourceReview:sourceReview!==null});
  return {schemaVersion:profile.version,format:profile.format,profile:profile.profile,...value,...(profile.routing?{routing}:{}),
    ...(profile.checks?{checks:checks===null&&profile.sourceReview?null:phaseCheckEvidenceBinding(checks)}:{}),...(profile.sourceReview?{sourceReview}:{})};
}

export function namespaceSubmittedSourceReview(value,{phaseId,generation}={}){return checked(()=>{
  exactObject(value,['schemaVersion','profile','phase','generation','reportSha256','report','contextBinding','records']);
  const profile=namespaceSourceReviewRecordProfile('submitted',value);
  if(value.profile!==profile.profile||value.phase!==phaseId||value.generation!==generation
    ||!digest(value.reportSha256)||contentReference(value.report).namespace!=='evidence'||value.report.sha256!==value.reportSha256||!/^sha256:[a-f0-9]{64}$/u.test(value.contextBinding??'')||!Array.isArray(value.records)||!value.records.length||value.records.length>128
    ||new Set(value.records.map(row=>row.sha256)).size!==value.records.length||value.records.some(row=>contentReference(row).namespace!=='evidence'))throw Error('Another exact source-review inventory.');
  return value;
});}
