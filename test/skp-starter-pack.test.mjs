import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { compileSkillPhaseProposal } from '../src/skp-contract.mjs';

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
  assert.deepEqual(guide.workflows[0].phases, ['intake', 'skp-team-note', 'conformance']);
  assert.equal(guide.phases.length, 1);
  assert.equal(guide.skills.length, 1);
  assert.equal(guide.agents.length, 1);

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
