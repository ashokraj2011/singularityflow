/** Versioned genesis and retry records. This contract grants no creation authority. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_STORY_SCHEMAS, admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { exactObject, namespaceScope, namespaceIdentifier, namespaceRevision } from '../sda/namespace/values.mjs';
import { contentReference } from '../sda/content/contract.mjs';
import { storyCreationInput, storyActorValue } from '../kernel/story-creation.mjs';
import { projectConfigurationReference, projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';
import { LIFECYCLE_STATE_MAXIMUM_BYTES } from './namespace-lifecycle-contract.mjs';

const fail = message => { throw new SingularityFlowError(message,{code:'ENGINE_STORAGE_CORRUPT'}); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fields = ['projectId','workId','authorityId','epoch','operationId','parametersSha256','configurationId','configuration',
  'configurationVersion','authorityVersion','source','title','workTypeId','actor','recordedAt','state','initialPhase'];

export function namespaceStoryRecord(kind, data) {
  if (!['intent','genesis','manifest'].includes(kind) || !data || Object.hasOwn(data,'schemaVersion') || Object.hasOwn(data,'format')) fail('Invalid Story creation profile.');
  return {schemaVersion:NAMESPACE_STORY_SCHEMAS[kind].currentVersion,format:`sflow-namespace-story-${kind}/v1`,...data};
}

export function namespaceStoryValue(kind, value, scope, workId, operationId = null) {
  namespaceScope(scope);
  if (!['intent','genesis','manifest'].includes(kind)) fail('Unknown Story creation record family.');
  try { admitRecordSchemaVersion(NAMESPACE_STORY_SCHEMAS[kind],value); }
  catch(cause) { throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'}); }
  exactObject(value,['schemaVersion','format',...fields,...(kind==='intent'?['requestDigest']:[])]);
  if (value.format!==`sflow-namespace-story-${kind}/v1` || value.projectId!==scope.projectId || value.workId!==workId
    || operationId!==null&&value.operationId!==operationId || !digest(value.parametersSha256)
    || kind==='intent'&&!digest(value.requestDigest) || !Number.isSafeInteger(value.epoch)||value.epoch<1
    || typeof value.initialPhase!=='string'||!value.initialPhase) fail('The Story genesis has another binding.');
  namespaceIdentifier(value.authorityId);
  storyCreationInput(Object.fromEntries(['operationId','workId','title','workTypeId','configurationId','source'].map(key=>[key,value[key]])));
  exactObject(value.actor,['principalId','actorKind','identity']);
  exactObject(value.actor.identity,['name','email','login']);
  storyActorValue(value.actor);
  projectEnrollmentTimestamp(value.recordedAt);
  exactObject(value.configuration,['key','content']);
  const config=projectConfigurationReference(value.configuration.content);
  if(value.configuration.key!==`configuration/versions/${config.sha256}`)fail('Story creation has another configuration key.');
  if(namespaceRevision(value.configurationVersion)===null||namespaceRevision(value.authorityVersion)===null)fail('Story creation requires observed authority and configuration revisions.');
  if(contentReference(value.state,LIFECYCLE_STATE_MAXIMUM_BYTES).namespace!=='state')fail('Story genesis requires shared lifecycle state.');
  return value;
}
