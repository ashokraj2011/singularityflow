import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOutcomeSelectionBundle, recommendDelivery } from '../src/delivery-modes/delivery-kernel.mjs';
import {
  buildAgentExecutionBinding, buildAgentExecutionCheckpoint, buildAgentSteeringDecision,
  M7_RECORD_FAMILIES, validateExecutionBridgeRecord
} from '../src/delivery-modes/execution-bridge.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (character) => `sha256:${character.repeat(64)}`;

function delivery() {
  const request = {
    schemaVersion: 1, kind: 'delivery-request', workId: 'GDP-M7',
    outcome: { statement: 'Run bounded work', observablePredicate: 'The exact check passes' },
    acceptanceClauses: [{ clauseId: 'GDP-M7:AC-001', bodySha256: digest('a'), required: true, witnessPolicy: 'exact' }],
    nonGoals: [], predicted: {
      repositories: 1, touchedResources: 1, protectedPaths: false, externalEffects: false,
      credentialUse: false, architectureDecision: false, publicContractChange: false,
      databaseMigration: false
    },
    riskClass: 'low', executionProvider: 'sgos', executionPace: 'auto', autonomyCeiling: 'A2',
    proofProfile: 'standard', workflowProfile: 'feature', allowedEffects: ['repository-file-write'],
    forbiddenEffects: ['external-network']
  };
  const recommendation = recommendDelivery({
    request, repositoryRevisionSha256: digest('b'), configurationSha256: digest('c')
  });
  return buildOutcomeSelectionBundle({
    request, recommendation, proofPolicySha256: digest('d'), policySnapshotSha256: digest('c'),
    gapAcceptancePolicySha256: digest('e'), promotionPolicySha256: digest('f'),
    selectedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null }
  });
}

function process(status = 'running', activeExecutions = []) {
  return {
    kind: 'gvm-process', processId: 'PROC-GDP-M7', revision: 4, status,
    authorityBinding: { kind: 'outcome', subjectId: 'GDP-M7' },
    programSha256: digest('1'), policySnapshotSha256: digest('2'),
    candidate: { candidateSha256: digest('3') }, currentCheckpointSha256: digest('4'),
    activeExecutions
  };
}

test('M7 binds delivery to the existing SGOS durable process without becoming an executor', () => {
  const currentDelivery = delivery();
  const currentProcess = process('running', [{ leaseSha256: digest('5') }]);
  const binding = buildAgentExecutionBinding({
    workId: 'GDP-M7', selection: currentDelivery.selection,
    completionContract: currentDelivery.completionContract, process: currentProcess,
    executionUnitManifestSha256: digest('6')
  });
  assert.equal(binding.runtime, 'sgos-durable-v2-bridge');
  assert.equal(binding.status, 'bound');
  const checkpoint = buildAgentExecutionCheckpoint({
    binding, process: currentProcess,
    checkpoint: { kind: 'gvm-checkpoint', checkpointSha256: digest('4'), sequence: 4 }
  });
  assert.equal(checkpoint.quiescent, false);
  assert.equal(checkpoint.status, 'observed');
  assert.equal(checkpoint.activeExecutionRefs.length, 1);
  assert.deepEqual(validateExecutionBridgeRecord('agent-execution-binding', binding), binding);
  assert.deepEqual(validateExecutionBridgeRecord('agent-execution-checkpoint', checkpoint), checkpoint);
});

test('M7 exposes only already-recorded steering and preserves recovery/quiescence truth', () => {
  const currentDelivery = delivery();
  const recovering = process('recovery-required');
  const binding = buildAgentExecutionBinding({
    workId: 'GDP-M7', selection: currentDelivery.selection,
    completionContract: currentDelivery.completionContract, process: recovering
  });
  assert.equal(binding.status, 'partial');
  const checkpoint = buildAgentExecutionCheckpoint({ binding, process: recovering, checkpoint: null });
  assert.equal(checkpoint.quiescent, true);
  assert.equal(checkpoint.recoveryRequired, true);
  assert.equal(checkpoint.status, 'recovery-required');
  assert.ok(checkpoint.gaps.includes('SGOS_CHECKPOINT_UNAVAILABLE'));

  const steering = buildAgentSteeringDecision({
    binding, priorCheckpointSha256: digest('4'), action: 'halt',
    sourceControlEventSha256: digest('7'),
    requestedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null },
    reasonSha256: digest('8')
  });
  assert.deepEqual(validateExecutionBridgeRecord('agent-steering-decision', steering), steering);
  assert.throws(() => buildAgentSteeringDecision({
    binding, priorCheckpointSha256: digest('4'), action: 'halt',
    sourceControlEventSha256: digest('7'),
    requestedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null },
    reasonSha256: digest('8'), status: 'requested'
  }), /already-recorded/);
});

test('M7 execution records are closed, immutable, and bounded by MIG', async () => {
  const currentDelivery = delivery();
  const currentProcess = process();
  const binding = buildAgentExecutionBinding({
    workId: 'GDP-M7', selection: currentDelivery.selection,
    completionContract: currentDelivery.completionContract, process: currentProcess
  });
  const records = {
    'agent-execution-binding': binding,
    'agent-execution-checkpoint': buildAgentExecutionCheckpoint({
      binding, process: currentProcess,
      checkpoint: { kind: 'gvm-checkpoint', checkpointSha256: digest('4') }
    }),
    'agent-steering-decision': buildAgentSteeringDecision({
      binding, priorCheckpointSha256: digest('4'), action: 'pause',
      sourceControlEventSha256: digest('7'),
      requestedBy: { kind: 'policy', identity: null, authoritySha256: digest('9') },
      reasonSha256: digest('8')
    })
  };
  const registry = new Map(migrationRegistrySnapshot().map((entry) => [entry.id, entry]));
  for (const [family, record] of Object.entries(records)) {
    assert.equal(currentSchemaVersion(family), 1, family);
    assert.equal(registry.get(family).immutable, true, family);
    assert.deepEqual(validateExecutionBridgeRecord(family, record), record, family);
    const schema = JSON.parse(await readFile(path.join(root, `schemas/gdp-${family}.schema.json`), 'utf8'));
    assert.deepEqual(Object.keys(record).sort(), [...schema.required].sort(), family);
    const [hashField] = M7_RECORD_FAMILIES[family];
    assert.equal(record[hashField], `sha256:${recordSha256(Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== hashField)
    ))}`);
  }
  assert.equal(familyForStoredPath(
    `singularity/work-items/GDP-M7/gdp/subjects/agent-execution-binding/${'a'.repeat(64)}.json`
  )?.id, 'agent-execution-binding');
  assert.equal(familyForStoredPath(
    `$git/gdp/operations/GDP-M7/agent-execution-checkpoint/checkpoint.json`
  )?.id, 'agent-execution-checkpoint');
});
