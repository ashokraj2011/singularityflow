import { reviewedImplementationSourceManifest } from '../source-digest.mjs';

function assertPinned(manifest, expected) {
  if (manifest.sourceSha256 !== expected.sourceSha256
      || manifest.manifestSha256 !== expected.manifestSha256) {
    const error = new Error(
      `Frozen persisted-view implementation '${manifest.id}' changed without a new version.`
    );
    error.code = 'WMP_FROZEN_IMPLEMENTATION_DRIFT';
    error.details = {
      id: manifest.id,
      expected,
      received: {
        sourceSha256: manifest.sourceSha256,
        manifestSha256: manifest.manifestSha256
      }
    };
    throw error;
  }
  return manifest;
}

// Historical v1 execution is deliberately isolated from active registries, migrations,
// configuration, platform helpers, and generic schemas. Its exact executable closure is small
// enough to retain indefinitely and cannot drift when unrelated product infrastructure advances.
const RENDERER_V1_MODULES = Object.freeze([
  'src/world-model/materialize/persisted-overview-renderer-v1.mjs'
]);

const V1_BUILTINS = Object.freeze(['node:crypto']);

export const PERSISTED_OVERVIEW_RENDERER_V1_SOURCE_MANIFEST = assertPinned(
  reviewedImplementationSourceManifest({
    id: 'persisted-overview-renderer-v1',
    version: 1,
    entries: ['src/world-model/materialize/persisted-overview-renderer-v1.mjs'],
    reviewedFiles: RENDERER_V1_MODULES,
    reviewedBuiltins: V1_BUILTINS,
    reviewedPackages: [],
    resources: []
  }), {
    sourceSha256: 'sha256:ade30351c6ec2e1cf79752c983666dfd9e3de9b2f6edc17281826e676eeb0d38',
    manifestSha256: 'sha256:07dc8922991423f8fbaddca027208c91892f039993c4c552ccdddfbf5fa10b42'
  }
);

export const PERSISTED_OVERVIEW_VALIDATOR_V1_SOURCE_MANIFEST = assertPinned(
  reviewedImplementationSourceManifest({
    id: 'persisted-overview-validator-v1',
    version: 1,
    entries: ['src/world-model/history/persisted-overview-validator-v1.mjs'],
    reviewedFiles: [
      'src/world-model/history/persisted-overview-validator-v1.mjs',
      ...RENDERER_V1_MODULES
    ],
    reviewedBuiltins: V1_BUILTINS,
    reviewedPackages: [],
    resources: []
  }), {
    sourceSha256: 'sha256:fa733655458ae841f4c5f85b944b37afa16d285295e57e5719cb337a11798742',
    manifestSha256: 'sha256:ecad005812eba668b0c1a59fd71f8d79d803c7e87998270c561992c9018bf70c'
  }
);
