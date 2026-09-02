import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildAutoFlightReport, createAutoFlightState, mutateAutoFlightState, persistAutoFlightReport,
  projectAutoFlightReport, readAutoFlightReport, restoreAutoFlightReport
} from '../src/auto/auto-flight-store.mjs';
import {
  recordAutoAttemptAuthored, recordAutoAttemptCompleted, recordAutoAttemptPublished,
  recordAutoAttemptRefusal
} from '../src/auto/auto-p1-lineage.mjs';
import {
  persistAutoAttempt, persistAutoExecutionUnitSwitch, persistAutoHumanRequest,
  persistAutoPhaseRun, persistAutoRepairPlan, readAutoP1Record, updateAutoHumanRequest
} from '../src/auto/auto-p1-records.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';

const FLIGHT = `AFL-${'E'.repeat(26)}`;
const PLAN = `APL-${'F'.repeat(26)}`;
const HASH = (character) => `sha256:${character.repeat(64)}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto Report Tester'], root);
  run('git', ['config', 'user.email', 'auto-report@example.com'], root);
  await createAutoFlightState(root, {
    flightId: FLIGHT, planId: PLAN, planSha256: HASH('1'), status: 'running',
    story: { workId: 'AUTO-REPORT', branch: 'AUTO-REPORT', phase: 'implementation' },
    worktree: root, scopePrediction: ['src/'], execution: { ceilings: {} }
  });
  return root;
}

async function attempt(root, {
  attemptNumber, attemptKind, parentAttemptId = null, character
}) {
  return persistAutoAttempt(root, {
    flightId: FLIGHT, phase: 'implementation', attemptNumber, attemptKind,
    parentAttemptId, reason: attemptKind === 'repair' ? 'repair:verified-plan' : 'phase-entry',
    generationIntentSha256: HASH(character), taskContractSha256: HASH('2'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'running', budgetImpact: { modelInvocations: 1 }, result: null
  });
}

function invocation(id, inputTokens, outputTokens, {
  toolOutputBytes = [24], providerToolOutputTokens = null
} = {}) {
  return {
    invocationId: id, promptBytes: 640,
    usage: {
      inputTokens, outputTokens, cachedInputTokens: 3, providerCost: 0.25,
      ...(providerToolOutputTokens == null ? {} : { toolOutputTokens: providerToolOutputTokens })
    },
    toolObservation: {
      status: 'exact', totalCalls: toolOutputBytes.length,
      calls: toolOutputBytes.map((outputBytes, index) => ({
        sequence: index + 1, outputBytes, status: 'completed'
      }))
    },
    economics: {
      prompt: { finalPromptBytes: 640 },
      input: { estimatedTokens: inputTokens - 1, inputTokens, cachedInputTokens: 3 },
      output: { estimatedTokens: outputTokens - 1, outputTokens },
      provider: { providerCost: 0.25 }
    }
  };
}

function resealCurrentReport(value) {
  const report = structuredClone(value);
  delete report.reportSha256;
  delete report.projectionSha256;
  report.reportSha256 = `sha256:${recordSha256(report)}`;
  report.projectionSha256 = `sha256:${recordSha256(report)}`;
  return report;
}

test('the Auto flight report schema stamp follows the migration registry', async () => {
  const schema = JSON.parse(await readFile(new URL(
    '../schemas/auto-flight-report.schema.json', import.meta.url
  ), 'utf8'));
  assert.equal(schema.properties.schemaVersion.const,
    currentSchemaVersion('auto-flight-report'));
});

test('attempt economics is pending at authoring and exact-CAS finalized by the observed outcome', async (t) => {
  const root = await repository(t);
  const initial = await attempt(root, {
    attemptNumber: 1, attemptKind: 'initial', character: '5'
  });
  const authored = await recordAutoAttemptAuthored(root, FLIGHT, initial.attemptId, {
    invocation: invocation('model-first-pass', 12, 5)
  });
  assert.equal(authored.receipt.quality.verification, 'pending');
  assert.equal(authored.receipt.classification, 'first-pass-pending-verification');
  assert.equal(authored.attempt.budgetImpact.toolOutputBytes, 24);
  assert.equal(authored.attempt.budgetImpact.estimatedToolOutputTokens, 6);
  assert.equal(Object.hasOwn(authored.attempt.budgetImpact, 'toolOutputTokens'), false,
    'unavailable provider tool tokens are not fabricated as zero');
  await recordAutoAttemptCompleted(root, FLIGHT, initial.attemptId);
  const passed = await readAutoP1Record(
    root, 'auto-token-economics-receipt', FLIGHT, initial.attemptId
  );
  assert.equal(passed.quality.verification, 'passed');
  assert.equal(passed.quality.firstPass, true);
  assert.equal(passed.quality.repairAttempts, 0);
  assert.equal(passed.classification, 'verified-first-pass');

  const repair = await attempt(root, {
    attemptNumber: 2, attemptKind: 'repair', parentAttemptId: initial.attemptId, character: '6'
  });
  const repairAuthored = await recordAutoAttemptAuthored(root, FLIGHT, repair.attemptId, {
    invocation: invocation('model-repair', 9, 4, {
      toolOutputBytes: [7, 9], providerToolOutputTokens: 5
    })
  });
  assert.equal(repairAuthored.receipt.classification, 'repair-pending-verification');
  assert.equal(repairAuthored.attempt.budgetImpact.toolOutputBytes, 16);
  assert.equal(repairAuthored.attempt.budgetImpact.estimatedToolOutputTokens, 4);
  assert.equal(repairAuthored.attempt.budgetImpact.toolOutputTokens, 5);
  await recordAutoAttemptRefusal(root, FLIGHT, {
    attemptId: repair.attemptId, phase: 'implementation', gate: 'verification',
    code: 'TEST_FAILED', message: 'required test failed', changedPaths: ['src/app.mjs']
  });
  const failed = await readAutoP1Record(
    root, 'auto-token-economics-receipt', FLIGHT, repair.attemptId
  );
  assert.equal(failed.quality.verification, 'failed');
  assert.equal(failed.quality.firstPass, false);
  assert.equal(failed.quality.repairAttempts, 1);
  assert.equal(failed.classification, 'verification-failed');
});

test('a post-verification lifecycle refusal preserves passed economics quality', async (t) => {
  const root = await repository(t);
  const initial = await attempt(root, {
    attemptNumber: 1, attemptKind: 'initial', character: 'd'
  });
  await recordAutoAttemptAuthored(root, FLIGHT, initial.attemptId, {
    invocation: invocation('model-before-publication-refusal', 11, 5)
  });
  await recordAutoAttemptPublished(root, FLIGHT, initial.attemptId, {
    generation: 1, candidateSha256: HASH('e'),
    verificationReceiptSha256: HASH('f'), publicationReceiptSha256: HASH('a')
  });
  await recordAutoAttemptRefusal(root, FLIGHT, {
    attemptId: initial.attemptId, phase: 'implementation', gate: 'verification-or-submission',
    code: 'SUBMISSION_FAILED', message: 'later lifecycle operation refused',
    candidateSha256: HASH('e')
  });
  const receipt = await readAutoP1Record(
    root, 'auto-token-economics-receipt', FLIGHT, initial.attemptId
  );
  const refusedAttempt = await readAutoP1Record(
    root, 'auto-attempt', FLIGHT, initial.attemptId
  );
  assert.equal(refusedAttempt.verificationReceiptSha256, HASH('f'));
  assert.equal(receipt.quality.verification, 'passed');
  assert.equal(receipt.classification, 'verified-first-pass');
});

test('terminal report is an immutable reconstruction of typed P1 lineage and observed economics', async (t) => {
  const root = await repository(t);
  const initial = await attempt(root, {
    attemptNumber: 1, attemptKind: 'initial', character: '7'
  });
  const phaseRun = await persistAutoPhaseRun(root, {
    flightId: FLIGHT, phase: 'implementation', status: 'running',
    attemptIds: [initial.attemptId], activeAttemptId: initial.attemptId,
    publishedGenerations: [], requiredHumanRequestIds: [], phaseCheckpointSha256: HASH('8')
  });
  await recordAutoAttemptAuthored(root, FLIGHT, initial.attemptId, {
    invocation: invocation('model-report', 14, 6)
  });
  await recordAutoAttemptCompleted(root, FLIGHT, initial.attemptId);
  const refusal = (await recordAutoAttemptRefusal(root, FLIGHT, {
    attemptId: null, phase: 'planning', gate: 'deterministic-preflight',
    code: 'PLAN_REVIEW', message: 'review exact Plan', repairScope: ['src/']
  })).refusal;
  await persistAutoRepairPlan(root, {
    flightId: FLIGHT, parentAttemptId: initial.attemptId,
    refusalSha256: refusal.refusalSha256, objective: 'Repair the exact refusal',
    readScope: ['src/'], writeScope: ['src/app.mjs'], forbiddenChanges: ['singularity/'],
    requiredEvidence: ['passing-tests'], budget: { maximumAttempts: 1 }, attemptNumber: 1
  });
  let request = await persistAutoHumanRequest(root, {
    flightId: FLIGHT, phase: 'implementation', attemptId: initial.attemptId,
    requestType: 'clarification', title: 'Confirm output',
    detail: { question: 'Which output?' }, options: [], subjectSha256: HASH('9'),
    policySha256: HASH('a'), checkpointSha256: HASH('b'), status: 'open', response: null
  });
  const response = { answer: 'CSV' };
  request = await updateAutoHumanRequest(root, FLIGHT, request.requestId, {
    status: 'answered',
    response: {
      value: response, requestSha256: request.requestSha256,
      responseSha256: `sha256:${recordSha256({
        requestSha256: request.requestSha256, response
      })}`
    }
  });
  await persistAutoExecutionUnitSwitch(root, {
    flightId: FLIGHT, fromExecutionUnit: 'copilot', toExecutionUnit: 'office-copilot',
    taskContractSha256: HASH('2'), parentAttemptId: initial.attemptId,
    reason: 'approved route', status: 'applied'
  });
  const terminal = await mutateAutoFlightState(root, FLIGHT, (state) => {
    state.status = 'halted';
    state.stopReason = 'human-halted';
    state.nextAction = 'Review the preserved Story.';
    state.observedPaths = ['src/app.mjs'];
    state.phaseRunIds = [phaseRun.phaseRunId];
    state.attemptIds = [initial.attemptId];
    state.refusalIds = [refusal.refusalId];
    state.approvals = [{ phase: 'specification', reviewPacketSha256: HASH('c') }];
  });
  const projected = await projectAutoFlightReport(root, terminal);
  assert.equal(projected.lineage['auto-attempt'].length, 1);
  assert.equal(projected.accounting.observations.receipts, 1);
  const first = await persistAutoFlightReport(root, terminal);
  assert.deepEqual(first, projected);
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.approvalSource, 'flight-checkpoint');
  assert.deepEqual(first.approvals, terminal.approvals);
  assert.equal(first.lineage['auto-phase-run'].length, 1);
  assert.equal(first.lineage['auto-attempt'].length, 1);
  assert.equal(first.lineage['auto-refusal'].length, 1);
  assert.equal(first.lineage['auto-repair-plan'].length, 1);
  assert.equal(first.lineage['auto-human-request'][0].status, 'answered');
  assert.equal(first.lineage['auto-token-economics-receipt'][0].quality.verification, 'passed');
  assert.equal(first.lineage['auto-execution-unit-switch'].length, 1);
  assert.equal(first.accounting.observations.receipts, 1);
  assert.equal(first.accounting.observations.passed, 1);
  assert.equal(first.accounting.tokens.totalTokens, 20);
  assert.equal(first.accounting.cost.amount, 0.25);
  assert.deepEqual(first.accounting.observations.toolOutput, {
    assurance: 'estimated-bytes-per-token-4.0',
    observedBytes: 24, estimatedTokens: 6, providerTokens: null
  });
  assert.equal(first.qualityFloor.status, 'passed');
  assert.equal(first.qualityFloor.basis, 'observed-task-outcomes');
  assert.equal(first.qualityFloor.tokenSavingComparison, 'not-evaluated');
  assert.equal(first.outcomeMetrics.contentFree, true);
  assert.equal(first.outcomeMetrics.verifiedOutcomes, 1);
  assert.equal(first.outcomeMetrics.firstPassVerifiedOutcomes, 1);
  assert.doesNotMatch(JSON.stringify(first.outcomeMetrics), /developer|identity|person|prompt/i);
  assert.equal(first.story.workId, 'AUTO-REPORT');
  assert.equal(first.story.branch, 'AUTO-REPORT');
  assert.equal(first.intent.source, 'unavailable');
  assert.doesNotMatch(JSON.stringify(first), /transcript/i);

  const plan = {
    planId: PLAN, planSha256: HASH('1'),
    requirement: { text: 'Add deterministic reporting.', sha256: HASH('2') },
    proposal: {
      title: 'Deterministic reporting', assumptions: ['Existing report storage is retained.'],
      unresolvedDecisions: [], predictedPaths: ['src/report.mjs'],
      acceptanceCriteria: ['The report names its exact Story and branch.']
    },
    story: {
      workId: 'AUTO-REPORT', branch: 'AUTO-REPORT', workType: 'feature',
      phaseRail: ['specification', 'implementation', 'verification']
    },
    executionHost: { id: 'copilot-cli' }
  };
  const explained = buildAutoFlightReport(terminal, {
    lineage: first.lineage, approvals: first.approvals,
    approvalSource: first.approvalSource, plan
  });
  assert.equal(explained.intent.source, 'exact-auto-plan');
  assert.equal(explained.intent.requirement.text, 'Add deterministic reporting.');
  assert.deepEqual(explained.intent.inferences.assumptions,
    ['Existing report storage is retained.']);
  assert.equal(explained.executionUnits.planned, 'copilot-cli');
  assert.equal(explained.story.workType, 'feature');

  // A late local record cannot rewrite a final report. It will be visible only in a new governed
  // flight, never retroactively inserted into this report's signed lineage.
  await persistAutoHumanRequest(root, {
    flightId: FLIGHT, phase: 'implementation', attemptId: initial.attemptId,
    requestType: 'clarification', title: 'Late local request',
    detail: { question: 'Should not alter the final report?' }, options: [],
    subjectSha256: HASH('d'), policySha256: HASH('e'), checkpointSha256: HASH('f'),
    status: 'open', response: null
  });
  const replay = await persistAutoFlightReport(root, terminal);
  assert.deepEqual(replay, first);
  assert.equal(replay.lineage['auto-human-request'].length, 1);
  const bound = await mutateAutoFlightState(root, FLIGHT, (state) => {
    state.finalReportSha256 = first.reportSha256;
  }, { expectedCheckpoint: terminal.checkpointSha256 });
  assert.deepEqual(await persistAutoFlightReport(root, bound), first);
  await assert.rejects(
    () => persistAutoFlightReport(root, terminal),
    (error) => error.code === 'AUTO_CHECKPOINT_STALE'
  );
  assert.deepEqual(await readAutoFlightReport(root, FLIGHT), first);

  const tampered = structuredClone(first);
  const nestedAttempt = tampered.lineage['auto-attempt'][0];
  nestedAttempt.budgetImpact.unreviewedNestedField = 1;
  delete nestedAttempt.recordSha256;
  nestedAttempt.recordSha256 = `sha256:${recordSha256(nestedAttempt)}`;
  delete tampered.reportSha256;
  tampered.reportSha256 = `sha256:${recordSha256(tampered)}`;
  await assert.rejects(
    () => restoreAutoFlightReport(root, tampered),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
  );
});

test('independently resealed report projections cannot fabricate quality or outcomes', async (t) => {
  const root = await repository(t);
  const state = await mutateAutoFlightState(root, FLIGHT, (flight) => {
    flight.status = 'halted';
    flight.stopReason = 'test-halt';
    flight.nextAction = 'Review the governed result.';
  });
  const current = buildAutoFlightReport(state);
  assert.equal(current.schemaVersion, currentSchemaVersion('auto-flight-report'));

  const fabricatedQuality = structuredClone(current);
  fabricatedQuality.qualityFloor.status = 'passed';
  fabricatedQuality.qualityFloor.reasons = [];
  await assert.rejects(
    () => restoreAutoFlightReport(root, resealCurrentReport(fabricatedQuality)),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
      && error.details?.detail === 'quality-floor'
  );

  const fabricatedOutcomes = structuredClone(current);
  fabricatedOutcomes.outcomeMetrics.verifiedOutcomes = 999;
  await assert.rejects(
    () => restoreAutoFlightReport(root, resealCurrentReport(fabricatedOutcomes)),
    (error) => error.code === 'AUTO_FLIGHT_CORRUPT'
      && error.details?.detail === 'outcome-metrics'
  );
});
