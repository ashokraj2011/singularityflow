import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalJson, collisionSafeIds, sealRecord, sha256
} from '../src/world-model/canonicalize.mjs';
import {
  assertInstalledExtractorRegistry, BUILTIN_EXTRACTOR_REGISTRY, resolveExtractorManifest,
  validateExtractorManifest, validateExtractorRegistry
} from '../src/world-model/registry/extractors.mjs';
import {
  BUILTIN_EXTRACTOR_CONFORMANCE_IDS, extractorConformanceDeclaration,
  extractorConformanceReceiptSha256, verifyBuiltInExtractorConformance
} from '../src/world-model/registry/extractor-conformance.mjs';
import {
  assertInstalledViewRegistry, BUILTIN_VIEW_REFERENCES, BUILTIN_VIEW_REGISTRY,
  resolveBuiltInViewContract, resolveViewContract, validateViewRegistry
} from '../src/world-model/registry/views.mjs';
import { planWorldModelV4 } from '../src/world-model/plan.mjs';

test('v4 View Registry is closed, dotted, exact-versioned, body-free, and self-hashed', () => {
  assert.deepEqual(BUILTIN_VIEW_REFERENCES, [
    'arch.contracts@4', 'biz.rules@4', 'dev.hotspots@4', 'dev.impact@4'
  ]);
  for (const reference of BUILTIN_VIEW_REFERENCES) {
    const contract = resolveBuiltInViewContract(reference);
    assert.match(contract.id, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/);
    assert.equal(contract.version, 4);
    assert.equal(contract.bodyAccess.allowed, false);
    assert.equal(contract.bodyAccess.maximumBytes, 0);
    assert.equal(contract.crossViewReferences.allowed, false);
    assert.equal(contract.narrative.factualUnitsRequireFactRefs, true);
  }
  assert.throws(
    () => resolveViewContract(BUILTIN_VIEW_REGISTRY, 'dev.impact@3'),
    (error) => error.code === 'WMB_VIEW_NOT_REGISTERED'
  );
  assert.throws(
    () => resolveViewContract(BUILTIN_VIEW_REGISTRY, 'dev-impact@4'),
    (error) => error.code === 'WMB_VIEW_REFERENCE_INVALID'
  );

  const tampered = structuredClone(BUILTIN_VIEW_REGISTRY);
  tampered.contracts.at(-1).title = 'Unregistered title mutation';
  assert.throws(() => validateViewRegistry(tampered), (error) => error.code === 'WMB_RECORD_HASH_MISMATCH');
  const extra = structuredClone(BUILTIN_VIEW_REGISTRY);
  extra.unregistered = true;
  assert.throws(() => validateViewRegistry(extra), (error) => error.code === 'WMB_CONTRACT_FIELD_UNKNOWN');
});

test('Extractor Registry is closed and binds deterministic no-network/no-model implementations', () => {
  for (const manifest of BUILTIN_EXTRACTOR_REGISTRY.manifests) {
    assert.equal(resolveExtractorManifest(
      BUILTIN_EXTRACTOR_REGISTRY, `${manifest.id}@${manifest.version}`
    ).manifestSha256, manifest.manifestSha256);
    assert.equal(manifest.producer.kind, 'deterministic-module');
    assert.match(manifest.producer.implementationSha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(manifest.producer.parser.version, /^\d+\.\d+\.\d+$/);
    assert.match(manifest.producer.parser.grammarSha256, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(manifest.permissions, { network: 'none', model: 'never', writes: 'derived-store-only' });
  }
  assert.throws(
    () => resolveExtractorManifest(BUILTIN_EXTRACTOR_REGISTRY, 'model-guesser@1.0.0'),
    (error) => error.code === 'WMB_EXTRACTOR_NOT_REGISTERED'
  );
  const tampered = structuredClone(BUILTIN_EXTRACTOR_REGISTRY);
  tampered.manifests[0].permissions.model = 'optional';
  assert.throws(() => validateExtractorRegistry(tampered));
});

test('governed registry authority rejects coherently resealed same-version substitutes', () => {
  const viewRegistry = structuredClone(BUILTIN_VIEW_REGISTRY);
  const viewContract = viewRegistry.contracts.find((entry) => entry.id === 'dev.impact');
  viewContract.title = 'Coherently resealed but unreviewed impact view';
  delete viewContract.contractSha256;
  Object.assign(viewContract, sealRecord(viewContract, 'contractSha256'));
  delete viewRegistry.registrySha256;
  const resealedViews = sealRecord(viewRegistry, 'registrySha256');
  assert.equal(validateViewRegistry(resealedViews).registrySha256, resealedViews.registrySha256);
  assert.throws(
    () => assertInstalledViewRegistry(resealedViews),
    (error) => error.code === 'WMB_VIEW_REGISTRY_NOT_INSTALLED'
  );
  assert.throws(
    () => planWorldModelV4('/repository-is-not-opened', {
      views: ['dev.impact'], viewRegistry: resealedViews
    }),
    (error) => error.code === 'WMB_VIEW_REGISTRY_NOT_INSTALLED'
  );

  const extractorRegistry = structuredClone(BUILTIN_EXTRACTOR_REGISTRY);
  const extractor = extractorRegistry.manifests.find((entry) => entry.languages.length > 1);
  extractor.languages = extractor.languages.slice(1);
  delete extractor.manifestSha256;
  Object.assign(extractor, sealRecord(extractor, 'manifestSha256'));
  delete extractorRegistry.registrySha256;
  const resealedExtractors = sealRecord(extractorRegistry, 'registrySha256');
  assert.equal(
    validateExtractorRegistry(resealedExtractors).registrySha256,
    resealedExtractors.registrySha256
  );
  assert.throws(
    () => assertInstalledExtractorRegistry(resealedExtractors),
    (error) => error.code === 'WMB_EXTRACTOR_REGISTRY_NOT_INSTALLED'
  );
  assert.throws(
    () => planWorldModelV4('/repository-is-not-opened', {
      views: ['dev.impact'], extractorRegistry: resealedExtractors
    }),
    (error) => error.code === 'WMB_EXTRACTOR_REGISTRY_NOT_INSTALLED'
  );
});

test('every registered extractor has an executable reviewed fixture receipt', () => {
  assert.deepEqual(verifyBuiltInExtractorConformance(), BUILTIN_EXTRACTOR_CONFORMANCE_IDS);
  assert.deepEqual(
    BUILTIN_EXTRACTOR_REGISTRY.manifests.map((manifest) => manifest.id).sort(),
    BUILTIN_EXTRACTOR_CONFORMANCE_IDS
  );
  const tampered = structuredClone(BUILTIN_EXTRACTOR_REGISTRY);
  tampered.manifests[0].tests.conformanceReceiptSha256 = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => validateExtractorRegistry(tampered),
    (error) => error.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
  for (const manifest of BUILTIN_EXTRACTOR_REGISTRY.manifests) {
    const reviewed = extractorConformanceDeclaration(manifest.id);
    assert.equal(manifest.version, reviewed.extractor.version);
    assert.equal(
      manifest.producer.implementationSha256,
      reviewed.extractor.implementationSha256
    );
    assert.deepEqual(manifest.producer.parser, reviewed.parser);
    assert.equal(manifest.tests.conformanceReceiptSha256, extractorConformanceReceiptSha256({
      id: manifest.id,
      version: manifest.version,
      implementationSha256: manifest.producer.implementationSha256
    }));
  }
});

test('reviewed extractor identity and parser cannot be replaced by a self-asserted receipt', () => {
  const original = BUILTIN_EXTRACTOR_REGISTRY.manifests[0];
  const parserCore = structuredClone(original);
  parserCore.producer.parser = {
    id: 'forged-parser',
    version: '9.9.9',
    grammarSha256: sha256({ forged: 'grammar' })
  };
  delete parserCore.manifestSha256;
  assert.throws(
    () => validateExtractorManifest(sealRecord(parserCore, 'manifestSha256')),
    (error) => error.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );

  const forgedImplementation = sha256({ forged: 'implementation' });
  assert.throws(
    () => extractorConformanceReceiptSha256({
      id: original.id,
      version: original.version,
      implementationSha256: forgedImplementation
    }),
    (error) => error.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
  const implementationCore = structuredClone(original);
  implementationCore.producer.implementationSha256 = forgedImplementation;
  delete implementationCore.manifestSha256;
  assert.throws(
    () => validateExtractorManifest(sealRecord(implementationCore, 'manifestSha256')),
    (error) => error.code === 'WMB_EXTRACTOR_CONFORMANCE_FAILED'
  );
});

test('canonical identities reject non-JSON inputs and extend colliding visible prefixes', () => {
  assert.throws(() => canonicalJson({ invalid: undefined }), /undefined/);
  const first = `sha256:${'a'.repeat(16)}0${'1'.repeat(47)}`;
  const second = `sha256:${'a'.repeat(16)}f${'2'.repeat(47)}`;
  const ids = collisionSafeIds([second, first], { prefix: 'EV-' });
  assert.equal(ids.get(first.slice(7)), `EV-${'a'.repeat(16)}0`);
  assert.equal(ids.get(second.slice(7)), `EV-${'a'.repeat(16)}f`);
});
