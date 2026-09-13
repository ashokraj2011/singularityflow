import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { sealRecord } from '../src/world-model/canonicalize.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, createExtractorRegistry,
  MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS, validateHistoricalExtractorRegistry
} from '../src/world-model/registry/extractors.mjs';

function historicalManifest(index) {
  const manifest = structuredClone(BUILTIN_EXTRACTOR_REGISTRY.manifests[0]);
  manifest.id = `fixture-${String(index).padStart(4, '0')}`;
  delete manifest.manifestSha256;
  return sealRecord(manifest, 'manifestSha256');
}

test('extractor registry schema and runtime share the 1024-manifest ceiling', () => {
  const schema = JSON.parse(readFileSync(
    new URL('../schemas/world-model-extractor-registry.schema.json', import.meta.url),
    'utf8'
  ));
  assert.equal(schema.properties.manifests.maxItems, MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS);

  const manifests = Array.from(
    { length: MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS },
    (_, index) => historicalManifest(index)
  );
  const boundary = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-extractor-registry'),
    kind: 'world-model-extractor-registry',
    manifests
  }, 'registrySha256');
  assert.equal(validateHistoricalExtractorRegistry(boundary), boundary);
});

test('current and historical registry entry points refuse oversized manifest arrays first', () => {
  const oversized = Array.from(
    { length: MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS + 1 },
    () => BUILTIN_EXTRACTOR_REGISTRY.manifests[0]
  );
  assert.throws(
    () => createExtractorRegistry(oversized),
    (error) => error?.code === 'WMB_EXTRACTOR_REGISTRY_LIMIT_EXCEEDED'
      && error?.details?.maximum === MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS
      && error?.details?.received === MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS + 1
  );

  const retained = sealRecord({
    schemaVersion: currentSchemaVersion('world-model-extractor-registry'),
    kind: 'world-model-extractor-registry',
    manifests: oversized
  }, 'registrySha256');
  assert.throws(
    () => validateHistoricalExtractorRegistry(retained),
    (error) => error?.code === 'WMB_EXTRACTOR_REGISTRY_LIMIT_EXCEEDED'
      && error?.details?.maximum === MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS
      && error?.details?.received === MAXIMUM_EXTRACTOR_REGISTRY_MANIFESTS + 1
  );
});
