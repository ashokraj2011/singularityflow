import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAutoRepairEligibility } from '../src/auto/auto-repair-eligibility.mjs';

const HASH = (character) => `sha256:${character.repeat(64)}`;

function fixture(overrides = {}) {
  const state = {
    status: 'running', stopRequested: null,
    story: { phase: 'implementation' },
    scopePrediction: ['src', 'test'],
    candidate: {
      candidateSha256: HASH('a'), bindingSha256: HASH('b'),
      verificationReceiptSha256: HASH('c')
    },
    execution: {
      repair: { policy: 'auto-on-machine-actionable', maximumAttempts: 1 },
      ceilings: { maximumModelInvocations: 3, maximumAuthoringAttemptsPerPhase: 2 }
    },
    counters: { modelInvocations: 1, authoringAttempts: { implementation: 1 } },
    ...overrides.state
  };
  const attempt = {
    attemptKind: 'initial', candidateSha256: HASH('a'), ...overrides.attempt
  };
  const repairScope = overrides.repairScope ?? ['test/app.test.mjs'];
  const machineEvidence = overrides.machineEvidence ?? [{
    kind: 'structured-test-failure', source: 'registered-verifier',
    commandId: 'affected-tests', commandArgvSha256: HASH('d'),
    adapter: 'node-tap', resultSha256: HASH('e'), resultBytes: 128,
    tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 },
    repairScope
  }];
  const candidateVerification = {
    status: 'failed', candidateTreeUnchanged: true,
    candidateSha256: HASH('a'), bindingSha256: HASH('b'),
    verificationReceiptSha256: HASH('c'),
    commands: [{
      id: 'affected-tests', status: 1, timedOut: false, overflow: false, signal: null
    }],
    repairEvidence: machineEvidence,
    ...overrides.candidateVerification
  };
  candidateVerification.commands[0].argvSha256 = HASH('d');
  return {
    state, attempt, candidateVerification,
    gate: overrides.gate ?? 'generation-publication',
    code: overrides.code ?? 'AUTO_CANDIDATE_VERIFICATION_FAILED',
    changedPaths: overrides.changedPaths ?? ['src/app.mjs', 'test/app.test.mjs'],
    repairScope,
    protectedPaths: overrides.protectedPaths ?? ['singularity'],
    repairOperationAvailable: overrides.repairOperationAvailable ?? true
  };
}

test('only an unchanged deterministic Candidate verification failure is automatic', () => {
  const classified = classifyAutoRepairEligibility(fixture());
  assert.equal(classified.eligibility, 'auto-eligible');
  assert.equal(classified.machineActionable, true);
  assert.deepEqual(classified.scope, ['test/app.test.mjs']);
  assert.equal(classified.requiredEvidence.length, 1);
  assert.equal(JSON.parse(classified.requiredEvidence[0]).kind, 'structured-test-failure');
});

test('ratified directory and double-star scopes contain an exact evidence path', () => {
  const directory = classifyAutoRepairEligibility(fixture({
    state: { scopePrediction: ['src', 'test'] }
  }));
  assert.equal(directory.eligibility, 'auto-eligible');
  const pattern = classifyAutoRepairEligibility(fixture({
    state: { scopePrediction: ['src/**', 'test/**'] }
  }));
  assert.equal(pattern.eligibility, 'auto-eligible');
  assert.deepEqual(pattern.scope, ['test/app.test.mjs']);
});

test('provider, unsafe verification, scope, protected, stale, and budget failures fail closed', () => {
  const cases = [
    [fixture({ code: 'MODEL_PROVIDER_FAILED' }), 'ask-only'],
    [fixture({ machineEvidence: [] }), 'ask-only'],
    [fixture({ machineEvidence: [{
      kind: 'structured-test-failure', source: 'registered-verifier',
      commandId: 'affected-tests', commandArgvSha256: HASH('d'),
      adapter: 'terminal-prose', resultSha256: HASH('e'), resultBytes: 128,
      tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 },
      repairScope: ['test/app.test.mjs']
    }] }), 'ask-only'],
    [fixture({
      machineEvidence: [],
      candidateVerification: { commands: [{
        id: 'compile', argvSha256: HASH('d'), status: 1,
        timedOut: false, overflow: false, signal: null
      }] }
    }), 'ask-only'],
    [fixture({ candidateVerification: { timedOut: true, commands: [{ id: 'test', status: 1, timedOut: true, overflow: false, signal: null }] } }), 'manual-only'],
    [fixture({ repairScope: ['other'], machineEvidence: [] }), 'ask-only'],
    [fixture({
      changedPaths: ['singularity/workflow.yml'], repairScope: ['singularity/workflow.yml'],
      state: { scopePrediction: ['singularity'] }
    }), 'ineligible'],
    [fixture({ state: { stopRequested: { kind: 'pause' } } }), 'manual-only'],
    [fixture({ state: { counters: { modelInvocations: 3, authoringAttempts: { implementation: 1 } } } }), 'ineligible'],
    [fixture({ attempt: { attemptKind: 'repair' } }), 'ineligible']
  ];
  for (const [input, expected] of cases) {
    assert.equal(classifyAutoRepairEligibility(input).eligibility, expected);
  }
});

test('structured evidence cannot authorize a broader or unrelated repair scope', () => {
  const broadened = fixture({
    repairScope: ['src', 'test/app.test.mjs'],
    machineEvidence: [{
      kind: 'structured-test-failure', source: 'registered-verifier',
      commandId: 'affected-tests', commandArgvSha256: HASH('d'),
      adapter: 'node-tap', resultSha256: HASH('e'), resultBytes: 128,
      tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 },
      repairScope: ['test/app.test.mjs']
    }]
  });
  assert.equal(classifyAutoRepairEligibility(broadened).eligibility, 'manual-only');

  const unrelated = fixture({
    repairScope: ['test/unrelated.test.mjs'],
    machineEvidence: [{
      kind: 'structured-test-failure', source: 'registered-verifier',
      commandId: 'affected-tests', commandArgvSha256: HASH('d'),
      adapter: 'node-tap', resultSha256: HASH('e'), resultBytes: 128,
      tests: { discovered: 2, passed: 1, failed: 1, skipped: 0 },
      repairScope: ['test/unrelated.test.mjs']
    }]
  });
  assert.equal(classifyAutoRepairEligibility(unrelated).eligibility, 'manual-only');

  const aggregateCannotIdentifyFailedFile = fixture({
    repairScope: ['test/app.test.mjs', 'test/unrelated.test.mjs'],
    changedPaths: ['src/app.mjs', 'test/app.test.mjs', 'test/unrelated.test.mjs'],
    machineEvidence: [{
      kind: 'structured-test-failure', source: 'registered-verifier',
      commandId: 'affected-tests', commandArgvSha256: HASH('d'),
      adapter: 'node-tap', resultSha256: HASH('e'), resultBytes: 128,
      tests: { discovered: 3, passed: 2, failed: 1, skipped: 0 },
      repairScope: ['test/app.test.mjs', 'test/unrelated.test.mjs']
    }]
  });
  assert.equal(classifyAutoRepairEligibility(aggregateCannotIdentifyFailedFile).eligibility,
    'ask-only');
});
