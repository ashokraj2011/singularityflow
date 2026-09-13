/**
 * Closed, code-local renderer registrations for the TKR M1 preview.
 *
 * These records prove which exact renderer identities the installed runtime understands. They are
 * intentionally not durable WMP authority; registration and migration through WMP remain M2 work.
 */
import { SingularityFlowError } from '../util.mjs';
import { TKR_GENERATED_RENDERER_REF } from './generated-renderer.mjs';
import {
  canonicalize, deepFreeze, sha256, withoutFields
} from '../world-model/canonicalize.mjs';

const REGISTRATION_KEYS = new Set([
  'kind', 'version', 'owner', 'rendererId', 'rendererRef', 'mode', 'format',
  'implementationSha256', 'registrationSha256'
]);
const REGISTRATION_INPUT_KEYS = new Set([
  'owner', 'rendererId', 'rendererRef', 'mode', 'format', 'implementationSha256'
]);
const OWNER = /^[a-z][a-z0-9.-]{0,127}$/u;
const RENDERER_ID = /^[a-z][a-z0-9.-]{0,127}$/u;
const EXACT_RENDERER_REF = /^([a-z][a-z0-9.-]{0,127})\/tkr\/renderer\/([a-z][a-z0-9.-]{0,127})@([1-9][0-9]*)#(sha256:[a-f0-9]{64})$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MODES = new Set(['source-pass-through', 'generated-framing']);
const FORMATS = new Set(['literal-utf8', 'canonical-json-utf8']);
// Keep the runtime closure independently bounded before inspecting any caller-controlled entry.
// This is the immutable v1 composer ceiling; contracts.mjs cannot be imported here without
// creating a module cycle.
const MAXIMUM_RENDERER_CONTRACTS = 256;

export const TKR_RUNTIME_RENDERER_REGISTRATION_KIND = 'tkr/runtime-renderer-registration';
export const TKR_RUNTIME_RENDERER_REGISTRATION_VERSION = 1;

function fail(message, code = 'TKR_CONTRACT_UNSUPPORTED', details = {}) {
  throw new SingularityFlowError(message, {
    code,
    details: {
      ...details,
      nextAction: details.nextAction
        ?? 'Install the exact code-local renderer registration required by this TKR composer.'
    }
  });
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  return value;
}

function exact(value, keys, label) {
  plain(value, label);
  const missing = [...keys].filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (missing.length || unknown.length) fail(`${label} has an invalid field set.`,
    'TKR_CONTRACT_UNSUPPORTED', { subject: label, missing, unknown: unknown.sort() });
  return value;
}

function text(value, pattern, label) {
  if (typeof value !== 'string' || !value.trim().length || !pattern.test(value)) fail(
    `${label} is not a supported exact value.`, 'TKR_CONTRACT_UNSUPPORTED',
    { subject: label, received: typeof value === 'string' ? value : null }
  );
  return value;
}

function registrationCore(value) {
  const owner = text(value.owner, OWNER, 'renderer registration.owner');
  const rendererId = text(value.rendererId, RENDERER_ID, 'renderer registration.rendererId');
  const rendererRef = text(
    value.rendererRef, EXACT_RENDERER_REF, 'renderer registration.rendererRef'
  );
  const match = EXACT_RENDERER_REF.exec(rendererRef);
  const implementationSha256 = text(
    value.implementationSha256, SHA256, 'renderer registration.implementationSha256'
  );
  if (match[1] !== owner || match[2] !== rendererId
      || Number(match[3]) !== TKR_RUNTIME_RENDERER_REGISTRATION_VERSION
      || match[4] !== implementationSha256) fail(
    'Renderer registration identity does not match its exact owner/version/implementation reference.',
    'TKR_RENDER_CONFLICT',
    { rendererRef, owner, rendererId, implementationSha256 }
  );
  if (!MODES.has(value.mode)) fail('renderer registration.mode is unsupported.',
    'TKR_CONTRACT_UNSUPPORTED', { mode: value.mode ?? null });
  if (!FORMATS.has(value.format)) fail('renderer registration.format is unsupported.',
    'TKR_CONTRACT_UNSUPPORTED', { format: value.format ?? null });
  if ((value.mode === 'source-pass-through' && value.format !== 'literal-utf8')
      || (value.mode === 'generated-framing' && value.format !== 'canonical-json-utf8')) fail(
    'Renderer registration mode and format are incompatible.', 'TKR_RENDER_CONFLICT',
    { mode: value.mode, format: value.format }
  );
  return {
    kind: TKR_RUNTIME_RENDERER_REGISTRATION_KIND,
    version: TKR_RUNTIME_RENDERER_REGISTRATION_VERSION,
    owner,
    rendererId,
    rendererRef,
    mode: value.mode,
    format: value.format,
    implementationSha256
  };
}

export function createTkrRuntimeRendererRegistration(value) {
  exact(value, REGISTRATION_INPUT_KEYS, 'renderer registration input');
  const core = registrationCore(value);
  return deepFreeze({ ...core, registrationSha256: sha256(core) });
}

export function validateTkrRuntimeRendererRegistration(value) {
  exact(value, REGISTRATION_KEYS, 'renderer registration');
  if (value.kind !== TKR_RUNTIME_RENDERER_REGISTRATION_KIND
      || value.version !== TKR_RUNTIME_RENDERER_REGISTRATION_VERSION) fail(
    'Renderer registration kind or version is unsupported.', 'TKR_CONTRACT_UNSUPPORTED',
    { kind: value.kind ?? null, version: value.version ?? null }
  );
  const core = registrationCore(value);
  const expected = sha256(core);
  if (value.registrationSha256 !== expected) fail(
    'Renderer registration failed its content-integrity check.', 'TKR_RENDER_CONFLICT',
    { expected, received: value.registrationSha256 ?? null }
  );
  if (JSON.stringify(canonicalize(withoutFields(value, ['registrationSha256'])))
      !== JSON.stringify(canonicalize(core))) fail(
    'Renderer registration is not canonical.', 'TKR_RENDER_CONFLICT',
    { rendererRef: value.rendererRef ?? null }
  );
  return deepFreeze({ ...core, registrationSha256: expected });
}

/** Resolve every composer renderer exactly once and reject missing or surplus registrations. */
export function validateTkrRuntimeRendererClosure(composer, rendererContracts) {
  if (!Array.isArray(rendererContracts)) fail(
    'TKR runtime requires an exact rendererContracts closure.',
    'TKR_CONTRACT_UNSUPPORTED', { missingCapability: 'tkr-renderer-contract-closure' }
  );
  const declared = Array.isArray(composer?.renderers) ? composer.renderers : [];
  if (rendererContracts.length > MAXIMUM_RENDERER_CONTRACTS) fail(
    'TKR runtime renderer closure exceeds the immutable version-1 processing limit.',
    'TKR_LIMIT_EXCEEDED', {
      limit: 'maximumRendererContracts',
      maximum: MAXIMUM_RENDERER_CONTRACTS,
      required: rendererContracts.length
    }
  );
  if (rendererContracts.length !== declared.length) fail(
    'TKR composer renderer closure is incomplete or contains unbound registrations.',
    'TKR_RENDER_CONFLICT', {
      expectedCount: declared.length,
      receivedCount: rendererContracts.length
    }
  );
  const normalized = rendererContracts.map(validateTkrRuntimeRendererRegistration);
  const byRef = new Map();
  for (const registration of normalized) {
    // Source-pass-through registrations carry bytes that were already rendered and verified by
    // their owner. Generated framing is executable code in this package, so a self-hashed record
    // cannot invent another implementation identity that the composer has no way to invoke.
    if (registration.mode === 'generated-framing'
        && registration.rendererRef !== TKR_GENERATED_RENDERER_REF) fail(
      `Generated renderer '${registration.rendererRef}' is not implemented by this runtime.`,
      'TKR_CONTRACT_UNSUPPORTED', {
        rendererRef: registration.rendererRef,
        supportedRendererRef: TKR_GENERATED_RENDERER_REF
      }
    );
    if (byRef.has(registration.rendererRef)) fail(
      `Renderer '${registration.rendererRef}' is registered more than once.`,
      'TKR_RENDER_CONFLICT', { rendererRef: registration.rendererRef }
    );
    byRef.set(registration.rendererRef, registration);
  }
  const missing = declared.filter((rendererRef) => !byRef.has(rendererRef));
  const surplus = normalized.filter((entry) => !declared.includes(entry.rendererRef))
    .map((entry) => entry.rendererRef);
  if (missing.length || surplus.length || normalized.length !== declared.length) fail(
    'TKR composer renderer closure is incomplete or contains unbound registrations.',
    'TKR_CONTRACT_UNSUPPORTED', { missing, surplus }
  );
  for (const rule of composer?.sectionRules ?? []) {
    if (!rule.generator) continue;
    const registration = byRef.get(rule.rendererRef);
    if (!registration || registration.mode !== 'generated-framing') fail(
      `Generated section '${rule.id}' is not bound to a generated-framing renderer registration.`,
      'TKR_CONTRACT_UNSUPPORTED',
      { sectionId: rule.id, rendererRef: rule.rendererRef,
        mode: registration?.mode ?? null }
    );
  }
  return deepFreeze(declared.map((rendererRef) => byRef.get(rendererRef)));
}
