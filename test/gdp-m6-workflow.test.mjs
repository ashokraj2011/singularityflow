import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildOutcomeSelectionBundle, recommendDelivery } from '../src/delivery-modes/delivery-kernel.mjs';
import {
  buildWorkflowCheckpointSatisfaction, buildWorkflowDeliveryProjection,
  validateWorkflowCheckpointSatisfaction
} from '../src/delivery-modes/workflow-delivery.mjs';
import { recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion, familyForStoredPath, migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (character) => `sha256:${character.repeat(64)}`;

function request(profile = 'feature') {
  return {
    schemaVersion: 1, kind: 'delivery-request', workId: 'GDP-M6',
    outcome: { statement: 'Deliver the reviewed feature', observablePredicate: 'AC-001 passes' },
    acceptanceClauses: [{
      clauseId: 'GDP-M6:AC-001', bodySha256: digest('a'), required: true,
      witnessPolicy: 'module-test'
    }],
    nonGoals: [],
    predicted: {
      repositories: 1, touchedResources: 2, protectedPaths: false,
      externalEffects: false, credentialUse: false, architectureDecision: false,
      publicContractChange: false, databaseMigration: false
    },
    riskClass: 'low', executionProvider: 'governed-agent', executionPace: 'assisted',
    autonomyCeiling: 'A2', proofProfile: 'standard', workflowProfile: profile,
    allowedEffects: ['repository-file-write'], forbiddenEffects: ['external-network']
  };
}

function workflow(profile = 'feature') {
  return {
    kind: 'story-workflow', workItem: { id: 'GDP-M6', title: 'Deliver feature', workType: profile },
    resolution: { workflowId: profile }, phaseOrder: ['specification', 'implementation'],
    phases: {
      specification: {
        id: 'specification', generation: 1, status: 'approved',
        artifacts: [{ id: 'spec', path: 'not-exported.md', sha256: digest('1') }],
        approvals: [{ decision: 'approved', approvalSha256: digest('2') }]
      },
      implementation: {
        id: 'implementation', generation: 2, status: 'in_progress',
        artifacts: [], groundingCompositionSha256: digest('3')
      }
    }
  };
}

function projection(profile = 'feature', worldModel = null) {
  return buildWorkflowDeliveryProjection({
    workflow: workflow(profile), request: request(profile), candidateSha256: digest('b'), worldModel,
    sourceRecordSha256: digest('c'), configurationSha256: digest('d'),
    proofPolicySha256: digest('e'), gapAcceptancePolicySha256: digest('f'),
    promotionPolicySha256: digest('0')
  });
}

test('M6 maps Feature and Bugfix without files, model, AST, or World Model requirements', () => {
  for (const profile of ['feature', 'bugfix']) {
    const current = projection(profile);
    assert.equal(current.workflowProfile, profile);
    assert.equal(current.selection.deliveryMode, 'workflow');
    assert.equal(current.guarantees.noWrites, true);
    assert.equal(current.guarantees.noModel, true);
    assert.equal(current.guarantees.astRequired, false);
    assert.equal(current.guarantees.worldModelRequired, false);
    assert.ok(current.gaps.includes('WORLD_MODEL_UNAVAILABLE_NON_BLOCKING'));
    assert.equal(JSON.stringify(current.checkpoints).includes('not-exported.md'), false);
    assert.equal(current.checkpoints[0].status, 'satisfied');
    assert.equal(current.checkpoints[1].status, 'pending');
    assert.deepEqual(projection(profile), current);
  }
  assert.throws(() => projection('chore'), /creation-pinned and not mapped/);
});

test('M6 Workflow and M5 Outcome share the exact Completion Contract for identical inputs', () => {
  const input = request();
  const workflowProjection = projection();
  const outcomeRecommendation = recommendDelivery({
    request: input, repositoryRevisionSha256: digest('c'), configurationSha256: digest('d')
  });
  const outcome = buildOutcomeSelectionBundle({
    request: input, recommendation: outcomeRecommendation,
    proofPolicySha256: digest('e'), policySnapshotSha256: digest('d'),
    gapAcceptancePolicySha256: digest('f'), promotionPolicySha256: digest('0'),
    selectedBy: { kind: 'human', identity: 'reviewer@example.com', authoritySha256: null }
  });
  assert.equal(workflowProjection.completionContract.contractSha256,
    outcome.completionContract.contractSha256);
  assert.equal(workflowProjection.effectPolicy.effectPolicySha256,
    outcome.effectPolicy.effectPolicySha256);
  assert.equal(workflowProjection.riskAssessment.riskAssessmentSha256,
    outcome.riskAssessment.riskAssessmentSha256);
});

test('M6 checkpoint receipts are closed immutable records and never infer missing inputs', async () => {
  const current = buildWorkflowCheckpointSatisfaction({
    workId: 'GDP-M6', workflowProfile: 'feature',
    phase: { id: 'release', generation: 1, status: 'approved', artifacts: [] },
    sourceRecordSha256: digest('c'), completionContractSha256: digest('d')
  });
  assert.equal(current.status, 'unavailable');
  assert.deepEqual(current.gaps, [
    'CANDIDATE_OR_PROOF_SUBJECT_UNAVAILABLE', 'CHECKPOINT_INPUT_IDENTITY_UNAVAILABLE'
  ]);
  assert.deepEqual(validateWorkflowCheckpointSatisfaction(current), current);
  assert.equal(currentSchemaVersion('workflow-checkpoint-satisfaction'), 1);
  assert.equal(new Map(migrationRegistrySnapshot().map((item) => [item.id, item]))
    .get('workflow-checkpoint-satisfaction').immutable, true);
  assert.equal(familyForStoredPath(
    `singularity/work-items/GDP-M6/gdp/decisions/workflow-checkpoint-satisfaction/${'a'.repeat(64)}.json`
  )?.id, 'workflow-checkpoint-satisfaction');
  const schema = JSON.parse(await readFile(path.join(
    root, 'schemas/gdp-workflow-checkpoint-satisfaction.schema.json'
  ), 'utf8'));
  assert.deepEqual(Object.keys(current).sort(), [...schema.required].sort());
  assert.equal(current.satisfactionSha256, `sha256:${recordSha256(Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== 'satisfactionSha256')
  ))}`);
});
