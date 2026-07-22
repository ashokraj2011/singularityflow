import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('deterministic check ignores generated files excluded by Git', async () => {
  const directory = path.join(root, 'coverage', 'ignored-check-probe');
  const probe = path.join(directory, 'invalid-generated-file.mjs');
  await mkdir(directory, { recursive: true });
  await writeFile(probe, 'this is intentionally invalid generated JavaScript\n');
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /invalid-generated-file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
