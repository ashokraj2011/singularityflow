import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the portable CMP/WEL matrix refuses a missing JDK before running tests', async () => {
  const emptyPath = await mkdtemp(path.join(os.tmpdir(), 'sflow-empty-path-'));
  try {
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'run-cmp-wel-platform.mjs'), '--preflight-only'
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyPath },
      windowsHide: true
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Java is not on PATH/);
    assert.match(result.stderr, /npm run test:platform:cmp-wel/);
    assert.doesNotMatch(result.stdout, /Subtest:/);
  } finally {
    await rm(emptyPath, { recursive: true, force: true });
  }
});
