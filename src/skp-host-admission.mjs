/**
 * SKP host admission is deliberately separate from prompt composition and final-diff validation.
 * This module checks the shape and operation binding of dimension-by-dimension evidence. It does
 * not establish that the evidence came from a trusted adapter or that a sandbox or broker exists.
 *
 * No installed, qualified adapter is connected yet. Authorizing entry points therefore remain
 * closed even when caller-supplied evidence has a consistent shape.
 */
import { SingularityFlowError } from './util.mjs';
import { types } from 'node:util';

export const SKP_HOST_DIMENSIONS = Object.freeze([
  'reads', 'writes', 'tools', 'network', 'credentials', 'controlPlane', 'cancellation'
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);
const BINDING_KEYS = Object.freeze(['operationId', 'profileId', 'adapterId', 'adapterVersion']);
const DELIVERY_KEYS = Object.freeze([
  'packageSha256', 'projectedEntrySha256', 'resourceManifestSha256'
]);
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

/**
 * Caller-supplied reports are never trusted adapter evidence. Read only closed, ordinary data
 * records so accessors, proxies and unreviewed extension fields cannot influence a preview.
 * A future live adapter must use a new registered dialect instead of widening this one.
 */
function closedRecord(value, keys, exact = true) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return null;
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (exact && (ownKeys.length !== keys.length
        || ownKeys.some((key) => !keys.includes(key)))) return null;
    const selected = ownKeys.filter((key) => keys.includes(key));
    if (selected.some((key) => !Object.hasOwn(descriptors[key], 'value'))) return null;
    return Object.fromEntries(selected.map((key) => [key, descriptors[key].value]));
  } catch {
    return null;
  }
}

function validBinding(value) {
  const binding = closedRecord(value, BINDING_KEYS);
  return binding && BINDING_KEYS.every((key) => validIdentity(binding[key]));
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
export function assessSkillHostLaunchAdmission(input) {
  const inputRecord = closedRecord(input, ['required', 'observed'], false);
  const required = inputRecord?.required;
  const observed = inputRecord?.observed;
  const requiredRecord = closedRecord(required, ['binding', 'dimensions']);
  const observedRecord = closedRecord(observed, ['binding', 'dimensions']);
  const binding = closedRecord(requiredRecord?.binding, BINDING_KEYS);
  const adapter = closedRecord(observedRecord?.binding, BINDING_KEYS);
  const policies = closedRecord(requiredRecord?.dimensions, SKP_HOST_DIMENSIONS);
  const evidence = closedRecord(observedRecord?.dimensions, SKP_HOST_DIMENSIONS);
  const bindingMatches = validBinding(binding) && validBinding(adapter)
    && policies !== null && evidence !== null
    && SKP_HOST_DIMENSIONS.every((dimension) => {
      const policy = closedRecord(policies[dimension], ['policySha256']);
      return policy && isSha256(policy.policySha256);
    })
    && BINDING_KEYS
      .every((field) => binding[field] === adapter[field]);
  const dimensions = Object.fromEntries(SKP_HOST_DIMENSIONS.map((dimension) => {
    const policy = closedRecord(policies?.[dimension], ['policySha256']);
    const policySha256 = isSha256(policy?.policySha256) ? policy.policySha256 : null;
    const dimensionEvidence = closedRecord(evidence?.[dimension], [
      'status', 'policySha256', 'mechanism', 'evidenceId'
    ]);
    const matches = bindingMatches && dimensionEvidence?.status === 'enforced-before-effect'
      && dimensionEvidence.policySha256 === policySha256
      && MECHANISMS[dimension].has(dimensionEvidence.mechanism)
      && validIdentity(dimensionEvidence.evidenceId);
    return [dimension, Object.freeze({
      required: policySha256,
      matchingEvidence: matches ? Object.freeze({
        mechanism: dimensionEvidence.mechanism, evidenceId: dimensionEvidence.evidenceId
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
  const admissionRecord = closedRecord(admission, [
    'schemaVersion', 'status', 'launchAuthorized', 'binding', 'bindingMatches',
    'dimensions', 'unavailableDimensions'
  ]);
  const binding = closedRecord(admissionRecord?.binding, BINDING_KEYS);
  const expectedRecord = closedRecord(expected, DELIVERY_KEYS);
  const acknowledgementRecord = closedRecord(acknowledgement, [
    ...BINDING_KEYS, ...DELIVERY_KEYS, 'status', 'channel', 'receiptId'
  ]);
  const expectedValid = expectedRecord && DELIVERY_KEYS.every((key) => isSha256(expectedRecord[key]));
  const matches = admissionRecord?.status === 'matching-shape'
    && admissionRecord.launchAuthorized === false
    && validBinding(binding) && expectedValid && acknowledgementRecord?.status === 'acknowledged'
    && acknowledgementRecord.channel === 'trusted-host-adapter'
    && validIdentity(acknowledgementRecord.receiptId)
    && BINDING_KEYS.every((key) => acknowledgementRecord[key] === binding[key])
    && DELIVERY_KEYS.every((key) => acknowledgementRecord[key] === expectedRecord[key]);
  return Object.freeze({
    schemaVersion: 1,
    status: matches ? 'matching-shape' : 'unavailable',
    deliveryConfirmed: false,
    binding: validBinding(binding) ? Object.freeze({ ...binding }) : null,
    missingOrMismatched: !expectedValid ? Object.freeze(['expected-digests'])
      : Object.freeze(DELIVERY_KEYS.filter((key) => acknowledgementRecord?.[key] !== expectedRecord[key]))
  });
}

/** Refuse delivery attribution until a live adapter establishes an authenticated receipt. */
export function assertSkillHostDelivery(admission, expected, acknowledgement) {
  const admissionRecord = closedRecord(admission, [
    'schemaVersion', 'status', 'launchAuthorized', 'binding', 'bindingMatches',
    'dimensions', 'unavailableDimensions'
  ]);
  if (admissionRecord?.status !== 'matching-shape' || admissionRecord.launchAuthorized !== false) {
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
