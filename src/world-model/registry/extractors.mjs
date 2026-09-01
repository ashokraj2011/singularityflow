import { canonicalJson, compareText, deepFreeze, sealRecord } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  assertBoolean, assertCanonicalOrder, assertExactKeys, assertPlainRecord, assertSchemaKind,
  assertSelfHash, assertSha256, assertString, assertStringArray, contractFailure
} from '../contracts.mjs';
import { EVIDENCE_KINDS, FACT_TYPES, assertVocabularyValue } from '../vocabularies.mjs';
import {
  IMPORT_DEPENDENCY_ID, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, IMPORT_DEPENDENCY_VERSION,
  LANGUAGE_DETECTION_ID, LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, LANGUAGE_DETECTION_VERSION,
  REPOSITORY_FILES_ID, REPOSITORY_FILES_IMPLEMENTATION_SHA256, REPOSITORY_FILES_VERSION,
  REQUIRED_FACT_COVERAGE_ID, REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, REQUIRED_FACT_COVERAGE_VERSION,
  SYMBOL_SKELETON_ID, SYMBOL_SKELETON_IMPLEMENTATION_SHA256, SYMBOL_SKELETON_VERSION
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
    id: IMPORT_DEPENDENCY_ID,
    version: IMPORT_DEPENDENCY_VERSION,
    implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256,
    languages: ['javascript', 'typescript'],
    evidenceKinds: ['dependency-edge', 'import'],
    factTypes: ['dependency-analysis', 'dependency-edge', 'import-dependency'],
    algorithm: 'code-and-literal-aware-imports-and-exact-local-resolution-v2'
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
    languages: ['javascript', 'typescript'],
    evidenceKinds: ['symbol'],
    factTypes: ['symbol-exists', 'symbol-index'],
    algorithm: 'code-only-exported-top-level-declarations-v2'
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
export const DEFAULT_EXTRACTOR_REFERENCES = Object.freeze([
  `${REPOSITORY_FILES_ID}@${REPOSITORY_FILES_VERSION}`,
  `${LANGUAGE_DETECTION_ID}@${LANGUAGE_DETECTION_VERSION}`,
  `${SYMBOL_SKELETON_ID}@${SYMBOL_SKELETON_VERSION}`,
  `${IMPORT_DEPENDENCY_ID}@${IMPORT_DEPENDENCY_VERSION}`
]);
