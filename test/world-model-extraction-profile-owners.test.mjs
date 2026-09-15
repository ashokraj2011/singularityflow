import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createWmpExtractionConfigurationContract, createWmpParseSchemaContract,
  deriveWmpParseSchemaSha256,
  validateWmpExtractionProfileOwnerDigests,
  WMP_EMPTY_EXTRACTOR_CONFIGURATION, WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
  WMP_SOURCE_NORMALIZATION_CONTRACT, WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256
} from '../src/world-model/history/extraction-profile-owners.mjs';

const digest = (label) => sha256({ fixture: label });

function extractor(overrides = {}) {
  return {
    id: 'repository-files',
    version: 1,
    manifestSha256: digest('manifest'),
    grammarSha256: digest('grammar'),
    parserSha256: null,
    resolverSha256: null,
    implementationSha256: digest('implementation'),
    ...overrides
  };
}

test('parse-schema identity is reconstructed only from its complete retained extractor tuple', () => {
  const extractors = [extractor()];
  const contract = createWmpParseSchemaContract(extractors);
  assert.equal(deriveWmpParseSchemaSha256(extractors), sha256(contract));
  assert.deepEqual(contract.extractors, extractors);
  assert.deepEqual(contract.factLedger, {
    family: 'world-model-fact-ledger', schemaVersion: 1
  });
  assert.equal(Object.hasOwn(contract, 'extractionConfigurationContractSha256'), false);
  assert.equal(
    deriveWmpParseSchemaSha256(extractors),
    'sha256:7540cbf074510ecd8b402aeb330f3b19061c98fdef916e6faecad9a79e4165b0',
    'the frozen v1 parse-schema identity must remain readable across upgrades'
  );

  for (const [field, value] of [
    ['manifestSha256', digest('changed-manifest')],
    ['grammarSha256', digest('changed-grammar')],
    ['parserSha256', digest('changed-parser')],
    ['resolverSha256', digest('changed-resolver')],
    ['implementationSha256', digest('changed-implementation')],
    ['version', 2]
  ]) {
    assert.notEqual(
      deriveWmpParseSchemaSha256([extractor({ [field]: value })]),
      deriveWmpParseSchemaSha256(extractors),
      field
    );
  }
});

test('frozen v1 owns the empty configuration and maps it to every exact extractor consumer', () => {
  const extractors = [extractor()];
  const contract = createWmpExtractionConfigurationContract(extractors);
  const profile = {
    kind: 'wmp/extraction-profile', version: 1, extractors,
    parseSchemaSha256: deriveWmpParseSchemaSha256(extractors),
    normalizationContractSha256: WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
    configurationRefs: []
  };
  assert.equal(
    WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    sha256(WMP_EMPTY_EXTRACTOR_CONFIGURATION)
  );
  assert.equal(
    WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    'sha256:8f21b3460bf0a82772645ac46d78e5aa7e0ababfc22af76561d91b98f9f3ae0b',
    'the frozen v1 empty extractor configuration must remain readable across upgrades'
  );
  assert.deepEqual(contract, {
    kind: 'wmp/extraction-configuration-contract',
    version: 1,
    mode: 'registered-empty',
    configurationSha256: WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    consumers: [{
      id: extractors[0].id,
      version: extractors[0].version,
      manifestSha256: extractors[0].manifestSha256,
      implementationSha256: extractors[0].implementationSha256,
      configurationRef: null
    }]
  });
  assert.equal(validateWmpExtractionProfileOwnerDigests(profile), profile);
  assert.throws(
    () => validateWmpExtractionProfileOwnerDigests({
      ...profile, configurationRefs: [{ sha256: digest('config') }]
    }),
    (error) => error?.code === 'WMP_EXTRACTION_CONFIGURATION_OWNER_UNAVAILABLE'
  );
});

test('parse-schema owner rejects unknown or non-canonical extractor identities', () => {
  assert.throws(
    () => createWmpParseSchemaContract([{ ...extractor(), ambientParser: 'current' }]),
    (error) => error instanceof TypeError && /unknown field 'ambientParser'/.test(error.message)
  );
  assert.throws(
    () => createWmpParseSchemaContract([
      extractor({ id: 'z-parser' }), extractor({ id: 'a-parser' })
    ]),
    (error) => error?.code === 'WMB_CANONICAL_ORDER_INVALID'
  );
});

test('source normalization identity is a fixed semantic contract, not an opaque sentinel', () => {
  assert.equal(
    WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
    sha256(WMP_SOURCE_NORMALIZATION_CONTRACT)
  );
  assert.equal(
    WMP_SOURCE_NORMALIZATION_CONTRACT_SHA256,
    'sha256:c09e4626f9c87804341a0bd32e2e0fcca8906839ded3aa7b1b4f9b9ea2aea77f',
    'the frozen v1 source-normalization identity must remain readable across upgrades'
  );
  assert.deepEqual(WMP_SOURCE_NORMALIZATION_CONTRACT, {
    kind: 'wmp/source-normalization-contract',
    version: 1,
    sourceBytes: 'preserve-exact-bytes',
    fileModes: 'preserve-git-mode',
    repositoryPaths: 'normalized-repository-relative-posix',
    pathOrdering: 'ecmascript-code-unit-lexical',
    lineEndings: 'preserve',
    unicode: 'preserve-code-points'
  });
});
