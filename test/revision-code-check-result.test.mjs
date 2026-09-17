import assert from 'node:assert/strict';
import test from 'node:test';
import { recordSha256 } from '../src/records.mjs';
import { projectRevisionCodeCheckResult } from '../src/revision/code-check-result.mjs';

const h = (value) => `sha256:${recordSha256(value)}`;
const H = (character) => `sha256:${character.repeat(64)}`;
const candidateReference = {
  family: 'sgos-candidate', namespace: 'refs/singularity-flow/candidates/CAN-ABCDEF123456',
  candidateId: 'CAN-ABCDEF123456', retainedRecordSha256: H('a'), candidateSha256: H('b'),
  repository: { baselineCommit: '1'.repeat(40), candidateTree: '2'.repeat(40), objectFormat: 'sha1' },
  sourceManifestSha256: H('c'), effectSetSha256: H('d'), createdBy: { kind: 'human', id: 'developer' }
};
const browser = {
  checkId: 'browser-tests', kind: 'browser', label: 'Playwright',
  checkDefinitionSha256: H('e'), argvSha256: H('f'), testBodySha256: H('0'),
  adapterSha256: H('1'), outputRoots: ['checks/browser-tests']
};
const unit = {
  checkId: 'unit-tests', kind: 'test', label: 'Unit tests',
  checkDefinitionSha256: H('2'), argvSha256: H('3'), testBodySha256: H('4'),
  adapterSha256: H('5'), outputRoots: ['checks/unit-tests']
};
const base = {
  candidateReference, verifyCandidate: async () => true,
  phaseId: 'implementation', phaseGeneration: 3,
  configSha256: H('6'), proofProfileSha256: H('7'), environmentSha256: H('8'),
  registeredChecks: [browser]
};

function receipt(check = browser, overrides = {}) {
  const core = {
    schemaVersion: 1, kind: 'revision-code-check-receipt',
    candidateId: candidateReference.candidateId,
    candidateRefSha256: h(candidateReference),
    candidateTree: candidateReference.repository.candidateTree,
    phase: base.phaseId, phaseGeneration: base.phaseGeneration,
    checkId: check.checkId, checkDefinitionSha256: check.checkDefinitionSha256,
    argvSha256: check.argvSha256, testBodySha256: check.testBodySha256,
    adapterSha256: check.adapterSha256, configSha256: base.configSha256,
    proofProfileSha256: base.proofProfileSha256, environmentSha256: base.environmentSha256,
    status: 'passed', exitCode: 0,
    tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 },
    logSha256: H('9'), artifacts: [], ...overrides
  };
  return { ...core, receiptSha256: h(core) };
}

test('current browser receipt projects only verified bounded evidence and never completes Testing', async () => {
  const artifact = {
    kind: 'playwright-screenshot', path: 'checks/browser-tests/screenshots/filter.png',
    mediaType: 'image/png', sha256: H('a'), captureProvenanceSha256: H('b'),
    accessClass: 'private', retentionClass: 'proof'
  };
  const stored = receipt(browser, { artifacts: [artifact] });
  let calls = 0;
  const input = { ...base, readVerifiedReceipt: async (checkId) => {
    calls += 1;
    assert.equal(checkId, 'browser-tests');
    return stored;
  } };
  const first = await projectRevisionCodeCheckResult(input);
  const second = await projectRevisionCodeCheckResult(input);
  assert.equal(calls, 2);
  assert.deepEqual(first, second);
  assert.equal(first.resultSha256, h(Object.fromEntries(
    Object.entries(first).filter(([key]) => key !== 'resultSha256')
  )));
  assert.equal(first.status, 'passed');
  assert.equal(first.checks[0].tests.passed, 2);
  assert.deepEqual(first.checks[0].artifacts[0], { status: 'available', ...artifact });
  assert.equal(first.testingVerificationStatus, 'not-established-by-code-result');
  assert.equal(first.publicationEligibilityEstablished, false);
});

test('candidate, definition, configuration, proof, and environment changes render a prior pass stale', async () => {
  const old = receipt(browser, {
    candidateId: 'CAN-OLD123456', candidateTree: '3'.repeat(40),
    checkDefinitionSha256: H('f'), configSha256: H('0'),
    proofProfileSha256: H('1'), environmentSha256: H('2')
  });
  const result = await projectRevisionCodeCheckResult({
    ...base, readVerifiedReceipt: async () => old
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.checks[0].status, 'stale');
  assert.deepEqual(result.checks[0].staleBindings, [
    'candidate', 'candidate-tree', 'check-definition', 'configuration', 'proof-profile', 'environment'
  ]);
  assert.equal(result.checks[0].tests, null);
  assert.deepEqual(result.checks[0].artifacts, []);
});

test('missing or unregistered checks are unavailable, not invented passes or browser requirements', async () => {
  const noChecks = await projectRevisionCodeCheckResult({
    ...base, registeredChecks: [], readVerifiedReceipt: async () => {
      throw new Error('Reader must not be called without checks');
    }
  });
  assert.equal(noChecks.status, 'unavailable');
  assert.equal(noChecks.reason, 'NO_REGISTERED_CHECKS');
  assert.deepEqual(noChecks.checks, []);
  const missing = await projectRevisionCodeCheckResult({
    ...base, registeredChecks: [unit], readVerifiedReceipt: async () => null
  });
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.checks[0].reason, 'NO_VERIFIED_RECEIPT');
  assert.deepEqual(missing.checks[0].artifacts, []);
});

test('failed, skipped, and missing screenshot provenance remain honest', async () => {
  const failed = receipt(unit, { status: 'failed', exitCode: 1,
    tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 } });
  const skipped = receipt(browser, { status: 'skipped', exitCode: null, tests: null,
    artifacts: [{ kind: 'playwright-screenshot', path: 'checks/browser-tests/screenshots/a.png',
      mediaType: 'image/png', sha256: H('c'), accessClass: 'private', retentionClass: 'proof' }] });
  const result = await projectRevisionCodeCheckResult({
    ...base, registeredChecks: [unit, browser],
    readVerifiedReceipt: async (checkId) => checkId === unit.checkId ? failed : skipped
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[1].status, 'skipped');
  assert.deepEqual(result.checks[1].artifacts,
    [{ status: 'unavailable', reason: 'SCREENSHOT_PROVENANCE_INCOMPLETE' }]);
});

test('direct self-hashed input, invalid reader output, and unverified candidate refuse', async () => {
  await assert.rejects(projectRevisionCodeCheckResult({
    ...base, receipts: [receipt()], readVerifiedReceipt: undefined
  }), { code: 'REV_CODE_RESULT_READER_REQUIRED' });
  await assert.rejects(projectRevisionCodeCheckResult({
    ...base, verifyCandidate: async () => false, readVerifiedReceipt: async () => receipt()
  }), { code: 'REV_CODE_RESULT_CANDIDATE_UNVERIFIED' });
  await assert.rejects(projectRevisionCodeCheckResult({
    ...base, readVerifiedReceipt: async () => ({ ...receipt(), status: 'failed' })
  }), { code: 'REV_CODE_RESULT_RECEIPT_INVALID' });
  await assert.rejects(projectRevisionCodeCheckResult({
    ...base, readVerifiedReceipt: async () => receipt(unit)
  }), { code: 'REV_CODE_RESULT_RECEIPT_INVALID' });
});
