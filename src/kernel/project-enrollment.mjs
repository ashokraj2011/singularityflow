/** Explicit project setup admission and results. Identity, clocks and persistence are host facts. */
import { SingularityFlowError } from '../foundation/failures.mjs';

const logicalId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
const principal = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const invalid = (message, code = 'ENGINE_PORT_RESULT_INVALID') => { throw new SingularityFlowError(message, { code }); };

export function projectEnrollmentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'operationId') || !logicalId(input.operationId)) {
    invalid('Project enrollment requires one explicit logical operation ID.', 'ENGINE_INPUT_INVALID');
  }
  return input;
}

export function projectEnrollmentBinding(binding) {
  if (!binding || !logicalId(binding.projectId) || !binding.authority
    || !logicalId(binding.authority.id) || binding.authority.epoch !== 1) {
    invalid('Enrollment requires an explicitly bound new-project authority at epoch one.');
  }
  return { projectId: binding.projectId, authority: { id: binding.authority.id, epoch: 1 } };
}

export function projectEnrollmentAccess(access, projectId, expectedPrincipal = null) {
  if (!access || access.projectId !== projectId || !principal(access.principalId)
    || !Array.isArray(access.permissions) || access.permissions.length > 128
    || access.permissions.some(value => typeof value !== 'string' || value.length > 128)) {
    invalid('The access port did not return a bounded identity for this project.');
  }
  if (!access.permissions.includes('project.enroll')) {
    invalid('The current principal cannot enroll this project.', 'ENGINE_AUTHORITY_REQUIRED');
  }
  if (expectedPrincipal !== null && access.principalId !== expectedPrincipal) {
    invalid('Enrollment must resume under its original principal.', 'ENGINE_ACTOR_CHANGED');
  }
  return access.principalId;
}

export function projectEnrollmentTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid('The enrollment clock must supply a canonical UTC timestamp.');
  }
  return value;
}

export function projectEnrollmentResult(binding, inputs, facts) {
  if (!facts || facts.projectId !== binding.projectId || facts.operationId !== inputs.operationId
    || facts.authorityId !== binding.authority.id || facts.epoch !== binding.authority.epoch
    || !principal(facts.principalId) || !digest(facts.requestDigest)
    || typeof facts.revision !== 'string' || !facts.revision || facts.revision.length > 512
    || /[\u0000-\u0020\u007f]/u.test(facts.revision) || typeof facts.replayed !== 'boolean') {
    invalid('The enrollment port returned another project, intent or authority.');
  }
  projectEnrollmentTimestamp(facts.recordedAt);
  return { status: 'enrolled',
    subject: { kind: 'project', id: binding.projectId }, operationId: inputs.operationId,
    authority: binding.authority, principalId: facts.principalId, recordedAt: facts.recordedAt,
    requestDigest: facts.requestDigest, revision: facts.revision, replayed: facts.replayed,
    effects: { committed: true, pushed: false, storyCreated: false, configurationApproved: false,
      humanReviewRecorded: false, approvalRecorded: false } };
}

export const CONFIGURATION_PACKAGE_MAXIMUM_BYTES = 4_194_304;
export const CONFIGURATION_RESOURCE_MAXIMUM_BYTES = 8_388_608;

/** Narrow configuration content binding, never a laptop path or a caller's approval identity. */
export function projectConfigurationReference(value, maximumBytes = CONFIGURATION_PACKAGE_MAXIMUM_BYTES, minimumBytes = 1) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3 || !['namespace','sha256','bytes'].every(key => Object.hasOwn(value, key))
    || value.namespace !== 'config' || !digest(value.sha256)
    || !Number.isSafeInteger(value.bytes) || value.bytes < minimumBytes || value.bytes > maximumBytes) {
    invalid('Configuration requires bounded immutable config content.', 'ENGINE_INPUT_INVALID');
  }
  return { namespace: 'config', sha256: value.sha256, bytes: value.bytes };
}

export function projectConfigurationInput(input) {
  const fields = ['operationId','source','expectedRevision','confirm','reason'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length
    || !fields.every(key => Object.hasOwn(input, key)) || !logicalId(input.operationId)
    || input.expectedRevision !== null && (!principal(input.expectedRevision))
    || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4096
    || /[\u0000\u007f]/u.test(input.reason)) invalid('Configuration approval needs an exact source, base revision, operation ID and reason.', 'ENGINE_INPUT_INVALID');
  const source = projectConfigurationReference(input.source);
  if (input.confirm !== source.sha256) invalid('Review and confirm the exact source package SHA-256 before configuration approval.', 'ENGINE_CONFIRMATION_REQUIRED');
  return { operationId: input.operationId, source, expectedRevision: input.expectedRevision, confirm: input.confirm, reason: input.reason };
}

export function projectConfigurationBinding(binding) {
  if (!binding || !logicalId(binding.projectId) || !binding.authority || !logicalId(binding.authority.id)
    || !Number.isSafeInteger(binding.authority.epoch) || binding.authority.epoch < 1) invalid('Configuration approval requires an explicitly bound project authority.');
  return { projectId: binding.projectId, authority: { id: binding.authority.id, epoch: binding.authority.epoch } };
}

export function projectConfigurationAccess(access, projectId, expectedPrincipal = null) {
  if (!access || access.projectId !== projectId || !principal(access.principalId)
    || !Array.isArray(access.permissions) || access.permissions.length > 128
    || access.permissions.some(value => typeof value !== 'string' || value.length > 128)
    || !['human','service'].includes(access.actorKind)) invalid('The access port did not return configuration reviewer identity facts.');
  if (access.actorKind !== 'human' || !access.permissions.includes('configuration.approve')) {
    invalid('Configuration approval requires an authorized human reviewer.', 'ENGINE_AUTHORITY_REQUIRED');
  }
  if (expectedPrincipal !== null && access.principalId !== expectedPrincipal) invalid('Configuration approval must resume under its original reviewer.', 'ENGINE_ACTOR_CHANGED');
  return access.principalId;
}

export function projectConfigurationResult(binding, inputs, facts) {
  if (!facts || facts.projectId !== binding.projectId || facts.operationId !== inputs.operationId
    || facts.authorityId !== binding.authority.id || facts.epoch !== binding.authority.epoch
    || !principal(facts.principalId) || !digest(facts.requestDigest) || !principal(facts.revision) || !principal(facts.transactionRevision)
    || typeof facts.replayed !== 'boolean' || !Number.isSafeInteger(facts.advisories) || facts.advisories<0 || facts.advisories>2048
    || facts.source?.sha256 !== inputs.source.sha256
    || facts.source?.bytes !== inputs.source.bytes || facts.reason !== inputs.reason) invalid('The configuration port returned another approval binding.');
  projectEnrollmentTimestamp(facts.recordedAt);
  const source = projectConfigurationReference(facts.source), configuration = projectConfigurationReference(facts.configuration);
  return { status: 'approved', subject: { kind: 'configuration', projectId: binding.projectId }, operationId: inputs.operationId,
    authority: binding.authority, principalId: facts.principalId, source, configuration, reason: facts.reason,
    recordedAt: facts.recordedAt, requestDigest: facts.requestDigest, revision: facts.revision,
    transactionRevision: facts.transactionRevision, replayed: facts.replayed,
    advisories: { count: facts.advisories, configuration },
    effects: { committed: true, pushed: false, storyCreated: false, configurationApproved: true,
      humanReviewRecorded: true, approvalRecorded: true } };
}
