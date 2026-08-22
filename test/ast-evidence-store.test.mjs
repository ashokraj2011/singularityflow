import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  astEvidenceStoreDescription, resolveAstEvidenceBundle, retainAstEvidenceBundle
} from '../src/ast-evidence-store.mjs';
import { canonicalJson, recordSha256 } from '../src/records.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-ast-evidence-store-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('AST evidence defaults to an ignored workspace-local store', async () => {
  const root = await repository();
  const bundle = { schemaVersion: 1, adapter: { id: 'builtin-text' } };
  const retained = await retainAstEvidenceBundle(root, 'local-directory', bundle);
  const expected = path.join(root, '.singularity-flow', 'ast-evidence-store');
  assert.equal(astEvidenceStoreDescription(root, 'local-directory').root, expected);
  assert.equal(JSON.parse(await readFile(path.join(expected, 'bundles', `${retained.bundleSha256}.json`), 'utf8')).adapter.id, 'builtin-text');
  assert.doesNotMatch(execFileSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), /ast-evidence-store/);
});

test('AST evidence replay still resolves bundles retained in the legacy Git-common store', async () => {
  const root = await repository();
  const bundle = { schemaVersion: 1, adapter: { id: 'legacy-adapter' } };
  const digest = recordSha256(bundle);
  const directory = path.join(root, '.git', 'singularity-flow', 'ast-evidence-store', 'bundles');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${digest}.json`), canonicalJson(bundle));
  const resolved = await resolveAstEvidenceBundle(root, 'local-directory', digest);
  assert.equal(resolved.available, true);
  assert.equal(resolved.bundle.adapter.id, 'legacy-adapter');
});
