import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'bin', 'singularity-flow.mjs');

function run(...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('top-level version flags print only the package version', () => {
  for (const argument of ['--version', '-v', 'version']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0.6.2');
  }
});

test('top-level help flags print usage', () => {
  for (const argument of ['--help', '-h', 'help']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Singularity Flow 0\.6\.2/m);
    assert.match(result.stdout, /singularity-flow start <WORK-ID>/);
  }
});
