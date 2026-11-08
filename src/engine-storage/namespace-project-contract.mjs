/** Enrollment wire records. They establish a new authority, not workflow approval or migration. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_ENROLLMENT_SCHEMAS, admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { exactObject, namespaceIdentifier, namespaceScope } from '../sda/namespace/values.mjs';
import { lifecycleAuthority } from './namespace-lifecycle-contract.mjs';

const formats = Object.freeze({ intent: 'sflow-namespace-enrollment-intent/v1', manifest: 'sflow-namespace-enrollment-manifest/v1' });
const common = Object.freeze(['schemaVersion','format','projectId','operationId','parametersSha256','authority','principalId','recordedAt']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = message => { throw new SingularityFlowError(message, { code: 'ENGINE_STORAGE_CORRUPT' }); };

export function namespaceEnrollmentRecord(kind, value) {
  if (!Object.hasOwn(formats, kind) || !value || typeof value !== 'object'
    || Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'format')) fail('Invalid enrollment record metadata.');
  return { schemaVersion: NAMESPACE_ENROLLMENT_SCHEMAS[kind].currentVersion, format: formats[kind], ...value };
}

export function namespaceEnrollmentRecordValue(kind, value, scope, operationId) {
  namespaceScope(scope);
  if (!Object.hasOwn(formats, kind)) fail('Unknown enrollment record family.');
  try { admitRecordSchemaVersion(NAMESPACE_ENROLLMENT_SCHEMAS[kind], value); }
  catch (cause) { throw new SingularityFlowError(cause.message, { cause, details: cause.details,
    code: ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code) ? 'ENGINE_STORAGE_UNSUPPORTED' : 'ENGINE_STORAGE_CORRUPT' }); }
  exactObject(value, kind === 'intent' ? [...common, 'requestDigest'] : common);
  if (value.format !== formats[kind] || value.projectId !== scope.projectId || value.operationId !== operationId
    || !digest(value.parametersSha256) || kind === 'intent' && !digest(value.requestDigest)
    || typeof value.principalId !== 'string' || !value.principalId || value.principalId.length > 512
    || /[\u0000-\u0020\u007f]/u.test(value.principalId)
    || typeof value.recordedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.recordedAt)
    || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) {
    fail('The enrollment record does not match its project or intent.');
  }
  namespaceIdentifier(value.operationId, 'Operation ID');
  lifecycleAuthority(value.authority, scope);
  if (value.authority.status !== 'active' || value.authority.epoch !== 1) fail('Enrollment cannot reactivate or replace an authority.');
  return value;
}
