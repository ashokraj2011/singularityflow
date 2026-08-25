import test from 'node:test';
import assert from 'node:assert/strict';

import { approvedReferenceAlreadyCaptured } from '../src/worldmodel.mjs';

test('approved reference previews deduplicate only an exact captured path and raw hash', () => {
  const inputs = [{
    status: 'captured',
    repositoryPath: 'singularity/work-items/WORK-1/artifacts/intake/intake.md',
    sha256: 'a'.repeat(64)
  }];
  assert.equal(approvedReferenceAlreadyCaptured({
    path: inputs[0].repositoryPath, rawSha256: `sha256:${'a'.repeat(64)}`
  }, inputs), true);
  assert.equal(approvedReferenceAlreadyCaptured({
    path: inputs[0].repositoryPath, rawSha256: 'b'.repeat(64)
  }, inputs), false);
  assert.equal(approvedReferenceAlreadyCaptured({
    path: 'singularity/work-items/WORK-1/artifacts/design/design.md',
    rawSha256: 'a'.repeat(64)
  }, inputs), false);
  assert.equal(approvedReferenceAlreadyCaptured({
    path: inputs[0].repositoryPath, rawSha256: 'a'.repeat(64)
  }, [{ ...inputs[0], status: 'hash_mismatch' }]), false);
});
