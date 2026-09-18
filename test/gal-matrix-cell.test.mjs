import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { classifySkippedScenarios, runtimeClass } from '../scripts/gal-matrix-cell.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['scripts/gal-matrix-cell.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
    maxBuffer: 1024 * 1024, windowsHide: true, shell: false
  });
}

test('GAL matrix classifies primary, legacy, and development-only Node versions', () => {
  assert.equal(runtimeClass('22.17.0'), 'primary');
  assert.equal(runtimeClass('24.8.0'), 'primary');
  assert.equal(runtimeClass('20.19.0'), 'legacy-compatibility');
  assert.equal(runtimeClass('25.5.0'), 'development-only');
});

test('GAL matrix names Windows-only exclusions and rejects an unexpected skip', () => {
  const tap = 'ok 1 - GAL disposal cancels an in-flight blob read # SKIP POSIX fixture\n'
    + 'ok 2 - GAL remoteRef classifies auth denial without returning provider stderr # SKIP POSIX fixture\n'
    + 'ok 3 - unrelated mandatory case # SKIP unsupported\n';
  assert.deepEqual(classifySkippedScenarios(tap, 'win32'), {
    skippedScenarios: [
      'GAL disposal cancels an in-flight blob read',
      'GAL remoteRef classifies auth denial without returning provider stderr',
      'unrelated mandatory case'
    ],
    unexpectedSkips: ['unrelated mandatory case']
  });
  assert.deepEqual(classifySkippedScenarios(tap, 'darwin').unexpectedSkips,
    [
      'GAL disposal cancels an in-flight blob read',
      'GAL remoteRef classifies auth denial without returning provider stderr',
      'unrelated mandatory case'
    ]);
});

test('GAL matrix preflight reports a source-bound local cell without claiming release qualification', () => {
  const result = run('--preflight-only');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'sflow-gal-matrix-cell/v1');
  assert.equal(report.status, 'preflight');
  assert.equal(report.localEvidenceOnly, true);
  assert.equal(report.releaseQualified, false);
  assert.equal(typeof report.sourceDirty, 'boolean');
  assert.equal(report.runtimeClass, runtimeClass(process.versions.node));
  assert.match(report.sourceRevision, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
  assert.match(report.gitVersion, /^git version /u);
  assert.ok(report.testFiles.includes('test/git-access.test.mjs'));
  assert.ok(report.testFiles.includes('test/gal-object-transport-conformance.test.mjs'));
  assert.equal(result.stdout.includes('sflow-gal-benchmark-'), false);
});

test('GAL matrix refuses unknown options without printing subprocess output', () => {
  const result = run('--unsafe');
  assert.notEqual(result.status, 0);
  const refusal = JSON.parse(result.stderr.trim());
  assert.equal(refusal.code, 'GAL_MATRIX_OPTION_INVALID');
  assert.equal(result.stdout, '');
});
