/**
 * SKP host admission is deliberately separate from prompt composition and final-diff validation.
 * This module checks the shape and operation binding of dimension-by-dimension evidence. It does
 * not establish that the evidence came from a trusted adapter or that a sandbox or broker exists.
 *
 * No installed, qualified adapter is connected yet. Authorizing entry points therefore remain
 * closed even when caller-supplied evidence has a consistent shape.
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
 * omitted dimension is not interpreted as permission to leave it unconfined. `observed` is
 * caller-supplied and this check cannot establish its origin. A string such as "prompt says no
 * network" cannot satisfy even the evidence-shape requirement.
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
    const matches = bindingMatches && evidence?.status === 'enforced-before-effect'
      && evidence.policySha256 === policySha256
      && MECHANISMS[dimension].has(evidence.mechanism)
      && validIdentity(evidence.evidenceId);
    return [dimension, Object.freeze({
      required: policySha256,
      matchingEvidence: matches ? Object.freeze({
        mechanism: evidence.mechanism, evidenceId: evidence.evidenceId
      }) : null
    })];
  }));
  const unavailableDimensions = SKP_HOST_DIMENSIONS.filter((dimension) => !dimensions[dimension].matchingEvidence);
  return Object.freeze({
    schemaVersion: 1,
    status: unavailableDimensions.length ? 'unavailable' : 'matching-shape',
    launchAuthorized: false,
    binding: validBinding(binding) ? Object.freeze({ ...binding }) : null,
    bindingMatches: Boolean(bindingMatches),
    dimensions: Object.freeze(dimensions),
    unavailableDimensions: Object.freeze(unavailableDimensions)
  });
}

/** Refuse launch until a qualified host adapter owns the live enforcement and evidence channel. */
export function assertSkillHostLaunchAdmission(input) {
  const result = assessSkillHostLaunchAdmission(input);
  unavailable('No qualified skill host adapter is connected to prove enforcement before launch.', {
    bindingMatches: result.bindingMatches,
    unavailableDimensions: [...result.unavailableDimensions],
    trustedAdapterAvailable: false
  });
}

/**
 * Pure shape check for an exact host acknowledgement. A matching string-labelled receipt remains
 * caller data; prompt construction, process exit, model text and a clean diff prove no delivery.
 */
export function assessSkillHostDelivery(admission, expected, acknowledgement) {
  const binding = admission?.binding;
  const digests = ['packageSha256', 'projectedEntrySha256', 'resourceManifestSha256'];
  const expectedValid = expected && digests.every((key) => isSha256(expected[key]));
  const matches = admission?.status === 'matching-shape' && admission?.launchAuthorized === false
    && validBinding(binding) && expectedValid && acknowledgement?.status === 'acknowledged'
    && acknowledgement?.channel === 'trusted-host-adapter'
    && validIdentity(acknowledgement.receiptId)
    && ['operationId', 'profileId', 'adapterId', 'adapterVersion']
      .every((key) => acknowledgement[key] === binding[key])
    && digests.every((key) => acknowledgement[key] === expected[key]);
  return Object.freeze({
    schemaVersion: 1,
    status: matches ? 'matching-shape' : 'unavailable',
    deliveryConfirmed: false,
    binding: validBinding(binding) ? Object.freeze({ ...binding }) : null,
    missingOrMismatched: !expectedValid ? Object.freeze(['expected-digests'])
      : Object.freeze(digests.filter((key) => acknowledgement?.[key] !== expected[key]))
  });
}

/** Refuse delivery attribution until a live adapter establishes an authenticated receipt. */
export function assertSkillHostDelivery(admission, expected, acknowledgement) {
  if (admission?.status !== 'matching-shape' || admission?.launchAuthorized !== false) {
    unavailable('Skill delivery has no matching launch evidence, and no qualified host adapter is connected.', {
      unavailableDimensions: [...SKP_HOST_DIMENSIONS], trustedAdapterAvailable: false
    });
  }
  const result = assessSkillHostDelivery(admission, expected, acknowledgement);
  unconfirmed('No qualified skill host adapter can confirm exact package delivery.', {
    operationId: result.binding?.operationId ?? null,
    missingOrMismatched: [...result.missingOrMismatched],
    trustedAdapterAvailable: false
  });
}
