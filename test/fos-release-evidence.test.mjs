import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildFosEvidenceInventory, FOS_ACCEPTANCE_CASES
} from '../src/fos-release-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('FOS release inventory binds exact source locations and test-body digests without inventing coverage', async () => {
  const report = await buildFosEvidenceInventory(root);
  assert.equal(FOS_ACCEPTANCE_CASES.length, 50);
  assert.equal(report.status, 'incomplete');
  assert.ok(report.representedAcceptanceCases.includes('FOS:AC-001'));
  assert.ok(report.representedAcceptanceCases.includes('FOS:AC-002'));
  assert.ok(report.unrepresentedAcceptanceCases.includes('FOS:AC-011'));
  assert.equal(report.malformedWitnesses.length, 0);
  assert.equal(report.duplicateTitles.length, 0);
  assert.ok(report.witnesses.every((entry) => entry.namePath.startsWith('test/')));
  assert.ok(report.witnesses.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.testBodySha256)));
  assert.ok(report.partialEvidence.some((entry) => entry.acceptance === 'FOS:AC-035'));
  assert.ok(report.deferredEvidence.some((entry) => entry.acceptance === 'FOS:AC-007'));
  assert.ok(report.unrepresentedAcceptanceCases.includes('FOS:AC-035'));
  assert.equal(report.execution.status, 'not-run');
});

test('FOS local benchmark compares cached and uncached semantics without authorizing claims', () => {
  const run = spawnSync(process.execPath, ['scripts/fos-benchmark.mjs', '--samples=1'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.claimsAuthorized, false);
  assert.deepEqual(report.coverage.localFixtures, ['small-local', 'medium-local', 'linked-worktrees']);
  assert.ok(report.coverage.notMeasured.includes('office-remote'));
  for (const fixture of report.fixtures.slice(0, 2)) {
    assert.equal(fixture.summary.semanticEquivalent, true);
    assert.deepEqual(fixture.summary.optimizedWarmGitRequests, [0]);
    assert.deepEqual(fixture.summary.noCacheWarmGitRequests, [9]);
  }
  assert.equal(report.fixtures[2].summary.semanticEquivalent, true);
});

test('FOS evidence command reports missing witnesses and never marks an inventory-only run passed', async () => {
  const run = spawnSync(process.execPath, ['scripts/fos-release-evidence.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.execution.status, 'not-run');
  const source = await readFile(path.join(root, 'scripts', 'fos-release-evidence.mjs'), 'utf8');
  assert.match(source, /output must stay outside the repository/);
});
