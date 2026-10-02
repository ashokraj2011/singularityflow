import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { compileConfirmedSkillPhase, compileSkillPhaseProposal,
  configurationPhaseFromCompiledSkill } from '../src/skp-contract.mjs';
import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import { simulateResolvedWorkflowLifecycle } from '../src/workflow-lifecycle-simulation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starter = path.join(root, 'templates/starter-packs/skp-team-notes/draft-input.json');
const { bindWorkflowDraftBase, workflowDraftGuide } = await import(
  path.join(root, 'apps/vscode/src/views/workflow-drafts-guide.ts')
);

test('packaged SKP starter is an inert, base-unbound artifact-only workflow candidate', async () => {
  const text = await readFile(starter, 'utf8');
  const input = JSON.parse(text);
  const guide = workflowDraftGuide(text);
  assert.deepEqual(Object.keys(input).sort(), ['assets', 'payload']);
  assert.deepEqual(input.assets, []);
  assert.equal(input.payload.schema, 'sflow-workflow-request@2');
  assert.equal(input.payload.intent, 'create');
  assert.equal(input.payload.baseRevision, undefined,
    'the starter must not pin a framework-repository commit for an application repository');
  assert.deepEqual(input.payload.target, {
    governs: 'story', authority: 'selected-repository', hosts: []
  });
  assert.deepEqual(guide.workflows[0].phases, ['intake', 'skp-team-note', 'skp-team-review']);
  assert.deepEqual(guide.workflows[0].reworkLoops, [
    { from: 'skp-team-review', to: 'skp-team-note', maxAttempts: 3 }
  ]);
  assert.equal(guide.phases.length, 2);
  assert.equal(guide.skills.length, 1);
  assert.equal(guide.agents.length, 2);
  assert.equal(guide.templates.length, 1);

  const phase = guide.phases[0];
  const skill = guide.skills[0];
  const agent = guide.agents[0];
  assert.equal(phase.kind, 'skill');
  assert.equal(phase.skill.id, skill.id);
  assert.equal(phase.agent, agent.id);
  assert.equal(phase.contract.writeScope, 'artifact-only');
  assert.deepEqual(phase.contract.readScope, { inputs: true, sourcePaths: [] });
  assert.deepEqual(phase.contract.consumes, [
    { phase: 'intake', output: 'primary', required: true, state: 'approved' }
  ]);
  assert.equal(phase.contract.produces.length, 1);
  assert.equal(phase.contract.produces[0].claimRole, 'findings');
  assert.deepEqual(phase.contract.checks, []);
  assert.deepEqual(phase.contract.approval, { authorities: ['product-approvers'], minimum: 1 });
  assert.deepEqual(skill.producerClassification, {
    profile: 'local-reviewed-artifact-producer/v1', eligibility: 'candidate-producer'
  });
  assert.deepEqual(skill.operationBindings, []);
  assert.deepEqual(skill.qualityBindings, []);
  assert.deepEqual(skill.resources, []);
  assert.deepEqual(agent.toolBindings, []);
  assert.deepEqual(agent.skillRefs, []);
  const review = guide.phases[1];
  assert.equal(review.id, 'skp-team-review');
  assert.deepEqual(review.inputs, ['intake', 'skp-team-note']);
  assert.deepEqual(review.artifact, {
    path: 'artifacts/skp-team-review/review.md', kind: 'custom:note-review',
    minimumBytes: 20, maximumBytes: 16384
  });
  assert.equal(review.writeScope, 'artifact-only');
  assert.equal(review.taskBinding, 'analysisTask');
  assert.equal(review.approvalBinding, 'productReview');
  assert.equal(review.agent, guide.agents[1].id);
  assert.equal(review.template, guide.templates[0].id);
  assert.deepEqual(guide.agents[1].toolBindings, []);
  assert.deepEqual(input.payload.bindings, {
    analysisTask: { kind: 'execution-task', id: 'analyze' },
    productReview: { kind: 'approval-authority', id: 'product-approvers' }
  });

  const bound = JSON.parse(bindWorkflowDraftBase(text, 'a'.repeat(40)));
  assert.equal(bound.payload.baseRevision, 'a'.repeat(40));
  assert.deepEqual(bound.payload.definitions, input.payload.definitions,
    'binding the exact approved base must preserve the proposed skill and workflow');
});

test('packaged SKP starter contract compiles as proposal only, never a confirmed phase', async () => {
  const { payload } = JSON.parse(await readFile(starter, 'utf8'));
  const skill = payload.definitions.skills[0];
  const selected = payload.definitions.phases[0];
  const contents = new Map([['SKILL.md', Buffer.from(`---\n${YAML.stringify({
    name: skill.id, description: skill.description
  })}---\n${skill.instructions}\n`)]]);
  const { manifest } = inspectSkillPackageContents(skill.id, contents);
  const { agent, ...phase } = selected;
  phase.skill = { id: skill.id, packageSha256: manifest.packageSha256 };
  const catalog = {
    skillPackages: { [skill.id]: { packageSha256: manifest.packageSha256, eligibility: 'proposed-candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: 'artifacts/intake/intake.md' }] } },
    checks: {},
    approvalAuthorities: { 'product-approvers': { label: 'Product approvers', members: [] } },
    approvalSecurity: { profile: 'team' },
    readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const proposal = compileSkillPhaseProposal({
    phase, catalog, phaseOrder: payload.definitions.workflows[0].phases
  });
  assert.equal(proposal.bindingRefs.skill.id, skill.id);
  assert.equal(proposal.bindingRefs.skill.packageSha256, manifest.packageSha256);
  assert.equal(proposal.bindingRefs.outputs[0].claimRole, 'findings');
  assert.equal(proposal.confirmation, 'absent');
});

test('packaged SKP starter resolves and structurally completes with configured reviewers', async () => {
  const { payload } = JSON.parse(await readFile(starter, 'utf8'));
  const definition = YAML.parse(await readFile(path.join(root, 'templates/workflow.yml'), 'utf8'));
  definition.version = 3;
  definition.approvalAuthorities['product-approvers'].members = [
    { name: 'Team reviewer', email: 'reviewer@example.test' }
  ];
  const [selected, finish] = payload.definitions.phases;
  const skill = payload.definitions.skills[0];
  const contents = new Map([['SKILL.md', Buffer.from(`---\n${YAML.stringify({
    name: skill.id, description: skill.description
  })}---\n${skill.instructions}\n`)]]);
  const { manifest } = inspectSkillPackageContents(skill.id, contents);
  const catalog = {
    skillPackages: { [skill.id]: { packageSha256: manifest.packageSha256, eligibility: 'candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: definition.phases.intake.artifact.path }] } },
    checks: {}, approvalAuthorities: definition.approvalAuthorities,
    approvalSecurity: definition.approvalSecurity, readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const phase = { ...selected, skill: { id: skill.id, packageSha256: manifest.packageSha256 } };
  delete phase.agent;
  const order = payload.definitions.workflows[0].phases;
  const proposal = compileSkillPhaseProposal({ phase, catalog, phaseOrder: order });
  definition.phases[selected.id] = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
    phase, catalog, phaseOrder: order, confirmation: {
      contractSha256: proposal.bindingRefs.contractSha256,
      catalogSha256: proposal.bindingRefs.catalogSha256,
      packageSha256: manifest.packageSha256,
      candidateSha256: proposal.candidateSha256,
      planSha256: `sha256:${'a'.repeat(64)}`, draftRevision: 1
    }
  }));
  definition.templates ??= {};
  definition.templates[finish.template] = {
    path: `${payload.id}/${finish.template}.md`, label: payload.definitions.templates[0].label
  };
  definition.phases[finish.id] = {
    label: finish.label, artifact: finish.artifact,
    inputs: finish.inputs.map((phaseId) => ({ phase: phaseId, optional: false })),
    defaultTemplate: `template:${finish.template}`,
    generation: { requirement: 'required', defaultProducer: 'governed-agent',
      allowedProducers: ['governed-agent'], task: 'analyze' },
    approval: { mode: 'required', authorities: ['product-approvers'], minimum: 1 },
    qualityCommands: [], writeScope: 'artifact-only'
  };
  definition.workTypes[payload.id] = {
    label: payload.label, description: payload.description, phases: order,
    reworkLoops: payload.definitions.workflows[0].reworkLoops,
    omits: payload.definitions.workflows[0].omits
  };
  validateDefinition(definition);
  const resolved = resolveWorkType(definition, payload.id);
  assert.equal(resolved.plannedClaims.mode, 'disabled');
  assert.deepEqual(resolved.phases.map((entry) => entry.id), order);
  assert.equal(resolved.phases.at(-1).approval.mode, 'required');
  assert.ok(resolved.phases.at(-1).approval.rejectTo.includes('skp-team-note'));
  assert.equal(simulateResolvedWorkflowLifecycle(resolved).status, 'complete-for-profile',
    JSON.stringify(resolved.obligationGraph.findings.map((entry) => entry.message)));
});
