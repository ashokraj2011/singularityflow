import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { specificationQualityPolicy } from '../src/specification-quality.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';
import { storyWelEnrollmentStatus } from '../src/state.mjs';
import { run } from '../src/util.mjs';
import { buildWelEnrollment, validateWelEnrollment, welEnrollmentDigest } from '../src/wel-policy.mjs';

const authority = Object.freeze({
  repository: 'https://example.invalid/product.git',
  branch: 'sflow/config',
  commit: 'a'.repeat(40),
  projectionSha256: 'sha256:' + 'b'.repeat(64)
});

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('new Stories pin an explicit disabled WEL enrollment without requiring configuration authority', () => {
  const enrollment = buildWelEnrollment({
    phases: [{ id: 'specification', specificationQuality: specificationQualityPolicy() }],
    codeDelivery: normalizeCodeDeliveryPolicy(),
    configurationSource: null
  });
  assert.equal(enrollment.mode, 'disabled');
  assert.equal(enrollment.witnessedClauses.enabled, false);
  assert.equal(enrollment.testcaseExact.mode, 'disabled');
  assert.equal(enrollment.configurationAuthority, null);
  assert.match(welEnrollmentDigest(enrollment), /^sha256:[0-9a-f]{64}$/);
});

test('witnessed clauses and exact JUnit observation produce one creation-pinned observe enrollment', () => {
  const enrollment = buildWelEnrollment({
    phases: [{ id: 'specification', specificationQuality: specificationQualityPolicy({
      mode: 'warn',
      witnessedClauses: {
        profile: 'witnessed-v1', clauseTypes: ['acceptance'], enforceableWitnessTypes: ['test']
      }
    }) }],
    codeDelivery: normalizeCodeDeliveryPolicy({ tests: { testcaseExact: {
      mode: 'observe', adapter: 'junit5-surefire-v1', requiredWitnessTypes: ['test'],
      evidenceTier: 'testcase-local-observed'
    } } }),
    configurationSource: authority
  });
  assert.equal(enrollment.mode, 'observe');
  assert.equal(enrollment.witnessedClauses.profiles[0].phaseId, 'specification');
  assert.match(enrollment.witnessedClauses.profiles[0].policySha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(enrollment.testcaseExact.requiredAssurance, 'testcase-local-observed');
  assert.equal(enrollment.cab.authority, 'packaged-observation-only');
  assert.equal(enrollment.sgos, null);
  assert.deepEqual(enrollment.configurationAuthority, authority);
});

test('observe enrollment refuses an unapproved configuration source', () => {
  assert.throws(() => buildWelEnrollment({
    phases: [{ id: 'specification', specificationQuality: specificationQualityPolicy({
      witnessedClauses: { profile: 'witnessed-v1' }
    }) }],
    codeDelivery: normalizeCodeDeliveryPolicy(),
    configurationSource: null
  }), (error) => error.code === 'WEL_CONFIGURATION_AUTHORITY_REQUIRED');
});

test('enrollment refuses an unsupported future claim-map contract', () => {
  const enrollment = buildWelEnrollment();
  assert.deepEqual(validateWelEnrollment({
    ...enrollment, claimMapContractVersion: enrollment.claimMapContractVersion + 1
  }), { valid: false, reason: 'claim-map-contract-unsupported' });
});

test('story-workflow v2 migration reaches the current schema without enrolling a legacy Story', () => {
  const legacy = {
    schemaVersion: 2,
    workItem: { id: 'LEGACY-1' },
    resolution: { policySha256: 'sha256:' + 'c'.repeat(64), codeDelivery: { mode: 'enforce' } },
    phaseOrder: [],
    phases: {}
  };
  const migrated = readRecord('story-workflow', legacy);
  assert.equal(migrated.storedVersion, 2);
  assert.equal(migrated.record.schemaVersion, currentSchemaVersion('story-workflow'));
  assert.deepEqual(migrated.record.resolution, legacy.resolution);
  assert.equal(Object.hasOwn(migrated.record.resolution, 'wel'), false);
  assert.deepEqual(legacy.resolution, {
    policySha256: 'sha256:' + 'c'.repeat(64), codeDelivery: { mode: 'enforce' }
  });
});

test('creation-anchor defects classify WEL as legacy without throwing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-wel-creation-classification-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'WEL Classification']);
  git(root, ['config', 'user.email', 'wel-classification@example.invalid']);
  const workItemRoot = 'singularity/work-items';
  const records = {
    'WEL-NO-ANCHOR': { schemaVersion: 3, resolution: {} },
    'WEL-BAD-ANCHOR': { schemaVersion: 3, resolution: { policySha256: 'not-a-digest' } },
    'WEL-WRONG-ANCHOR': {
      schemaVersion: 3,
      resolution: { policySha256: `sha256:${'a'.repeat(64)}` }
    }
  };
  for (const [workId, record] of Object.entries(records)) {
    const file = path.join(root, workItemRoot, workId, 'workflow.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'add creation records']);

  const config = { workItemRoot };
  assert.equal(storyWelEnrollmentStatus(root, config, 'WEL-NO-ANCHOR').reason,
    'creation-anchor-missing');
  assert.equal(storyWelEnrollmentStatus(root, config, 'WEL-BAD-ANCHOR').reason,
    'creation-anchor-malformed');
  assert.equal(storyWelEnrollmentStatus(root, config, 'WEL-WRONG-ANCHOR').reason,
    'creation-anchor-mismatch');
  for (const workId of Object.keys(records)) {
    const status = storyWelEnrollmentStatus(root, config, workId);
    assert.equal(status.classification, 'legacy');
    assert.equal(status.mode, 'disabled');
  }
});
