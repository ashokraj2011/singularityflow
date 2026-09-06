import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildChangeRegionManifest } from '../src/comprehension/contracts.mjs';
import { buildComprehensionEvidenceProjection } from '../src/comprehension/evidence-projection.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function manifestFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cmp-evidence-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'CMP Evidence');
  git(root, 'config', 'user.email', 'cmp-evidence@example.com');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 1;\n');
  await writeFile(path.join(root, 'src', 'app.test.js'), '// @ac:CMP-1:AC-001\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const answer = 2;\n');
  await writeFile(path.join(root, 'src', 'app.test.js'), '// @ac:CMP-1:AC-001\n// passing\n');
  const changeSet = await buildRepositoryChangeSet(root, { baseCommit: 'HEAD' });
  return buildChangeRegionManifest(changeSet);
}

test('recorded delivery evidence joins only exact current region paths', async () => {
  const manifest = await manifestFixture();
  const receiptSha256 = 'a'.repeat(64);
  const workflow = {
    phases: {
      implementation: {
        generation: 3,
        deliveryEvidence: {
          status: 'ready', receiptSha256,
          sourcePaths: ['src/app.js', 'src/not-in-this-change.js'],
          testPaths: ['src/app.test.js'], supportingTestPaths: [],
          acceptanceCriteria: {
            required: ['CMP-1:AC-001'], tagged: ['CMP-1:AC-001'], missing: []
          },
          testExecutions: [{
            commandId: 'unit', status: 'passed', receiptSha256: 'b'.repeat(64), affectedRoots: ['.']
          }]
        }
      }
    }
  };

  const result = buildComprehensionEvidenceProjection({ workflow, phaseId: 'implementation', manifest });
  assert.equal(result.status, 'available');
  assert.equal(result.authoritative, false);
  assert.equal(result.lifecycleGate, false);
  assert.equal(result.deliveryReceiptSha256, `sha256:${receiptSha256}`);
  assert.deepEqual(result.acceptance.required, ['CMP-1:AC-001']);
  assert.deepEqual(result.acceptance.tagged, ['CMP-1:AC-001']);
  assert.equal(result.counts.linkedRegions, 2);
  assert.deepEqual(result.regions.map((entry) => entry.path).sort(), ['src/app.js', 'src/app.test.js']);
  assert.deepEqual(result.regions.find((entry) => entry.path === 'src/app.js').roles, ['source']);
  assert.deepEqual(result.regions.find((entry) => entry.path === 'src/app.test.js').roles, ['test']);
  assert.ok(result.regions.every((entry) => entry.testCommandIds.includes('unit')));
  assert.equal(result.regions.some((entry) => entry.path === 'src/not-in-this-change.js'), false,
    'a path present only in workflow evidence cannot enter the current change projection');
  assert.match(result.evidenceProjectionSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(result), true);
});

test('missing Story or delivery state remains explicit and non-blocking', async () => {
  const manifest = await manifestFixture();
  const noStory = buildComprehensionEvidenceProjection({ manifest });
  assert.equal(noStory.status, 'not-applicable');
  assert.equal(noStory.reason, 'no-active-story');
  assert.deepEqual(noStory.regions, []);

  const noDelivery = buildComprehensionEvidenceProjection({
    workflow: { phases: { planning: { generation: 1 } } }, phaseId: 'planning', manifest
  });
  assert.equal(noDelivery.status, 'unavailable');
  assert.equal(noDelivery.reason, 'delivery-evidence-unavailable');
  assert.equal(noDelivery.lifecycleGate, false);
});

test('evidence projection applies fixed record ceilings without guessing', async () => {
  const manifest = await manifestFixture();
  const required = Array.from({ length: 520 }, (_, index) => `CMP-1:AC-${String(index).padStart(3, '0')}`);
  const testExecutions = Array.from({ length: 120 }, (_, index) => ({
    commandId: `test-${index}`, status: 'passed', receiptSha256: 'c'.repeat(64), affectedRoots: ['src']
  }));
  const result = buildComprehensionEvidenceProjection({
    workflow: { phases: { implementation: { generation: 1, deliveryEvidence: {
      status: 'ready', sourcePaths: ['src/app.js'], testPaths: ['src/app.test.js'],
      acceptanceCriteria: { required, tagged: required, missing: [] }, testExecutions
    } } } },
    phaseId: 'implementation', manifest
  });
  assert.equal(result.acceptance.required.length, 500);
  assert.equal(result.acceptance.tagged.length, 500);
  assert.equal(result.testExecutions.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.acceptance.omitted, 40);
});
