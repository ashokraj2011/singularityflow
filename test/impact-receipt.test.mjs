import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeImpactDefinition } from '../src/impact-config.mjs';
import { createImpactReceipt, impactBandDrift, impactSha256, invalidateImpactReceipt, listImpactReceipts, verifyImpactReceipt } from '../src/impact.mjs';
import { readJson, writeJson } from '../src/util.mjs';

const startedAt = '2026-08-07T00:00:00.000Z';
const submittedAt = '2026-08-07T00:30:00.000Z';
const approvedAt = '2026-08-07T01:00:00.000Z';

function normalizedStudy() {
  return normalizeImpactDefinition({
    version: 1,
    studies: [{
      id: 'delivery-study', label: 'Delivery study', method: 'matched-observational',
      groups: [
        { id: 'baseline', label: 'Baseline', assistanceMode: 'baseline' },
        { id: 'agent', label: 'Agent', assistanceMode: 'governed-agent' }
      ],
      matching: { dimensions: ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'], timePeriod: 'quarter' },
      primaryMetric: { id: 'flow-time-excluding-approval-wait-ms' },
      guardrails: [{ id: 'rework-cycles', maximumRegressionPercent: 10 }],
      reporting: { bootstrapSamples: 300, confidenceLevel: 0.95 },
      privacy: { minimumCohortSize: 3 }
    }]
  }).studies[0];
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-impact-receipt-'));
  const relativePlan = 'singularity/work-items/STORY-9/measurement/plan.json';
  await mkdir(path.dirname(path.join(root, relativePlan)), { recursive: true });
  const planCore = {
    schemaVersion: 1, workId: 'STORY-9',
    study: { id: 'delivery-study', configurationSha256: 'b'.repeat(64), configurationPath: 'singularity/impact.yml' },
    method: 'matched-observational',
    group: { id: 'agent', plannedAssistanceMode: 'governed-agent' },
    classification: {
      suggested: { complexity: 'medium', risk: 'small', signals: {} },
      confirmed: { complexity: 'medium', risk: 'small' }, confirmedAt: startedAt,
      confirmedBy: { name: 'Reviewer', email: 'reviewer@example.com' }
    },
    matching: { capability: 'checkout', repositoryClass: 'delivery', workType: 'feature', timePeriod: '2026-Q3' },
    enrollment: { mode: 'automatic', enrolledAt: startedAt, optedOutAt: null, reason: null }
  };
  const plan = { ...planCore, integrity: { sha256: impactSha256(planCore) } };
  await writeJson(path.join(root, relativePlan), plan);
  const study = normalizedStudy();
  const workflow = {
    schemaVersion: 2, status: 'complete', currentPhase: null,
    workItem: { id: 'STORY-9', title: 'Measured work', workType: 'feature', branch: 'STORY-9', createdAt: startedAt },
    resolution: { impact: { path: 'singularity/impact.yml', sha256: 'b'.repeat(64), studies: [study] } },
    phaseOrder: ['implementation'],
    phases: {
      implementation: {
        id: 'implementation', label: 'Implementation', status: 'approved', startedAt, approvedAt,
        generation: 1,
        usage: [{
          status: 'exact', provider: 'provider', model: 'model-a',
          inputTokens: 100, outputTokens: 40, cachedInputTokens: 25, totalTokens: 140
        }],
        checks: [{ status: 'passed' }],
        approvals: [{ decision: 'approved', at: approvedAt, selfApproval: false }]
      }
    },
    history: [
      { at: startedAt, event: 'phase_generated', phase: 'implementation' },
      { at: submittedAt, event: 'phase_submitted', phase: 'implementation' },
      { at: approvedAt, event: 'phase_approved', phase: 'implementation' }
    ],
    usage: { exactRecords: 1, unavailableRecords: 0, byAgent: {}, byPhase: {} },
    sequenceOverrides: [],
    measurement: {
      schemaVersion: 1, status: 'enrolled',
      plan: { path: relativePlan, sha256: plan.integrity.sha256, studyId: 'delivery-study', groupId: 'agent' },
      classification: plan.classification, exposures: [], evidence: [], receipt: null, invalidations: []
    }
  };
  return { root, workflow };
}

test('finalization emits a deterministic receipt bound to the pre-publication subject revision', async () => {
  const { root, workflow } = await fixture();
  const finalization = {
    sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'c'.repeat(64),
    packetSha256: 'd'.repeat(64), finalizedAt: approvedAt
  };
  const first = await createImpactReceipt(root, { workItemRoot: 'singularity/work-items' }, workflow, finalization);
  const second = await createImpactReceipt(root, { workItemRoot: 'singularity/work-items' }, workflow, finalization);
  assert.equal(first.receipt.integrity.sha256, second.receipt.integrity.sha256);
  assert.deepEqual(first.receipt.subject.subjectRevision, {
    commit: finalization.sourceCommit, sourceTreeSha256: finalization.sourceTreeSha256
  });
  assert.equal(first.receipt.publication.eventType, 'impact-finalized');
  assert.equal(first.receipt.publication.subjectCommit, finalization.sourceCommit);
  assert.equal(first.receipt.metrics['input-tokens'].value, 100);
  assert.equal(first.receipt.metrics['output-tokens'].value, 40);
  assert.equal(first.receipt.metrics['cached-input-tokens'].value, 25);
  assert.deepEqual(first.receipt.economics.models.map(({ provider, model, totalTokens }) => ({ provider, model, totalTokens })), [
    { provider: 'provider', model: 'model-a', totalTokens: 140 }
  ]);
  assert.equal((await verifyImpactReceipt(root, workflow)).valid, true);
});

test('reopening measured work preserves the receipt and appends a hash-bound invalidation', async () => {
  const { root, workflow } = await fixture();
  await createImpactReceipt(root, { workItemRoot: 'singularity/work-items' }, workflow, {
    sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'c'.repeat(64),
    packetSha256: 'd'.repeat(64), finalizedAt: approvedAt
  });
  workflow.history ??= [];
  const result = await invalidateImpactReceipt(root, { workItemRoot: 'singularity/work-items' }, workflow, {
    reason: 'Requirements changed', actor: { name: 'Reviewer', email: 'reviewer@example.com' }, agent: 'product-owner'
  });
  assert.equal(workflow.measurement.receipt.status, 'invalidated');
  assert.equal(workflow.measurement.status, 'invalidated');
  assert.equal(result.record.receiptSha256, workflow.measurement.receipt.sha256);
  assert.equal(result.record.integrity.sha256, impactSha256(Object.fromEntries(Object.entries(result.record).filter(([key]) => key !== 'integrity'))));
  assert.equal((await verifyImpactReceipt(root, workflow)).valid, false);
  await writeJson(path.join(root, 'singularity/work-items/STORY-9/workflow.json'), workflow);
  assert.deepEqual(await listImpactReceipts(root, { workItemRoot: 'singularity/work-items' }), []);
});

test('verification recomputes receipt semantics instead of trusting a rehashed receipt', async () => {
  const { root, workflow } = await fixture();
  await createImpactReceipt(root, { workItemRoot: 'singularity/work-items' }, workflow, {
    sourceCommit: 'a'.repeat(40), sourceTreeSha256: 'c'.repeat(64),
    packetSha256: 'd'.repeat(64), finalizedAt: approvedAt
  });
  const target = path.join(root, workflow.measurement.receipt.path);
  const receipt = await readJson(target);
  receipt.metrics.rejections.value = 99;
  const { integrity: _integrity, ...core } = receipt;
  receipt.integrity = { sha256: impactSha256(core) };
  workflow.measurement.receipt.sha256 = receipt.integrity.sha256;
  await writeJson(target, receipt);
  const result = await verifyImpactReceipt(root, workflow);
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /metrics do not match/);
});

test('band drift is aggregated by study and time period without contributor details', async () => {
  const { root, workflow } = await fixture();
  const source = await readJson(path.join(root, workflow.measurement.plan.path));
  source.classification.confirmed = { complexity: 'large', risk: 'medium' };
  const { integrity: _integrity, ...core } = source;
  source.integrity = { sha256: impactSha256(core) };
  workflow.measurement.plan.sha256 = source.integrity.sha256;
  await writeJson(path.join(root, workflow.measurement.plan.path), source);
  await writeJson(path.join(root, 'singularity/work-items/STORY-9/workflow.json'), workflow);
  assert.deepEqual(await impactBandDrift(root, { workItemRoot: 'singularity/work-items' }), [{
    studyId: 'delivery-study', timePeriod: '2026-Q3', confirmed: 1, matches: 0,
    mismatches: 1, upward: 1, downward: 0, mixed: 0,
    complexityMismatches: 1, riskMismatches: 1
  }]);
});
