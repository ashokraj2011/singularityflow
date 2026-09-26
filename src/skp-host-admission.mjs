/**
 * SKP host admission is deliberately separate from prompt composition and final-diff validation.
 * Only a trusted host adapter may supply `observed`; this module checks that the adapter's
 * dimension-by-dimension, operation-bound evidence satisfies the normalized phase policy. It does
 * not itself establish that a named sandbox or broker exists on the machine.
 *
 * Launch admission happens before exposing skill bytes to a host. Delivery acknowledgement is a
 * separate check after handoff and before its output may be treated as governed phase evidence.
 */
import { SingularityFlowError } from './util.mjs';

export const SKP_HOST_DIMENSIONS = Object.freeze([
  'reads', 'writes', 'tools', 'network', 'credentials', 'controlPlane', 'cancellation'
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);
const MECHANISMS = Object.freeze({
  reads: new Set(['os-sandbox', 'pre-effect-broker']),
  writes: new Set(['os-sandbox', 'pre-effect-broker']),
  tools: new Set(['os-sandbox', 'pre-effect-broker']),
  network: new Set(['os-sandbox', 'pre-effect-broker']),
  credentials: new Set(['os-sandbox', 'pre-effect-broker']),
  controlPlane: new Set(['os-sandbox', 'pre-effect-broker']),
  cancellation: new Set(['process-supervisor'])
});
const admittedLaunches = new WeakSet();

function nonempty(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function validIdentity(value) {
  return nonempty(value) && !/[\r\n\0]/u.test(value) && value.length <= 256;
}

function validBinding(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && validIdentity(value.operationId) && validIdentity(value.profileId)
    && validIdentity(value.adapterId) && validIdentity(value.adapterVersion);
}

function unavailable(message, details) {
  throw new SingularityFlowError(message, {
    code: 'SKP_HOST_ENFORCEMENT_UNAVAILABLE', details
  });
}

function unconfirmed(message, details) {
  throw new SingularityFlowError(message, {
    code: 'SKP_HOST_DELIVERY_UNCONFIRMED', details
  });
}

/**
 * Pure, non-authorizing preview. Every dimension is required as an explicit policy binding; an
 * omitted dimension is not interpreted as permission to leave it unconfined. `observed` must come
 * from a qualified host adapter, never from a skill, prompt, model response, or final file diff.
 * A string such as "prompt says no network" cannot satisfy a native enforcement requirement.
 */
export function assessSkillHostLaunchAdmission({ required, observed } = {}) {
  const binding = required?.binding;
  const adapter = observed?.binding;
  const bindingMatches = validBinding(binding) && validBinding(adapter)
    && SKP_HOST_DIMENSIONS.every((dimension) => isSha256(required?.dimensions?.[dimension]?.policySha256))
    && Object.keys(required?.dimensions ?? {}).length === SKP_HOST_DIMENSIONS.length
    && ['operationId', 'profileId', 'adapterId', 'adapterVersion']
      .every((field) => binding[field] === adapter[field]);
  const dimensions = Object.fromEntries(SKP_HOST_DIMENSIONS.map((dimension) => {
    const policySha256 = required?.dimensions?.[dimension]?.policySha256 ?? null;
    const evidence = observed?.dimensions?.[dimension];
    const verified = bindingMatches && evidence?.status === 'enforced-before-effect'
      && evidence.policySha256 === policySha256
      && MECHANISMS[dimension].has(evidence.mechanism)
      && validIdentity(evidence.evidenceId);
    return [dimension, Object.freeze({
      required: policySha256,
      verified: verified ? Object.freeze({
        mechanism: evidence.mechanism, evidenceId: evidence.evidenceId
      }) : null
    })];
  }));
  const unavailableDimensions = SKP_HOST_DIMENSIONS.filter((dimension) => !dimensions[dimension].verified);
  return Object.freeze({
    schemaVersion: 1,
    status: unavailableDimensions.length ? 'unavailable' : 'ready',
    binding: validBinding(binding) ? Object.freeze({ ...binding }) : null,
    bindingMatches: Boolean(bindingMatches),
    dimensions: Object.freeze(dimensions),
    unavailableDimensions: Object.freeze(unavailableDimensions)
  });
}

/** Refuse before starting a skill-producing host when any required control is unproven. */
export function assertSkillHostLaunchAdmission(input) {
  const result = assessSkillHostLaunchAdmission(input);
  if (result.status !== 'ready') {
    unavailable('The selected host has not proven every required skill-phase enforcement dimension before launch.', {
      bindingMatches: result.bindingMatches,
      unavailableDimensions: [...result.unavailableDimensions]
    });
  }
  admittedLaunches.add(result);
  return result;
}

/**
 * An exact host acknowledgement is required before attributing a candidate to the selected skill.
 * Prompt construction, process exit, model text, and a clean final diff are not acknowledgements.
 */
export function assertSkillHostDelivery(admission, expected, acknowledgement) {
  if (!admittedLaunches.has(admission)) {
    unavailable('Skill host delivery requires a successful, operation-bound launch admission.', {
      unavailableDimensions: [...SKP_HOST_DIMENSIONS]
    });
  }
  const binding = admission.binding;
  const digests = ['packageSha256', 'projectedEntrySha256', 'resourceManifestSha256'];
  const expectedValid = expected && digests.every((key) => isSha256(expected[key]));
  const matches = expectedValid && acknowledgement?.status === 'acknowledged'
    && acknowledgement?.channel === 'trusted-host-adapter'
    && validIdentity(acknowledgement.receiptId)
    && ['operationId', 'profileId', 'adapterId', 'adapterVersion']
      .every((key) => acknowledgement[key] === binding[key])
    && digests.every((key) => acknowledgement[key] === expected[key]);
  if (!matches) {
    unconfirmed('The host has not acknowledged the exact selected skill package, projection, and resources.', {
      operationId: binding.operationId,
      missingOrMismatched: !expectedValid ? ['expected-digests'] : digests.filter((key) => (
        acknowledgement?.[key] !== expected[key]
      ))
    });
  }
  return Object.freeze({
    schemaVersion: 1, status: 'confirmed',
    operationId: binding.operationId,
    profileId: binding.profileId,
    adapterId: binding.adapterId,
    adapterVersion: binding.adapterVersion,
    receiptId: acknowledgement.receiptId,
    packageSha256: expected.packageSha256,
    projectedEntrySha256: expected.projectedEntrySha256,
    resourceManifestSha256: expected.resourceManifestSha256
  });
}
