/** New-project admission and results. Identity, clocks and persistence are explicit host facts. */
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
