import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { renderClarificationProtocol } from '../src/clarifications.mjs';
import { generationSkillForPhase } from '../src/code-delivery-policy.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { phasePromptExecutionContract, renderFinalClarificationGuard } from '../src/worldmodel.mjs';

const catalogs = [
  ['starter', new URL('../templates/workflow.yml', import.meta.url)],
  ['quality-example', new URL('../examples/workflow-with-quality-gates.yml', import.meta.url)]
];

function runtimeWorkflow(workTypeId, phaseDefinition) {
  const phase = {
    ...structuredClone(phaseDefinition),
    generationPolicy: structuredClone(phaseDefinition.generation),
    approvalPolicy: structuredClone(phaseDefinition.approval),
    requiredArtifact: structuredClone(phaseDefinition.artifact),
    generation: 0,
    status: 'in_progress'
  };
  return {
    workItem: { id: 'CLARIFICATION-GUIDANCE-1', workType: workTypeId, workTypeLabel: workTypeId },
    status: 'in_progress',
    currentPhase: phase.id,
    phaseOrder: [phase.id],
    phases: { [phase.id]: phase },
    resolution: { phases: [structuredClone(phaseDefinition)] },
    history: []
  };
}

function directSkill(skill) {
  return skill.replace(/^\/sflow-/, '/sf-');
}

test('every catalogued phase route preserves its clarification policy in prompt and Copilot guidance', async () => {
  const coverage = new Map();
  const routes = [];

  for (const [catalog, url] of catalogs) {
    const definition = YAML.parse(await readFile(url, 'utf8'));
    validateDefinition(definition);

    for (const workTypeId of Object.keys(definition.workTypes).sort()) {
      for (const phaseDefinition of resolveWorkType(definition, workTypeId).phases) {
        const workflow = runtimeWorkflow(workTypeId, phaseDefinition);
        const phase = workflow.phases[phaseDefinition.id];
        const label = `${catalog}:${workTypeId}/${phase.id}`;
        const skill = generationSkillForPhase(phase);
        const contract = phasePromptExecutionContract(definition, workflow, phase);
        const protocol = renderClarificationProtocol(contract.clarification, phase.id);
        const guide = workflowGuide(workflow);
        const key = `${contract.clarification.mode}:${skill}`;

        routes.push(label);
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
        assert.equal(contract.clarification.mode, phase.clarification.mode,
          `${label} changed its pinned clarification mode`);
        assert.equal(guide.nextActions[0].skill, directSkill(skill),
          `${label} routed to a different Copilot generation skill`);

        if (contract.clarification.mode === 'off') {
          assert.equal(protocol, '', `${label} injected a clarification/recording protocol while off`);
          assert.ok(contract.lines.includes(
            '- Clarification mode: `off`; do not ask phase clarification questions or run `clarification record`'
          ), `${label} did not explicitly prohibit questions and clarification recording`);
          assert.match(
            renderFinalClarificationGuard(phase.id, contract.clarification),
            /this guard grants no authoring authority/,
            `${label} allowed the off-mode guard to grant authoring authority`
          );
        } else {
          assert.match(protocol, /# Human clarification checkpoint/, `${label} omitted its checkpoint`);
          assert.match(protocol, new RegExp('mode `' + contract.clarification.mode + '`'),
            `${label} rendered the wrong checkpoint mode`);
          assert.match(protocol, new RegExp(`clarification record ${phase.id} --response-file`),
            `${label} omitted durable accepted-answer recording`);
        }
      }
    }
  }

  assert.ok(routes.length >= 65, `catalog route inventory unexpectedly shrank to ${routes.length}`);
  assert.ok(coverage.has('required:/sflow-phase'), 'no required phase route was exercised');
  assert.ok(coverage.has('when-needed:/sflow-phase'), 'no conditional document route was exercised');
  assert.ok(coverage.has('when-needed:/sflow-code'), 'no conditional code route was exercised');
  assert.ok(coverage.has('off:/sflow-phase'), 'no off document route was exercised');
  assert.ok(coverage.has('off:/sflow-code'), 'no off code route was exercised');
  assert.ok(coverage.has('off:/sflow-converge'), 'no off deterministic convergence route was exercised');
  for (const expected of [
    'starter:quick-fix/implement',
    'starter:reference-driven-build/planning',
    'starter:reference-driven-build/release',
    'starter:spec-driven-standard/planning',
    'starter:poc-lite/poc-lite-act'
  ]) assert.ok(routes.includes(expected), `${expected} was not covered`);
});
