import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  authorizeAutoRepair, authorizeAutomaticAutoRepair,
  confirmAutoExecutionUnitSwitch, createAutoHumanBoundary,
  planAutoExecutionUnitSwitch, planAutoRepair, respondAutoHumanRequest
} from '../src/auto/auto-p1-control.mjs';
import {
  autoRecordDigest, buildAutoAttempt, buildAutoExecutionUnitSwitch,
  buildAutoHumanRequest, buildAutoPhaseRun, buildAutoRefusal, buildAutoRepairPlan,
  buildAutoTokenEconomicsReceipt, listAutoP1Records, persistAutoAttempt, persistAutoRefusal,
  persistAutoPhaseRun, persistAutoTokenEconomicsReceipt, readAutoP1Record, updateAutoAttempt,
  updateAutoExecutionUnitSwitch, updateAutoHumanRequest, updateAutoPhaseRun,
  updateAutoTokenEconomicsReceipt, validateAutoP1Snapshot
} from '../src/auto/auto-p1-records.mjs';
import {
  beginAutoAttemptLineage, recordAutoAttemptCompleted
} from '../src/auto/auto-p1-lineage.mjs';
import { autoAttemptId } from '../src/auto/auto-candidate.mjs';
import {
  createAutoFlightState, mutateAutoFlightState, readAutoFlightState, resumeAutoFlight
} from '../src/auto/auto-flight-store.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';

const FLIGHT_ID = `AFL-${'A'.repeat(26)}`;
const HASH = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;
const NOW = () => '2026-09-01T00:00:00.000Z';
const WORLD_MODEL_REFERENCE = Object.freeze({
  protocol: 'auto-world-model-reference-v1',
  path: 'singularity/work-items/AUTO-P1/context/implementation-gen1.json',
  workId: 'AUTO-P1', phase: 'implementation', generation: 1, agent: 'developer',
  worldModelCommit: 'a'.repeat(40), manifestSha256: HASH('a'), renderedSha256: HASH('b'),
  modelSourceTreeSha256: HASH('c'), composedSourceTreeSha256: HASH('c'), fresh: true
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function repository(t, suffix = 'records') {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-auto-p1-${suffix}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  return root;
}

async function flight(t, suffix = 'flight') {
  const root = await repository(t, suffix);
  const state = await createAutoFlightState(root, {
    flightId: FLIGHT_ID, planId: `APL-${'B'.repeat(26)}`, planSha256: HASH('b'),
    status: 'paused', story: { workId: 'AUTO-P1', branch: 'AUTO-P1', phase: 'implementation' },
    worktree: root, scopePrediction: ['src/**'],
    execution: {
      repair: { policy: 'ask', maximumAttempts: 1 },
      ceilings: { maximumAuthoringAttemptsPerPhase: 2, maximumModelInvocations: 4 }
    }
  });
  return { root, state };
}

function records() {
  const attempt = buildAutoAttempt({
    flightId: FLIGHT_ID, phase: 'implementation', attemptNumber: 1,
    attemptKind: 'initial', parentAttemptId: null, reason: 'phase-entry',
    generationIntentSha256: HASH('1'), taskContractSha256: HASH('2'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'running', budgetImpact: { modelInvocations: 1 }, result: null
  }, { now: NOW });
  const phaseRun = buildAutoPhaseRun({
    flightId: FLIGHT_ID, phase: 'implementation', status: 'running',
    attemptIds: [attempt.attemptId], activeAttemptId: attempt.attemptId,
    publishedGenerations: [], requiredHumanRequestIds: [], phaseCheckpointSha256: HASH('5')
  }, { now: NOW });
  const refusal = buildAutoRefusal({
    flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
    gate: 'verification', code: 'TEST_FAILED', subject: { candidateSha256: HASH('6') },
    missing: [{ evidence: 'passing tests' }], preserved: { paths: ['src/a.mjs'] },
    repair: { eligibility: 'ask-only', operation: 'auto.repair', scope: ['src/a.mjs'], maximumAttempts: 1 },
    primaryNextAction: { operation: 'auto.repair', label: 'Review repair' }
  }, { now: NOW });
  return {
    attempt, phaseRun, refusal,
    repairPlan: buildAutoRepairPlan({
      flightId: FLIGHT_ID, parentAttemptId: attempt.attemptId,
      refusalSha256: refusal.refusalSha256, objective: 'Make tests pass',
      readScope: ['src/**'], writeScope: ['src/a.mjs'], forbiddenChanges: ['workflow.yml'],
      requiredEvidence: ['passing tests'], budget: { maximumAttempts: 1 }, attemptNumber: 1
    }, { now: NOW }),
    humanRequest: buildAutoHumanRequest({
      flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
      requestType: 'architecture-choice', title: 'Choose persistence',
      detail: { reason: 'material design choice' }, options: [{ id: 'sql' }, { id: 'document' }],
      subjectSha256: HASH('7'), policySha256: HASH('8'), checkpointSha256: HASH('9'),
      status: 'open', response: null, expiresAt: null
    }, { now: NOW }),
    economics: buildAutoTokenEconomicsReceipt({
      flightId: FLIGHT_ID, attemptId: attempt.attemptId,
      contextManifestSha256: attempt.contextManifestSha256,
      input: { providerTokens: 10 }, output: { providerTokens: 4 },
      cost: { amount: null, currency: 'USD', assurance: 'unavailable' },
      quality: {
        verification: 'pending', firstPass: true, repairAttempts: 0,
        reviewReturned: false, missingContextIncident: false
      },
      classification: 'first-pass-pending-verification',
      worldModelReference: WORLD_MODEL_REFERENCE, comprehensionReference: null
    }, { now: NOW }),
    switchPlan: buildAutoExecutionUnitSwitch({
      flightId: FLIGHT_ID, fromExecutionUnit: 'copilot', toExecutionUnit: 'office-copilot',
      taskContractSha256: attempt.taskContractSha256, parentAttemptId: attempt.attemptId,
      reason: 'office route', status: 'proposed'
    }, { now: NOW })
  };
}

function governedBoundaryPublisher(calls = []) {
  return async (storyRoot, state, checkpointClass, options) => {
    calls.push({ storyRoot, flightId: state.flightId, checkpointClass, options });
    return {
      checkpointClass,
      path: `singularity/work-items/${state.story.workId}/context/auto/${state.flightId}/checkpoint.json`,
      checkpointSha256: HASH(String(calls.length)),
      commit: String(calls.length).repeat(40).slice(0, 40),
      eventId: `AUTO-BOUNDARY-${calls.length}`,
      phase: state.story.phase,
      position: state.position,
      createdAt: NOW()
    };
  };
}

test('AUT v2 P1 builders stamp the migration registry, close vocabularies, and self-seal every record family', () => {
  const built = records();
  for (const record of Object.values(built)) {
    assert.equal(record.schemaVersion, currentSchemaVersion(record.kind));
    const hashField = record.kind === 'auto-refusal' ? 'refusalSha256'
      : record.kind === 'auto-repair-plan' ? 'repairPlanSha256'
        : record.kind === 'auto-human-request' ? 'requestSha256'
          : record.kind === 'auto-token-economics-receipt' ? 'receiptSha256'
            : record.kind === 'auto-execution-unit-switch' ? 'switchPlanSha256'
              : 'recordSha256';
    assert.equal(record[hashField], autoRecordDigest(record, hashField));
  }
  assert.throws(() => buildAutoHumanRequest({
    ...built.humanRequest, requestType: 'free-form-question'
  }), /must be one of/);
  assert.throws(() => buildAutoRepairPlan({ ...built.repairPlan, attemptNumber: 2 }), /exactly one/);
  assert.equal(built.refusal.subject.verificationReceiptSha256, null);
  assert.equal(built.refusal.preserved.verificationReceiptSha256, null);
});

test('AUT v2 P1 readers reject correctly resealed timestamps and duplicate authority IDs outside the schemas', () => {
  const built = records();
  const familyRecords = {
    'auto-phase-run': built.phaseRun,
    'auto-attempt': built.attempt,
    'auto-refusal': built.refusal,
    'auto-repair-plan': built.repairPlan,
    'auto-human-request': built.humanRequest,
    'auto-token-economics-receipt': built.economics,
    'auto-execution-unit-switch': built.switchPlan
  };
  const hashField = (family) => family === 'auto-refusal' ? 'refusalSha256'
    : family === 'auto-repair-plan' ? 'repairPlanSha256'
      : family === 'auto-human-request' ? 'requestSha256'
        : family === 'auto-token-economics-receipt' ? 'receiptSha256'
          : family === 'auto-execution-unit-switch' ? 'switchPlanSha256'
            : 'recordSha256';
  const snapshotWith = (family, record) => Object.fromEntries(
    Object.keys(familyRecords).map((name) => [name, name === family ? [record] : []])
  );
  const reseal = (family, value) => {
    const field = hashField(family);
    const changed = { ...structuredClone(value), [field]: null };
    changed[field] = autoRecordDigest(changed, field);
    return changed;
  };

  for (const [family, record] of Object.entries(familyRecords)) {
    const invalid = reseal(family, { ...record, createdAt: 'not-a-date' });
    assert.throws(
      () => validateAutoP1Snapshot(FLIGHT_ID, snapshotWith(family, invalid)),
      (error) => error.code === 'AUTO_RECORD_CORRUPT' && /RFC 3339/.test(error.message),
      family
    );
  }

  for (const field of ['attemptIds', 'requiredHumanRequestIds']) {
    const id = field === 'attemptIds' ? built.attempt.attemptId : built.humanRequest.requestId;
    const invalid = reseal('auto-phase-run', {
      ...built.phaseRun, [field]: [id, id]
    });
    assert.throws(
      () => validateAutoP1Snapshot(
        FLIGHT_ID, snapshotWith('auto-phase-run', invalid)
      ),
      (error) => error.code === 'AUTO_RECORD_CORRUPT' && /duplicates/.test(error.message),
      field
    );
  }

  const invalidExpiry = reseal('auto-human-request', {
    ...built.humanRequest, expiresAt: 'tomorrow'
  });
  assert.throws(
    () => validateAutoP1Snapshot(
      FLIGHT_ID, snapshotWith('auto-human-request', invalidExpiry)
    ),
    (error) => error.code === 'AUTO_RECORD_CORRUPT' && /expiresAt/.test(error.message)
  );
  const invalidCalendarDate = reseal('auto-phase-run', {
    ...built.phaseRun, updatedAt: '2026-02-30T00:00:00.000Z'
  });
  assert.throws(
    () => validateAutoP1Snapshot(
      FLIGHT_ID, snapshotWith('auto-phase-run', invalidCalendarDate)
    ),
    (error) => error.code === 'AUTO_RECORD_CORRUPT' && /updatedAt/.test(error.message)
  );
});

test('AUT v2 P1 builders recursively close every nested record vocabulary', () => {
  const built = records();
  const rejected = [
    () => buildAutoPhaseRun({
      ...built.phaseRun,
      publishedGenerations: [{
        generation: 1, candidateSha256: HASH('1'), publicationReceiptSha256: HASH('2'),
        unreviewed: true
      }]
    }),
    () => buildAutoAttempt({
      ...built.attempt, budgetImpact: { modelInvocations: '1' }
    }),
    () => buildAutoAttempt({
      ...built.attempt, result: { status: 'completed', evidence: 'invented' }
    }),
    () => buildAutoRefusal({
      ...built.refusal, subject: { candidateSha256: HASH('1'), path: 'src/a.mjs' }
    }),
    () => buildAutoRefusal({
      ...built.refusal, missing: [{ evidence: 'passing tests', certainty: 'high' }]
    }),
    () => buildAutoRefusal({
      ...built.refusal, preserved: { ...built.refusal.preserved, changedPaths: '1' }
    }),
    () => buildAutoRefusal({
      ...built.refusal, repair: { ...built.refusal.repair, operation: 'shell' }
    }),
    () => buildAutoRefusal({
      ...built.refusal, primaryNextAction: { ...built.refusal.primaryNextAction, command: 'run' }
    }),
    () => buildAutoRepairPlan({
      ...built.repairPlan, budget: { ...built.repairPlan.budget, timeoutMs: 1 }
    }),
    () => buildAutoHumanRequest({
      ...built.humanRequest, detail: { ...built.humanRequest.detail, implementation: 'hidden' }
    }),
    () => buildAutoHumanRequest({
      ...built.humanRequest, options: [{ id: 'sql', secret: 'no' }, { id: 'document' }]
    }),
    () => buildAutoHumanRequest({
      ...built.humanRequest, status: 'answered',
      response: {
        value: { brokerReference: 'broker://wrong-kind' },
        requestSha256: built.humanRequest.requestSha256, responseSha256: HASH('3')
      }
    }),
    () => buildAutoTokenEconomicsReceipt({
      ...built.economics, input: { ...built.economics.input, hiddenTokens: 4 }
    }),
    () => buildAutoTokenEconomicsReceipt({
      ...built.economics, quality: { ...built.economics.quality, repairAttempts: 0.5 }
    }),
    () => buildAutoTokenEconomicsReceipt({
      ...built.economics,
      worldModelReference: { ...WORLD_MODEL_REFERENCE, unreviewed: true }
    }),
    () => buildAutoTokenEconomicsReceipt({
      ...built.economics,
      comprehensionReference: {
        protocol: 'auto-comprehension-reference-v1', packetSha256: HASH('4'),
        subjectSha256: HASH('5'), status: 'guessed'
      }
    }),
    () => buildAutoExecutionUnitSwitch({
      ...built.switchPlan, toExecutionUnit: built.switchPlan.fromExecutionUnit
    })
  ];
  for (const reject of rejected) assert.throws(reject);

  const answered = buildAutoHumanRequest({
    ...built.humanRequest, status: 'answered',
    response: {
      value: { choice: 'sql' }, requestSha256: built.humanRequest.requestSha256,
      responseSha256: `sha256:${recordSha256({
        requestSha256: built.humanRequest.requestSha256, response: { choice: 'sql' }
      })}`
    }
  });
  assert.equal(answered.response.value.choice, 'sql');
  const withComprehension = buildAutoTokenEconomicsReceipt({
    ...built.economics,
    comprehensionReference: {
      protocol: 'auto-comprehension-reference-v1', packetSha256: HASH('7'),
      subjectSha256: HASH('8'), status: 'verified'
    }
  });
  assert.equal(withComprehension.comprehensionReference.status, 'verified');
});

test('AUT v2 private readers verify stored integrity and reject resealed unknown fields', async (t) => {
  const root = await repository(t);
  const { attempt } = records();
  await persistAutoAttempt(root, attempt);
  assert.deepEqual(await readAutoP1Record(root, 'auto-attempt', FLIGHT_ID, attempt.attemptId), attempt);

  const file = path.join(root, '.git', 'singularity-flow', 'auto-flights', FLIGHT_ID,
    'attempts', `${attempt.attemptId}.json`);
  const tampered = JSON.parse(await readFile(file, 'utf8'));
  tampered.reason = 'tampered';
  await writeFile(file, JSON.stringify(tampered));
  await assert.rejects(
    () => readAutoP1Record(root, 'auto-attempt', FLIGHT_ID, attempt.attemptId),
    (error) => error.code === 'AUTO_RECORD_CORRUPT'
  );

  tampered.recordSha256 = autoRecordDigest(tampered);
  tampered.budgetImpact.unreviewed = 1;
  tampered.recordSha256 = autoRecordDigest(tampered);
  await writeFile(file, JSON.stringify(tampered));
  await assert.rejects(
    () => readAutoP1Record(root, 'auto-attempt', FLIGHT_ID, attempt.attemptId),
    (error) => error.code === 'AUTO_RECORD_CORRUPT' && error.details?.unknown?.includes('unreviewed')
  );
});

test('mutable phase-run and attempt records use per-record exact hash CAS under concurrency', async (t) => {
  const { root } = await flight(t, 'mutable-record-cas');
  const built = records();
  const attempt = await persistAutoAttempt(root, built.attempt);
  const phaseRun = await persistAutoPhaseRun(root, built.phaseRun);

  await assert.rejects(
    () => updateAutoAttempt(root, FLIGHT_ID, attempt.attemptId, { status: 'authored' }),
    (error) => error.code === 'AUTO_RECORD_CAS_REQUIRED'
  );
  await assert.rejects(
    () => updateAutoPhaseRun(root, FLIGHT_ID, phaseRun.phaseRunId, { status: 'verifying' }),
    (error) => error.code === 'AUTO_RECORD_CAS_REQUIRED'
  );

  const attemptUpdates = [
    {
      status: 'authored',
      result: { status: 'authored', invocationId: 'invocation-one' }
    },
    {
      status: 'failed',
      result: { status: 'failed', code: 'FAILED', message: 'bounded failure' }
    }
  ];
  const attemptRace = await Promise.allSettled(attemptUpdates.map((update) => (
    updateAutoAttempt(root, FLIGHT_ID, attempt.attemptId, update, {
      expectedRecordSha256: attempt.recordSha256
    })
  )));
  assert.equal(attemptRace.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedAttempt = attemptRace.find((result) => result.status === 'rejected');
  assert.equal(rejectedAttempt.reason.code, 'AUTO_ATTEMPT_STALE');
  const winningAttemptIndex = attemptRace.findIndex((result) => result.status === 'fulfilled');
  const winningAttempt = attemptRace[winningAttemptIndex].value;
  const replayedAttempt = await updateAutoAttempt(
    root, FLIGHT_ID, attempt.attemptId, attemptUpdates[winningAttemptIndex], {
      expectedRecordSha256: attempt.recordSha256
    }
  );
  assert.equal(replayedAttempt.recordSha256, winningAttempt.recordSha256);

  const phaseUpdates = [{ status: 'verifying' }, { status: 'refused' }];
  const phaseRace = await Promise.allSettled(phaseUpdates.map((update) => (
    updateAutoPhaseRun(root, FLIGHT_ID, phaseRun.phaseRunId, update, {
      expectedRecordSha256: phaseRun.recordSha256
    })
  )));
  assert.equal(phaseRace.filter((result) => result.status === 'fulfilled').length, 1);
  const rejectedPhase = phaseRace.find((result) => result.status === 'rejected');
  assert.equal(rejectedPhase.reason.code, 'AUTO_PHASE_RUN_STALE');
  const winningPhaseIndex = phaseRace.findIndex((result) => result.status === 'fulfilled');
  const winningPhase = phaseRace[winningPhaseIndex].value;
  const replayedPhase = await updateAutoPhaseRun(
    root, FLIGHT_ID, phaseRun.phaseRunId, phaseUpdates[winningPhaseIndex], {
      expectedRecordSha256: phaseRun.recordSha256
    }
  );
  assert.equal(replayedPhase.recordSha256, winningPhase.recordSha256);
});

test('per-flight attempt control serializes concurrent starts and reattaches orphan lineage', async (t) => {
  const phase = {
    id: 'implementation', generationIntent: { receiptSha256: HASH('1') }
  };
  const phaseContract = {
    taskContractSha256: HASH('2'), contextContractSha256: HASH('3'),
    executionUnitContractSha256: HASH('4')
  };

  const concurrent = await flight(t, 'lineage-concurrent');
  const starts = await Promise.all([
    beginAutoAttemptLineage(concurrent.root, FLIGHT_ID, { phase, phaseContract }),
    beginAutoAttemptLineage(concurrent.root, FLIGHT_ID, { phase, phaseContract })
  ]);
  assert.equal(new Set(starts.map((entry) => entry.attempt.attemptId)).size, 1);
  assert.equal(new Set(starts.map((entry) => entry.phaseRun.phaseRunId)).size, 1);
  assert.equal((await listAutoP1Records(
    concurrent.root, 'auto-attempt', FLIGHT_ID
  )).length, 1);
  assert.equal((await listAutoP1Records(
    concurrent.root, 'auto-phase-run', FLIGHT_ID
  )).length, 1);

  const crashed = await flight(t, 'lineage-orphan');
  const before = await readAutoFlightState(crashed.root, FLIGHT_ID);
  const orphanAttempt = await persistAutoAttempt(crashed.root, {
    flightId: FLIGHT_ID, phase: phase.id, attemptNumber: 1,
    attemptKind: 'initial', parentAttemptId: null, reason: 'phase-entry',
    generationIntentSha256: HASH('1'), taskContractSha256: HASH('2'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'running', budgetImpact: { modelInvocations: 1, repairAttempts: 0 }, result: null
  }, { now: NOW });
  const orphanPhaseRun = await persistAutoPhaseRun(crashed.root, {
    flightId: FLIGHT_ID, phase: phase.id, status: 'running',
    attemptIds: [orphanAttempt.attemptId], activeAttemptId: orphanAttempt.attemptId,
    publishedGenerations: [], requiredHumanRequestIds: [],
    phaseCheckpointSha256: before.checkpointSha256
  }, { now: NOW });
  const recovered = await beginAutoAttemptLineage(
    crashed.root, FLIGHT_ID, { phase, phaseContract }
  );
  assert.equal(recovered.reused, true);
  assert.equal(recovered.attempt.attemptId, orphanAttempt.attemptId);
  assert.equal(recovered.phaseRun.phaseRunId, orphanPhaseRun.phaseRunId);
  assert.equal(recovered.state.activeAttemptId, orphanAttempt.attemptId);
  assert.equal(recovered.state.activePhaseRunId, orphanPhaseRun.phaseRunId);
  assert.equal((await listAutoP1Records(
    crashed.root, 'auto-attempt', FLIGHT_ID
  )).length, 1);
});

test('an active attempt cannot be rebound to a different generation or phase contract', async (t) => {
  const { root } = await flight(t, 'attempt-authority-stale');
  const phase = {
    id: 'implementation', generationIntent: { receiptSha256: HASH('1') }
  };
  const phaseContract = {
    taskContractSha256: HASH('2'), contextContractSha256: HASH('3'),
    executionUnitContractSha256: HASH('4')
  };
  const started = await beginAutoAttemptLineage(root, FLIGHT_ID, { phase, phaseContract });
  const originalSha256 = started.attempt.recordSha256;

  await assert.rejects(
    () => beginAutoAttemptLineage(root, FLIGHT_ID, {
      phase, phaseContract: { ...phaseContract, taskContractSha256: HASH('5') }
    }),
    (error) => error.code === 'AUTO_ATTEMPT_AUTHORITY_STALE'
      && error.details?.mismatchedFields?.includes('taskContractSha256')
  );
  await assert.rejects(
    () => beginAutoAttemptLineage(root, FLIGHT_ID, {
      phase: { ...phase, generationIntent: { receiptSha256: HASH('6') } }, phaseContract
    }),
    (error) => error.code === 'AUTO_ATTEMPT_AUTHORITY_STALE'
      && error.details?.mismatchedFields?.includes('generationIntentSha256')
  );
  const retained = await readAutoP1Record(
    root, 'auto-attempt', FLIGHT_ID, started.attempt.attemptId
  );
  assert.equal(retained.recordSha256, originalSha256);
  assert.equal(retained.generationIntentSha256, HASH('1'));
  assert.equal(retained.taskContractSha256, HASH('2'));
});

test('an active attempt cannot be reused by a different phase with coincident authority hashes', async (t) => {
  const { root } = await flight(t, 'attempt-phase-stale');
  const phase = {
    id: 'implementation', generationIntent: { receiptSha256: HASH('1') }
  };
  const phaseContract = {
    taskContractSha256: HASH('2'), contextContractSha256: HASH('3'),
    executionUnitContractSha256: HASH('4')
  };
  const started = await beginAutoAttemptLineage(root, FLIGHT_ID, { phase, phaseContract });

  await assert.rejects(
    () => beginAutoAttemptLineage(root, FLIGHT_ID, {
      phase: { ...phase, id: 'planning' }, phaseContract
    }),
    (error) => error.code === 'AUTO_ATTEMPT_AUTHORITY_STALE'
      && error.details?.mismatchedFields?.includes('phase')
  );
  const retained = await readAutoP1Record(
    root, 'auto-attempt', FLIGHT_ID, started.attempt.attemptId
  );
  assert.equal(retained.phase, 'implementation');
});

test('an orphan live attempt with stale authority blocks a second model attempt', async (t) => {
  const { root } = await flight(t, 'attempt-orphan-stale');
  const phase = {
    id: 'implementation', generationIntent: { receiptSha256: HASH('1') }
  };
  await persistAutoAttempt(root, {
    flightId: FLIGHT_ID, phase: phase.id, attemptNumber: 1,
    attemptKind: 'initial', parentAttemptId: null, reason: 'phase-entry',
    generationIntentSha256: HASH('1'), taskContractSha256: HASH('9'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'running', budgetImpact: { modelInvocations: 1, repairAttempts: 0 }, result: null
  }, { now: NOW });

  await assert.rejects(
    () => beginAutoAttemptLineage(root, FLIGHT_ID, {
      phase,
      phaseContract: {
        taskContractSha256: HASH('2'), contextContractSha256: HASH('3'),
        executionUnitContractSha256: HASH('4')
      }
    }),
    (error) => error.code === 'AUTO_ATTEMPT_AUTHORITY_STALE'
      && error.details?.attemptIds?.length === 1
  );
  assert.equal((await listAutoP1Records(root, 'auto-attempt', FLIGHT_ID)).length, 1);
});

test('AUT v2 private readers verify and migrate every frozen v1 P1 family without rewriting bytes', async (t) => {
  const root = await repository(t, 'p1-v1-migrations');
  const goldens = JSON.parse(await readFile(new URL(
    './fixtures/schema-migrations/goldens.json', import.meta.url
  ), 'utf8'));
  const locations = {
    'auto-phase-run': ['phase-runs', 'phaseRunId'],
    'auto-attempt': ['attempts', 'attemptId'],
    'auto-refusal': ['refusals', 'refusalId'],
    'auto-repair-plan': ['repair-plans', 'repairPlanId'],
    'auto-human-request': ['human-requests', 'requestId'],
    'auto-token-economics-receipt': ['economics', 'attemptId'],
    'auto-execution-unit-switch': ['execution-unit-switches', 'switchPlanId']
  };
  for (const [family, [directory, idField]] of Object.entries(locations)) {
    const legacy = goldens[family].find((entry) => entry.schemaVersion === 1);
    const target = path.join(root, '.git', 'singularity-flow', 'auto-flights', legacy.flightId,
      directory, `${legacy[idField]}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = `${JSON.stringify(legacy)}\n`;
    await writeFile(target, bytes);
    const migrated = await readAutoP1Record(root, family, legacy.flightId, legacy[idField]);
    assert.equal(migrated.schemaVersion, currentSchemaVersion(family), family);
    assert.equal(await readFile(target, 'utf8'), bytes, `${family} rewrote archival bytes`);
  }
});

test('Human Request v2 migration accepts only the historical v2 vocabulary', async (t) => {
  const root = await repository(t, 'human-request-v2-vocabulary');
  const current = records().humanRequest;
  const resealV2 = (value) => {
    const legacy = { ...structuredClone(value), schemaVersion: 2 };
    delete legacy.requestSha256;
    legacy.requestSha256 = autoRecordDigest(legacy, 'requestSha256');
    return legacy;
  };
  const valid = resealV2(current);
  const directory = path.join(
    root, '.git', 'singularity-flow', 'auto-flights', FLIGHT_ID, 'human-requests'
  );
  await mkdir(directory, { recursive: true });
  const validPath = path.join(directory, `${valid.requestId}.json`);
  const validBytes = `${JSON.stringify(valid)}\n`;
  await writeFile(validPath, validBytes);

  const migrated = await readAutoP1Record(
    root, 'auto-human-request', FLIGHT_ID, valid.requestId
  );
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.requestType, 'architecture-choice');
  assert.deepEqual(readRecord('auto-human-request', valid).migratedThrough, [
    { from: 2, to: 3 }
  ]);
  assert.equal(await readFile(validPath, 'utf8'), validBytes);

  const forged = resealV2({
    ...current,
    requestId: `AHR-${'F'.repeat(26)}`,
    requestType: 'risk-acceptance',
    title: 'Forged v3-only type under a v2 stamp',
    detail: { reason: 'This type did not exist in v2.' },
    options: ['accept', 'reject']
  });
  await writeFile(path.join(directory, `${forged.requestId}.json`), `${JSON.stringify(forged)}\n`);
  assert.throws(
    () => readRecord('auto-human-request', forged),
    (error) => error.code === 'SCHEMA_MIGRATION_SOURCE_CORRUPT'
      && error.details?.storedVersion === 2
  );
  await assert.rejects(
    () => readAutoP1Record(root, 'auto-human-request', FLIGHT_ID, forged.requestId),
    (error) => error.code === 'AUTO_RECORD_CORRUPT'
      && /must be one of/.test(error.message)
  );
});

test('token economics observation replay reuses the first exact receipt instead of conflicting', async (t) => {
  const root = await repository(t, 'economics-replay');
  const { economics } = records();
  const { schemaVersion: _schema, kind: _kind, mode: _mode, createdAt: _created,
    receiptSha256: _receipt, ...input } = economics;
  const first = await persistAutoTokenEconomicsReceipt(root, input, {
    now: () => '2026-09-01T01:00:00.000Z'
  });
  const replay = await persistAutoTokenEconomicsReceipt(root, input, {
    now: () => '2026-09-01T02:00:00.000Z'
  });
  assert.deepEqual(replay, first);
  assert.equal(replay.createdAt, '2026-09-01T01:00:00.000Z');
});

test('token economics finalization is exact-CAS, idempotent, and rejects conflicting reclassification', async (t) => {
  const root = await repository(t, 'economics-finalize');
  const { economics } = records();
  const initial = await persistAutoTokenEconomicsReceipt(root, economics);
  const quality = { ...initial.quality, verification: 'passed' };
  const finalized = await updateAutoTokenEconomicsReceipt(
    root, FLIGHT_ID, initial.attemptId,
    { quality, classification: 'verified-first-pass' },
    { expectedReceiptSha256: initial.receiptSha256 }
  );
  assert.equal(finalized.quality.verification, 'passed');
  assert.equal(finalized.classification, 'verified-first-pass');
  assert.notEqual(finalized.receiptSha256, initial.receiptSha256);

  const replay = await updateAutoTokenEconomicsReceipt(
    root, FLIGHT_ID, initial.attemptId,
    { quality, classification: 'verified-first-pass' },
    { expectedReceiptSha256: initial.receiptSha256 }
  );
  assert.deepEqual(replay, finalized);
  await assert.rejects(
    () => updateAutoTokenEconomicsReceipt(
      root, FLIGHT_ID, initial.attemptId,
      {
        quality: { ...quality, verification: 'failed' },
        classification: 'verification-failed'
      },
      { expectedReceiptSha256: finalized.receiptSha256 }
    ),
    (error) => error.code === 'AUTO_ECONOMICS_RECEIPT_FINALIZED'
  );
});

test('attempt lineage reuses the exact pinned phase-contract hashes', async (t) => {
  const { root, state } = await flight(t, 'phase-contract');
  const running = await mutateAutoFlightState(root, FLIGHT_ID, (draft) => { draft.status = 'running'; });
  const phaseContract = {
    contractSha256: HASH('1'), taskContractSha256: HASH('2'),
    contextContractSha256: HASH('3'), executionUnitContractSha256: HASH('4')
  };
  const lineage = await beginAutoAttemptLineage(root, FLIGHT_ID, {
    phase: {
      id: state.story.phase,
      generationIntent: { receiptSha256: HASH('8') }
    },
    phaseContract
  });
  assert.equal(lineage.state.status, running.status);
  assert.equal(lineage.attempt.generationIntentSha256, HASH('8'));
  assert.equal(lineage.attempt.taskContractSha256, phaseContract.taskContractSha256);
  assert.equal(lineage.attempt.contextManifestSha256, phaseContract.contextContractSha256);
  assert.equal(lineage.attempt.executionUnitManifestSha256, phaseContract.executionUnitContractSha256);

  const completed = await recordAutoAttemptCompleted(root, FLIGHT_ID, lineage.attempt.attemptId, {
    candidateSha256: HASH('5'), verificationReceiptSha256: HASH('6'),
    publicationReceiptSha256: HASH('7')
  });
  assert.equal(completed.verificationReceiptSha256, HASH('6'));
  const executor = await readFile(new URL('../src/auto/auto-executor.mjs', import.meta.url), 'utf8');
  assert.match(executor, /verificationReceiptSha256:\s*stopped\.candidate\?\.verificationReceiptSha256/);
  assert.doesNotMatch(executor, /verificationReceiptSha256:\s*submittedPacket\?\.packetSha256/);
});

test('repair is ask-only, exact-hash authorized once, and creates a lineage-linked attempt', async (t) => {
  const { root } = await flight(t, 'repair');
  const { attempt, refusal } = records();
  await persistAutoAttempt(root, attempt);
  await persistAutoRefusal(root, refusal);
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.status = 'waiting-human';
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.candidate = {
      candidateId: `CAN-${'C'.repeat(26)}`, candidateSha256: refusal.subject.candidateSha256,
      bindingSha256: HASH('b'), attemptId: attempt.attemptId,
      applicationChangeSetDigest: HASH('c'), applicationResourceDigest: HASH('d')
    };
  });

  const preview = await planAutoRepair(root, FLIGHT_ID, refusal.refusalId);
  assert.equal((await readAutoFlightState(root, FLIGHT_ID)).status, 'waiting-human');
  await assert.rejects(
    () => authorizeAutoRepair(root, FLIGHT_ID, preview.repairPlan.repairPlanId, HASH('f')),
    (error) => error.code === 'AUTO_REPAIR_CONFIRMATION_REQUIRED'
  );
  const authorized = await authorizeAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId, preview.repairPlan.repairPlanSha256,
    {
      publishBoundary: governedBoundaryPublisher(),
      loadStoryAuthority: async () => ({
        phase: { generationIntent: { receiptSha256: HASH('9') } }
      })
    }
  );
  assert.equal(authorized.flight.status, 'running');
  assert.equal(authorized.flight.position, 'repair-authorized');
  assert.equal(authorized.attempt.attemptKind, 'repair');
  assert.equal(authorized.attempt.parentAttemptId, attempt.attemptId);
  assert.equal(authorized.attempt.generationIntentSha256, HASH('9'));
  assert.equal(authorized.flight.repairAttempts[0].checkpointSha256, HASH('1'));
  assert.equal(authorized.flight.repairAttempts.length, 1);
  const replay = await authorizeAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId, preview.repairPlan.repairPlanSha256
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.attemptId, authorized.attempt.attemptId);
  assert.equal(replay.flight.checkpointSha256, authorized.flight.checkpointSha256);
});

test('human repair cannot erase an unquiesced stop or bypass an open Human Request', async (t) => {
  const { root } = await flight(t, 'repair-stop-boundary');
  const { attempt, refusal } = records();
  await persistAutoAttempt(root, attempt);
  await persistAutoRefusal(root, refusal);
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.status = 'paused';
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.candidate = {
      candidateId: `CAN-${'C'.repeat(26)}`, candidateSha256: refusal.subject.candidateSha256,
      bindingSha256: HASH('b'), attemptId: attempt.attemptId,
      applicationChangeSetDigest: HASH('c'), applicationResourceDigest: HASH('d')
    };
    state.stopRequested = {
      kind: 'pause', requestId: 'repair-stop-boundary', requestedAt: NOW()
    };
  });
  const preview = await planAutoRepair(root, FLIGHT_ID, refusal.refusalId);
  const authorize = () => authorizeAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId,
    preview.repairPlan.repairPlanSha256, {
      publishBoundary: governedBoundaryPublisher(),
      loadStoryAuthority: async () => ({
        phase: { generationIntent: { receiptSha256: HASH('9') } }
      })
    }
  );

  await assert.rejects(authorize, (error) => error.code === 'AUTO_REPAIR_NOT_QUIESCENT');
  const stopped = await readAutoFlightState(root, FLIGHT_ID);
  assert.equal(stopped.status, 'paused');
  assert.equal(stopped.stopRequested.requestId, 'repair-stop-boundary');
  assert.equal((stopped.repairAttempts ?? []).length, 0);

  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.stopRequested.quiescedAt = NOW();
    state.openHumanRequestIds = [`AHR-${'A'.repeat(26)}`];
  });
  await assert.rejects(authorize, (error) => error.code === 'AUTO_HUMAN_REQUEST_OPEN');
  const blocked = await readAutoFlightState(root, FLIGHT_ID);
  assert.deepEqual(blocked.openHumanRequestIds, [`AHR-${'A'.repeat(26)}`]);
  assert.equal((blocked.repairAttempts ?? []).length, 0);
});

test('repair authorization replay accepts its expected position transition', async (t) => {
  const { root } = await flight(t, 'repair-publication-replay');
  const { attempt } = records();
  const refusal = buildAutoRefusal({
    flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
    gate: 'generation-publication', code: 'PUBLISH_REFUSED',
    subject: { candidateSha256: HASH('6') },
    missing: [{ evidence: 'publishable generation' }],
    preserved: { paths: ['src/a.mjs'] },
    repair: {
      eligibility: 'ask-only', operation: 'auto.repair',
      scope: ['src/a.mjs'], maximumAttempts: 1
    },
    primaryNextAction: { operation: 'auto.repair', label: 'Review repair' }
  }, { now: NOW });
  await persistAutoAttempt(root, attempt);
  await persistAutoRefusal(root, refusal);
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.status = 'waiting-human';
    state.position = 'authored';
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.candidate = {
      candidateId: `CAN-${'C'.repeat(26)}`, candidateSha256: refusal.subject.candidateSha256,
      bindingSha256: HASH('b'), attemptId: attempt.attemptId,
      applicationChangeSetDigest: HASH('c'), applicationResourceDigest: HASH('d')
    };
  });
  const preview = await planAutoRepair(root, FLIGHT_ID, refusal.refusalId);
  const options = {
    publishBoundary: governedBoundaryPublisher(),
    loadStoryAuthority: async () => ({
      phase: { generationIntent: { receiptSha256: HASH('9') } }
    })
  };
  const authorized = await authorizeAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId,
    preview.repairPlan.repairPlanSha256, options
  );
  assert.equal(authorized.flight.position, 'repair-authorized');
  const replay = await authorizeAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId,
    preview.repairPlan.repairPlanSha256, options
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.attempt.attemptId, authorized.attempt.attemptId);
});

test('automatic repair heals a crash-window reservation before any executor can use it', async (t) => {
  const { root } = await flight(t, 'automatic-repair-publication-replay');
  const { attempt } = records();
  const refusal = buildAutoRefusal({
    flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
    gate: 'generation-publication', code: 'AUTO_CANDIDATE_VERIFICATION_FAILED',
    subject: { candidateSha256: HASH('6') },
    missing: [{ evidence: '{"kind":"structured-test-failure"}' }],
    preserved: { paths: ['src/a.mjs'] },
    repair: {
      eligibility: 'auto-eligible', operation: 'auto.repair',
      scope: ['src/a.mjs'], maximumAttempts: 1
    },
    primaryNextAction: { operation: 'auto.repair', label: 'Run bounded repair' }
  }, { now: NOW });
  await persistAutoAttempt(root, attempt);
  await persistAutoRefusal(root, refusal);
  let waiting = await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.status = 'waiting-human';
    state.position = 'authored';
    state.execution.repair.policy = 'auto-on-machine-actionable';
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.candidate = {
      candidateId: `CAN-${'C'.repeat(26)}`, candidateSha256: refusal.subject.candidateSha256,
      bindingSha256: HASH('b'), attemptId: attempt.attemptId,
      applicationChangeSetDigest: HASH('c'), applicationResourceDigest: HASH('d')
    };
  });
  const preview = await planAutoRepair(
    root, FLIGHT_ID, refusal.refusalId, { expectedCheckpoint: waiting.checkpointSha256 }
  );
  waiting = await readAutoFlightState(root, FLIGHT_ID);
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const delayedPublisher = governedBoundaryPublisher();
  const interrupted = authorizeAutomaticAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId, {
      expectedCheckpoint: waiting.checkpointSha256,
      loadStoryAuthority: async () => ({
        phase: { generationIntent: { receiptSha256: HASH('9') } }
      }),
      publishBoundary: async (...args) => {
        enteredResolve();
        await release;
        return delayedPublisher(...args);
      }
    }
  );
  const interruptedRejection = interrupted.catch((error) => error);
  await entered;
  const crashWindow = await readAutoFlightState(root, FLIGHT_ID);
  assert.equal(crashWindow.status, 'running');
  assert.equal(crashWindow.position, 'repair-authorized');
  assert.equal(crashWindow.repairAttempts[0].checkpointSha256, undefined);

  const calls = [];
  const recovered = await authorizeAutomaticAutoRepair(
    root, FLIGHT_ID, preview.repairPlan.repairPlanId, {
      expectedCheckpoint: crashWindow.checkpointSha256,
      publishBoundary: governedBoundaryPublisher(calls)
    }
  );
  assert.equal(recovered.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(recovered.flight.repairAttempts[0].checkpointSha256, HASH('1'));
  assert.equal(recovered.flight.boundaryCheckpoint.position, 'repair-authorized');
  releaseResolve();
  assert.equal((await interruptedRejection).code, 'AUTO_CHECKPOINT_STALE');
});

test('Repair Plans fail closed when refusal, attempt, or Candidate authority changes', async (t) => {
  const { root } = await flight(t, 'repair-stale');
  const { attempt, refusal } = records();
  await persistAutoAttempt(root, attempt);
  await persistAutoRefusal(root, refusal);
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.status = 'waiting-human';
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.candidate = {
      candidateId: `CAN-${'D'.repeat(26)}`, candidateSha256: refusal.subject.candidateSha256,
      bindingSha256: HASH('b'), attemptId: attempt.attemptId,
      applicationChangeSetDigest: HASH('c'), applicationResourceDigest: HASH('d')
    };
  });
  const preview = await planAutoRepair(root, FLIGHT_ID, refusal.refusalId);
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.activeRefusalId = null;
  });
  await assert.rejects(
    () => authorizeAutoRepair(
      root, FLIGHT_ID, preview.repairPlan.repairPlanId,
      preview.repairPlan.repairPlanSha256
    ),
    (error) => error.code === 'AUTO_REPAIR_PLAN_STALE'
  );
  await assert.rejects(
    () => planAutoRepair(root, FLIGHT_ID, refusal.refusalId),
    (error) => error.code === 'AUTO_REFUSAL_STALE'
  );
});

test('typed Human Requests require exact CAS, reject secret-shaped credential answers, and block resume', async (t) => {
  const { root } = await flight(t, 'request');
  const boundaryCalls = [];
  const options = { publishBoundary: governedBoundaryPublisher(boundaryCalls) };
  const created = await createAutoHumanBoundary(root, FLIGHT_ID, {
    requestType: 'credential', title: 'Connect approved broker', detail: { provider: 'office' }, options: []
  }, options);
  assert.equal(boundaryCalls.length, 1);
  assert.equal(created.flight.boundaryCheckpoint.checkpointClass, 'human-boundary');
  assert.equal(created.flight.lastSuccessfulStoryRevision, '1'.repeat(40));
  await assert.rejects(
    () => resumeAutoFlight(root, FLIGHT_ID, created.flight.checkpointSha256),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_REQUIRED'
  );
  await assert.rejects(
    () => respondAutoHumanRequest(root, FLIGHT_ID, created.request.requestId,
      { secret: 'do-not-store' }, created.request.requestSha256),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID'
  );
  await assert.rejects(
    () => respondAutoHumanRequest(root, FLIGHT_ID, created.request.requestId,
      { brokerReference: 'broker://office/copilot', status: 'available' }, HASH('e')),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_CONFIRMATION_REQUIRED'
  );
  const answered = await respondAutoHumanRequest(root, FLIGHT_ID, created.request.requestId,
    { brokerReference: 'broker://office/copilot', status: 'available' },
    created.request.requestSha256, options);
  assert.equal(answered.request.status, 'answered');
  assert.equal(answered.flight.status, 'paused');
  assert.deepEqual(answered.flight.openHumanRequestIds, []);
  assert.equal(answered.flight.humanRequestDecisions[0].requestId, created.request.requestId);
  assert.equal(boundaryCalls.length, 2);
  assert.equal(answered.flight.boundaryCheckpoints.length, 2);
  const replay = await respondAutoHumanRequest(root, FLIGHT_ID, created.request.requestId,
    { brokerReference: 'broker://office/copilot', status: 'available' },
    created.request.requestSha256, options);
  assert.equal(replay.replayed, true);
  assert.equal(replay.flight.checkpointSha256, answered.flight.checkpointSha256);
  assert.equal(boundaryCalls.length, 2);
});

test('every judgment Human Request accepts only one exact offered choice', async (t) => {
  const { root } = await flight(t, 'request-judgment-choice');
  const options = { publishBoundary: governedBoundaryPublisher() };
  const created = await createAutoHumanBoundary(root, FLIGHT_ID, {
    requestType: 'risk-acceptance', title: 'Choose risk disposition',
    detail: { reason: 'A human judgment boundary is required.' },
    options: ['accept-risk', 'reject-risk']
  }, options);
  await assert.rejects(
    () => respondAutoHumanRequest(root, FLIGHT_ID, created.request.requestId,
      { answer: 'accept-risk' }, created.request.requestSha256, options),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID'
  );
  const answered = await respondAutoHumanRequest(
    root, FLIGHT_ID, created.request.requestId,
    { choice: 'accept-risk' }, created.request.requestSha256, options
  );
  assert.equal(answered.request.status, 'answered');
  assert.deepEqual(answered.request.response.value, { choice: 'accept-risk' });
});

test('a Human Request is never reported durable when its governed boundary checkpoint cannot publish', async (t) => {
  const { root } = await flight(t, 'request-publication-failure');
  await assert.rejects(
    () => createAutoHumanBoundary(root, FLIGHT_ID, {
      requestType: 'clarification', title: 'Clarify exact behavior',
      detail: { question: 'Which accepted behavior applies?' }, options: []
    }, {
      publishBoundary: async () => {
        const error = new Error('remote rejected checkpoint');
        error.code = 'GIT_PUSH_FAILED';
        throw error;
      }
    }),
    (error) => error.code === 'AUTO_CHECKPOINT_PUBLICATION_FAILED'
      && error.details?.status === 'recovery-required'
  );
  const state = await readAutoFlightState(root, FLIGHT_ID);
  assert.equal(state.status, 'recovery-required');
  assert.equal(state.stopReason, 'human-boundary-checkpoint-publication-failed');
  assert.equal(state.openHumanRequestIds.length, 1);
});

test('a Human Request written before a crashed flight CAS is exactly reattached on retry', async (t) => {
  const { root } = await flight(t, 'request-pre-cas-crash');
  const value = {
    requestType: 'clarification', title: 'Clarify exact behavior',
    detail: { question: 'Which accepted behavior applies?' }, options: []
  };
  await assert.rejects(
    () => createAutoHumanBoundary(root, FLIGHT_ID, value, {
      now: () => '2026-09-01T00:00:00.000Z',
      mutateFlightState: async () => {
        const error = new Error('injected process stop before flight CAS');
        error.code = 'INJECTED_PROCESS_STOP';
        throw error;
      }
    }),
    (error) => error.code === 'INJECTED_PROCESS_STOP'
  );
  const [orphanedBeforeRetry] = await listAutoP1Records(
    root, 'auto-human-request', FLIGHT_ID
  );
  assert.equal(orphanedBeforeRetry.status, 'open');
  const beforeRetry = await readAutoFlightState(root, FLIGHT_ID);
  assert.deepEqual(beforeRetry.openHumanRequestIds ?? [], []);

  const boundaryCalls = [];
  const recovered = await createAutoHumanBoundary(root, FLIGHT_ID, value, {
    now: () => '2026-09-01T00:01:00.000Z',
    publishBoundary: governedBoundaryPublisher(boundaryCalls)
  });
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.request.requestId, orphanedBeforeRetry.requestId);
  assert.equal(recovered.request.requestSha256, orphanedBeforeRetry.requestSha256);
  assert.equal(recovered.request.createdAt, orphanedBeforeRetry.createdAt);
  assert.deepEqual(recovered.flight.openHumanRequestIds, [orphanedBeforeRetry.requestId]);
  assert.equal(recovered.flight.status, 'waiting-human');
  assert.equal(boundaryCalls.length, 1);
  const requests = await listAutoP1Records(root, 'auto-human-request', FLIGHT_ID);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], orphanedBeforeRetry);
});

test('a Human Request CAS race reuses one immutable request and retries the attachment', async (t) => {
  const { root } = await flight(t, 'request-cas-race');
  let raced = false;
  const recovered = await createAutoHumanBoundary(root, FLIGHT_ID, {
    requestType: 'clarification', title: 'Clarify exact behavior',
    detail: { question: 'Which accepted behavior applies?' }, options: []
  }, {
    publishBoundary: governedBoundaryPublisher(),
    mutateFlightState: async (...args) => {
      if (!raced) {
        raced = true;
        await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
          draft.nextAction = 'Concurrent deterministic status refresh.';
        });
      }
      return mutateAutoFlightState(...args);
    }
  });
  assert.equal(raced, true);
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.flight.openHumanRequestIds, [recovered.request.requestId]);
  assert.equal((await listAutoP1Records(root, 'auto-human-request', FLIGHT_ID)).length, 1);
});

test('Human Request responses reject expiry, phase drift, and stale mutable-record CAS', async (t) => {
  const { root } = await flight(t, 'request-stale');
  const options = { publishBoundary: governedBoundaryPublisher() };
  const created = await createAutoHumanBoundary(root, FLIGHT_ID, {
    requestType: 'clarification', title: 'Choose exact output',
    detail: { question: 'Which output is authoritative?' }, options: [],
    expiresAt: '2026-09-01T00:00:01.000Z'
  }, options);
  await assert.rejects(
    () => respondAutoHumanRequest(
      root, FLIGHT_ID, created.request.requestId, { answer: 'CSV' },
      created.request.requestSha256,
      { ...options, now: () => '2026-09-01T00:00:02.000Z' }
    ),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_EXPIRED'
  );
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.story.phase = 'verification';
  });
  await assert.rejects(
    () => respondAutoHumanRequest(
      root, FLIGHT_ID, created.request.requestId, { answer: 'CSV' },
      created.request.requestSha256,
      { ...options, now: () => '2026-09-01T00:00:00.500Z' }
    ),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_STALE'
  );
  const cancelled = await updateAutoHumanRequest(
    root, FLIGHT_ID, created.request.requestId, { status: 'cancelled', response: null },
    { expectedRequestSha256: created.request.requestSha256 }
  );
  await assert.rejects(
    () => updateAutoHumanRequest(
      root, FLIGHT_ID, created.request.requestId, { status: 'open', response: null },
      { expectedRequestSha256: created.request.requestSha256 }
    ),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_STALE'
  );
  assert.equal(cancelled.status, 'cancelled');
});

test('Execution Unit switching uses pinned Story authority and publishes an exact Human Boundary', async (t) => {
  const { root } = await flight(t, 'execution-unit-switch');
  const { attempt } = records();
  await persistAutoAttempt(root, attempt);
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.activeAttemptId = attempt.attemptId;
    draft.attemptIds = [attempt.attemptId];
    draft.executionUnit = { id: 'copilot', manifestSha256: HASH('1') };
  });
  const authorityCalls = [];
  const loadStoryAuthority = async (state) => {
    authorityCalls.push(state.worktree);
    return {
      definition: {
        models: {
          defaultProvider: 'copilot',
          providers: { copilot: { type: 'copilot-cli' }, office: { type: 'copilot-cli' } }
        }
      }
    };
  };
  const planned = await planAutoExecutionUnitSwitch(
    root, FLIGHT_ID, 'office', 'approved office route', { loadStoryAuthority }
  );
  const applied = await confirmAutoExecutionUnitSwitch(
    root, FLIGHT_ID, planned.switchPlan.switchPlanId, planned.switchPlan.switchPlanSha256,
    { loadStoryAuthority, publishBoundary: governedBoundaryPublisher() }
  );
  assert.equal(applied.flight.executionUnit.id, 'office');
  assert.equal(applied.attempt.parentAttemptId, attempt.attemptId);
  assert.equal(applied.flight.executionUnitSwitches[0].checkpointSha256, HASH('1'));
  assert.equal(applied.flight.boundaryCheckpoint.checkpointClass, 'human-boundary');
  assert.equal(authorityCalls.length, 2);

  const replay = await confirmAutoExecutionUnitSwitch(
    root, FLIGHT_ID, planned.switchPlan.switchPlanId, planned.switchPlan.switchPlanSha256
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.flight.checkpointSha256, applied.flight.checkpointSha256);
  assert.equal(authorityCalls.length, 2);
});

test('Execution Unit switch resume consumes only its route marker and mints one exact authoring attempt', async (t) => {
  const { root } = await flight(t, 'execution-unit-switch-resume');
  const { attempt } = records();
  const completedParent = buildAutoAttempt({
    ...attempt, status: 'completed', result: { status: 'completed' }
  }, { now: NOW });
  await persistAutoAttempt(root, completedParent);
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.activeAttemptId = completedParent.attemptId;
    draft.attemptIds = [completedParent.attemptId];
    draft.executionUnit = { id: 'copilot', manifestSha256: HASH('1') };
    draft.counters.authoringAttempts.implementation = 1;
    draft.counters.modelInvocations = 1;
  });
  const loadStoryAuthority = async () => ({
    definition: {
      models: {
        defaultProvider: 'copilot',
        providers: { copilot: { type: 'copilot-cli' }, office: { type: 'copilot-cli' } }
      }
    }
  });
  const planned = await planAutoExecutionUnitSwitch(
    root, FLIGHT_ID, 'office', 'approved office route', { loadStoryAuthority }
  );
  const applied = await confirmAutoExecutionUnitSwitch(
    root, FLIGHT_ID, planned.switchPlan.switchPlanId, planned.switchPlan.switchPlanSha256,
    { loadStoryAuthority, publishBoundary: governedBoundaryPublisher() }
  );
  const markerBeforeResume = await readAutoP1Record(
    root, 'auto-attempt', FLIGHT_ID, applied.attempt.attemptId
  );
  assert.equal(markerBeforeResume.status, 'planned');
  assert.equal(markerBeforeResume.budgetImpact.modelInvocations, 0);
  assert.equal(markerBeforeResume.budgetImpact.routeChanges, 1);

  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.status = 'running';
    draft.stopReason = 'human-resumed';
    draft.counters.authoringAttempts.implementation = 2;
    draft.counters.modelInvocations = 2;
  });
  const phase = {
    id: 'implementation',
    generationIntent: { id: 'GEN-2', receiptSha256: HASH('8') }
  };
  const phaseContract = {
    attemptId: autoAttemptId({
      flightId: FLIGHT_ID, phase: phase.id, attemptNumber: 2,
      generationIntentId: phase.generationIntent.id
    }),
    taskContractSha256: HASH('a'), contextContractSha256: HASH('b'),
    executionUnitContractSha256: HASH('c')
  };
  const started = await beginAutoAttemptLineage(root, FLIGHT_ID, { phase, phaseContract });
  assert.equal(started.reused, false);
  assert.equal(started.attempt.attemptId, phaseContract.attemptId);
  assert.equal(started.attempt.attemptNumber, 2);
  assert.equal(started.attempt.attemptKind, 'resume');
  assert.equal(started.attempt.parentAttemptId, markerBeforeResume.attemptId);
  assert.equal(started.attempt.reason,
    `execution-unit-switch-authoring:${planned.switchPlan.switchPlanId}`);
  assert.equal(started.attempt.generationIntentSha256, HASH('8'));
  assert.equal(started.attempt.taskContractSha256, phaseContract.taskContractSha256);
  assert.equal(started.attempt.contextManifestSha256, phaseContract.contextContractSha256);
  assert.equal(started.attempt.executionUnitManifestSha256,
    phaseContract.executionUnitContractSha256);
  assert.equal(started.attempt.budgetImpact.modelInvocations, 1);

  const markerAfterResume = await readAutoP1Record(
    root, 'auto-attempt', FLIGHT_ID, markerBeforeResume.attemptId
  );
  assert.equal(markerAfterResume.status, 'completed');
  assert.deepEqual({
    attemptId: markerAfterResume.attemptId,
    attemptNumber: markerAfterResume.attemptNumber,
    attemptKind: markerAfterResume.attemptKind,
    parentAttemptId: markerAfterResume.parentAttemptId,
    reason: markerAfterResume.reason,
    generationIntentSha256: markerAfterResume.generationIntentSha256,
    taskContractSha256: markerAfterResume.taskContractSha256,
    contextManifestSha256: markerAfterResume.contextManifestSha256,
    executionUnitManifestSha256: markerAfterResume.executionUnitManifestSha256,
    budgetImpact: markerAfterResume.budgetImpact,
    createdAt: markerAfterResume.createdAt
  }, {
    attemptId: markerBeforeResume.attemptId,
    attemptNumber: markerBeforeResume.attemptNumber,
    attemptKind: markerBeforeResume.attemptKind,
    parentAttemptId: markerBeforeResume.parentAttemptId,
    reason: markerBeforeResume.reason,
    generationIntentSha256: markerBeforeResume.generationIntentSha256,
    taskContractSha256: markerBeforeResume.taskContractSha256,
    contextManifestSha256: markerBeforeResume.contextManifestSha256,
    executionUnitManifestSha256: markerBeforeResume.executionUnitManifestSha256,
    budgetImpact: markerBeforeResume.budgetImpact,
    createdAt: markerBeforeResume.createdAt
  });

  const replay = await beginAutoAttemptLineage(root, FLIGHT_ID, { phase, phaseContract });
  assert.equal(replay.reused, true);
  assert.equal(replay.attempt.attemptId, started.attempt.attemptId);
  const attempts = await listAutoP1Records(root, 'auto-attempt', FLIGHT_ID);
  assert.equal(attempts.filter((entry) => (
    entry.attemptId === phaseContract.attemptId
  )).length, 1);
});

test('Execution Unit switch resume recovers after its marker settled before child persistence', async (t) => {
  const { root } = await flight(t, 'execution-unit-switch-crash-window');
  const { attempt } = records();
  const completedParent = buildAutoAttempt({
    ...attempt, status: 'completed', result: { status: 'completed' }
  }, { now: NOW });
  await persistAutoAttempt(root, completedParent);
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.activeAttemptId = completedParent.attemptId;
    draft.attemptIds = [completedParent.attemptId];
    draft.executionUnit = { id: 'copilot', manifestSha256: HASH('1') };
    draft.counters.authoringAttempts.implementation = 1;
    draft.counters.modelInvocations = 1;
  });
  const loadStoryAuthority = async () => ({
    definition: {
      models: {
        defaultProvider: 'copilot',
        providers: { copilot: { type: 'copilot-cli' }, office: { type: 'copilot-cli' } }
      }
    }
  });
  const planned = await planAutoExecutionUnitSwitch(
    root, FLIGHT_ID, 'office', 'approved office route', { loadStoryAuthority }
  );
  const applied = await confirmAutoExecutionUnitSwitch(
    root, FLIGHT_ID, planned.switchPlan.switchPlanId, planned.switchPlan.switchPlanSha256,
    { loadStoryAuthority, publishBoundary: governedBoundaryPublisher() }
  );
  const marker = await updateAutoAttempt(
    root, FLIGHT_ID, applied.attempt.attemptId,
    { status: 'completed', result: { status: 'completed' } },
    { expectedRecordSha256: applied.attempt.recordSha256 }
  );
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.activeAttemptId = null;
    draft.status = 'running';
    draft.stopReason = 'human-resumed';
    draft.counters.authoringAttempts.implementation = 2;
    draft.counters.modelInvocations = 2;
  });
  const phase = {
    id: 'implementation',
    generationIntent: { id: 'GEN-2', receiptSha256: HASH('8') }
  };
  const phaseContract = {
    attemptId: autoAttemptId({
      flightId: FLIGHT_ID, phase: phase.id, attemptNumber: 2,
      generationIntentId: phase.generationIntent.id
    }),
    taskContractSha256: HASH('a'), contextContractSha256: HASH('b'),
    executionUnitContractSha256: HASH('c')
  };

  const recovered = await beginAutoAttemptLineage(root, FLIGHT_ID, {
    phase, phaseContract
  });
  assert.equal(recovered.attempt.attemptId, phaseContract.attemptId);
  assert.equal(recovered.attempt.parentAttemptId, marker.attemptId);
  assert.equal(recovered.attempt.reason,
    `execution-unit-switch-authoring:${planned.switchPlan.switchPlanId}`);
  assert.equal((await listAutoP1Records(root, 'auto-attempt', FLIGHT_ID)).filter((entry) => (
    entry.parentAttemptId === marker.attemptId
      && entry.budgetImpact.modelInvocations === 1
  )).length, 1);
});

test('Execution Unit switching rejects open Human Requests and stale route or attempt authority', async (t) => {
  const { root } = await flight(t, 'execution-unit-switch-stale');
  const { attempt } = records();
  await persistAutoAttempt(root, attempt);
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.activeAttemptId = attempt.attemptId;
    draft.attemptIds = [attempt.attemptId];
    draft.executionUnit = { id: 'copilot', manifestSha256: HASH('1') };
  });
  const loadStoryAuthority = async () => ({
    definition: {
      models: {
        defaultProvider: 'copilot',
        providers: {
          copilot: { type: 'copilot-cli' }, office: { type: 'copilot-cli' },
          alternate: { type: 'copilot-cli' }
        }
      }
    }
  });
  const planned = await planAutoExecutionUnitSwitch(
    root, FLIGHT_ID, 'office', 'approved office route', { loadStoryAuthority }
  );
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.executionUnit = { id: 'alternate', manifestSha256: HASH('2') };
  });
  await assert.rejects(
    () => confirmAutoExecutionUnitSwitch(
      root, FLIGHT_ID, planned.switchPlan.switchPlanId,
      planned.switchPlan.switchPlanSha256, { loadStoryAuthority }
    ),
    (error) => error.code === 'AUTO_SWITCH_STALE'
  );
  await mutateAutoFlightState(root, FLIGHT_ID, (draft) => {
    draft.executionUnit = { id: 'copilot', manifestSha256: HASH('1') };
    draft.openHumanRequestIds = [`AHR-${'A'.repeat(26)}`];
    draft.status = 'waiting-human';
  });
  await assert.rejects(
    () => planAutoExecutionUnitSwitch(
      root, FLIGHT_ID, 'office', 'must not bypass request', { loadStoryAuthority }
    ),
    (error) => error.code === 'AUTO_HUMAN_REQUEST_REQUIRED'
  );

  const changedPlan = await updateAutoExecutionUnitSwitch(
    root, FLIGHT_ID, planned.switchPlan.switchPlanId, { status: 'refused' },
    { expectedSwitchPlanSha256: planned.switchPlan.switchPlanSha256 }
  );
  await assert.rejects(
    () => updateAutoExecutionUnitSwitch(
      root, FLIGHT_ID, planned.switchPlan.switchPlanId, { status: 'applied' },
      { expectedSwitchPlanSha256: planned.switchPlan.switchPlanSha256 }
    ),
    (error) => error.code === 'AUTO_SWITCH_STALE'
  );
  assert.equal(changedPlan.status, 'refused');
});

test('P1 Auto commands retain closed model policies and read/mutation classification', () => {
  const operation = (positionals, options = {}) => resolveOperation({
    requestedCommand: 'auto', positionals, options
  });
  assert.deepEqual(
    [operation(['auto', 'continue', 'STORY-1']).id, operation(['auto', 'continue', 'STORY-1']).classification],
    ['auto.continue', 'read']
  );
  assert.equal(operation(['auto', 'needs-you', FLIGHT_ID]).modelPolicy, 'never');
  assert.equal(operation(['auto', 'repair', FLIGHT_ID], { refusal: 'ARF-X' }).id, 'auto.repair.plan');
  assert.equal(operation(['auto', 'repair', FLIGHT_ID], { refusal: 'ARF-X', confirm: HASH('a') }).modelPolicy, 'required');
  assert.equal(operation(['auto', 'respond', FLIGHT_ID], { confirm: HASH('a') }).classification, 'mutation');
  assert.equal(operation(['auto', 'respond', FLIGHT_ID], { confirm: HASH('a') }).modelPolicy, 'never');
  assert.equal(operation(['auto', 'switch-unit', FLIGHT_ID], { 'execution-unit': 'office' }).id, 'auto.switch-unit.plan');
  assert.equal(operation(['auto', 'switch-unit', FLIGHT_ID], {
    'execution-unit': 'office', confirm: HASH('b')
  }).classification, 'mutation');
});
