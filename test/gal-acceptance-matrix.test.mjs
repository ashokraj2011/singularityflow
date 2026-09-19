import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matrixPath = path.join(root, 'docs/contracts/gal/acceptance-matrix.json');

test('GAL acceptance traceability names all 44 cases without converting local evidence into release approval', async () => {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  assert.equal(matrix.schemaVersion, 1);
  assert.equal(matrix.claim, 'traceability-only');
  assert.match(matrix.specification.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(matrix.cases.length, 44);
  assert.deepEqual(matrix.cases.map(({ id }) => id), Array.from({ length: 44 }, (_, index) =>
    `GAL:AC-${String(index + 1).padStart(3, '0')}`));
  for (const entry of matrix.cases) {
    assert.deepEqual(Object.keys(entry), ['id', 'evidence', 'external']);
    assert.ok(entry.evidence.length > 0, `${entry.id} has no code-local evidence owner`);
    assert.equal(new Set(entry.evidence).size, entry.evidence.length,
      `${entry.id} repeats an evidence owner`);
    for (const relative of entry.evidence) {
      assert.match(relative, /^test\/[a-z0-9-]+\.test\.mjs$/u);
      assert.equal((await stat(path.join(root, relative))).isFile(), true, relative);
    }
    assert.ok(Array.isArray(entry.external));
    assert.ok(entry.external.every((value) => typeof value === 'string' && value.trim() === value
      && value.length > 0));
  }
  const externallyBound = matrix.cases.filter(({ external }) => external.length > 0);
  assert.ok(externallyBound.length > 0, 'a single-host test must not make the matrix release-qualified');
});
