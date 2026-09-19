import {
  assertExactKeys, assertInteger, assertPlainRecord, assertSchemaKind, assertSelfHash,
  assertSha256, assertString, assertStringArray, contractFailure
} from '../contracts.mjs';
import { canonicalJson, deepFreeze, sealRecord, sha256 } from '../canonicalize.mjs';
import {
  PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES,
  PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES,
  PERSISTED_OVERVIEW_RENDERER_SHA256
} from '../materialize/persisted-overview-renderer-v1.mjs';
import { verifyPersistedOverviewCandidateV1 } from './persisted-overview-validator-v1.mjs';
import { createPersistedViewImplementationRegistry } from './persisted-view-implementation-registry.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST,
  PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST
} from './persisted-view-source-manifests.mjs';

// Frozen v1 owner scope. Never derive historical owner contracts from the mutable active View
// Registry: a later view version or active-status change must not redefine retained v1 bytes.
const VIEW_IDS = Object.freeze([
  'repository.architecture',
  'repository.business',
  'repository.development',
  'repository.security',
  'repository.testing'
]);
const FORMATS = Object.freeze(['json', 'md']);
const VARIANTS = Object.freeze(['brief', 'full']);

function assertFrozenContract(contract, expectedSha256) {
  if (contract.contractSha256 !== expectedSha256) {
    contractFailure(
      `Frozen persisted-view contract '${contract.id}' changed without a new version.`,
      'WMP_FROZEN_OWNER_CONTRACT_DRIFT',
      { expectedContractSha256: expectedSha256, receivedContractSha256: contract.contractSha256 }
    );
  }
  return contract;
}

function implementationRecord(kind, sourceManifest, expectedManifestId, extra = {}) {
  assertSha256(sourceManifest.manifestSha256, `${kind} source manifestSha256`);
  assertSha256(sourceManifest.sourceSha256, `${kind} sourceSha256`);
  if (sourceManifest.id !== expectedManifestId || sourceManifest.version !== 1) {
    contractFailure(`${kind} requires its exact frozen v1 source manifest.`,
      'WMP_IMPLEMENTATION_SOURCE_MANIFEST_INVALID', {
        expectedManifestId, receivedManifestId: sourceManifest.id ?? null,
        receivedVersion: sourceManifest.version ?? null
      });
  }
  return deepFreeze({
    kind,
    version: 1,
    sourceManifestId: sourceManifest.id,
    sourceManifestSha256: sourceManifest.manifestSha256,
    sourceSha256: sourceManifest.sourceSha256,
    entrypoints: [...sourceManifest.entrypoints],
    sourceFiles: sourceManifest.modules.map((entry) => entry.path),
    ...extra
  });
}

export function createPersistedOverviewRendererImplementation({
  sourceManifest = PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST
} = {}) {
  return implementationRecord(
    'wmp/persisted-overview-renderer-implementation', sourceManifest,
    'persisted-overview-renderer-v1'
  );
}

export const PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION =
  createPersistedOverviewRendererImplementation();
export const PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION_SHA256 = sha256(
  PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION
);

export const PERSISTED_OVERVIEW_RENDERER_CONTRACT = assertFrozenContract(deepFreeze(sealRecord({
  schemaVersion: 1,
  kind: 'world-model-renderer-contract',
  id: 'repository-overview-fixed-template',
  version: 1,
  viewIds: [...VIEW_IDS],
  formats: [...FORMATS],
  variants: [...VARIANTS],
  implementationSha256: PERSISTED_OVERVIEW_RENDERER_IMPLEMENTATION_SHA256,
  configurationSha256: PERSISTED_OVERVIEW_RENDERER_SHA256,
  maximumBytes: {
    brief: PERSISTED_OVERVIEW_BRIEF_MAXIMUM_BYTES,
    full: PERSISTED_OVERVIEW_FULL_MAXIMUM_BYTES
  }
}, 'contractSha256')), 'sha256:c0b385b076a05d5ae1c336f1877ba45e59102346432a6d6ce39182588a97216d');

export const PERSISTED_OVERVIEW_CANDIDATE_SCHEMA = deepFreeze({
  kind: 'wmp/persisted-overview-rendered-candidate',
  version: 1,
  formats: [...FORMATS],
  digest: 'sha256-exact-utf8-bytes',
  requiredBindings: [
    'model-binding', 'source-fact-ledger', 'selected-fact-ledger', 'view-contract'
  ]
});
export const PERSISTED_OVERVIEW_CANDIDATE_SCHEMA_SHA256 = sha256(
  PERSISTED_OVERVIEW_CANDIDATE_SCHEMA
);

// These checks belong to the immutable validator-v1 algorithm. Structural graph admission remains
// independently enforced by the retained-object store and is not misattributed to this owner.
export const PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS = Object.freeze([
  'candidate-digest',
  'exact-render-replay',
  'measurement-replay',
  'selection-replay',
  'view-identity'
]);

export function createPersistedOverviewValidatorImplementation({
  sourceManifest = PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST
} = {}) {
  return implementationRecord(
    'wmp/persisted-overview-validator-implementation', sourceManifest,
    'persisted-overview-validator-v1', {
      candidateSchemaSha256: PERSISTED_OVERVIEW_CANDIDATE_SCHEMA_SHA256,
      checks: [...PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS],
      result: 'all-checks-must-pass'
    }
  );
}

export const PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION =
  createPersistedOverviewValidatorImplementation();
export const PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION_SHA256 = sha256(
  PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION
);

export const PERSISTED_OVERVIEW_VALIDATOR_CONTRACT = assertFrozenContract(deepFreeze(sealRecord({
  schemaVersion: 1,
  kind: 'world-model-validator-contract',
  id: 'repository-overview-graph-validator',
  version: 1,
  viewIds: [...VIEW_IDS],
  candidateSchemaSha256: PERSISTED_OVERVIEW_CANDIDATE_SCHEMA_SHA256,
  checks: [...PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS],
  implementationSha256: PERSISTED_OVERVIEW_VALIDATOR_IMPLEMENTATION_SHA256
}, 'contractSha256')), 'sha256:1518178b2655949c3588954a161fe11ab02a758deaae8a6cfbbab0a8cc3e146b');

export const PERSISTED_VIEW_IMPLEMENTATION_REGISTRY =
  createPersistedViewImplementationRegistry({
    activeWriterId: 'persisted-overview-v1',
    entries: [{
      id: 'persisted-overview-v1',
      version: 1,
      rendererContract: PERSISTED_OVERVIEW_RENDERER_CONTRACT,
      validatorContract: PERSISTED_OVERVIEW_VALIDATOR_CONTRACT,
      replay: verifyPersistedOverviewCandidateV1
    }]
  });

function fail(message, details = {}) {
  contractFailure(message, 'WMP_OWNER_CONTRACT_INVALID', details);
}

function validateViewIds(values, label) {
  assertStringArray(values, label, { sorted: true });
  if (canonicalJson(values) !== canonicalJson(VIEW_IDS)) {
    fail(`${label} does not name the complete persisted-overview view set.`, {
      expected: VIEW_IDS, received: values
    });
  }
}

function parseRendererContract(value) {
  const record = value;
  assertPlainRecord(record, 'WMP Renderer Contract');
  assertExactKeys(record, {
    required: [
      'schemaVersion', 'kind', 'id', 'version', 'viewIds', 'formats', 'variants',
      'implementationSha256', 'configurationSha256', 'maximumBytes', 'contractSha256'
    ],
    label: 'WMP Renderer Contract'
  });
  assertSchemaKind(record, 'world-model-renderer-contract', 'WMP Renderer Contract');
  assertString(record.id, 'WMP Renderer Contract id');
  assertInteger(record.version, 'WMP Renderer Contract version', { minimum: 1 });
  validateViewIds(record.viewIds, 'WMP Renderer Contract viewIds');
  assertStringArray(record.formats, 'WMP Renderer Contract formats', { sorted: true });
  assertStringArray(record.variants, 'WMP Renderer Contract variants', { sorted: true });
  assertSha256(record.implementationSha256, 'WMP Renderer Contract implementationSha256');
  assertSha256(record.configurationSha256, 'WMP Renderer Contract configurationSha256');
  assertPlainRecord(record.maximumBytes, 'WMP Renderer Contract maximumBytes');
  assertExactKeys(record.maximumBytes, {
    required: ['brief', 'full'], label: 'WMP Renderer Contract maximumBytes'
  });
  assertInteger(record.maximumBytes.brief, 'WMP Renderer Contract brief maximumBytes', {
    minimum: 1
  });
  assertInteger(record.maximumBytes.full, 'WMP Renderer Contract full maximumBytes', {
    minimum: record.maximumBytes.brief
  });
  assertSha256(record.contractSha256, 'WMP Renderer Contract contractSha256');
  assertSelfHash(record, 'contractSha256', 'WMP Renderer Contract');
  return record;
}

function parseValidatorContract(value) {
  const record = value;
  assertPlainRecord(record, 'WMP Validator Contract');
  assertExactKeys(record, {
    required: [
      'schemaVersion', 'kind', 'id', 'version', 'viewIds', 'candidateSchemaSha256',
      'checks', 'implementationSha256', 'contractSha256'
    ],
    label: 'WMP Validator Contract'
  });
  assertSchemaKind(record, 'world-model-validator-contract', 'WMP Validator Contract');
  assertString(record.id, 'WMP Validator Contract id');
  assertInteger(record.version, 'WMP Validator Contract version', { minimum: 1 });
  validateViewIds(record.viewIds, 'WMP Validator Contract viewIds');
  assertSha256(record.candidateSchemaSha256, 'WMP Validator Contract candidateSchemaSha256');
  assertStringArray(record.checks, 'WMP Validator Contract checks', { sorted: true });
  assertSha256(record.implementationSha256, 'WMP Validator Contract implementationSha256');
  assertSha256(record.contractSha256, 'WMP Validator Contract contractSha256');
  assertSelfHash(record, 'contractSha256', 'WMP Validator Contract');
  return record;
}

export function validateWorldModelRendererContract(value) {
  const record = parseRendererContract(value);
  PERSISTED_VIEW_IMPLEMENTATION_REGISTRY.resolveRenderer(record);
  return record;
}

export function validateWorldModelValidatorContract(value) {
  const record = parseValidatorContract(value);
  PERSISTED_VIEW_IMPLEMENTATION_REGISTRY.resolveValidator(record);
  return record;
}

export function replayPersistedOverviewCandidate({
  rendererContract, validatorContract, ...input
}) {
  return PERSISTED_VIEW_IMPLEMENTATION_REGISTRY.replay({
    ...input, rendererContract, validatorContract
  });
}
