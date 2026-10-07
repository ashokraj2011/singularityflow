import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../src/package-root.mjs';

import {
  implementationSourceSha256, WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256,
  WMB_V4_KERNEL_SOURCE_SHA256
} from '../src/world-model/source-digest.mjs';

test('WMB implementation identities hash exact bytes under installation-independent labels', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wmb-source-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  for (const installation of [left, right]) {
    await mkdir(path.join(installation, 'kernel'), { recursive: true });
    await writeFile(path.join(installation, 'kernel', 'a.mjs'), 'export const a = 1;\n');
    await writeFile(path.join(installation, 'kernel', 'b.mjs'), 'export const b = 2;\n');
    await writeFile(path.join(installation, 'candidate.schema.json'), '{"type":"object"}\n');
  }

  const digest = (installation) => implementationSourceSha256({
    directories: [{ label: 'src/world-model', path: path.join(installation, 'kernel') }],
    files: [{
      label: 'schemas/world-model-composition-candidate.schema.json',
      path: path.join(installation, 'candidate.schema.json')
    }]
  });
  const original = digest(left);
  assert.equal(digest(right), original, 'installation paths must not enter the durable digest');

  assert.equal(implementationSourceSha256({
    directories: [{ label: 'src/world-model', url: pathToFileURL(path.join(left, 'kernel')) }],
    files: [{
      label: 'schemas/world-model-composition-candidate.schema.json',
      url: pathToFileURL(path.join(left, 'candidate.schema.json'))
    }]
  }), original, 'file-URL callers retain the same byte identity');

  await writeFile(path.join(right, 'kernel', 'b.mjs'), 'export const b = 3;\n');
  assert.notEqual(digest(right), original, 'an executable byte change must invalidate the digest');
});

test('the packaged WMB kernel and candidate schema expose mechanical SHA-256 identities', () => {
  assert.match(WMB_V4_KERNEL_SOURCE_SHA256, /^sha256:[a-f0-9]{64}$/);
  assert.match(WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(WMB_V4_KERNEL_SOURCE_SHA256, WMB_V4_CANDIDATE_SCHEMA_SOURCE_SHA256);
});

test('WMB pins the shared clause lexer as a transitive executable grammar dependency', () => {
  const files = [
    'src/configuration-assets.mjs', 'src/repository-facts.mjs', 'src/traceability-ids.mjs',
    'src/javascript-source-comments.mjs', 'schemas/world-model-composition-candidate.schema.json'
  ].map(label => ({ label, path: path.join(PACKAGE_ROOT, ...label.split('/')) }));
  const directories = [{ label: 'src/world-model', path: path.join(PACKAGE_ROOT, 'src/world-model') }];
  assert.equal(implementationSourceSha256({ directories, files }), WMB_V4_KERNEL_SOURCE_SHA256);
  assert.notEqual(implementationSourceSha256({
    directories, files: files.filter(file => file.label !== 'src/javascript-source-comments.mjs')
  }), WMB_V4_KERNEL_SOURCE_SHA256);
});
