import { reviewedImplementationSourceManifest } from '../source-digest.mjs';

const manifest = reviewedImplementationSourceManifest({
  id: 'persisted-grounding-composer-v1',
  version: 1,
  entries: ['src/world-model/history/persisted-grounding-composer-v1.mjs'],
  reviewedFiles: ['src/world-model/history/persisted-grounding-composer-v1.mjs'],
  reviewedBuiltins: ['node:crypto'],
  reviewedPackages: [],
  resources: []
});

const expected = Object.freeze({
  sourceSha256: 'sha256:5ce86df9ac509b60b3a4feab35cd661fdc6b232fcd358322fb539b61e601f0dd',
  manifestSha256: 'sha256:e0d2dcf3771a5a7118af47f5bf2e8fe96020f82dcde54105620eee322ae9dc34'
});

if (manifest.sourceSha256 !== expected.sourceSha256
    || manifest.manifestSha256 !== expected.manifestSha256) {
  const error = new Error(
    "Frozen persisted-grounding implementation 'persisted-grounding-composer-v1' changed without a new version."
  );
  error.code = 'WMP_FROZEN_IMPLEMENTATION_DRIFT';
  error.details = { expected, received: {
    sourceSha256: manifest.sourceSha256,
    manifestSha256: manifest.manifestSha256
  } };
  throw error;
}

export const PERSISTED_GROUNDING_COMPOSER_V1_SOURCE_MANIFEST = manifest;
