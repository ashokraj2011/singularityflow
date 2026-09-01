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
    flightId: FLIGHT_ID, story: { workId: 'AUTO-SURFACE', phase: 'implementation' },
    checkpointSha256: HASH('c'),
    cards: [
      {
        kind: 'plan', status: 'startable',
        planId: `APL-${'D'.repeat(26)}`, packetSha256: HASH('a'),
        phaseRail: ['intake', 'implementation', 'verification'],
        scope: {
          status: 'predicted', predictedRead: ['src/input.mjs'], predictedWrite: ['src/output.mjs'],
          protected: ['singularity/workflow.yml'], forbidden: ['.git/config']
        },
        evidenceReadiness: {
          status: 'ready', commandIds: ['node-test'], acceptanceCriteria: ['AC-001']
        },
        ceilings: { maximumPhases: 3, maximumRepairs: 1 },
        humanStops: ['approval'], capability: { id: 'calculator' },
        repositories: [{ id: 'lead', role: 'lead' }]
      },
      { kind: 'running', flightId: FLIGHT_ID, status: 'running' },
      { kind: 'refusal', flightId: FLIGHT_ID, status: 'paused',
        refusalId: `ARF-${'E'.repeat(26)}`, repair: { eligibility: 'ask-only' } },
      { kind: 'needs-you', flightId: FLIGHT_ID, requestId: `AHR-${'F'.repeat(26)}`,
        requestSha256: HASH('b'), options: [{ id: 'sql', label: 'SQL' }, { id: 'document' }] },
      { kind: 'takeover', flightId: FLIGHT_ID, status: 'manual-takeover',
        candidateId: `CAN-${'A'.repeat(26)}`, candidateSha256: HASH('d') },
      { kind: 'report', flightId: FLIGHT_ID,
        candidateId: `CAN-${'A'.repeat(26)}`, candidateSha256: HASH('d') }
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
    Story: 'AUTO-SURFACE', Phase: 'implementation',
    'Phase rail': 'intake → implementation → verification', Scope: 'predicted',
    'Predicted reads': 'src/input.mjs', 'Predicted writes': 'src/output.mjs',
    'Protected paths': 'singularity/workflow.yml', 'Forbidden paths': '.git/config',
    'Evidence readiness': 'ready', 'Verification commands': 'node-test',
    'Acceptance criteria': 'AC-001', Ceilings: 'maximumPhases=3, maximumRepairs=1',
    'Human stops': 'approval', Capability: '{"id":"calculator"}',
    Repositories: '{"id":"lead","role":"lead"}'
  });
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
