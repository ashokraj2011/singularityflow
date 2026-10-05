import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType } from '../src/config.mjs';
import { bindAcceptedPhaseInterpretation, intentAmendmentSource, scopeStepOf } from '../src/phase-roles.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { renderClarificationProtocol } from '../src/clarifications.mjs';

function runtime(resolved) {
  const phases = Object.fromEntries(resolved.phases.map(phase => [phase.id, {
    ...structuredClone(phase), requiredArtifact: phase.artifact, approvalPolicy: phase.approval,
    status: 'approved', generation: 1
  }]));
  return { workItem: { id: 'INTENT-1', workType: resolved.id }, status: 'in_progress',
    currentPhase: null, phaseOrder: resolved.phases.map(phase => phase.id), phases,
    resolution: { obligationGraph: resolved.obligationGraph, reworkLoops: [] } };
}

test('every packaged and example workflow defaults to amendments in every active downstream phase', async () => {
  const covered = new Set();
  for (const relative of ['../templates/workflow.yml', '../examples/workflow-with-quality-gates.yml']) {
    const definition = YAML.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
    for (const id of Object.keys(definition.workTypes)) {
      const workflow = runtime(resolveWorkType(definition, id));
      const scope = scopeStepOf(workflow);
      // A profile explicitly omitting scope has no approved requirement clauses to amend.
      if (!scope) {
        workflow.currentPhase = workflow.phaseOrder[0];
        workflow.phases[workflow.currentPhase].status = 'in_progress';
        assert.equal(intentAmendmentSource(workflow), false);
        continue;
      }
      for (const phaseId of workflow.phaseOrder.slice(workflow.phaseOrder.indexOf(scope.id) + 1)) {
        workflow.currentPhase = phaseId;
        workflow.phases[phaseId].status = 'in_progress';
        assert.equal(intentAmendmentSource(workflow), true, `${id}/${phaseId}`);
        const action = workflowGuide(workflow).nextActions.find(entry => entry.command.includes('intent-amendment propose'));
        assert.ok(action, `${id}/${phaseId} offers no amendment route`);
        assert.equal(action.skill, '/sf-reject');
        assert.equal(action.optional, true);
        covered.add(`${id}/${phaseId}`);
        workflow.phases[phaseId].status = 'awaiting_approval';
        assert.equal(intentAmendmentSource(workflow), true, `${id}/${phaseId} review`);
        workflow.phases[phaseId].status = 'approved';
      }
    }
  }
  assert.ok(covered.size >= 45, `Only ${covered.size} downstream routes covered`);
  for (const route of ['spec-driven-standard/planning', 'spec-driven-standard/convergence',
    'spec-driven-standard/verification', 'spec-driven-standard/release', 'classic-delivery/implementation',
    'classic-delivery/testing', 'quick-fix/implement', 'feature/design']) assert.ok(covered.has(route), route);
});

test('future renamed workflows need no convergence phase, revision loop or YAML amendment setting', () => {
  const workflow = { workItem: { id: 'INTENT-1', workType: 'future-custom-workflow' }, status: 'in_progress',
    currentPhase: 'peer-signoff', phaseOrder: ['agreed-outcome', 'delivery', 'peer-signoff'],
    resolution: { obligationGraph: { nodes: [{ id: 'agreed-outcome', responsibilities: ['scope', 'plan'] }] } },
    phases: { 'agreed-outcome': { id: 'agreed-outcome', status: 'approved', generation: 1 },
      delivery: { id: 'delivery', status: 'approved', generation: 1 },
      'peer-signoff': { id: 'peer-signoff', status: 'in_progress', generation: 0 } } };
  assert.equal(intentAmendmentSource(workflow), true);
  assert.ok(workflowGuide(workflow).nextActions.some(action => action.command.includes('intent-amendment propose')));
  assert.equal(intentAmendmentSource(workflow, 'delivery'), false, 'caller cannot bind a different phase');
  workflow.phases['agreed-outcome'].status = 'in_progress';
  assert.equal(intentAmendmentSource(workflow), false, 'unapproved intent is a draft, not an amendment');
  workflow.phases['agreed-outcome'].status = 'approved';
  for (const status of ['cancelled', 'completed', 'complete', 'archived']) {
    workflow.status = status;
    assert.equal(intentAmendmentSource(workflow), false, `${status} must not silently reopen`);
  }
});

test('existing pins with read-side role interpretation gain the default without rewriting policy or Story state', () => {
  const workflow = { workItem: { id: 'OLD-1', workType: 'older-custom-workflow' }, status: 'in_progress',
    currentPhase: 'build', phaseOrder: ['scope', 'build'], resolution: { phases: [] },
    workflowSnapshot: { sha256: 'a'.repeat(64) },
    phases: { scope: { id: 'scope', status: 'approved', generation: 1 },
      build: { id: 'build', status: 'in_progress', generation: 0 } } };
  const before = JSON.stringify(workflow);
  bindAcceptedPhaseInterpretation(workflow, {}, { scope: ['scope', 'plan', 'review'], build: ['implement'] });
  assert.equal(intentAmendmentSource(workflow), true);
  assert.ok(workflowGuide(workflow).nextActions.some(action => action.command.includes('intent-amendment propose')));
  assert.equal(JSON.stringify(workflow), before, 'read-side compatibility rewrote the accepted Story');
});

test('Copilot guidance distinguishes unapproved drafts from universally available approved-intent amendments', async () => {
  const protocol = renderClarificationProtocol({ mode: 'required' }, 'custom-build');
  assert.match(protocol, /no convergence finding or revision loop is required/);
  assert.match(protocol, /Before scope approval.*revise\/review the scope draft/);
  const skill = await readFile(new URL('../plugin/skills/sflow-reject/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /intent-amendment propose --work-id/);
  assert.match(skill, /do not invent an `update-intent` convergence/);
  assert.match(skill, /Only an authorized human scope reviewer/);
  assert.match(skill, /stale proposal can be rejected/);
});
