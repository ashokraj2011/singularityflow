import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { resolveWorkType } from '../src/config.mjs';
import { scopeStepOf } from '../src/phase-roles.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { assertPhaseGovernanceMayAdvance, phaseGovernanceHold } from '../src/phase-governance-routing.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { phaseNeedsGeneration } from '../src/sequence.mjs';
import { assertPhaseAgentMayMutate } from '../src/phase-actor-policy.mjs';
import { assertIntentAmendmentAcknowledged, assertSourceReviewerAvailable } from '../src/source-review-policy.mjs';
import { validateAgentCatalog } from '../src/agents.mjs';

test('every eligible seeded downstream step routes pending acknowledgement before authoring/review/submission', async () => {
  const covered = new Set();
  for (const relative of ['../templates/workflow.yml', '../examples/workflow-with-quality-gates.yml']) {
    const definition = YAML.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
    for (const id of Object.keys(definition.workTypes)) {
      const resolved = resolveWorkType(definition, id);
      const phases = Object.fromEntries(resolved.phases.map(phase => [phase.id, {
        ...structuredClone(phase), requiredArtifact: phase.artifact, approvalPolicy: phase.approval,
        status: 'approved', generation: 1
      }]));
      const workflow = { workItem: { id: 'ACK-1', workType: id }, status: 'in_progress',
        phaseOrder: resolved.phases.map(phase => phase.id), phases, history: [],
        resolution: { obligationGraph: resolved.obligationGraph },
        intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: ['ACK-1:REQ-008'] }] };
      const scope = scopeStepOf(workflow);
      if (!scope) continue;
      for (const phaseId of workflow.phaseOrder.slice(workflow.phaseOrder.indexOf(scope.id) + 1)) {
        workflow.currentPhase = phaseId;
        const phase = phases[phaseId];
        for (const status of ['in_progress', 'awaiting_approval']) {
          phase.status = status;
          const before = JSON.stringify(workflow);
          const hold = phaseGovernanceHold(workflow, phase);
          const readiness = submissionReadinessSnapshot(workflow);
          assert.equal(readiness.lifecycleReady, false, `${id}/${phaseId}/${status}`);
          assert.equal(readiness.nextCommand, hold.actions[0].command);
          assert.equal(readiness.nextSkill, '/sf-reject');
          assert.equal(workflowGuide(workflow).nextActions[0].command, hold.actions[0].command);
          assert.throws(() => assertIntentAmendmentAcknowledged(workflow), { code: hold.code });
          assert.throws(() => assertPhaseGovernanceMayAdvance(workflow, phase), { code: hold.code });
          assert.equal(JSON.stringify(workflow), before, 'a read route acknowledged or rewrote state');
          covered.add(`${id}/${phaseId}`);
        }
        phase.status = 'approved';
      }
    }
  }
  assert.ok(covered.size >= 45, `Only ${covered.size} eligible routes checked`);
});

test('copied/renamed review steps offer honest successor authorship instead of an impossible review loop', () => {
  const phase = { id: 'custom-peer-step', status: 'in_progress', generation: 2,
    defaultAgent: 'architect', generatedAgent: 'peer', generationPolicy: { requirement: 'none' } };
  const workflow = { workItem: { id: 'COPY-1' }, currentPhase: phase.id, status: 'in_progress',
    phaseOrder: [phase.id], phases: { [phase.id]: phase }, history: [],
    resolution: { sourceReview: { mode: 'enforce', phases: [phase.id], reviewerAgent: 'peer' } } };
  assert.equal(phaseNeedsGeneration(workflow, phase), true);
  assert.throws(() => assertPhaseGovernanceMayAdvance(workflow, phase), { code: 'SOURCE_REVIEW_AUTHOR_COLLISION' });
  const hold = phaseGovernanceHold(workflow, phase);
  assert.equal(hold.classification, 'source-review-author-conflict');
  assert.deepEqual(hold.actions.map(entry => entry.command), [
    'singularity-flow agent --agent architect', 'singularity-flow prepare custom-peer-step'
  ]);
  assert.equal(workflowGuide(workflow).nextActions[0].command, hold.actions[0].command);
  assert.equal(submissionReadinessSnapshot(workflow).classification, hold.classification);
  phase.status = 'awaiting_approval';
  assert.equal(phaseGovernanceHold(workflow, phase).actions[1].skill, '/sf-reject');
  assert.match(phaseGovernanceHold(workflow, phase).actions[1].command, /--to custom-peer-step/);
  phase.status = 'in_progress';
  phase.generationPolicy = { requirement: 'required', task: 'code' };
  phase.generationIntent = { status: 'consumed' };
  assert.match(phaseGovernanceHold(workflow, phase).actions[1].command, /phase rollover custom-peer-step --json/);
  phase.generationPolicy = { requirement: 'none' };
  delete phase.generationIntent;
  phase.generatedAgent = 'architect';
  assert.equal(phaseGovernanceHold(workflow, phase), null);
  assert.equal(phaseNeedsGeneration(workflow, phase), false);
});

test('read-only role enforcement covers every lifecycle operation even when source review is off', () => {
  const config = { agents: { peer: { metadata: { 'sflow-mode': 'read-only-review' } },
    utility: { metadata: { 'sflow-mode': 'read-only' } }, writer: {} } };
  const workflow = { workItem: { id: 'ROLE-1' }, resolution: { sourceReview: { mode: 'off' } } };
  for (const id of ['scope', 'planning-copy', 'build', 'inspect', 'release']) {
    const phase = { id, defaultAgent: 'writer' };
    for (const operation of ['prepare', 'begin', 'publish', 'submit', 'approve', 'reject', 'cancel']) {
      for (const agent of ['peer', 'utility']) assert.throws(() =>
        assertPhaseAgentMayMutate(config, workflow, phase, { agent }, operation), error =>
        error.details.actions[0].command === 'singularity-flow agent --agent writer');
      assert.doesNotThrow(() => assertPhaseAgentMayMutate(config, workflow, phase, { agent: 'writer' }, operation));
    }
  }
});

test('readonly default authors and reviewer/author collisions are rejected at configuration validation', () => {
  const reviewer = { id: 'peer', label: 'Peer', scope: 'repository', phases: ['scope-copy'],
    defaultFor: ['scope-copy'], worldModelViews: [], metadata: { 'sflow-mode': 'read-only-review' } };
  assert.throws(() => validateAgentCatalog([reviewer], { phases: { 'scope-copy': {} } }),
    { code: 'READ_ONLY_AGENT_DEFAULT_AUTHOR' });
  assert.throws(() => assertSourceReviewerAvailable({ mode: 'enforce', phases: ['scope-copy'], reviewerAgent: 'peer' },
    [reviewer]), { code: 'SOURCE_REVIEW_AUTHOR_COLLISION' });
});
