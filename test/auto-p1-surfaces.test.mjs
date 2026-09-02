import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { buildAutoCards } from '../apps/vscode/src/views/auto-cards-model.ts';
import { buildResultCard } from '../apps/vscode/src/views/result-card-model.ts';
import { resultCardHtml } from '../apps/vscode/src/views/result-card-page.ts';
import { createAutoFlightState, mutateAutoFlightState } from '../src/auto/auto-flight-store.mjs';
import { persistAutoAttempt, persistAutoHumanRequest, persistAutoRefusal } from '../src/auto/auto-p1-records.mjs';
import { gatewayRegistry } from '../src/gateway/operations.mjs';
import { autoFlightRead } from '../src/gateway/planners/auto-flight.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { SFLOW_TOOLS } from '../src/gateway/tools.mjs';

const FLIGHT_ID = `AFL-${'C'.repeat(26)}`;
const HASH = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-p1-surface-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  await createAutoFlightState(root, {
    flightId: FLIGHT_ID, planId: `APL-${'D'.repeat(26)}`, planSha256: HASH('d'),
    status: 'waiting-human', story: { workId: 'AUTO-SURFACE', branch: 'AUTO-SURFACE', phase: 'implementation' },
    worktree: root, execution: { ceilings: {} }
  });
  const attempt = await persistAutoAttempt(root, {
    flightId: FLIGHT_ID, phase: 'implementation', attemptNumber: 1,
    attemptKind: 'initial', parentAttemptId: null, reason: 'phase-entry',
    generationIntentSha256: HASH('1'), taskContractSha256: HASH('2'),
    contextManifestSha256: HASH('3'), executionUnitManifestSha256: HASH('4'),
    status: 'refused', budgetImpact: {}, result: null
  });
  const refusal = await persistAutoRefusal(root, {
    flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
    gate: 'verification', code: 'TEST_FAILED', subject: { candidateSha256: HASH('5') },
    missing: [{ evidence: 'passing tests' }], preserved: { paths: ['src/a.mjs'] },
    repair: { eligibility: 'ask-only', scope: ['src/a.mjs'], maximumAttempts: 1 },
    primaryNextAction: { operation: 'auto.repair', label: 'Review repair' }
  });
  const request = await persistAutoHumanRequest(root, {
    flightId: FLIGHT_ID, phase: 'implementation', attemptId: attempt.attemptId,
    requestType: 'architecture-choice', title: 'Choose storage', detail: { reason: 'material' },
    options: [{ id: 'sql' }, { id: 'document' }], subjectSha256: HASH('6'),
    policySha256: HASH('7'), checkpointSha256: HASH('8'), status: 'open', response: null
  });
  await mutateAutoFlightState(root, FLIGHT_ID, (state) => {
    state.activeAttemptId = attempt.attemptId;
    state.activeRefusalId = refusal.refusalId;
    state.openHumanRequestIds = [request.requestId];
  });
  return root;
}

test('AUT v2 read-first gateway mappings use the existing five-tool surface', async (t) => {
  const root = await fixture(t);
  assert.equal(SFLOW_TOOLS.length, 5);
  const registry = gatewayRegistry();
  const planners = gatewayPlanners();
  for (const id of [
    'auto.list', 'auto.show-plan', 'auto.status', 'auto.needs-you', 'auto.report', 'auto.continue'
  ]) {
    const operation = registry.operations.find((entry) => entry.id === id);
    assert.ok(operation, id);
    assert.equal(operation.classification, 'read');
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(typeof planners.get(operation.gateway.planner), 'function');
  }

  const result = await autoFlightRead({
    operation: { id: 'auto.needs-you' }, arguments: { flightId: FLIGHT_ID }, root
  });
  assert.equal(result.effects.stateChanged, false);
  assert.deepEqual(result.data.auto.cards.map((card) => card.kind), ['status', 'refusal', 'needs-you']);
  const view = buildResultCard(result);
  assert.deepEqual(view.auto.map((card) => card.kind), ['status', 'refusal', 'needs-you']);
  assert.match(view.auto[1].actions.find((action) => action.id.endsWith(':repair')).command, /auto repair/);
  const choice = view.auto[2].actions.find((action) => action.id.includes(':choice-sql'));
  assert.equal(choice.confirmation, result.data.auto.cards[2].requestSha256);
  assert.match(choice.command, /--choice sql --confirm sha256:/);
  const html = resultCardHtml(view);
  assert.match(html, /aria-label="Auto work"/);
  assert.match(html, /singularity-flow auto repair/);
  assert.doesNotMatch(html, /requestSha256|checkpointSha256/);

  const continued = await autoFlightRead({
    operation: { id: 'auto.continue' }, arguments: { workId: 'AUTO-SURFACE' }, root
  });
  assert.equal(continued.data.auto.flightId, FLIGHT_ID);
  const listed = await autoFlightRead({ operation: { id: 'auto.list' }, arguments: {}, root });
  assert.equal(listed.data.auto.cards.length, 1);
  assert.equal(listed.data.auto.cards[0].flightId, FLIGHT_ID);
});

test('VS Code Auto cards cover Plan, running, refusal, Needs You, takeover, and report without direct state writes', () => {
  const cards = buildAutoCards({
    flightId: FLIGHT_ID,
    story: { workId: 'AUTO-SURFACE', branch: 'AUTO-SURFACE', phase: 'implementation' },
    checkpointSha256: HASH('c'),
    cards: [
      {
        kind: 'plan', status: 'startable',
        planId: `APL-${'D'.repeat(26)}`, packetSha256: HASH('a'),
        title: 'Add exact reporting', requirement: 'Add exact reporting to Auto.',
        inferences: { assumptions: ['Existing storage remains.'], unresolvedDecisions: [] },
        phaseRail: ['intake', 'implementation', 'verification'],
        scope: {
          status: 'predicted', predictedRead: ['src/input.mjs'], predictedWrite: ['src/output.mjs'],
          protected: ['singularity/workflow.yml'], forbidden: ['.git/config']
        },
        evidenceReadiness: {
          status: 'ready', commandIds: ['node-test'], acceptanceCriteria: ['AC-001']
        },
        ceilings: { maximumPhases: 3, maximumRepairs: 1 },
        execution: {
          profile: 'story', pace: 'phase', until: 'verification', executionUnit: 'copilot-cli'
        },
        humanStops: ['approval'], capability: { id: 'calculator' },
        repositories: [{ id: 'lead', role: 'lead' }]
      },
      {
        kind: 'running', flightId: FLIGHT_ID, status: 'running',
        progress: {
          phasesCompleted: 1, maximumPhases: 3, currentAttempt: 1,
          maximumAttemptsPerPhase: 2, currentAttemptStatus: 'running'
        },
        budget: {
          touchedPaths: 2, maximumTouchedPaths: 8,
          modelInvocations: 1, maximumModelInvocations: 6,
          providerInputTokens: 1200, maximumInputTokens: 30000,
          tokenAssurance: 'provider-reported'
        }
      },
      { kind: 'refusal', flightId: FLIGHT_ID, status: 'paused',
        refusalId: `ARF-${'E'.repeat(26)}`, repair: { eligibility: 'ask-only' } },
      { kind: 'needs-you', flightId: FLIGHT_ID, requestId: `AHR-${'F'.repeat(26)}`,
        requestSha256: HASH('b'), options: [{ id: 'sql', label: 'SQL' }, { id: 'document' }] },
      { kind: 'takeover', flightId: FLIGHT_ID, status: 'manual-takeover',
        candidateId: `CAN-${'A'.repeat(26)}`, candidateSha256: HASH('d') },
      {
        kind: 'report', flightId: FLIGHT_ID,
        candidateId: `CAN-${'A'.repeat(26)}`, candidateSha256: HASH('d'),
        qualityFloor: { status: 'passed', tokenSavingComparison: 'not-evaluated' },
        outcomeMetrics: {
          contentFree: true, verifiedOutcomes: 2, refusals: 1,
          repairAttempts: 1, manualTakeover: false
        },
        accounting: {
          observations: {
            toolOutput: {
              assurance: 'estimated-bytes-per-token-4.0', observedBytes: 400,
              estimatedTokens: 100, providerTokens: null
            }
          }
        }
      }
    ]
  });
  assert.deepEqual(cards.map((card) => card.kind), [
    'plan', 'running', 'refusal', 'needs-you', 'takeover', 'report'
  ]);
  assert.ok(cards.every((card) => card.actions.length > 0));
  assert.ok(cards.flatMap((card) => card.actions)
    .every((action) => action.command.startsWith('singularity-flow auto ')));
  assert.equal(cards[0].actions.find((action) => action.id.endsWith(':start')).confirmation, HASH('a'));
  assert.deepEqual(Object.fromEntries(cards[0].details.map((entry) => [entry.label, entry.value])), {
    Origin: `Auto · ${FLIGHT_ID}`, Plan: `APL-${'D'.repeat(26)}`,
    Requirement: 'Add exact reporting to Auto.',
    'Inferred assumptions': 'Existing storage remains.',
    Story: 'AUTO-SURFACE', Branch: 'AUTO-SURFACE', Phase: 'implementation',
    'Phase rail': 'intake → implementation → verification', Scope: 'predicted',
    Profile: 'story', Pacing: 'phase', Endpoint: 'verification',
    'Predicted reads': 'src/input.mjs', 'Predicted writes': 'src/output.mjs',
    'Protected paths': 'singularity/workflow.yml', 'Forbidden paths': '.git/config',
    'Evidence readiness': 'ready', 'Verification commands': 'node-test',
    'Acceptance criteria': 'AC-001', Ceilings: 'maximumPhases=3, maximumRepairs=1',
    'Human stops': 'approval', Capability: '{"id":"calculator"}',
    'Execution Unit': 'copilot-cli',
    Repositories: '{"id":"lead","role":"lead"}'
  });
  assert.equal(cards[0].title, 'Auto Plan · Add exact reporting');
  assert.ok(cards[1].details.some((entry) => (
    entry.label === 'Progress' && entry.value === '1/3 phases · attempt 1/2 · running'
  )));
  assert.ok(cards[1].details.some((entry) => (
    entry.label === 'Budget' && entry.value === '2/8 paths · 1/6 model calls · 1200/30000 input tokens'
  )));
  assert.ok(cards[5].details.some((entry) => (
    entry.label === 'Quality floor' && entry.value === 'passed · token savings not-evaluated'
  )));
  assert.ok(cards[5].details.some((entry) => (
    entry.label === 'Tool output' && entry.value === '100 estimated tokens from 400 bytes'
  )));
  assert.ok(cards[5].details.some((entry) => (
    entry.label === 'Outcomes' && entry.value === '2 verified · 1 refusals · 1 repairs'
  )));
  assert.deepEqual(cards[1].actions.map((action) => action.label), [
    'Prepare pause', 'Prepare takeover', 'Prepare stop'
  ]);
  assert.equal(cards[3].actions.find((action) => action.id.includes(':choice-sql')).confirmation, HASH('b'));
  assert.ok(Object.isFrozen(cards[1].actions));
  assert.ok(cards[1].actions.every(Object.isFrozen));
});

test('VS Code Auto recovery actions never interpolate a forged Story work ID', () => {
  const forged = 'SAFE; touch /tmp/owned';
  const cards = buildAutoCards({
    flightId: FLIGHT_ID,
    story: { workId: forged, phase: 'implementation' },
    cards: [
      { kind: 'status', status: 'recovery-required', flightId: FLIGHT_ID },
      { kind: 'unavailable', status: 'report-unavailable', flightId: FLIGHT_ID }
    ]
  });
  assert.equal(cards[0].actions.some((entry) => entry.command.includes('auto recover')), false);
  assert.deepEqual(cards[1].actions, [], 'a forged non-empty ID does not degrade into another recovery command');
  assert.equal(cards.flatMap((card) => card.actions).some((entry) => entry.command.includes(forged)), false);
});
