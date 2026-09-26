import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

import { resolveWorkType, validateDefinition } from '../src/config.mjs';
import {
  compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256
} from '../src/skp-contract.mjs';

const H = (digit) => `sha256:${digit.repeat(64)}`;

async function configuredSkill() {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  definition.version = 3;
  const order = [...definition.workTypes.feature.phases];
  order.splice(order.indexOf('requirements') + 1, 0, 'threat-model');
  const authoring = {
    id: 'threat-model', kind: 'skill', label: 'Threat model',
    skill: { id: 'threat-model', packageSha256: H('a') },
    contract: {
      task: 'analyze',
      consumes: [{ phase: 'requirements', output: 'primary', required: true, state: 'approved' }],
      produces: [{
        id: 'threat-report', path: 'artifacts/threat-model/threat-model.md',
        kind: 'custom:threat-model', mediaType: 'text/markdown', encoding: 'utf-8',
        minimumBytes: 400, maximumBytes: 131072, clauses: 'optional', claimRole: 'findings'
      }],
      checks: ['markdownlint'], writeScope: 'artifact-only',
      readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['engineering-reviewers'], minimum: 1 }
    }
  };
  const catalog = {
    skillPackages: { 'threat-model': { packageSha256: H('a'), eligibility: 'candidate-producer' } },
    phases: { requirements: { outputs: [{
      id: 'primary', path: definition.phases.requirements.artifact.path
    }] } },
    checks: { markdownlint: {
      id: 'markdownlint', argv: ['markdownlint', 'artifacts/threat-model/threat-model.md'],
      modelPolicy: 'never', kind: 'lint', requirement: 'required'
    } },
    approvalAuthorities: { 'engineering-reviewers': definition.approvalAuthorities['engineering-reviewers'] },
    approvalSecurity: definition.approvalSecurity,
    readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const compiled = compileConfirmedSkillPhase({
    phase: authoring, catalog, phaseOrder: order,
    confirmation: {
      contractSha256: skillContractSha256(authoring.id, authoring.contract),
      catalogSha256, packageSha256: authoring.skill.packageSha256,
      candidateSha256: skillPhaseCandidateSha256(authoring, order, catalogSha256),
      planSha256: H('b'), draftRevision: 8
    }
  });
  definition.phases['threat-model'] = configurationPhaseFromCompiledSkill(compiled);
  definition.workTypes.feature.phases = order;
  return definition;
}

test('v3 admits an exact compiled skill policy and preserves its selected binding in resolution', async () => {
  const definition = await configuredSkill();
  validateDefinition(definition);
  const resolved = resolveWorkType(definition, 'feature');
  const skill = resolved.phases.find((phase) => phase.id === 'threat-model');
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.template, null);
  assert.equal(skill.generation.defaultProducer, 'governed-agent');
  assert.equal(skill.skillBinding.bindingRefs.skill.packageSha256, H('a'));
  assert.match(skill.skillBinding.bindingRefs.contractSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(skill.skillBinding.bindingRefs.inputs.map((input) => input.path),
    [definition.phases.requirements.artifact.path]);
});

test('v2 and altered v3 skill bindings fail before phase resolution', async () => {
  const original = await configuredSkill();
  const v2 = structuredClone(original);
  v2.version = 2;
  assert.throws(() => validateDefinition(v2), { code: 'SKP_PHASE_PRODUCER_UNSUPPORTED' });

  for (const edit of [
    (value) => { value.phases['threat-model'].artifact.path = 'artifacts/threat-model/other.md'; },
    (value) => { value.phases['threat-model'].skillBinding.parserProfile = 'unknown/v9'; },
    (value) => { value.phases['threat-model'].defaultTemplate = 'feature/intake.md'; },
    (value) => { value.workTypes.feature.phaseOverrides['threat-model'] = { inputs: [] }; },
    (value) => { value.workTypes.feature.templateOverrides['threat-model'] = 'feature/intake.md'; }
  ]) {
    const value = structuredClone(original);
    edit(value);
    assert.throws(() => validateDefinition(value),
      (error) => ['SKP_PHASE_BINDING_INVALID', 'SKP_PHASE_BINDING_UNSUPPORTED'].includes(error?.code));
  }
});

test('a changed upstream output cannot satisfy the compiled input binding', async () => {
  const definition = await configuredSkill();
  definition.phases.requirements.artifact.path = 'artifacts/requirements/renamed.md';
  assert.throws(() => validateDefinition(definition), { code: 'SKP_INPUT_UNKNOWN' });
});

test('Story schema registers skill bindings with v9/v10 and WFA v2', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/workflow.schema.json', import.meta.url), 'utf8'));
  assert.ok(schema.properties.schemaVersion.enum.includes(9));
  assert.ok(schema.properties.schemaVersion.enum.includes(10));
  assert.equal(schema.properties.resolution.properties.phases.items.properties.skillBinding.$ref,
    'workflow-definition.schema.json#/$defs/skpSkillBinding');
  assert.equal(schema.properties.phases.additionalProperties.properties.skillBinding.$ref,
    'workflow-definition.schema.json#/$defs/skpSkillBinding');
  const skillVersion = schema.allOf.find((entry) =>
    entry.then?.properties?.schemaVersion?.enum?.includes(9));
  assert.deepEqual(skillVersion.then.properties.schemaVersion.enum, [9, 10]);
  assert.equal(skillVersion.then.properties.workflowSnapshot.properties.schemaVersion.const, 2);
  assert.ok(schema.allOf.some((entry) => entry.if?.properties?.schemaVersion?.maximum === 8));
  assert.equal(schema.properties.skillVersionAmendments.items.$ref,
    '#/$defs/skillVersionAmendmentSummary');
  assert.ok(schema.$defs.skillVersionAmendmentSummary.required.includes('proposalSha256'));
  assert.ok(schema.allOf.some((entry) => entry.if?.properties?.workflowSnapshot
    ?.properties?.revision?.minimum === 2
    && entry.then?.properties?.schemaVersion?.const === 10));
});
