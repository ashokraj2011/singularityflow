import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  createWmpParseSchemaContract, deriveWmpParseSchemaSha256,
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
