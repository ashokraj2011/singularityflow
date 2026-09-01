import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { assertAutoCredentialBrokerReference } from '../src/auto/auto-credential-reference.mjs';
import {
  createAutoHumanBoundary, respondAutoHumanRequest
} from '../src/auto/auto-p1-control.mjs';
import {
  createAutoFlightState, readAutoFlightState
} from '../src/auto/auto-flight-store.mjs';
import { readAutoP1Record } from '../src/auto/auto-p1-records.mjs';

const FLIGHT_ID = `AFL-${'C'.repeat(26)}`;
const HASH = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;
const NOW = '2026-09-01T00:00:00.000Z';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-credential-response-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  await createAutoFlightState(root, {
    flightId: FLIGHT_ID, planId: `APL-${'D'.repeat(26)}`, planSha256: HASH('d'),
    status: 'paused', story: { workId: 'AUTO-CREDENTIAL', branch: 'AUTO-CREDENTIAL', phase: 'implementation' },
    worktree: root, scopePrediction: ['src/**'],
    execution: {
      repair: { policy: 'ask', maximumAttempts: 1 },
      ceilings: { maximumAuthoringAttemptsPerPhase: 2, maximumModelInvocations: 4 }
    }
  });
  let publications = 0;
  const options = {
    publishBoundary: async (_storyRoot, state, checkpointClass) => {
      publications += 1;
      return {
        checkpointClass,
        path: `singularity/work-items/${state.story.workId}/context/auto/${state.flightId}/checkpoint.json`,
        checkpointSha256: HASH(String(publications)), commit: String(publications).repeat(40),
        eventId: `AUTO-CREDENTIAL-${publications}`, phase: state.story.phase,
        position: state.position, createdAt: NOW
      };
    }
  };
  const created = await createAutoHumanBoundary(root, FLIGHT_ID, {
    requestType: 'credential', title: 'Connect approved broker',
    detail: { provider: 'office' }, options: []
  }, options);
  return { root, created, options };
}

test('credential broker references use one closed broker:// handle grammar', () => {
  assert.equal(
    assertAutoCredentialBrokerReference('broker://office/copilot'),
    'broker://office/copilot'
  );
  for (const reference of [
    'https://vault.example.test/entry',
    'vault:office/copilot',
    'broker://https://vault.example.test/entry',
    'broker://office//copilot',
    'broker://office/copilot?token=inline',
    'broker://office/copilot#fragment',
    'broker://office/copilot/',
    ' broker://office/copilot'
  ]) {
    assert.throws(
      () => assertAutoCredentialBrokerReference(reference),
      (error) => error.code === 'AUTO_HUMAN_REQUEST_RESPONSE_INVALID'
        && !error.message.includes(reference)
    );
  }
});

test('credential Human Request rejects provider-shaped values before persistence without echoing them', async (t) => {
  const { root, created, options } = await fixture(t);
  const providerValues = [
    { rule: 'github-token', value: `ghp_${'A'.repeat(36)}` },
    { rule: 'aws-access-key', value: `AKIA${'B'.repeat(16)}` },
    { rule: 'openai-key', value: `sk-${'C'.repeat(32)}` }
  ];
  for (const candidate of providerValues) {
    const brokerReference = `broker://office/${candidate.value}`;
    await assert.rejects(
      () => respondAutoHumanRequest(
        root, FLIGHT_ID, created.request.requestId,
        { brokerReference, status: 'available' }, created.request.requestSha256, options
      ),
      (error) => error.code === 'AUTO_HUMAN_REQUEST_SECRET_REFUSED'
        && error.details?.rules?.includes(candidate.rule)
        && !error.message.includes(candidate.value)
        && !JSON.stringify(error.details).includes(candidate.value)
    );
  }
  const retained = await readAutoP1Record(
    root, 'auto-human-request', FLIGHT_ID, created.request.requestId
  );
  assert.equal(retained.status, 'open');
  assert.equal(retained.response, null);
  assert.equal((await readAutoFlightState(root, FLIGHT_ID)).status, 'waiting-human');

  const answered = await respondAutoHumanRequest(
    root, FLIGHT_ID, created.request.requestId,
    { brokerReference: 'broker://office/copilot', status: 'available' },
    created.request.requestSha256, options
  );
  assert.equal(answered.request.response.value.brokerReference, 'broker://office/copilot');
  assert.equal(answered.flight.status, 'paused');
});

