import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition, resolveWorkType, validateDefinition } from '../src/config.mjs';

const definition = async () => YAML.parse(await readFile(
  new URL('../templates/workflow.yml', import.meta.url), 'utf8'
));

function unsupported(action, field) {
  assert.throws(action, (error) => error?.code === 'SKP_PHASE_PRODUCER_UNSUPPORTED'
    && error?.details?.field === field
    && /template-backed phases only/.test(error.message));
}

test('legacy template phases and unrelated custom metadata retain their v2 behavior', async () => {
  const config = await definition();
  config.phases.intake.teamNote = 'Reviewed in the ordinary template workflow';
  config.phases.intake.contractOwner = 'application-team';
  config.phases.intake.packageOwner = 'application-team';
  validateDefinition(config);
  const resolved = resolveWorkType(config, 'feature');
  assert.equal(resolved.phases[0].teamNote, config.phases.intake.teamNote);
  assert.equal(resolved.phases[0].contractOwner, 'application-team');
  assert.equal(resolved.phases[0].template, 'feature/intake.md');
  assert.equal(resolved.phases.find((phase) => phase.id === 'implementation').generation.defaultProducer,
    'governed-agent', 'the existing generation producer remains valid');
});

test('a skill declaration cannot fall through to a default template at validation', async () => {
  for (const [field, value] of [
    ['kind', 'skill'],
    ['skill', { path: 'skills/review', entry: 'SKILL.md' }],
    ['contract', { task: 'analyze' }],
    ['phaseProducer', { kind: 'skill' }],
    ['skillBinding', { packageSha256: 'abc' }]
  ]) {
    const config = await definition();
    config.phases.intake[field] = value;
    unsupported(() => validateDefinition(config), field);
  }
});

test('phase overrides and nested generation bindings are guarded', async () => {
  for (const [field, value] of [
    ['kind', 'skill'],
    ['contract', { task: 'analyze' }],
    ['producerBinding', { package: 'review' }]
  ]) {
    const config = await definition();
    config.workTypes.feature.phaseOverrides ??= {};
    config.workTypes.feature.phaseOverrides.intake = { [field]: value };
    unsupported(() => validateDefinition(config), field);
  }
  const config = await definition();
  config.phases.intake.generation = { requirement: 'required', skill: 'review' };
  unsupported(() => validateDefinition(config), 'generation.skill');
});

test('direct resolution refuses producer fields on already validated definitions', async () => {
  const config = validateDefinition(await definition());
  config.workTypes.feature.phaseOverrides ??= {};
  config.workTypes.feature.phaseOverrides.intake = { skillPackage: 'sha256:abc' };
  unsupported(() => resolveWorkType(config, 'feature'), 'skillPackage');
  delete config.workTypes.feature.phaseOverrides.intake;
  config.phases.intake.kind = 'skill';
  unsupported(() => resolveWorkType(config, 'feature'), 'kind');
});

test('a repository workflow with a skill phase is refused during load', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git'));
  await initializeDefinition(root);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  config.phases.intake.kind = 'skill';
  await writeFile(file, YAML.stringify(config));
  await assert.rejects(() => loadDefinition(root), (error) => (
    error?.code === 'SKP_PHASE_PRODUCER_UNSUPPORTED'
      && error?.details?.field === 'kind'
  ));
});

test('v2 workflow schema explicitly refuses the SKP authoring fragment', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../schemas/workflow-definition.schema.json', import.meta.url), 'utf8'
  ));
  const v2 = schema.allOf.find((entry) => entry.if.properties.version.const === 2);
  assert.deepEqual(v2.then.properties.phases.additionalProperties.not.anyOf
    .map(({ required }) => required[0]), ['kind', 'skill', 'contract', 'skillBinding']);
  assert.deepEqual(schema.properties.workTypes.additionalProperties.properties.phaseOverrides
    .additionalProperties.not.anyOf.map(({ required }) => required[0]),
  ['kind', 'skill', 'contract']);
  const v3 = schema.allOf.find((entry) => entry.if.properties.version.const === 3);
  assert.deepEqual(v3.then.properties.phases.additionalProperties.oneOf[0].required,
    ['kind', 'skillBinding', 'label', 'artifact', 'inputs', 'qualityCommands',
      'approval', 'writeScope', 'generation', 'clarification']);
});
