/**
 * TKR M0 immutable contract kernel.
 *
 * These records describe how a future token-reduction composer may render existing governed
 * inputs. They do not select inputs, publish packets, or create a second authority store.
 */
import { currentSchemaVersion, readRecord, schemaFamily } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { validateTkrRuntimeRendererClosure } from './renderer-contracts.mjs';
import {
  canonicalJson, compareText, deepFreeze, sealRecord, sha256
} from '../world-model/canonicalize.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const TYPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const OWNER_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SECTION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EXACT_CONTRACT_REF = /^[a-z][a-z0-9./-]*@[1-9][0-9]*#sha256:[a-f0-9]{64}$/;
const TKR_OWNED_REF = /^([a-z][a-z0-9.-]*)\/(tkr\/[a-z][a-z0-9-]*)\/([a-z][a-z0-9.-]*)@([1-9][0-9]*)#(sha256:[a-f0-9]{64})$/;
const MAXIMUM_CONTRACT_BYTES = 16 * 1024 * 1024;

export const TKR_ERROR_CODES = Object.freeze([
  'TKR_ALIAS_INVALID',
  'TKR_CONTRACT_UNSUPPORTED',
  'TKR_COVERAGE_UNPROVEN',
  'TKR_LIMIT_EXCEEDED',
  'TKR_PROTECTED_CONTENT_CHANGED',
  'TKR_RENDER_CONFLICT'
]);

export const TKR_CONTRACT_FAMILIES = Object.freeze([
  'token-reduction-composer-contract',
  'token-reduction-representation-rules',
  'token-reduction-deduplication-rules',
  'token-reduction-protected-text-rules',
  'token-reduction-ordering-rules',
  'token-reduction-normalization-rules'
]);

const KIND_BY_FAMILY = Object.freeze({
  'token-reduction-composer-contract': 'tkr/composer-contract',
  'token-reduction-representation-rules': 'tkr/representation-rules',
  'token-reduction-deduplication-rules': 'tkr/deduplication-rules',
  'token-reduction-protected-text-rules': 'tkr/protected-text-rules',
  'token-reduction-ordering-rules': 'tkr/ordering-rules',
  'token-reduction-normalization-rules': 'tkr/normalization-rules'
});

const FAMILY_BY_KIND = Object.freeze(Object.fromEntries(
  Object.entries(KIND_BY_FAMILY).map(([family, kind]) => [kind, family])
));

export const TKR_REPRESENTATIONS = Object.freeze([
  'full', 'exact-excerpt', 'deterministic-brief', 'reference-only'
]);

export const TKR_COMPOSER_LIMITS = Object.freeze({
  maximumSections: 256,
  maximumCandidatesPerSubject: 4,
  maximumCoverageClaims: 4096,
  maximumAliases: 1024,
  maximumWorkingMetadataBytes: 16 * 1024 * 1024
});

function fail(message, code = 'TKR_CONTRACT_UNSUPPORTED', details = {}) {
  if (!TKR_ERROR_CODES.includes(code)) {
    throw new Error(`Unregistered TKR error code '${code}'.`);
  }
  throw new SingularityFlowError(message, { code, details });
}

export function assertTkrErrorCode(code) {
  if (!TKR_ERROR_CODES.includes(code)) fail(`Unknown TKR error code '${code}'.`);
  return code;
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object.`);
  }
  return value;
}

function exact(value, required, label) {
  plain(value, label);
  const allowed = new Set(required);
  const missing = required.filter((field) => !Object.hasOwn(value, field));
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (missing.length || unknown.length) {
    fail(`${label} has an invalid field set.`, 'TKR_CONTRACT_UNSUPPORTED', {
      label, missing, unknown
    });
  }
  return value;
}

function text(value, label, { pattern = null, maximumBytes = 1024 } = {}) {
  if (typeof value !== 'string' || !value.length || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'TKR_LIMIT_EXCEEDED', {
      limit: label, maximum: maximumBytes, required: bytes
    });
  }
  return value;
}

function integer(value, label, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be a finite integer from ${minimum} through ${maximum}.`,
      'TKR_LIMIT_EXCEEDED', { limit: label, minimum, maximum, required: value });
  }
  return value;
}

function digest(value, label) {
  return text(value, label, { pattern: SHA256, maximumBytes: 71 });
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is unsupported.`, 'TKR_CONTRACT_UNSUPPORTED', {
    label, received: value, allowed
  });
  return value;
}

function array(value, label, item, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  if (value.length < minimum || value.length > maximum) {
    fail(`${label} must contain ${minimum} through ${maximum} entries.`, 'TKR_LIMIT_EXCEEDED', {
      limit: label, minimum, maximum, required: value.length
    });
  }
  value.forEach((entry, index) => item(entry, `${label}[${index}]`));
  return value;
}

function unique(values, keyOf, label, code = 'TKR_RENDER_CONFLICT') {
  const seen = new Set();
  for (const [index, value] of values.entries()) {
    const key = keyOf(value);
    if (seen.has(key)) fail(`${label} contains duplicate '${key}'.`, code, { label, key, index });
    seen.add(key);
  }
  return values;
}

function sortedStrings(values, label) {
  array(values, label, (entry, itemLabel) => text(entry, itemLabel, {
    pattern: SECTION_ID, maximumBytes: 64
  }), { maximum: TKR_COMPOSER_LIMITS.maximumSections });
  unique(values, (entry) => entry, label);
  if (values.some((entry, index) => index > 0 && compareText(values[index - 1], entry) > 0)) {
    fail(`${label} must use locale-independent lexical order.`, 'TKR_RENDER_CONFLICT', {
      label
    });
  }
  return values;
}

function currentRecord(value, family, label) {
  let record;
  try { record = readRecord(family, value).record; }
  catch (error) {
    fail(`${label} schema is unsupported: ${error.message}`, 'TKR_CONTRACT_UNSUPPORTED', {
      family, cause: error.code ?? null
    });
  }
  const expectedKind = KIND_BY_FAMILY[family];
  if (record.kind !== expectedKind || record.version !== 1) {
    fail(`${label} kind or logical version is unsupported.`, 'TKR_CONTRACT_UNSUPPORTED', {
      family, expectedKind, receivedKind: record.kind ?? null,
      expectedVersion: 1, receivedVersion: record.version ?? null
    });
  }
  return record;
}

function common(record, family, label, fields) {
  exact(record, [
    'schemaVersion', 'kind', 'owner', 'contractId', 'version', ...fields, 'contractSha256'
  ], label);
  text(record.owner, `${label} owner`, { pattern: OWNER_ID, maximumBytes: 128 });
  text(record.contractId, `${label} contractId`, { pattern: TYPE_ID, maximumBytes: 128 });
  digest(record.contractSha256, `${label} contractSha256`);
  const core = structuredClone(record);
  delete core.contractSha256;
  const expected = sha256(core);
  if (record.contractSha256 !== expected) {
    fail(`${label} failed its exact content-integrity check.`, 'TKR_RENDER_CONFLICT', {
      contractId: record.contractId, expected, received: record.contractSha256
    });
  }
  const registration = schemaFamily(family);
  if (!registration.immutable || registration.migrationPolicy !== 'frozen-identity') {
    fail(`${label} is not registered as a frozen immutable owner contract.`);
  }
  return record;
}

function createContract(family, values, validator) {
  const record = sealRecord({
    ...structuredClone(values),
    schemaVersion: currentSchemaVersion(family),
    kind: KIND_BY_FAMILY[family],
    version: 1
  }, 'contractSha256');
  return deepFreeze(validator(record));
}

export function tkrContractReference(contract) {
  const family = FAMILY_BY_KIND[contract?.kind];
  if (!family) fail(`Unknown TKR contract kind '${contract?.kind ?? '(missing)'}'.`);
  const validated = VALIDATORS[family](contract);
  return `${validated.owner}/${validated.kind}/${validated.contractId}@${validated.version}#${validated.contractSha256}`;
}

function validateReference(value, label, expectedKind = null) {
  text(value, label, { pattern: EXACT_CONTRACT_REF, maximumBytes: 512 });
  if (!expectedKind) return value;
  const matched = TKR_OWNED_REF.exec(value);
  if (!matched || matched[2] !== expectedKind) {
    fail(`${label} must reference '${expectedKind}'.`, 'TKR_CONTRACT_UNSUPPORTED', {
      expectedKind, received: value
    });
  }
  return value;
}

export function validateTkrRepresentationRules(value) {
  const family = 'token-reduction-representation-rules';
  const record = currentRecord(value, family, 'TKR Representation Rules');
  common(record, family, 'TKR Representation Rules', [
    'representations', 'undeclaredInputBehavior', 'emptyContentBehavior',
    'unknownRequiredApplicabilityBehavior'
  ]);
  array(record.representations, 'TKR representations', (entry, label) => {
    exact(entry, ['id', 'completeness', 'expansion'], label);
    oneOf(entry.id, TKR_REPRESENTATIONS, `${label} id`);
    oneOf(entry.completeness, ['complete', 'selected'], `${label} completeness`);
    oneOf(entry.expansion, ['not-required', 'required', 'owner-defined'], `${label} expansion`);
  }, { minimum: TKR_REPRESENTATIONS.length, maximum: TKR_REPRESENTATIONS.length });
  unique(record.representations, (entry) => entry.id, 'TKR representations');
  if (record.representations.some((entry, index) => entry.id !== TKR_REPRESENTATIONS[index])) {
    fail('TKR representations must retain the registered preference order.',
      'TKR_RENDER_CONFLICT');
  }
  const expected = {
    full: ['complete', 'not-required'],
    'exact-excerpt': ['selected', 'required'],
    'deterministic-brief': ['selected', 'required'],
    'reference-only': ['selected', 'required']
  };
  for (const entry of record.representations) {
    const [completeness, expansion] = expected[entry.id];
    if (entry.completeness !== completeness || entry.expansion !== expansion) {
      fail(`TKR representation '${entry.id}' changes its registered meaning.`,
        'TKR_CONTRACT_UNSUPPORTED');
    }
  }
  if (record.undeclaredInputBehavior !== 'preserve-existing-required-representation'
      || record.emptyContentBehavior !== 'refuse'
      || record.unknownRequiredApplicabilityBehavior !== 'refuse') {
    fail('TKR Representation Rules weaken the required-input fallback.',
      'TKR_COVERAGE_UNPROVEN');
  }
  return deepFreeze(record);
}

export function createTkrRepresentationRules(values) {
  return createContract('token-reduction-representation-rules', values,
    validateTkrRepresentationRules);
}

export function validateTkrDeduplicationRules(value) {
  const family = 'token-reduction-deduplication-rules';
  const record = currentRecord(value, family, 'TKR Deduplication Rules');
  common(record, family, 'TKR Deduplication Rules', [
    'identity', 'textEqualitySufficient', 'coverageProofRequired',
    'revalidateAfterBudgeting', 'carrierRemoval'
  ]);
  if (record.identity !== 'owner-qualified-subject-revision-role'
      || record.textEqualitySufficient !== false
      || record.coverageProofRequired !== true
      || record.revalidateAfterBudgeting !== true
      || record.carrierRemoval !== 'refuse-when-required-claims-depend') {
    fail('TKR Deduplication Rules do not preserve owner-qualified coverage.',
      'TKR_COVERAGE_UNPROVEN');
  }
  return deepFreeze(record);
}

export function createTkrDeduplicationRules(values) {
  return createContract('token-reduction-deduplication-rules', values,
    validateTkrDeduplicationRules);
}

export function validateTkrProtectedTextRules(value) {
  const family = 'token-reduction-protected-text-rules';
  const record = currentRecord(value, family, 'TKR Protected Text Rules');
  common(record, family, 'TKR Protected Text Rules', [
    'sourceModes', 'normalizationScope', 'continuityProofRequired',
    'verifyAfterComposition'
  ]);
  array(record.sourceModes, 'TKR protected source modes', (entry, label) => {
    oneOf(entry, ['verbatim', 'lossless-encoded'], label);
  }, { minimum: 2, maximum: 2 });
  if (record.sourceModes[0] !== 'verbatim' || record.sourceModes[1] !== 'lossless-encoded'
      || record.normalizationScope !== 'generated-framing-only'
      || record.continuityProofRequired !== true
      || record.verifyAfterComposition !== true) {
    fail('TKR Protected Text Rules permit protected content to change.',
      'TKR_PROTECTED_CONTENT_CHANGED');
  }
  return deepFreeze(record);
}

export function createTkrProtectedTextRules(values) {
  return createContract('token-reduction-protected-text-rules', values,
    validateTkrProtectedTextRules);
}

export function validateTkrOrderingRules(value) {
  const family = 'token-reduction-ordering-rules';
  const record = currentRecord(value, family, 'TKR Ordering Rules');
  common(record, family, 'TKR Ordering Rules', [
    'stableOrder', 'dynamicOrder', 'dependencyPolicy', 'rolePolicy', 'setOrdering'
  ]);
  if (record.stableOrder !== 'declared-section-order'
      || record.dynamicOrder !== 'purpose-rule-qualified-subject'
      || record.dependencyPolicy !== 'preserve'
      || record.rolePolicy !== 'preserve'
      || record.setOrdering !== 'unicode-code-point') {
    fail('TKR Ordering Rules change an instruction role, dependency, or canonical order.',
      'TKR_RENDER_CONFLICT');
  }
  return deepFreeze(record);
}

export function createTkrOrderingRules(values) {
  return createContract('token-reduction-ordering-rules', values,
    validateTkrOrderingRules);
}

export function validateTkrNormalizationRules(value) {
  const family = 'token-reduction-normalization-rules';
  const record = currentRecord(value, family, 'TKR Normalization Rules');
  common(record, family, 'TKR Normalization Rules', [
    'scope', 'sourceBytes', 'authorityBytes', 'generatedLineEndings',
    'generatedWhitespace'
  ]);
  if (record.scope !== 'generated-framing-only'
      || record.sourceBytes !== 'unchanged'
      || record.authorityBytes !== 'unchanged'
      || record.generatedLineEndings !== 'lf'
      || record.generatedWhitespace !== 'preserve') {
    fail('TKR Normalization Rules redefine source or authority bytes.',
      'TKR_PROTECTED_CONTENT_CHANGED');
  }
  return deepFreeze(record);
}

export function createTkrNormalizationRules(values) {
  return createContract('token-reduction-normalization-rules', values,
    validateTkrNormalizationRules);
}

function validateSectionRule(value, label, priorIds, renderers, generators, dynamicGroups) {
  exact(value, [
    'id', 'slot', 'orderGroup', 'stability', 'permittedRoles', 'dependencies',
    'generator', 'rendererRef'
  ], label);
  text(value.id, `${label} id`, { pattern: SECTION_ID, maximumBytes: 64 });
  text(value.slot, `${label} slot`, { pattern: TYPE_ID, maximumBytes: 128 });
  text(value.orderGroup, `${label} orderGroup`, { pattern: SECTION_ID, maximumBytes: 64 });
  oneOf(value.stability, ['invariant', 'dynamic'], `${label} stability`);
  sortedStrings(value.permittedRoles, `${label} permittedRoles`);
  if (!value.permittedRoles.length) fail(`${label} permittedRoles cannot be empty.`);
  sortedStrings(value.dependencies, `${label} dependencies`);
  for (const dependency of value.dependencies) {
    if (!priorIds.has(dependency)) {
      fail(`${label} dependency '${dependency}' is unknown or appears after its consumer.`,
        'TKR_RENDER_CONFLICT', { sectionId: value.id, dependency });
    }
  }
  const group = `${value.slot}\0${value.orderGroup}`;
  if (value.stability === 'invariant' && dynamicGroups.has(group)) {
    fail(`${label} places invariant content after dynamic content in one ordering group.`,
      'TKR_RENDER_CONFLICT', { sectionId: value.id, slot: value.slot,
        orderGroup: value.orderGroup });
  }
  if (value.stability === 'dynamic') dynamicGroups.add(group);
  if (value.generator !== null) {
    oneOf(value.generator, ['alias-table', 'omission-notices'], `${label} generator`);
    if (generators.has(value.generator)) {
      fail(`TKR Composer repeats generator '${value.generator}'.`,
        'TKR_RENDER_CONFLICT', { generator: value.generator });
    }
    generators.add(value.generator);
    validateReference(value.rendererRef, `${label} rendererRef`);
    if (!renderers.includes(value.rendererRef) || value.permittedRoles.length !== 1) {
      fail(`${label} generator is not bound to one pinned renderer and role.`,
        'TKR_CONTRACT_UNSUPPORTED', { sectionId: value.id,
          rendererRef: value.rendererRef });
    }
  } else if (value.rendererRef !== null) {
    fail(`${label} rendererRef must be null when no generator is declared.`,
      'TKR_CONTRACT_UNSUPPORTED', { sectionId: value.id });
  }
}

function validateLimits(value) {
  exact(value, Object.keys(TKR_COMPOSER_LIMITS), 'TKR Composer limits');
  for (const [field, maximum] of Object.entries(TKR_COMPOSER_LIMITS)) {
    integer(value[field], `TKR Composer limits.${field}`, { maximum });
  }
  return value;
}

export function validateTkrComposerContract(value) {
  const family = 'token-reduction-composer-contract';
  const record = currentRecord(value, family, 'TKR Composer Contract');
  common(record, family, 'TKR Composer Contract', [
    'sectionRules', 'representationRulesRef', 'deduplicationRulesRef', 'renderers',
    'protectedTextRulesRef', 'orderingRulesRef', 'normalizationRulesRef', 'limits'
  ]);
  validateLimits(record.limits);
  array(record.renderers, 'TKR Composer renderers', (entry, label) => {
    validateReference(entry, label);
  }, { minimum: 1, maximum: record.limits.maximumSections });
  unique(record.renderers, (entry) => entry, 'TKR Composer renderers');
  const priorIds = new Set();
  const generators = new Set();
  const dynamicGroups = new Set();
  array(record.sectionRules, 'TKR Composer sectionRules', (entry, label) => {
    validateSectionRule(
      entry, label, priorIds, record.renderers, generators, dynamicGroups
    );
    if (priorIds.has(entry.id)) {
      fail(`TKR Composer sectionRules contains duplicate '${entry.id}'.`,
        'TKR_RENDER_CONFLICT', { sectionId: entry.id });
    }
    priorIds.add(entry.id);
  }, { minimum: 1, maximum: record.limits.maximumSections });
  validateReference(record.representationRulesRef, 'TKR representationRulesRef',
    'tkr/representation-rules');
  validateReference(record.deduplicationRulesRef, 'TKR deduplicationRulesRef',
    'tkr/deduplication-rules');
  validateReference(record.protectedTextRulesRef, 'TKR protectedTextRulesRef',
    'tkr/protected-text-rules');
  validateReference(record.orderingRulesRef, 'TKR orderingRulesRef',
    'tkr/ordering-rules');
  validateReference(record.normalizationRulesRef, 'TKR normalizationRulesRef',
    'tkr/normalization-rules');
  const metadataBytes = Buffer.byteLength(canonicalJson({
    sectionRules: record.sectionRules,
    renderers: record.renderers,
    references: [
      record.representationRulesRef, record.deduplicationRulesRef,
      record.protectedTextRulesRef, record.orderingRulesRef, record.normalizationRulesRef
    ]
  }), 'utf8');
  if (metadataBytes > record.limits.maximumWorkingMetadataBytes) {
    fail('TKR Composer working metadata exceeds its declared bound.',
      'TKR_LIMIT_EXCEEDED', {
        limit: 'maximumWorkingMetadataBytes',
        maximum: record.limits.maximumWorkingMetadataBytes,
        required: metadataBytes
      });
  }
  return deepFreeze(record);
}

function referenceKey(value) {
  const matched = TKR_OWNED_REF.exec(value);
  if (!matched) fail(`TKR owned contract reference '${value}' is invalid.`);
  return `${matched[1]}\0${matched[2]}\0${matched[3]}\0${matched[4]}`;
}

function assertReferenceResolves(reference, byIdentity, label) {
  const matched = TKR_OWNED_REF.exec(reference);
  if (!matched) fail(`${label} is not an exact TKR owner contract reference.`);
  const [, owner, kind, id, version, receivedSha256] = matched;
  const target = byIdentity.get(referenceKey(reference));
  if (!target) {
    fail(`${label} has no registered owner contract.`, 'TKR_CONTRACT_UNSUPPORTED', {
      owner, kind, id, version: Number(version)
    });
  }
  if (target.contractSha256 !== receivedSha256) {
    fail(`${label} digest does not match its registered owner contract.`,
      'TKR_CONTRACT_UNSUPPORTED', {
        owner, kind, id, version: Number(version), expected: target.contractSha256,
        received: receivedSha256
      });
  }
  return target;
}

export function validateTkrContractSet({ composer, contracts, rendererContracts }) {
  const rules = array(contracts, 'TKR referenced contracts', (entry) => {
    const family = FAMILY_BY_KIND[entry?.kind];
    if (!family || family === 'token-reduction-composer-contract') {
      fail(`TKR referenced contract kind '${entry?.kind ?? '(missing)'}' is unsupported.`);
    }
    VALIDATORS[family](entry);
  }, { minimum: 5, maximum: 5 });
  const byIdentity = new Map();
  for (const rule of rules) {
    const key = referenceKey(tkrContractReference(rule));
    if (byIdentity.has(key)) {
      fail('TKR referenced contracts contain a duplicate owner identity.',
        'TKR_RENDER_CONFLICT', { identity: key });
    }
    byIdentity.set(key, rule);
  }
  const value = validateTkrComposerContract(composer);
  for (const [label, reference] of [
    ['representationRulesRef', value.representationRulesRef],
    ['deduplicationRulesRef', value.deduplicationRulesRef],
    ['protectedTextRulesRef', value.protectedTextRulesRef],
    ['orderingRulesRef', value.orderingRulesRef],
    ['normalizationRulesRef', value.normalizationRulesRef]
  ]) assertReferenceResolves(reference, byIdentity, label);
  const renderers = validateTkrRuntimeRendererClosure(value, rendererContracts);
  return deepFreeze({ composer: value, contracts: [...rules], rendererContracts: renderers });
}

export function createTkrComposerContract(values, { contracts, rendererContracts } = {}) {
  if (!Array.isArray(contracts) || !Array.isArray(rendererContracts)) {
    fail('TKR Composer creation requires its five exact owner contracts and renderer closure.');
  }
  const composer = createContract('token-reduction-composer-contract', values,
    validateTkrComposerContract);
  return validateTkrContractSet({ composer, contracts, rendererContracts }).composer;
}

/** Project a validated durable owner record into the exact logical composer consumed at runtime. */
export function tkrLogicalComposerContract(value, { contracts, rendererContracts } = {}) {
  if (!Array.isArray(contracts) || !Array.isArray(rendererContracts)) fail(
    'A logical TKR composer requires its complete semantic and runtime renderer closure.'
  );
  const composer = validateTkrContractSet({
    composer: value, contracts, rendererContracts
  }).composer;
  return deepFreeze({
    kind: composer.kind,
    version: composer.version,
    sectionRules: structuredClone(composer.sectionRules),
    representationRulesRef: composer.representationRulesRef,
    deduplicationRulesRef: composer.deduplicationRulesRef,
    renderers: [...composer.renderers],
    protectedTextRulesRef: composer.protectedTextRulesRef,
    orderingRulesRef: composer.orderingRulesRef,
    normalizationRulesRef: composer.normalizationRulesRef,
    limits: structuredClone(composer.limits)
  });
}

const VALIDATORS = Object.freeze({
  'token-reduction-composer-contract': validateTkrComposerContract,
  'token-reduction-representation-rules': validateTkrRepresentationRules,
  'token-reduction-deduplication-rules': validateTkrDeduplicationRules,
  'token-reduction-protected-text-rules': validateTkrProtectedTextRules,
  'token-reduction-ordering-rules': validateTkrOrderingRules,
  'token-reduction-normalization-rules': validateTkrNormalizationRules
});

/**
 * Strict authority-byte reader. Alternate formatting and duplicate JSON keys fail because only
 * the registered canonical encoding is accepted after semantic validation.
 */
export function parseCanonicalTkrContractBytes(family, rawBytes, options = {}) {
  const validator = VALIDATORS[family];
  if (!validator) fail(`Unknown TKR contract family '${family}'.`);
  const maximumBytes = options.maximumBytes ?? MAXIMUM_CONTRACT_BYTES;
  integer(maximumBytes, 'TKR canonical reader maximumBytes', {
    maximum: MAXIMUM_CONTRACT_BYTES
  });
  if (!(Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array)) {
    fail('TKR contract input must be exact UTF-8 bytes.');
  }
  const bytes = Buffer.from(rawBytes);
  if (!bytes.length || bytes.length > maximumBytes) {
    fail(`TKR contract bytes must contain 1 through ${maximumBytes} bytes.`,
      'TKR_LIMIT_EXCEEDED', { limit: 'contractBytes', maximum: maximumBytes,
        required: bytes.length });
  }
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    fail('TKR contract is not valid UTF-8.', 'TKR_CONTRACT_UNSUPPORTED', {
      cause: error.message
    });
  }
  let parsed;
  try { parsed = JSON.parse(source); }
  catch (error) {
    fail(`TKR contract is not valid JSON: ${error.message}`);
  }
  const validated = validator(parsed);
  if (family === 'token-reduction-composer-contract') {
    if (!Array.isArray(options.contracts) || !Array.isArray(options.rendererContracts)) {
      fail('TKR Composer authority-byte ingestion requires its exact owner and renderer closure.');
    }
    validateTkrContractSet({
      composer: validated,
      contracts: options.contracts,
      rendererContracts: options.rendererContracts
    });
  }
  if (!Buffer.from(canonicalJson(validated), 'utf8').equals(bytes)) {
    fail('TKR contract is not the exact canonical JSON encoding.',
      'TKR_RENDER_CONFLICT');
  }
  return deepFreeze(validated);
}
