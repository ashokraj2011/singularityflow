/** Namespace review packets name immutable publication proof, without a Git source-commit fiction. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_SUBMISSION_SCHEMAS,admitRecordSchemaVersion,phasePublicationBindingValue,canonicalJson} from '../foundation/record-schema.mjs';
import {exactObject,namespaceIdentifier,namespaceRevision,namespaceKey} from '../sda/namespace/values.mjs';
import {contentReference} from '../sda/content/contract.mjs';
import {storyActorValue} from '../kernel/story-creation.mjs';
import {projectEnrollmentTimestamp} from '../kernel/project-enrollment.mjs';
export const NAMESPACE_SUBMISSION_PROFILE='sflow-primary-document-submission/v1';
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
  admitRecordSchemaVersion(NAMESPACE_SUBMISSION_SCHEMAS.packet,value);
  exactObject(value,['schemaVersion','format','profile','projectId','workId','phase','generation','operationId','requestSha256','baseRevision',
    'configuration','publication','actor','agentId','submittedAt']);
  if(value.format!=='sflow-namespace-phase-review-packet/v1'||value.profile!==NAMESPACE_SUBMISSION_PROFILE||value.projectId!==projectId
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
  projectEnrollmentTimestamp(value.submittedAt);return value;
});}
