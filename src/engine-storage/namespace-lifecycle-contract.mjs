/** Persistence records, not policy admission or an installed-project authority selector. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { NAMESPACE_LIFECYCLE_SCHEMAS, namespaceLifecycleRecordProfile } from '../foundation/record-schema.mjs';
import { contentReference } from '../sda/content/contract.mjs';
import { exactObject, namespaceIdentifier, namespaceKey, namespaceRevision, namespaceScope } from '../sda/namespace/values.mjs';

export const LIFECYCLE_AUTHORITY_KEY = 'authority/lifecycle';
export const LIFECYCLE_STATE_MAXIMUM_BYTES = 16_777_216;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const bad = message => { throw new SingularityFlowError(message, { code: 'ENGINE_STORAGE_CORRUPT' }); };
export function lifecycleRecord(kind, value) {
  if (!Object.hasOwn(NAMESPACE_LIFECYCLE_SCHEMAS, kind) || !plain(value)
    || Object.hasOwn(value, 'schemaVersion') || Object.hasOwn(value, 'format')) bad('Lifecycle record metadata must use its registered profile.');
  const schemaVersion = NAMESPACE_LIFECYCLE_SCHEMAS[kind].currentVersion;
  return { schemaVersion, format: namespaceLifecycleRecordProfile(kind, { schemaVersion }).format, ...value };
}
function admit(kind, value, scope) {
  namespaceScope(scope);
  let profile;
  try { profile = namespaceLifecycleRecordProfile(kind, value); }
  catch (cause) { throw new SingularityFlowError(cause.message, { cause, details: cause.details,
    code: ['SCHEMA_VERSION_FUTURE','SCHEMA_VERSION_ARCHIVED'].includes(cause.code) ? 'ENGINE_STORAGE_UNSUPPORTED' : 'ENGINE_STORAGE_CORRUPT' }); }
  if (value.format !== profile.format || value.projectId !== scope.projectId) bad('Lifecycle record belongs to another format or project.');
  return profile;
}
export function lifecycleAuthority(value, scope) {
  admit('authority', value, scope);
  exactObject(value, ['schemaVersion','format','projectId','authorityId','epoch','status','recordsId','contentId']);
  namespaceIdentifier(value.authorityId, 'Authority ID');
  namespaceIdentifier(value.recordsId, 'Record adapter ID'); namespaceIdentifier(value.contentId, 'Content adapter ID');
  if (!count(value.epoch) || value.epoch < 1 || !['active','fenced'].includes(value.status)) bad('Invalid lifecycle authority epoch or status.');
  return value;
}
export function lifecycleConfiguration(value, scope) {
  admit('configuration', value, scope);
  exactObject(value, ['schemaVersion','format','projectId','content']);
  if (contentReference(value.content).namespace !== 'config') bad('Pinned configuration needs config content.');
  return value;
}
function configuration(value) {
  exactObject(value, ['key','content']); namespaceKey(value.key);
  if (contentReference(value.content).namespace !== 'config') bad('Invalid pinned configuration reference.');
}
export function lifecycleHead(value, scope, workId) {
  admit('head', value, scope);
  exactObject(value, ['schemaVersion','format','projectId','workId','authorityId','epoch','sequence','configuration','state','previous','operationId']);
  namespaceIdentifier(value.authorityId, 'Authority ID');
  if (!text(workId) || value.workId !== workId || !count(value.sequence) || !count(value.epoch) || value.epoch < 1) bad('Invalid lifecycle Story head.');
  configuration(value.configuration);
  if (contentReference(value.state, LIFECYCLE_STATE_MAXIMUM_BYTES).namespace !== 'state'
    || value.previous !== null && contentReference(value.previous, LIFECYCLE_STATE_MAXIMUM_BYTES).namespace !== 'state') bad('Lifecycle state needs bounded state content.');
  namespaceIdentifier(value.operationId, 'Operation ID');
  return value;
}
export function lifecycleState(value, scope, head) {
  const profile = admit('state', value, scope).state;
  exactObject(value, ['schemaVersion','format','projectId','authorityId','epoch','workId','configuration','workflow']);
  if (value.authorityId !== head.authorityId || value.epoch !== head.epoch || value.workId !== head.workId
    || JSON.stringify(contentReference(value.configuration)) !== JSON.stringify(contentReference(head.configuration.content))
    || !plain(value.workflow) || value.workflow.workItem?.id !== head.workId || !plain(value.workflow.phases)) bad('The lifecycle body does not match its head.');
  const workflow = value.workflow;
  const current = text(workflow.currentPhase) && Object.hasOwn(workflow.phases, workflow.currentPhase);
  // v1 retains its original active-phase meaning. v2 makes an explicit terminal pointer nullable;
  // persistence still assumes the operation's policy owner admitted the transition beforehand.
  const terminal = workflow.currentPhase === null && Object.hasOwn(workflow, 'status')
    && profile.terminalStatuses.includes(workflow.status);
  if (profile.requireOwnedCurrentPhase && !Object.hasOwn(workflow, 'currentPhase') || !current && !terminal) {
    bad('The lifecycle body does not match its head.');
  }
  for (const [id, phase] of Object.entries(value.workflow.phases)) {
    if (!plain(phase) || phase.id !== id || !count(phase.generation) || !text(phase.status)) bad('Invalid lifecycle phase identity.');
  }
  return value;
}
export function lifecyclePrepared(value, scope, workId, operationId) {
  admit('prepared', value, scope);
  exactObject(value, ['schemaVersion','format','projectId','workId','authorityId','epoch','operationId','operation','inputsSha256',
    'basis','state','evidence','requestDigest']);
  namespaceIdentifier(operationId, 'Operation ID');
  if (value.workId !== workId || value.operationId !== operationId || !text(value.operation) || !digest(value.inputsSha256)
    || !digest(value.requestDigest) || !Array.isArray(value.evidence) || value.evidence.length > 128) bad('Invalid prepared lifecycle operation.');
  exactObject(value.basis, ['authorityVersion','headVersion','configurationVersion','head']);
  for (const key of ['authorityVersion','headVersion','configurationVersion']) {
    if (namespaceRevision(value.basis[key]) === null) bad('A prepared operation needs exact observed revisions.');
  }
  const head = lifecycleHead(value.basis.head, scope, workId);
  if (value.authorityId !== head.authorityId || value.epoch !== head.epoch || contentReference(value.state, LIFECYCLE_STATE_MAXIMUM_BYTES).namespace !== 'state'
    || head.sequence === Number.MAX_SAFE_INTEGER) bad('Invalid prepared authority, body or sequence.');
  const seen = new Set();
  for (const ref of value.evidence) {
    const checked = contentReference(ref);
    if (checked.namespace !== 'evidence' || seen.has(checked.sha256)) bad('Evidence must have distinct shared evidence references.');
    seen.add(checked.sha256);
  }
  return value;
}
