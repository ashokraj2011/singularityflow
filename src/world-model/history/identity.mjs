import { schemaFamily } from '../../schema-migrations.mjs';
import {
  COMMIT_PATTERN, VIEW_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSha256, assertString, contractFailure
} from '../contracts.mjs';
import { compareText, deepFreeze, sha256, sha256Bytes } from '../canonicalize.mjs';

export const WMP_IDENTITY_VERSION = 1;
export const WMP_MAXIMUM_OBJECT_BYTES = 32 * 1024 * 1024;
export const WMP_MAXIMUM_OBJECT_REFS = 100_000;
export const WMP_RENDERED_OBJECT_ROLES = Object.freeze([
  'rendered-grounding',
  'rendered-view'
]);

const ROLE_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const FAMILY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

function fail(message, code = 'WMP_CONTRACT_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function nullableSha256(value, label) {
  if (value !== null) assertSha256(value, label);
}

function positiveVersion(value, label) {
  assertInteger(value, label, { minimum: 1 });
}

function assertIdentityVersion(value, label) {
  if (value !== WMP_IDENTITY_VERSION) {
    fail(`${label} identityVersion must be ${WMP_IDENTITY_VERSION}.`, 'WMP_IDENTITY_VERSION_UNSUPPORTED');
  }
}

function assertBoundedString(value, label, { pattern = null, maximumBytes = 256 } = {}) {
  assertString(value, label, { pattern });
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) {
    fail(`${label} exceeds its ${maximumBytes}-byte limit.`, 'WMP_CONTRACT_LIMIT', {
      label, maximumBytes, bytes
    });
  }
  return value;
}

export function objectRefByteSha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), 'utf8');
  return `sha256:${sha256Bytes(bytes)}`;
}

/**
 * Validate one retained-object reference.
 *
 * Registered JSON records always name their MIG family. `family: null` is reserved for exact
 * rendered payload bytes; it can never be used to smuggle an unregistered JSON authority object
 * into the retained closure.
 */
export function validateWmpObjectRef(value, {
  expectedRole = null, expectedFamily = undefined, rendered = false
} = {}) {
  assertPlainRecord(value, 'WMP ObjectRef');
  assertExactKeys(value, {
    required: ['role', 'family', 'mediaType', 'sha256', 'bytes'], label: 'WMP ObjectRef'
  });
  assertBoundedString(value.role, 'WMP ObjectRef role', {
    pattern: ROLE_PATTERN, maximumBytes: 128
  });
  if (expectedRole !== null && value.role !== expectedRole) {
    fail(`WMP ObjectRef role must be '${expectedRole}'.`, 'WMP_OBJECT_ROLE_MISMATCH', {
      expected: expectedRole, received: value.role
    });
  }
  if (value.family === null) {
    if (!rendered || !WMP_RENDERED_OBJECT_ROLES.includes(value.role)) {
      fail('A family-less WMP ObjectRef is allowed only for an exact bounded rendered role.',
        'WMP_OBJECT_FAMILY_REQUIRED', {
          role: value.role,
          allowedRoles: [...WMP_RENDERED_OBJECT_ROLES]
        });
    }
  } else {
    assertBoundedString(value.family, 'WMP ObjectRef family', {
      pattern: FAMILY_PATTERN, maximumBytes: 128
    });
    try { schemaFamily(value.family); }
    catch (error) {
      fail(`WMP ObjectRef names unregistered family '${value.family}'.`,
        'WMP_OBJECT_FAMILY_UNKNOWN', { family: value.family, cause: error.code ?? null });
    }
    if (value.mediaType !== 'application/json') {
      fail('A registered WMP ObjectRef family requires application/json.',
        'WMP_OBJECT_MEDIA_TYPE_INVALID', { family: value.family, mediaType: value.mediaType });
    }
  }
  if (expectedFamily !== undefined && value.family !== expectedFamily) {
    fail('WMP ObjectRef family does not match its required role.', 'WMP_OBJECT_FAMILY_MISMATCH', {
      expected: expectedFamily, received: value.family, role: value.role
    });
  }
  if (!['application/json', 'text/markdown'].includes(value.mediaType)) {
    fail(`Unsupported WMP ObjectRef media type '${value.mediaType}'.`,
      'WMP_OBJECT_MEDIA_TYPE_INVALID');
  }
  if (value.mediaType === 'text/markdown' && value.family !== null) {
    fail('Markdown WMP objects cannot claim a registered JSON family.',
      'WMP_OBJECT_MEDIA_TYPE_INVALID');
  }
  assertSha256(value.sha256, 'WMP ObjectRef sha256');
  assertInteger(value.bytes, 'WMP ObjectRef bytes', {
    minimum: 1, maximum: WMP_MAXIMUM_OBJECT_BYTES
  });
  return value;
}

export function validateWmpObjectRefs(values, label = 'WMP ObjectRefs', {
  maximum = WMP_MAXIMUM_OBJECT_REFS, uniqueRoles = true
} = {}) {
  if (!Array.isArray(values)) fail(`${label} must be an array.`);
  if (values.length > maximum) {
    fail(`${label} exceeds its ${maximum}-item limit.`, 'WMP_CONTRACT_LIMIT', {
      label, maximum, received: values.length
    });
  }
  values.forEach((entry) => validateWmpObjectRef(entry));
  const exactReferences = values.map((entry) => `${entry.role}\0${entry.family ?? ''}\0${entry.sha256}`);
  if (new Set(exactReferences).size !== exactReferences.length) {
    fail(`${label} repeats an exact object reference.`, 'WMP_OBJECT_REF_DUPLICATE');
  }
  if (uniqueRoles && new Set(values.map((entry) => entry.role)).size !== values.length) {
    fail(`${label} repeats an object role.`, 'WMP_OBJECT_ROLE_DUPLICATE');
  }
  assertCanonicalOrder(values, (entry) => `${entry.role}\0${entry.family ?? ''}\0${entry.sha256}`, label);
  return values;
}

export function validateWmpSourceBinding(value) {
  assertPlainRecord(value, 'WMP Source Binding');
  assertExactKeys(value, {
    required: [
      'kind', 'version', 'repositoryDomainRef', 'repositoryDomainSha256', 'sourceKind',
      'sourceSnapshotRef', 'sourceManifestSha256', 'scopeManifestSha256', 'gitObjectFormat',
      'requestedRevision', 'effectiveRevision', 'sourceAuthorityRef'
    ],
    label: 'WMP Source Binding'
  });
  if (value.kind !== 'wmp/source-binding' || value.version !== 1) {
    fail("WMP Source Binding must use kind 'wmp/source-binding' and version 1.",
      'WMP_SOURCE_BINDING_INVALID');
  }
  validateWmpObjectRef(value.repositoryDomainRef, { expectedRole: 'repository-domain' });
  assertSha256(value.repositoryDomainSha256, 'WMP Source Binding repositoryDomainSha256');
  if (!['committed', 'candidate'].includes(value.sourceKind)) {
    fail(`Unsupported WMP source kind '${value.sourceKind}'.`, 'WMP_SOURCE_BINDING_INVALID');
  }
  validateWmpObjectRef(value.sourceSnapshotRef, {
    expectedRole: 'source-snapshot', expectedFamily: 'world-model-source-snapshot'
  });
  assertSha256(value.sourceManifestSha256, 'WMP Source Binding sourceManifestSha256');
  assertSha256(value.scopeManifestSha256, 'WMP Source Binding scopeManifestSha256');
  if (!['sha1', 'sha256'].includes(value.gitObjectFormat)) {
    fail(`Unsupported Git object format '${value.gitObjectFormat}'.`, 'WMP_SOURCE_BINDING_INVALID');
  }
  assertString(value.requestedRevision, 'WMP Source Binding requestedRevision', {
    pattern: COMMIT_PATTERN
  });
  assertString(value.effectiveRevision, 'WMP Source Binding effectiveRevision', {
    pattern: COMMIT_PATTERN
  });
  const revisionLength = value.gitObjectFormat === 'sha1' ? 40 : 64;
  for (const field of ['requestedRevision', 'effectiveRevision']) {
    if (value[field].length !== revisionLength) {
      fail(`WMP Source Binding ${field} disagrees with its Git object format.`,
        'WMP_SOURCE_BINDING_INVALID', {
          field,
          gitObjectFormat: value.gitObjectFormat,
          expectedLength: revisionLength,
          receivedLength: value[field].length
        });
    }
  }
  if (value.sourceKind === 'candidate') {
    validateWmpObjectRef(value.sourceAuthorityRef, { expectedRole: 'source-authority' });
  } else if (value.sourceAuthorityRef !== null) {
    fail('A committed WMP Source Binding cannot carry candidate source authority.',
      'WMP_SOURCE_BINDING_INVALID');
  }
  return value;
}

export function createWmpSourceBinding(value) {
  return deepFreeze(validateWmpSourceBinding(structuredClone({
    kind: 'wmp/source-binding', version: 1, ...value
  })));
}

export function validateWmpModelInputs(value) {
  assertPlainRecord(value, 'WMP ModelInputs');
  assertExactKeys(value, {
    required: [
      'identityVersion', 'repositoryDomainSha256', 'sourceBindingSha256',
      'sourceManifestSha256', 'scopeManifestSha256', 'extractionPolicySha256',
      'extractorRegistrySha256', 'extractionProfileSha256', 'factRequirementsSha256',
      'extractionInputsSha256'
    ],
    label: 'WMP ModelInputs'
  });
  assertIdentityVersion(value.identityVersion, 'WMP ModelInputs');
  for (const field of Object.keys(value).filter((field) => field.endsWith('Sha256'))) {
    assertSha256(value[field], `WMP ModelInputs ${field}`);
  }
  return value;
}

export function deriveWmpModelKey(inputs) {
  validateWmpModelInputs(inputs);
  return sha256({ kind: 'wmp/model-key', ...structuredClone(inputs) });
}

export function validateWmpViewInputsKey(value) {
  assertPlainRecord(value, 'WMP ViewInputsKey');
  assertExactKeys(value, {
    required: [
      'identityVersion', 'modelPayloadSha256', 'viewInputsSha256', 'viewId', 'viewVersion',
      'viewContractSha256', 'rendererSha256', 'validatorSha256', 'consumerProfileSha256',
      'selectionSha256', 'outputBudgetSha256', 'tokenizerSha256', 'format', 'variant'
    ],
    label: 'WMP ViewInputsKey'
  });
  assertIdentityVersion(value.identityVersion, 'WMP ViewInputsKey');
  for (const field of [
    'modelPayloadSha256', 'viewInputsSha256', 'viewContractSha256', 'rendererSha256',
    'validatorSha256', 'consumerProfileSha256', 'selectionSha256', 'outputBudgetSha256'
  ]) assertSha256(value[field], `WMP ViewInputsKey ${field}`);
  nullableSha256(value.tokenizerSha256, 'WMP ViewInputsKey tokenizerSha256');
  assertBoundedString(value.viewId, 'WMP ViewInputsKey viewId', {
    pattern: VIEW_ID_PATTERN, maximumBytes: 128
  });
  positiveVersion(value.viewVersion, 'WMP ViewInputsKey viewVersion');
  if (!['md', 'json'].includes(value.format)) {
    fail(`Unsupported WMP view format '${value.format}'.`, 'WMP_VIEW_KEY_INVALID');
  }
  if (!['full', 'brief'].includes(value.variant)) {
    fail(`Unsupported WMP view variant '${value.variant}'.`, 'WMP_VIEW_KEY_INVALID');
  }
  // A null tokenizer is valid only for the specification's explicitly selected byte-budget
  // mode. The output-budget record named above owns that distinction; identity code must not
  // guess its contents from the variant label.
  return value;
}

export function deriveWmpViewKey(inputs) {
  validateWmpViewInputsKey(inputs);
  return sha256({ kind: 'wmp/view-key', ...structuredClone(inputs) });
}

export function assertSortedTypeIds(values, label, { maximum = 10_000 } = {}) {
  if (!Array.isArray(values) || values.length > maximum) {
    fail(`${label} must contain at most ${maximum} entries.`, 'WMP_CONTRACT_LIMIT');
  }
  values.forEach((entry, index) => assertBoundedString(entry, `${label}[${index}]`, {
    pattern: TYPE_ID_PATTERN, maximumBytes: 256
  }));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates.`);
  assertCanonicalOrder(values, (entry) => entry, label);
  return values;
}

export function compareWmpText(left, right) {
  return compareText(left, right);
}
