import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { validateDefinition } from '../src/config.mjs';
import {
  addPhaseToWorkType,
  createPersona,
  createPhase,
  createWorkType,
  deleteUnusedPhase,
  personaPromptRepositoryPath,
  removePhaseFromWorkType,
  removePersona,
  removeWorkType,
  repositorySkillPath,
  setWorkTypeInputs,
  templateRepositoryPath
} from '../apps/desktop/src/workflow-designer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function definition() {
  return YAML.parse(await readFile(path.join(root, 'templates/workflow.yml'), 'utf8'));
}

test('workflow designer creates and removes cloned workflow profiles', async () => {
  const original = await definition();
  const created = createWorkType(original, { id: 'security-review', label: 'Security review', copyFrom: 'feature' });
  assert.equal(created.workTypes['security-review'].label, 'Security review');
  assert.deepEqual(created.workTypes['security-review'].phases, original.workTypes.feature.phases);
  assert.notEqual(created.workTypes['security-review'].phases, original.workTypes.feature.phases);
  assert.equal(original.workTypes['security-review'], undefined);
  assert.doesNotThrow(() => validateDefinition(created));
  assert.equal(removeWorkType(created, 'security-review').workTypes['security-review'], undefined);
  await assert.rejects(async () => createWorkType(original, { id: 'Bad ID', copyFrom: 'feature' }), /kebab-case/);
});

test('workflow designer creates stages with artifact, approval, template, and input contracts', async () => {
  const original = await definition();
  const created = createPhase(original, 'chore', {
    id: 'security-review',
    label: 'Security review',
    artifactFile: 'security-review.md',
    kind: 'security-evidence',
    minimumBytes: 350,
    persona: 'architect',
    template: 'common/conformance.md',
    writeScope: 'artifact-only'
  });
  const stage = created.phases['security-review'];
  assert.equal(stage.artifact.path, 'artifacts/security-review/security-review.md');
  assert.equal(stage.artifact.minimumBytes, 350);
  assert.deepEqual(stage.approval.personas, ['architect']);
  assert.equal(created.workTypes.chore.phases.at(-1), 'security-review');
  assert.deepEqual(created.workTypes.chore.phaseOverrides['security-review'].inputs, ['conformance']);
  assert.ok(created.personas.architect.mayApprove.includes('security-review'));
  assert.doesNotThrow(() => validateDefinition(created));
});

test('workflow designer adds, sequences, removes, and cleans stage definitions safely', async () => {
  const original = await definition();
  const added = addPhaseToWorkType(original, 'chore', 'design');
  assert.equal(added.workTypes.chore.phases.at(-1), 'design');
  assert.deepEqual(added.workTypes.chore.phaseOverrides.design.inputs, ['conformance']);
  const inputs = setWorkTypeInputs(added, 'chore', 'design', ['implementation', 'verification']);
  assert.deepEqual(inputs.workTypes.chore.phaseOverrides.design.inputs, ['implementation', 'verification']);
  assert.throws(() => setWorkTypeInputs(added, 'chore', 'implementation', ['verification']), /earlier stages/);

  const removed = removePhaseFromWorkType(inputs, 'chore', 'design');
  assert.ok(!removed.workTypes.chore.phases.includes('design'));
  assert.throws(() => deleteUnusedPhase(removed, 'design'), /still used by: feature/);
  const withoutFeature = removePhaseFromWorkType(removed, 'feature', 'design');
  const deleted = deleteUnusedPhase(withoutFeature, 'design');
  assert.equal(deleted.phases.design, undefined);
  assert.ok(!deleted.personas.architect.mayApprove.includes('design'));
  assert.doesNotThrow(() => validateDefinition(deleted));
});

test('workflow designer normalizes safe template repository paths', async () => {
  const original = await definition();
  assert.equal(templateRepositoryPath(original, 'security/review.md'), 'singularity/templates/security/review.md');
  assert.throws(() => templateRepositoryPath(original, '../review.md'), /without "\.\."/);
  assert.throws(() => templateRepositoryPath(original, 'review.txt'), /relative \.md path/);
});

test('workflow designer creates personas and safely rewrites persona references', async () => {
  const original = await definition();
  const created = createPersona(original, { id: 'security-reviewer', label: 'Security reviewer', description: 'Review controls.', prompt: 'security/security-reviewer.md' });
  assert.equal(created.personas['security-reviewer'].prompt, 'security/security-reviewer.md');
  assert.equal(personaPromptRepositoryPath(created, created.personas['security-reviewer'].prompt), 'singularity/personas/security/security-reviewer.md');
  const referenced = structuredClone(created);
  referenced.phases.design.suggestedPersonas.push('security-reviewer');
  referenced.phases.design.approval.personas = ['security-reviewer'];
  const removed = removePersona(referenced, 'security-reviewer', 'architect');
  assert.equal(removed.personas['security-reviewer'], undefined);
  assert.ok(removed.phases.design.suggestedPersonas.includes('architect'));
  assert.deepEqual(removed.phases.design.approval.personas, ['architect']);
  assert.doesNotThrow(() => validateDefinition(removed));
  assert.throws(() => createPersona(original, { id: 'Bad ID' }), /kebab-case/);
});

test('workflow designer normalizes repository skill paths', () => {
  assert.equal(repositorySkillPath('security-review'), '.github/skills/security-review/SKILL.md');
  assert.throws(() => repositorySkillPath('../security'), /kebab-case/);
});
