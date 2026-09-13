import assert from 'node:assert/strict';
import test from 'node:test';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { canonicalJson, sealRecord, sha256 } from '../src/world-model/canonicalize.mjs';
import {
  allocateDerivationIdentities, validateDerivationCatalog, validateHistoricalDerivationCatalog
} from '../src/world-model/extract/derivation-catalog.mjs';
import {
  validateFactLedger, validateHistoricalFactLedger
} from '../src/world-model/extract/fact-ledger.mjs';
import { parseExactRetainedObject } from '../src/world-model/history/retained-object.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget
} from '../src/world-model/plan.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, validateExtractorManifest, validateExtractorRegistry
} from '../src/world-model/registry/extractors.mjs';
import { resolveBuiltInViewContract } from '../src/world-model/registry/views.mjs';
import {
  WMB_V4_CANDIDATE_SCHEMA_SHA256, WMB_V4_VALIDATION_CHECK_IDS,
  WMB_V4_VALIDATOR_SHA256
} from '../src/world-model/validate/candidate.mjs';

const digest = (label) => sha256({ fixture: label });

function retained(record, role, family) {
  const bytes = Buffer.from(canonicalJson(record), 'utf8');
  return Object.freeze({
    ref: Object.freeze({
      role,
      family,
      mediaType: 'application/json',
      sha256: sha256(bytes),
      bytes: bytes.length
    }),
    bytes
  });
}

function validationReceipt(contract) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-view-validation-receipt'),
    kind: 'world-model-view-validation-receipt',
    viewId: contract.id,
    viewVersion: contract.version,
    candidateSha256: digest('candidate'),
    candidateSchemaSha256: WMB_V4_CANDIDATE_SCHEMA_SHA256,
    viewSpecSha256: contract.contractSha256,
    factLedgerSha256: digest('fact-ledger'),
    scopeSha256: digest('scope'),
    checks: WMB_V4_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pass' })),
    status: 'passed',
    validatorSha256: WMB_V4_VALIDATOR_SHA256
  };
  return sealRecord(base, 'receiptSha256');
}

function ownedFixtures() {
  const contract = resolveBuiltInViewContract('dev.impact@4');
  return Object.freeze([
    Object.freeze({
      role: 'extractor-registry',
      family: 'world-model-extractor-registry',
      record: BUILTIN_EXTRACTOR_REGISTRY,
      hashField: 'registrySha256'
    }),
    Object.freeze({
      role: 'consumer-profile',
      family: 'world-model-consumer-profile',
      record: createWorldModelConsumerProfile(),
      hashField: 'profileSha256'
    }),
    Object.freeze({
      role: 'output-budget',
      family: 'world-model-output-budget',
      record: createWorldModelOutputBudget([contract]),
      hashField: 'budgetSha256'
    }),
    Object.freeze({
      role: 'validator-receipt',
      family: 'world-model-view-validation-receipt',
      record: validationReceipt(contract),
      hashField: 'receiptSha256'
    })
  ]);
}

test('retained-object adapters admit exact bytes from each installed semantic owner', () => {
  for (const { role, family, record } of ownedFixtures()) {
    const object = retained(record, role, family);
    assert.deepEqual(parseExactRetainedObject(object.ref, object.bytes), record, role);
  }
});

test('retained extractor owners read historical identities without admitting them for execution', () => {
  const historicalManifest = structuredClone(BUILTIN_EXTRACTOR_REGISTRY.manifests[0]);
  historicalManifest.version = '99.0.0';
  historicalManifest.producer.implementationSha256 = digest('historical-implementation');
  historicalManifest.producer.parser = {
    ...historicalManifest.producer.parser,
    version: '99.0.0',
    grammarSha256: digest('historical-grammar')
  };
  historicalManifest.tests.conformanceReceiptSha256 = digest('historical-conformance-receipt');
  const sealedManifest = sealRecord(historicalManifest, 'manifestSha256');
  const historicalRegistry = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-extractor-registry'),
    kind: 'world-model-extractor-registry',
    manifests: [sealedManifest]
  }, 'registrySha256');

  const manifestObject = retained(
    sealedManifest, 'extractor-manifest', 'world-model-extractor-manifest'
  );
  const registryObject = retained(
    historicalRegistry, 'extractor-registry', 'world-model-extractor-registry'
  );
  assert.deepEqual(
    parseExactRetainedObject(manifestObject.ref, manifestObject.bytes), sealedManifest
  );
  assert.deepEqual(
    parseExactRetainedObject(registryObject.ref, registryObject.bytes), historicalRegistry
  );

  assert.throws(
    () => validateExtractorManifest(sealedManifest),
    (error) => error?.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
  assert.throws(
    () => validateExtractorRegistry(historicalRegistry),
    (error) => error?.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );

  const sourceManifestSha256 = digest('historical-source-manifest');
  const scopeManifestSha256 = digest('historical-scope-manifest');
  const factLedger = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-fact-ledger'),
    kind: 'world-model-fact-ledger',
    sourceManifestSha256,
    scopeManifestSha256,
    extractorRegistrySha256: historicalRegistry.registrySha256,
    facts: []
  }, 'ledgerSha256');
  const derivationIdentity = {
    extractor: {
      id: sealedManifest.id,
      version: sealedManifest.version,
      implementationSha256: sealedManifest.producer.implementationSha256
    },
    sourceManifestSha256,
    scopeManifestSha256,
    configurationSha256: digest('historical-extraction-configuration'),
    grammarSha256: sealedManifest.producer.parser.grammarSha256,
    dependencyManifestSha256: sha256({
      extractorRegistrySha256: historicalRegistry.registrySha256,
      extractorManifestSha256: sealedManifest.manifestSha256
    }),
    inputEvidenceIds: []
  };
  const derivationId = allocateDerivationIdentities([derivationIdentity])[0].id;
  const derivationCatalog = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-derivation-catalog'),
    kind: 'world-model-derivation-catalog',
    derivations: [sealRecord({
      schemaVersion: currentSchemaVersion('world-model-derivation'),
      kind: 'world-model-derivation',
      id: derivationId,
      ...derivationIdentity,
      outputFactIds: [],
      status: 'complete'
    }, 'derivationSha256')]
  }, 'catalogSha256');

  assert.equal(
    validateHistoricalFactLedger(factLedger, { extractorRegistry: historicalRegistry }),
    factLedger
  );
  assert.equal(validateHistoricalDerivationCatalog(derivationCatalog, {
    factLedger, extractorRegistry: historicalRegistry
  }), derivationCatalog);
  assert.throws(
    () => validateFactLedger(factLedger, { extractorRegistry: historicalRegistry }),
    (error) => error?.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
  assert.throws(
    () => validateDerivationCatalog(derivationCatalog, {
      factLedger, extractorRegistry: historicalRegistry
    }),
    (error) => error?.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
});

test('the validation-receipt owner preserves the registered historical detail field', () => {
  const contract = resolveBuiltInViewContract('dev.impact@4');
  const receipt = validationReceipt(contract);
  const detailed = structuredClone(receipt);
  detailed.checks[0].detail = 'Validated by the retained v1 check implementation.';
  const resealed = sealRecord(detailed, 'receiptSha256');
  const object = retained(
    resealed, 'validator-receipt', 'world-model-view-validation-receipt'
  );
  assert.deepEqual(parseExactRetainedObject(object.ref, object.bytes), resealed);
});

test('retained-object adapters reject self-consistent but semantically corrupt owner records', () => {
  const mutations = {
    'extractor-registry': (record) => ({ ...record, kind: 'world-model-extractor-manifest' }),
    'consumer-profile': (record) => ({ ...record, consumer: 'unregistered-consumer' }),
    'output-budget': (record) => ({ ...record, overflowPolicy: ['refuse'] }),
    'validator-receipt': (record) => ({ ...record, status: 'failed' })
  };
  for (const { role, family, record, hashField } of ownedFixtures()) {
    const corrupted = sealRecord(mutations[role](structuredClone(record)), hashField);
    const object = retained(corrupted, role, family);
    assert.throws(
      () => parseExactRetainedObject(object.ref, object.bytes),
      (error) => error?.code === 'WMP_INTEGRITY_FAILED'
        && error?.details?.role === role
        && error?.details?.family === family,
      role
    );
  }
});

test('retained-object adapters reject valid owner bytes under a false semantic role', () => {
  for (const { role, family, record } of ownedFixtures()) {
    const object = retained(record, 'unrelated-authority', family);
    assert.throws(
      () => parseExactRetainedObject(object.ref, object.bytes),
      (error) => error?.code === 'WMP_OBJECT_ROLE_MISMATCH'
        && error?.details?.expectedRole === role
        && error?.details?.receivedRole === 'unrelated-authority',
      role
    );
  }
});

test('unimplemented authority roles cannot borrow a registered semantic family', () => {
  const contract = resolveBuiltInViewContract('dev.impact@4');
  for (const role of [
    'admission-proof', 'adoption-authorization', 'origin-authority',
    'publication-receipt', 'renderer-contract', 'source-authority',
    'target-authority', 'tokenizer', 'validator-contract'
  ]) {
    const object = retained(contract, role, 'world-model-view-contract');
    assert.throws(
      () => parseExactRetainedObject(object.ref, object.bytes),
      (error) => error?.code === 'WMP_OBJECT_OWNER_UNAVAILABLE'
        && error?.details?.role === role,
      role
    );
  }
});
