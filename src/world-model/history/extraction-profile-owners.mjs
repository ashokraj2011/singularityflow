import {
  assertCanonicalOrder, assertExactKeys, assertInteger, assertPlainRecord, assertSha256,
  assertString, contractFailure
} from '../contracts.mjs';
import { deepFreeze, sha256 } from '../canonicalize.mjs';

const TYPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAXIMUM_EXTRACTORS = 1024;

function fail(message, code, details = {}) {
  contractFailure(message, code, details);
}

function assertFrozenContractDigest(value, expectedSha256, label) {
  const actualSha256 = sha256(value);
  if (actualSha256 !== expectedSha256) {
    fail(
      `${label} no longer matches its frozen v1 digest. Introduce a successor contract instead of changing v1.`,
      'WMP_FROZEN_CONTRACT_DIGEST_MISMATCH',
      { expected: expectedSha256, actual: actualSha256 }
    );
  }
}

/**
 * Frozen v1 extraction configuration.
 *
 * The current deterministic adapters accept no caller or repository supplied configuration.
 * Keep that fact as an owned semantic contract instead of repeating an opaque digest in the
 * runner and history reader. A future configured extractor must retain its exact bytes and use a
 * successor contract; it cannot be made compatible by adding a ref to this frozen empty owner.
 */
export const WMP_EMPTY_EXTRACTOR_CONFIGURATION = deepFreeze({
  kind: 'world-model-extractor-configuration',
  version: 1
});

export const WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256 =
  'sha256:8f21b3460bf0a82772645ac46d78e5aa7e0ababfc22af76561d91b98f9f3ae0b';

assertFrozenContractDigest(
  WMP_EMPTY_EXTRACTOR_CONFIGURATION,
  WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
  'WMP empty extractor configuration'
);

function nullableDigest(value, label) {
  if (value !== null) assertSha256(value, label);
}

function validateExtractor(value, index) {
  const label = `WMP Parse Schema extractor ${index}`;
  assertPlainRecord(value, label);
  assertExactKeys(value, {
    required: [
      'id', 'version', 'manifestSha256', 'grammarSha256', 'parserSha256',
      'resolverSha256', 'implementationSha256'
    ],
    label
  });
  assertString(value.id, `${label} id`, { pattern: TYPE_ID });
  if (Buffer.byteLength(value.id, 'utf8') > 128) {
    fail(`${label} id exceeds its 128-byte limit.`, 'WMP_CONTRACT_LIMIT');
  }
  assertInteger(value.version, `${label} version`, { minimum: 1 });
  assertSha256(value.manifestSha256, `${label} manifestSha256`);
  for (const field of [
    'grammarSha256', 'parserSha256', 'resolverSha256', 'implementationSha256'
  ]) nullableDigest(value[field], `${label} ${field}`);
  return value;
}

/**
 * Frozen v1 parse-schema preimage.
 *
 * The Model Binding already retains this complete extractor tuple in its Extraction Profile.
 * Reconstructing the preimage from that tuple gives parseSchemaSha256 an exact semantic owner
 * without inventing an unreferenced durable record or depending on whichever parser is installed
 * when historical bytes are read.
 */
export function createWmpExtractionConfigurationContract(extractors, configurationRefs = []) {
  if (!Array.isArray(extractors) || extractors.length > MAXIMUM_EXTRACTORS) {
    fail(`WMP extraction-configuration consumers must contain at most ${MAXIMUM_EXTRACTORS} entries.`,
      'WMP_CONTRACT_LIMIT');
  }
  extractors.forEach(validateExtractor);
  assertCanonicalOrder(
    extractors,
    (entry) => `${entry.id}\0${String(entry.version).padStart(12, '0')}`,
    'WMP extraction-configuration consumers'
  );
  if (!Array.isArray(configurationRefs)) {
    fail('WMP extraction-configuration refs must be an array.',
      'WMP_EXTRACTION_CONFIGURATION_OWNER_UNAVAILABLE');
  }
  if (configurationRefs.length) {
    fail(
      'Configured extraction requires a successor owner that binds exact retained bytes to each consuming extractor.',
      'WMP_EXTRACTION_CONFIGURATION_OWNER_UNAVAILABLE',
      { configurationRefs: configurationRefs.length }
    );
  }
  return deepFreeze({
    kind: 'wmp/extraction-configuration-contract',
    version: 1,
    mode: 'registered-empty',
    configurationSha256: WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    consumers: extractors.map((entry) => ({
      id: entry.id,
      version: entry.version,
      manifestSha256: entry.manifestSha256,
      implementationSha256: entry.implementationSha256,
      configurationRef: null
    }))
  });
}

export function deriveWmpExtractionConfigurationContractSha256(
  extractors, configurationRefs = []
) {
  return sha256(createWmpExtractionConfigurationContract(extractors, configurationRefs));
}

export function createWmpParseSchemaContract(extractors) {
  if (!Array.isArray(extractors) || extractors.length > MAXIMUM_EXTRACTORS) {
    fail(`WMP Parse Schema extractors must contain at most ${MAXIMUM_EXTRACTORS} entries.`,
      'WMP_CONTRACT_LIMIT');
  }
  extractors.forEach(validateExtractor);
  assertCanonicalOrder(
    extractors,
    (entry) => `${entry.id}\0${String(entry.version).padStart(12, '0')}`,
    'WMP Parse Schema extractors'
  );
  const identities = extractors.map((entry) => `${entry.id}@${entry.version}`);
  if (new Set(identities).size !== identities.length) {
    fail('WMP Parse Schema repeats an extractor identity.', 'WMP_CONTRACT_INVALID');
  }
  return deepFreeze({
    kind: 'wmp/parse-schema-contract',
    version: 1,
    canonicalization: 'wmb-canonical-json-v1',
    evidenceCatalog: {
      family: 'world-model-evidence-catalog', schemaVersion: 1
    },
    derivationCatalog: {
      family: 'world-model-derivation-catalog', schemaVersion: 1
    },
    factLedger: {
      family: 'world-model-fact-ledger', schemaVersion: 1
    },
    extractors: structuredClone(extractors)
  });
}

export function deriveWmpParseSchemaSha256(extractors) {
  return sha256(createWmpParseSchemaContract(extractors));
}

/** Exact source identity normalization used by frozen WMP Model Binding v1. */
export const WMP_SOURCE_NORMALIZATION_CONTRACT = deepFreeze({
  kind: 'wmp/source-normalization-contract',
  version: 1,
  sourceBytes: 'preserve-exact-bytes',
  fileModes: 'preserve-git-mode',
  repositoryPaths: 'normalized-repository-relative-posix',
  pathOrdering: 'ecmascript-code-unit-lexical',
  lineEndings: 'preserve',
  unicode: 'preserve-code-points'
});

export const WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256 =
  'sha256:c09e4626f9c87804341a0bd32e2e0fcca8906839ded3aa7b1b4f9b9ea2aea77f';

assertFrozenContractDigest(
  WMP_SOURCE_NORMALIZATION_CONTRACT,
  WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
  'WMP source-normalization contract'
);

export function validateWmpExtractionProfileOwnerDigests(profile) {
  // Constructing this contract is also the frozen-v1 admission check for configurationRefs. It
  // proves which exact extractor consumes the registered empty configuration and refuses any
  // configured profile before its bytes can influence a Model Key without an owner.
  createWmpExtractionConfigurationContract(profile.extractors, profile.configurationRefs);
  const expectedParseSchemaSha256 = deriveWmpParseSchemaSha256(profile.extractors);
  if (profile.parseSchemaSha256 !== expectedParseSchemaSha256) {
    fail('WMP Extraction Profile parseSchemaSha256 has no matching frozen parse-schema contract.',
      'WMP_PARSE_SCHEMA_MISMATCH', {
        expected: expectedParseSchemaSha256,
        received: profile.parseSchemaSha256 ?? null
      });
  }
  if (profile.normalizationContractSha256 !== WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256) {
    fail(
      'WMP Extraction Profile normalizationContractSha256 has no matching frozen source-normalization contract.',
      'WMP_NORMALIZATION_CONTRACT_MISMATCH', {
        expected: WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
        received: profile.normalizationContractSha256 ?? null
      }
    );
  }
  return profile;
}
