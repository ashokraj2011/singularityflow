import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyRevisionFeedback, revisionImplementationSha256
} from '../src/revision/product-context.mjs';

const criteria = [{ id: 'PAY-142:AC-001', text: 'Cache duration must be 60 seconds.' }];

test('REV disposition distinguishes implementation correction from approved-intent change', () => {
  assert.equal(classifyRevisionFeedback(
    'Fix the implementation because it does not cache for the required 60 seconds.', null, criteria
  ).result, 'implementation-change');
  assert.deepEqual(classifyRevisionFeedback(
    'Change the cache from 60 seconds to 5 minutes instead.', null, criteria
  ), { result: 'specification-change', predicateId: 'structured-value-conflict', human: false });
  assert.equal(classifyRevisionFeedback(
    'Set the timeout to 5 seconds.', null, []
  ).result, 'ambiguous');
});

test('REV explicit disposition cannot override direct deterministic conflict evidence', () => {
  assert.throws(() => classifyRevisionFeedback(
    'Amend the acceptance criterion to make caching optional.', 'implementation-change', criteria
  ), { code: 'REV_DISPOSITION_CONFLICT' });
  assert.equal(classifyRevisionFeedback(
    'This may be a new behavior; treat it as an implementation correction.',
    'implementation-change', criteria
  ).result, 'implementation-change');
});

test('REV producer identity changes when any shipped runtime authority module changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-revision-producer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src', 'revision'), { recursive: true });
  await mkdir(path.join(root, 'schemas'), { recursive: true });
  await writeFile(path.join(root, 'src', 'revision', 'current-context.mjs'),
    'export const savedState = 1;\n');
  await writeFile(path.join(root, 'src', 'revision', 'runtime.mjs'),
    'export const activation = true;\n');
  await writeFile(path.join(root, 'src', 'revision', 'producer-lock.json'), JSON.stringify({
    schemaVersion: 1,
    algorithm: 'sha256',
    packageLockSha256: 'sha256:f25e7d293543b03d1a2cab20f9827739fd644af8400382bc4f6a5124e46aead0'
  }));
  await writeFile(path.join(root, 'schemas', 'revision-feedback.schema.json'), '{}\n');
  await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

  const before = revisionImplementationSha256(root);
  await writeFile(path.join(root, 'src', 'revision', 'current-context.mjs'),
    'export const savedState = 2;\n');
  const afterAuthorityChange = revisionImplementationSha256(root);
  assert.notEqual(afterAuthorityChange, before);

  await rm(path.join(root, 'package-lock.json'));
  assert.equal(revisionImplementationSha256(root), afterAuthorityChange,
    'a packaged install uses the same shipped lock authority without the npm-omitted lockfile');

  await writeFile(path.join(root, 'package-lock.json'),
    '{"lockfileVersion":3,"packages":{"node_modules/example":{"version":"2"}}}\n');
  assert.throws(() => revisionImplementationSha256(root),
    /dependency authority does not match package-lock\.json/u);
});
