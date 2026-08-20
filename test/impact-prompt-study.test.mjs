import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  deterministicStudyGroup,
  loadImpactDefinition,
  normalizeImpactDefinition
} from '../src/impact-config.mjs';
import {
  compareImpactReceipts,
  initializeStoryImpact,
  resolveImpactPromptOverride,
  verifyImpactPlanBinding
} from '../src/impact.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function promptStudy(firstHash, secondHash) {
  return {
    version: 2,
    automaticEnrollment: true,
    studies: [{
      id: 'spec-prompts',
      label: 'Specification prompt comparison',
      kind: 'prompt-set-randomized',
      generation: 1,
      status: 'active',
      hypothesis: 'Prompt B improves first-pass approval without increasing rework.',
      method: 'randomized',
      eligibility: { workTypes: ['feature'], capabilities: [] },
      targetPhases: ['specification'],
      window: { start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' },
      assignment: { algorithm: 'sha256-mod-n-v1', seed: 'spec-prompts-2026-q3' },
      variants: [
        {
          id: 'prompt-a', label: 'Prompt A',
          prompts: { specification: { path: 'singularity/prompts/specification-a.md', sha256: firstHash } }
        },
        {
          id: 'prompt-b', label: 'Prompt B',
          prompts: { specification: { path: 'singularity/prompts/specification-b.md', sha256: secondHash } }
        }
      ],
      matching: {
        dimensions: ['capability', 'repository-class', 'work-type', 'complexity', 'risk', 'time-period'],
        timePeriod: 'quarter', weighting: 'minimum-cohort-count'
      },
      primaryMetric: { id: 'flow-time-excluding-approval-wait-ms', direction: 'lower' },
      guardrails: [
        { id: 'rework-cycles', maximumRegressionPercent: 10 },
        { id: 'first-pass-approval-rate', maximumRegressionPercent: 10 }
      ],
      reporting: { bootstrapSamples: 300, confidenceLevel: 0.95 },
      privacy: { individualReporting: false, minimumCohortSize: 3 }
    }]
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-prompt-study-'));
  const promptDirectory = path.join(root, 'singularity/prompts');
  await mkdir(promptDirectory, { recursive: true });
  const first = '# Prompt A\n\nProduce a concise specification.\n';
  const second = '# Prompt B\n\nProduce an evidence-linked specification.\n';
  await writeFile(path.join(promptDirectory, 'specification-a.md'), first);
  await writeFile(path.join(promptDirectory, 'specification-b.md'), second);
  const raw = promptStudy(sha256(first), sha256(second));
  await writeFile(path.join(root, 'singularity/impact.yml'), YAML.stringify(raw));
  return { root, first, second, raw };
}

test('prompt-set studies validate reviewed hashes and deterministic two-arm assignment', async () => {
  const { root, raw } = await fixture();
  const loaded = await loadImpactDefinition(root, { required: true });
  const study = loaded.studies[0];
  assert.equal(study.studyRunId, 'spec-prompts@1');
  assert.equal(study.kind, 'prompt-set-randomized');
  assert.equal(study.groups.length, 2);
  assert.deepEqual(
    deterministicStudyGroup(study, 'WORK-101'),
    deterministicStudyGroup(normalizeImpactDefinition(raw).studies[0], 'WORK-101')
  );

  await writeFile(path.join(root, 'singularity/prompts/specification-a.md'), '# changed\n');
  await assert.rejects(() => loadImpactDefinition(root, { required: true }), (error) => {
    assert.equal(error.code, 'IMPACT_VARIANT_DRIFT');
    return /is stale/.test(error.message);
  });
});

test('Story birth snapshots one prompt variant and refuses agent or snapshot contamination', async () => {
  const { root } = await fixture();
  const impact = await loadImpactDefinition(root, { required: true });
  const agentSha256 = 'a'.repeat(64);
  const workflow = {
    workItem: {
      id: 'WORK-202', workType: 'feature', createdAt: '2026-08-20T00:00:00.000Z'
    },
    phases: {
      specification: { id: 'specification', defaultAgent: 'product-owner', generation: 0 }
    },
    resolution: {
      configSha256: 'c'.repeat(64),
      agents: { 'product-owner': { sha256: agentSha256 } },
      impact
    }
  };
  await initializeStoryImpact(root, { workItemRoot: 'singularity/work-items' }, workflow, { title: 'Measured Story' });
  assert.equal(workflow.measurement.plan.kind, 'prompt-set-randomized');
  assert.equal(workflow.measurement.plan.studyRunId, 'spec-prompts@1');
  const selected = impact.studies[0].variants.find((variant) => variant.id === workflow.measurement.plan.variantId);
  const resolved = await resolveImpactPromptOverride(root, workflow, 'specification', {
    agentId: 'product-owner', agentSha256
  });
  assert.equal(resolved.text, await readFile(path.join(root, selected.prompts.specification.path), 'utf8'));
  assert.equal(resolved.sha256, selected.prompts.specification.sha256);

  await writeFile(path.join(root, selected.prompts.specification.path), '# source changed after Story birth\n');
  assert.equal((await resolveImpactPromptOverride(root, workflow, 'specification', {
    agentId: 'product-owner', agentSha256
  })).sha256, selected.prompts.specification.sha256, 'the Story uses its copied prompt, not mutable shared configuration');
  assert.equal((await verifyImpactPlanBinding(root, workflow)).valid, true,
    'later shared prompt changes do not invalidate the Story-local assignment');

  await assert.rejects(() => resolveImpactPromptOverride(root, workflow, 'specification', {
    agentId: 'developer', agentSha256
  }), (error) => error.code === 'IMPACT_EXPERIMENT_AGENT_MISMATCH');

  const plan = JSON.parse(await readFile(path.join(root, workflow.measurement.plan.path), 'utf8'));
  await writeFile(path.join(root, plan.experiment.prompts.specification.path), '# corrupted snapshot\n');
  assert.equal((await verifyImpactPlanBinding(root, workflow)).valid, false);
  await assert.rejects(() => resolveImpactPromptOverride(root, workflow, 'specification', {
    agentId: 'product-owner', agentSha256
  }), (error) => error.code === 'IMPACT_PINNED_PROMPT_CHANGED');
});

function receipt(groupId, index, duration, definitionSha256) {
  return {
    status: 'finalized',
    subject: {
      workId: `${groupId}-${index}`, capability: 'checkout', repositoryClass: 'delivery',
      workType: 'feature', complexity: 'medium', risk: 'small', timePeriod: '2026-Q3'
    },
    study: { id: 'spec-prompts', groupId, definitionSha256 },
    experiment: {
      kind: 'prompt-set-randomized', studyRunId: 'spec-prompts@1',
      adherence: { status: 'exact' }
    },
    metrics: {
      'flow-time-excluding-approval-wait-ms': { value: duration, status: 'exact' },
      'rework-cycles': { value: 1, status: 'exact' },
      'first-pass-approval-rate': { value: 1, status: 'exact' }
    }
  };
}

test('prompt-set reports are deterministic, generation-scoped and quality guarded', async () => {
  const first = '# Prompt A\n';
  const second = '# Prompt B\n';
  const study = normalizeImpactDefinition(promptStudy(sha256(first), sha256(second))).studies[0];
  const receipts = [
    receipt('prompt-a', 1, 100, study.definitionSha256), receipt('prompt-a', 2, 110, study.definitionSha256), receipt('prompt-a', 3, 90, study.definitionSha256),
    receipt('prompt-b', 1, 70, study.definitionSha256), receipt('prompt-b', 2, 80, study.definitionSha256), receipt('prompt-b', 3, 60, study.definitionSha256),
    { ...receipt('prompt-a', 99, 1, study.definitionSha256), experiment: { kind: 'prompt-set-randomized', studyRunId: 'spec-prompts@2', adherence: { status: 'exact' } } }
  ];
  const result = compareImpactReceipts(receipts, study);
  assert.equal(result.studyRunId, 'spec-prompts@1');
  assert.equal(result.inference, 'randomized-intention-to-treat-comparison');
  assert.equal(result.label, 'quality-gated randomized prompt-set comparison');
  assert.equal(result.promptAdherence.exact, 6);
  assert.equal(result.cohorts.eligibleBaseline, 3);
  assert.deepEqual(result, compareImpactReceipts(receipts, study));

  const reusedGeneration = structuredClone(receipts);
  reusedGeneration[0].study.definitionSha256 = 'f'.repeat(64);
  assert.throws(() => compareImpactReceipts(reusedGeneration, study), /privacy floor/,
    'receipts from a different definition cannot enter the current run');
});

test('prompt-set studies require complete prompt maps and mandatory quality guardrails', () => {
  const first = sha256('a');
  const second = sha256('b');
  const missingPrompt = promptStudy(first, second);
  delete missingPrompt.studies[0].variants[1].prompts.specification;
  assert.throws(() => normalizeImpactDefinition(missingPrompt), /must define exactly/);

  const missingGuardrail = promptStudy(first, second);
  missingGuardrail.studies[0].guardrails = missingGuardrail.studies[0].guardrails.filter((item) => item.id !== 'first-pass-approval-rate');
  assert.throws(() => normalizeImpactDefinition(missingGuardrail), /first-pass-approval-rate/);

  const conflictingLifecycle = promptStudy(first, second);
  conflictingLifecycle.studies[0].enabled = false;
  assert.throws(() => normalizeImpactDefinition(conflictingLifecycle), /enabled conflicts with status/);
});

test('active study scopes cannot overlap and closed prompt runs do not claim new Stories', () => {
  const first = sha256('a');
  const second = sha256('b');
  const overlapping = promptStudy(first, second);
  overlapping.studies.push({
    ...structuredClone(overlapping.studies[0]),
    id: 'second-prompt-run',
    generation: 3,
    assignment: { algorithm: 'sha256-mod-n-v1', seed: 'second-run' }
  });
  assert.throws(() => normalizeImpactDefinition(overlapping), /overlapping work-type and capability scopes/);

  overlapping.studies[0].status = 'closed';
  const normalized = normalizeImpactDefinition(overlapping);
  assert.equal(normalized.studies[0].enabled, false);
  assert.equal(normalized.studies[1].enabled, true);
  const activeAgain = structuredClone(overlapping);
  activeAgain.studies[0].status = 'active';
  activeAgain.studies[1].status = 'closed';
  assert.equal(normalized.studies[0].definitionSha256,
    normalizeImpactDefinition(activeAgain).studies[0].definitionSha256,
    'closing a run does not change the definition that its receipts bind');
});

test('closed runs remain readable after their shared prompt sources are archived', async () => {
  const { root, raw } = await fixture();
  raw.studies[0].status = 'closed';
  await writeFile(path.join(root, 'singularity/impact.yml'), YAML.stringify(raw));
  await unlink(path.join(root, 'singularity/prompts/specification-a.md'));
  await unlink(path.join(root, 'singularity/prompts/specification-b.md'));
  const loaded = await loadImpactDefinition(root, { required: true });
  assert.equal(loaded.studies[0].status, 'closed');
  assert.equal(loaded.studies[0].enabled, false);
});
