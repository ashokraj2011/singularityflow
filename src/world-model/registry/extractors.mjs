import { canonicalJson, compareText, deepFreeze, sealRecord } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  assertBoolean, assertCanonicalOrder, assertExactKeys, assertPlainRecord, assertSchemaKind,
  assertSelfHash, assertSha256, assertString, assertStringArray, contractFailure
} from '../contracts.mjs';
import { EVIDENCE_KINDS, FACT_TYPES, assertVocabularyValue } from '../vocabularies.mjs';
import {
  CALL_REFERENCE_EDGE_ID, CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256, CALL_REFERENCE_EDGE_VERSION,
  CLAUSE_CODE_BINDING_ID, CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256, CLAUSE_CODE_BINDING_VERSION,
  CHANGE_REGION_ID, CHANGE_REGION_IMPLEMENTATION_SHA256, CHANGE_REGION_VERSION,
  CLOSED_STRUCTURE_LANGUAGES,
  CONFIGURATION_OBJECT_ID, CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256, CONFIGURATION_OBJECT_VERSION,
  IMPORT_DEPENDENCY_ID, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, IMPORT_DEPENDENCY_VERSION,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION,
  INTERFACE_CONTRACT_ID, INTERFACE_CONTRACT_IMPLEMENTATION_SHA256, INTERFACE_CONTRACT_VERSION,
  LANGUAGE_DETECTION_ID, LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, LANGUAGE_DETECTION_VERSION,
  LEGACY_MIGRATION_RESOLUTION_ID, LEGACY_MIGRATION_RESOLUTION_IMPLEMENTATION_SHA256,
  LEGACY_MIGRATION_RESOLUTION_VERSION,
  OWNERSHIP_MAINTAINER_RECORD_ID, OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256,
  OWNERSHIP_MAINTAINER_RECORD_VERSION,
  REPOSITORY_FILES_ID, REPOSITORY_FILES_IMPLEMENTATION_SHA256, REPOSITORY_FILES_VERSION,
  REQUIRED_FACT_COVERAGE_ID, REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, REQUIRED_FACT_COVERAGE_VERSION,
  RUNTIME_OBSERVATION_IMPORT_ID, RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256,
  RUNTIME_OBSERVATION_IMPORT_VERSION,
  RULE_DEFINITION_ID, RULE_DEFINITION_IMPLEMENTATION_SHA256, RULE_DEFINITION_VERSION,
  SIGNATURE_AND_EXPORT_ID, SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256, SIGNATURE_AND_EXPORT_VERSION,
  SYMBOL_SKELETON_ID, SYMBOL_SKELETON_IMPLEMENTATION_SHA256, SYMBOL_SKELETON_VERSION,
  TEST_IDENTITY_ID, TEST_IDENTITY_IMPLEMENTATION_SHA256, TEST_IDENTITY_VERSION,
  TEST_IDENTITY_LANGUAGES,
  POLYGLOT_STRUCTURAL_LANGUAGES
} from '../extract/adapters/index.mjs';
import {
  extractorConformanceDeclaration, extractorConformanceReceiptSha256
} from './extractor-conformance.mjs';

const EXTRACTOR_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const FAILURE_VALUES = Object.freeze({
  unsupportedLanguage: ['unavailable', 'not-applicable'],
  parseFailure: ['partial-or-unavailable', 'not-applicable'],
  internalError: ['refuse']
});

function manifest({ id, version, implementationSha256, languages, evidenceKinds, factTypes, algorithm }) {
  const conformance = extractorConformanceDeclaration(id);
  return sealRecord({
    schemaVersion: currentSchemaVersion('world-model-extractor-manifest'),
    kind: 'world-model-extractor-manifest',
    id,
    version,
    producer: {
      kind: 'deterministic-module', implementationSha256,
      parser: structuredClone(conformance.parser)
    },
    languages: [...languages].sort(),
    evidenceKinds: [...evidenceKinds].sort(),
    factTypes: [...factTypes].sort(),
    inputs: { sourceManifest: 'required', scopeManifest: 'required' },
    outputs: { evidenceCatalogEntries: true, derivationRecords: true, factLedgerEntries: true },
    failure: {
      unsupportedLanguage: 'unavailable',
      parseFailure: 'partial-or-unavailable',
      internalError: 'refuse'
    },
    permissions: { network: 'none', model: 'never', writes: 'derived-store-only' },
    tests: {
      conformanceReceiptSha256: extractorConformanceReceiptSha256({
        id, version, implementationSha256, algorithm
      })
    }
  }, 'manifestSha256');
}

const BUILTINS = [
  manifest({
    id: CALL_REFERENCE_EDGE_ID,
    version: CALL_REFERENCE_EDGE_VERSION,
    implementationSha256: CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256,
    languages: [...CLOSED_STRUCTURE_LANGUAGES],
    evidenceKinds: ['call-edge', 'file', 'reference-edge'],
    factTypes: ['dependency-analysis', 'dependency-edge'],
    algorithm: 'single-pass-bounded-same-file-lexical-edge-candidates-v2'
  }),
  manifest({
    id: CLAUSE_CODE_BINDING_ID,
    version: CLAUSE_CODE_BINDING_VERSION,
    implementationSha256: CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256,
    languages: CLOSED_STRUCTURE_LANGUAGES,
    evidenceKinds: ['clause-binding'],
    factTypes: ['clause-binding'],
    algorithm: 'explicit-source-comment-clause-tags-v1'
  }),
  manifest({
    id: CHANGE_REGION_ID,
    version: CHANGE_REGION_VERSION,
    implementationSha256: CHANGE_REGION_IMPLEMENTATION_SHA256,
    languages: [...CLOSED_STRUCTURE_LANGUAGES],
    evidenceKinds: [
      'configuration-object', 'interface-implementation', 'signature', 'symbol',
      'test-symbol-binding'
    ],
    factTypes: ['changed-symbol', 'contract-change', 'structural-impact', 'test-impact'],
    algorithm: 'constant-process-exact-first-parent-zero-context-change-regions-v2'
  }),
  manifest({
    id: CONFIGURATION_OBJECT_ID,
    version: CONFIGURATION_OBJECT_VERSION,
    implementationSha256: CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256,
    languages: ['json', 'properties', 'toml', 'yaml'],
    evidenceKinds: ['configuration-object', 'file'],
    factTypes: ['configuration-object'],
    algorithm: 'strict-configuration-key-inventory-v1'
  }),
  manifest({
    id: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID,
    version: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION,
    implementationSha256: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256,
    languages: ['json'],
    evidenceKinds: ['human-confirmed-record'],
    factTypes: ['business-glossary', 'business-meaning'],
    algorithm: 'sealed-bounded-human-confirmed-business-knowledge-import-v1'
  }),
  manifest({
    id: IMPORT_DEPENDENCY_ID,
    version: IMPORT_DEPENDENCY_VERSION,
    implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256,
    languages: [...POLYGLOT_STRUCTURAL_LANGUAGES, 'javascript', 'typescript'].sort(),
    evidenceKinds: ['dependency-edge', 'import'],
    factTypes: ['dependency-analysis', 'dependency-edge', 'import-dependency'],
    algorithm: 'code-and-literal-aware-imports-and-exact-local-resolution-v2'
  }),
  manifest({
    id: INTERFACE_CONTRACT_ID,
    version: INTERFACE_CONTRACT_VERSION,
    implementationSha256: INTERFACE_CONTRACT_IMPLEMENTATION_SHA256,
    languages: CLOSED_STRUCTURE_LANGUAGES,
    evidenceKinds: ['configuration-object', 'interface-implementation', 'signature'],
    factTypes: [
      'consumer-dependency', 'implementation', 'interface', 'protocol-field', 'schema-contract'
    ],
    algorithm: 'explicit-interface-implementation-field-and-schema-syntax-v2'
  }),
  manifest({
    id: OWNERSHIP_MAINTAINER_RECORD_ID,
    version: OWNERSHIP_MAINTAINER_RECORD_VERSION,
    implementationSha256: OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256,
    languages: ['codeowners'],
    evidenceKinds: ['configuration-object'],
    factTypes: ['maintainer-record', 'ownership-concentration'],
    algorithm: 'exact-codeowners-record-and-frequency-v1'
  }),
  manifest({
    id: LANGUAGE_DETECTION_ID,
    version: LANGUAGE_DETECTION_VERSION,
    implementationSha256: LANGUAGE_DETECTION_IMPLEMENTATION_SHA256,
    languages: [
      'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'php', 'python', 'ruby', 'rust', 'swift', 'typescript'
    ],
    evidenceKinds: ['file'],
    factTypes: ['language-detected'],
    algorithm: 'closed-extension-map-v1'
  }),
  manifest({
    id: LEGACY_MIGRATION_RESOLUTION_ID,
    version: LEGACY_MIGRATION_RESOLUTION_VERSION,
    implementationSha256: LEGACY_MIGRATION_RESOLUTION_IMPLEMENTATION_SHA256,
    languages: [],
    evidenceKinds: [],
    factTypes: FACT_TYPES,
    algorithm: 'claim-digest-only-typed-unavailable-resolution-v1'
  }),
  manifest({
    id: RUNTIME_OBSERVATION_IMPORT_ID,
    version: RUNTIME_OBSERVATION_IMPORT_VERSION,
    implementationSha256: RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256,
    languages: ['json'],
    evidenceKinds: ['runtime-observation'],
    factTypes: ['runtime-frequency'],
    algorithm: 'sealed-bounded-runtime-frequency-record-import-v1'
  }),
  manifest({
    id: RULE_DEFINITION_ID,
    version: RULE_DEFINITION_VERSION,
    implementationSha256: RULE_DEFINITION_IMPLEMENTATION_SHA256,
    languages: ['json', 'yaml'],
    evidenceKinds: ['condition-expression', 'file', 'rule-object'],
    factTypes: ['condition-expression', 'rule-definition'],
    algorithm: 'explicit-named-rule-container-objects-v1'
  }),
  manifest({
    id: SIGNATURE_AND_EXPORT_ID,
    version: SIGNATURE_AND_EXPORT_VERSION,
    implementationSha256: SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256,
    languages: CLOSED_STRUCTURE_LANGUAGES,
    evidenceKinds: ['export', 'signature'],
    factTypes: ['export', 'signature'],
    algorithm: 'body-free-single-line-signature-and-export-v1'
  }),
  manifest({
    id: REPOSITORY_FILES_ID,
    version: REPOSITORY_FILES_VERSION,
    implementationSha256: REPOSITORY_FILES_IMPLEMENTATION_SHA256,
    languages: [],
    evidenceKinds: ['file'],
    factTypes: ['file-exists'],
    algorithm: 'pinned-git-tree-enumeration-v1'
  }),
  manifest({
    id: REQUIRED_FACT_COVERAGE_ID,
    version: REQUIRED_FACT_COVERAGE_VERSION,
    implementationSha256: REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256,
    languages: [],
    evidenceKinds: [],
    factTypes: [
      'business-meaning', 'change-frequency', 'changed-symbol', 'complexity-metric', 'consumer-dependency',
      'contract-change', 'dependency-degree', 'dependency-edge', 'implementation', 'incident-mapping',
      'interface', 'ownership-concentration', 'protocol-field', 'rule-definition', 'runtime-frequency',
      'runtime-guarantee', 'schema-contract', 'signature'
    ],
    algorithm: 'typed-unavailable-required-coverage-v1'
  }),
  manifest({
    id: SYMBOL_SKELETON_ID,
    version: SYMBOL_SKELETON_VERSION,
    implementationSha256: SYMBOL_SKELETON_IMPLEMENTATION_SHA256,
    languages: [...POLYGLOT_STRUCTURAL_LANGUAGES, 'javascript', 'typescript'].sort(),
    evidenceKinds: ['symbol'],
    factTypes: ['symbol-exists', 'symbol-index'],
    algorithm: 'code-only-exported-top-level-declarations-v2'
  }),
  manifest({
    id: TEST_IDENTITY_ID,
    version: TEST_IDENTITY_VERSION,
    implementationSha256: TEST_IDENTITY_IMPLEMENTATION_SHA256,
    languages: TEST_IDENTITY_LANGUAGES,
    evidenceKinds: ['test-identity'],
    factTypes: ['test-identity'],
    algorithm: 'framework-declared-test-identities-v1'
  })
].map(validateExtractorManifest);

export function validateExtractorManifest(value) {
  assertPlainRecord(value, 'World-model Extractor Manifest');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'id', 'version', 'producer', 'languages', 'evidenceKinds',
      'factTypes', 'inputs', 'outputs', 'failure', 'permissions', 'tests', 'manifestSha256'
    ],
    label: 'World-model Extractor Manifest'
  });
  assertSchemaKind(value, 'world-model-extractor-manifest', 'World-model Extractor Manifest');
  assertString(value.id, 'Extractor id', { pattern: EXTRACTOR_ID_PATTERN });
  assertString(value.version, 'Extractor version', { pattern: SEMVER_PATTERN });
  assertExactKeys(value.producer, {
    required: ['kind', 'implementationSha256', 'parser'], label: 'Extractor producer'
  });
  if (value.producer.kind !== 'deterministic-module') contractFailure("Extractor producer kind must be 'deterministic-module'.");
  assertSha256(value.producer.implementationSha256, 'Extractor implementationSha256');
  assertExactKeys(value.producer.parser, {
    required: ['id', 'version', 'grammarSha256'], label: 'Extractor parser declaration'
  });
  assertString(value.producer.parser.id, 'Extractor parser id', { pattern: EXTRACTOR_ID_PATTERN });
  assertString(value.producer.parser.version, 'Extractor parser version', { pattern: SEMVER_PATTERN });
  assertSha256(value.producer.parser.grammarSha256, 'Extractor parser grammarSha256');
  const reviewedConformance = extractorConformanceDeclaration(value.id);
  if (value.version !== reviewedConformance.extractor.version
      || value.producer.implementationSha256
        !== reviewedConformance.extractor.implementationSha256
      || canonicalJson(value.producer.parser) !== canonicalJson(reviewedConformance.parser)) {
    contractFailure(
      `Extractor '${value.id}@${value.version}' producer is not the exact reviewed conformance subject.`,
      'WMB_EXTRACTOR_CONFORMANCE_FAILED',
      {
        expectedVersion: reviewedConformance.extractor.version,
        expectedImplementationSha256: reviewedConformance.extractor.implementationSha256,
        expectedParser: reviewedConformance.parser
      }
    );
  }
  assertStringArray(value.languages, 'Extractor languages', { sorted: true });
  assertStringArray(value.evidenceKinds, 'Extractor evidenceKinds', { sorted: true });
  value.evidenceKinds.forEach((entry) => assertVocabularyValue('Extractor evidence kind', entry, EVIDENCE_KINDS));
  assertStringArray(value.factTypes, 'Extractor factTypes', { sorted: true });
  value.factTypes.forEach((entry) => assertVocabularyValue('Extractor fact type', entry, FACT_TYPES));
  assertExactKeys(value.inputs, { required: ['sourceManifest', 'scopeManifest'], label: 'Extractor inputs' });
  if (value.inputs.sourceManifest !== 'required' || value.inputs.scopeManifest !== 'required') {
    contractFailure('Registered deterministic extractors require exact source and scope manifests.');
  }
  assertExactKeys(value.outputs, {
    required: ['evidenceCatalogEntries', 'derivationRecords', 'factLedgerEntries'], label: 'Extractor outputs'
  });
  for (const [key, enabled] of Object.entries(value.outputs)) {
    assertBoolean(enabled, `Extractor outputs.${key}`);
    if (!enabled) contractFailure(`Registered extractor output '${key}' cannot be disabled.`);
  }
  assertExactKeys(value.failure, {
    required: ['unsupportedLanguage', 'parseFailure', 'internalError'], label: 'Extractor failure policy'
  });
  for (const [key, allowed] of Object.entries(FAILURE_VALUES)) {
    if (!allowed.includes(value.failure[key])) contractFailure(`Extractor failure.${key} is invalid.`);
  }
  assertExactKeys(value.permissions, { required: ['network', 'model', 'writes'], label: 'Extractor permissions' });
  if (value.permissions.network !== 'none' || value.permissions.model !== 'never'
      || value.permissions.writes !== 'derived-store-only') {
    contractFailure('Deterministic extractor permissions exceed the governed extraction sandbox.');
  }
  assertExactKeys(value.tests, { required: ['conformanceReceiptSha256'], label: 'Extractor tests' });
  assertSha256(value.tests.conformanceReceiptSha256, 'Extractor conformanceReceiptSha256');
  const expectedConformance = extractorConformanceReceiptSha256({
    id: value.id, version: value.version,
    implementationSha256: value.producer.implementationSha256
  });
  if (value.tests.conformanceReceiptSha256 !== expectedConformance) {
    contractFailure(
      `Extractor '${value.id}' is not bound to its reviewed conformance receipt.`,
      'WMB_EXTRACTOR_CONFORMANCE_FAILED'
    );
  }
  assertSha256(value.manifestSha256, 'Extractor manifestSha256');
  assertSelfHash(value, 'manifestSha256', 'World-model Extractor Manifest');
  return value;
}

export function createExtractorRegistry(manifests) {
  if (!Array.isArray(manifests) || !manifests.length) contractFailure('Extractor Registry manifests must be a non-empty array.');
  const sorted = manifests.map((item) => structuredClone(validateExtractorManifest(item)))
    .sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`));
  const keys = sorted.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) contractFailure('Extractor Registry repeats an exact extractor version.');
  return validateExtractorRegistry(sealRecord({
    schemaVersion: 1,
    kind: 'world-model-extractor-registry',
    manifests: sorted
  }, 'registrySha256'));
}

export function validateExtractorRegistry(value) {
  assertPlainRecord(value, 'World-model Extractor Registry');
  assertExactKeys(value, {
    required: ['schemaVersion', 'kind', 'manifests', 'registrySha256'], label: 'World-model Extractor Registry'
  });
  assertSchemaKind(value, 'world-model-extractor-registry', 'World-model Extractor Registry');
  if (!Array.isArray(value.manifests) || !value.manifests.length) contractFailure('Extractor Registry manifests must be a non-empty array.');
  value.manifests.forEach(validateExtractorManifest);
  assertCanonicalOrder(value.manifests, (item) => `${item.id}@${item.version}`, 'Extractor Registry manifests');
  const keys = value.manifests.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) contractFailure('Extractor Registry repeats an exact extractor version.');
  assertSha256(value.registrySha256, 'Extractor Registry registrySha256');
  assertSelfHash(value, 'registrySha256', 'World-model Extractor Registry');
  return value;
}

export function resolveExtractorManifest(registryValue, reference) {
  const registry = validateExtractorRegistry(registryValue);
  const parsed = typeof reference === 'string'
    ? /^(?<id>[a-z][a-z0-9]*(?:-[a-z0-9]+)*)@(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?)$/.exec(reference)?.groups
    : reference;
  if (!parsed) contractFailure(`Extractor reference '${reference}' must bind an exact id and semantic version.`, 'WMB_EXTRACTOR_REFERENCE_INVALID');
  const found = registry.manifests.find((item) => item.id === parsed.id && item.version === parsed.version);
  if (!found) contractFailure(`Extractor '${parsed.id}@${parsed.version}' is not registered.`, 'WMB_EXTRACTOR_NOT_REGISTERED');
  return found;
}

export const BUILTIN_EXTRACTOR_REGISTRY = deepFreeze(createExtractorRegistry(BUILTINS));

/** Require the exact reviewed extractor registry shipped by this build. */
export function assertInstalledExtractorRegistry(value) {
  const registry = validateExtractorRegistry(value);
  if (registry.registrySha256 !== BUILTIN_EXTRACTOR_REGISTRY.registrySha256
      || canonicalJson(registry) !== canonicalJson(BUILTIN_EXTRACTOR_REGISTRY)) {
    contractFailure(
      'World-model Extractor Registry is not the exact reviewed registry installed by this build.',
      'WMB_EXTRACTOR_REGISTRY_NOT_INSTALLED',
      {
        expectedRegistrySha256: BUILTIN_EXTRACTOR_REGISTRY.registrySha256,
        receivedRegistrySha256: registry.registrySha256
      }
    );
  }
  return registry;
}

export const DEFAULT_EXTRACTOR_REFERENCES = Object.freeze([
  `${REPOSITORY_FILES_ID}@${REPOSITORY_FILES_VERSION}`,
  `${LANGUAGE_DETECTION_ID}@${LANGUAGE_DETECTION_VERSION}`,
  `${SYMBOL_SKELETON_ID}@${SYMBOL_SKELETON_VERSION}`,
  `${SIGNATURE_AND_EXPORT_ID}@${SIGNATURE_AND_EXPORT_VERSION}`,
  `${IMPORT_DEPENDENCY_ID}@${IMPORT_DEPENDENCY_VERSION}`,
  `${CALL_REFERENCE_EDGE_ID}@${CALL_REFERENCE_EDGE_VERSION}`,
  `${INTERFACE_CONTRACT_ID}@${INTERFACE_CONTRACT_VERSION}`,
  `${CONFIGURATION_OBJECT_ID}@${CONFIGURATION_OBJECT_VERSION}`,
  `${RULE_DEFINITION_ID}@${RULE_DEFINITION_VERSION}`,
  `${TEST_IDENTITY_ID}@${TEST_IDENTITY_VERSION}`,
  `${CLAUSE_CODE_BINDING_ID}@${CLAUSE_CODE_BINDING_VERSION}`,
  `${CHANGE_REGION_ID}@${CHANGE_REGION_VERSION}`,
  `${OWNERSHIP_MAINTAINER_RECORD_ID}@${OWNERSHIP_MAINTAINER_RECORD_VERSION}`,
  `${RUNTIME_OBSERVATION_IMPORT_ID}@${RUNTIME_OBSERVATION_IMPORT_VERSION}`,
  `${HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID}@${HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_VERSION}`
]);
