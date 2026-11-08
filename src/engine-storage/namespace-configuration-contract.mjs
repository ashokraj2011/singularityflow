/** Durable namespace configuration decisions. No policy, discovery, human identity or migration. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_CONFIGURATION_SCHEMAS, admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { exactObject, namespaceIdentifier, namespaceScope, namespaceRevision, namespaceKey } from '../sda/namespace/values.mjs';
import { projectConfigurationReference, projectEnrollmentTimestamp } from '../kernel/project-enrollment.mjs';

export const NAMESPACE_CONFIGURATION_HEAD_KEY = 'configuration/current';
const fields = ['schemaVersion','format','projectId','authorityId','epoch','operationId','parametersSha256','source',
  'configuration','baseRevision','authorityVersion','configurationVersion','principalId','recordedAt','reason'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = message => { throw new SingularityFlowError(message, { code: 'ENGINE_STORAGE_CORRUPT' }); };

export function namespaceConfigurationRecord(kind, value) {
  if (!['head','intent','manifest'].includes(kind) || !value || Object.hasOwn(value,'schemaVersion') || Object.hasOwn(value,'format')) fail('Invalid namespace configuration record metadata.');
  return { schemaVersion: NAMESPACE_CONFIGURATION_SCHEMAS[kind].currentVersion, format: `sflow-namespace-configuration-${kind}/v1`, ...value };
}

export function namespaceConfigurationRecordValue(kind, value, scope, operationId = null) {
  namespaceScope(scope);
  if (!['head','intent','manifest'].includes(kind)) fail('Unknown namespace configuration record family.');
  try { admitRecordSchemaVersion(NAMESPACE_CONFIGURATION_SCHEMAS[kind],value); }
  catch(cause) { throw new SingularityFlowError(cause.message, { cause, details: cause.details,
    code: ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code) ? 'ENGINE_STORAGE_UNSUPPORTED' : 'ENGINE_STORAGE_CORRUPT' }); }
  exactObject(value, kind === 'intent' ? [...fields,'requestDigest'] : fields);
  if (value.format !== `sflow-namespace-configuration-${kind}/v1` || value.projectId !== scope.projectId
    || operationId !== null && value.operationId !== operationId || !digest(value.parametersSha256)
    || kind === 'intent' && !digest(value.requestDigest) || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || typeof value.principalId !== 'string' || !value.principalId || value.principalId.length > 512 || /[\u0000-\u0020\u007f]/u.test(value.principalId)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 4096 || /[\u0000\u007f]/u.test(value.reason)) fail('The retained configuration approval has another binding.');
  namespaceIdentifier(value.authorityId); namespaceIdentifier(value.operationId);
  projectEnrollmentTimestamp(value.recordedAt); projectConfigurationReference(value.source);
  exactObject(value.configuration,['key','content']); namespaceKey(value.configuration.key);
  const ref=projectConfigurationReference(value.configuration.content);
  if (value.configuration.key !== `configuration/versions/${ref.sha256}`) fail('Configuration identity does not match its version key.');
  namespaceRevision(value.baseRevision); namespaceRevision(value.configurationVersion);
  if(namespaceRevision(value.authorityVersion) === null) fail('Configuration approval requires an observed authority revision.');
  return value;
}

export function namespaceConfigurationCompiledValue(value,source) {
  try {admitRecordSchemaVersion(NAMESPACE_CONFIGURATION_SCHEMAS.compiled,value);}
  catch(cause){throw new SingularityFlowError(cause.message,{cause,details:cause.details,
    code:['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code)?'ENGINE_STORAGE_UNSUPPORTED':'ENGINE_STORAGE_CORRUPT'});}
  exactObject(value,['schemaVersion','format','source','definition','workTypeIds','workflows','agents','skills','instructions','templates','files','warnings']);
  if(value.format!=='sflow-namespace-configuration-compiled/v1' || !value.definition || typeof value.definition!=='object'
    || value.source?.namespace!==source.namespace || value.source?.sha256!==source.sha256 || value.source?.bytes!==source.bytes
    || !Array.isArray(value.warnings) || value.warnings.length>2048 || !Array.isArray(value.workTypeIds)
    || !value.workflows || typeof value.workflows!=='object' || Array.isArray(value.workflows)
    || new Set(value.workTypeIds).size!==value.workTypeIds.length || Object.keys(value.workflows).length!==value.workTypeIds.length
    || value.workTypeIds.some(id=>typeof id!=='string'||!Object.hasOwn(value.workflows,id)))fail('The compiled configuration does not match its approved source.');
  return value;
}
