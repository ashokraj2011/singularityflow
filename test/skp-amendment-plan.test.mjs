import assert from 'node:assert/strict';
import test from 'node:test';

import { planSkillAmendmentEvidence } from '../src/skp-amendment-plan.mjs';

function template(id, order, inputs = []) {
  return { id, order, artifact: { path: `artifacts/${id}/${id}.md` }, inputs };
}

function skill(id, order, { skillId = id, inputs = [], sourcePaths = [],
  writeScope = 'artifact-only' } = {}) {
  return {
    id, order, kind: 'skill', writeScope,
    inputs: [...new Set(inputs.map((input) => input.phase))].map((phase) => ({ phase })),
    skillBinding: { compilationSha256: `sha256:${'c'.repeat(64)}`, bindingRefs: {
      skill: { id: skillId, packageSha256: `sha256:${'a'.repeat(64)}` },
      contractSha256: `sha256:${'b'.repeat(64)}`,
      inputs: inputs.map((input) => ({ ...input, required: true, state: 'approved' })),
      outputs: [{ id: 'report', path: `artifacts/${id}/${id}.md` }],
      readScope: { inputs: inputs.length > 0, sourcePaths }
    } }
  };
}

function input(phase, output = 'report') {
  return { phase, output, path: `artifacts/${phase}/${phase}.md` };
}

test('reviewed package selection projects only exact transitive output consumers', () => {
  const resolution = { phases: [
    template('requirements', 0),
    skill('analysis', 1, { inputs: [input('requirements', 'primary')] }),
    skill('audit', 2, { inputs: [input('requirements', 'primary')] }),
    skill('review', 3, { inputs: [input('analysis')] }),
    skill('release', 4, { inputs: [input('review')] })
  ] };
  const unchanged = structuredClone(resolution);
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: new Set(['analysis']) });
  assert.equal(result.status, 'ready');
  assert.equal(result.assurance, 'dependency-only');
  assert.deepEqual(result.affectedPhaseIds, ['analysis', 'review', 'release']);
  assert.deepEqual(result.preservedPhaseIds, ['requirements', 'audit']);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.dependencyEdges.find((edge) => edge.toPhase === 'review'), {
    fromPhase: 'analysis', outputId: 'report', toPhase: 'review'
  });
  assert.deepEqual(resolution, unchanged, 'the planner must not mutate accepted policy');
  assert.equal(Object.isFrozen(result.affectedPhaseIds), true);
});

test('template without a complete read scope is unknown after changed evidence, even with no inputs', () => {
  const resolution = { phases: [
    template('requirements', 0),
    skill('analysis', 1),
    template('testing', 2),
    skill('release', 3, { inputs: [input('testing', 'primary')] })
  ] };
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: ['analysis'] });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.affectedPhaseIds, ['analysis']);
  assert.deepEqual(result.preservedPhaseIds, ['requirements']);
  assert.deepEqual(result.unknown.map(({ phaseId }) => phaseId), ['testing', 'release']);
});

test('changed code-producing skill leaves an unrelated source reader unproven', () => {
  const resolution = { phases: [
    skill('code', 0, { writeScope: 'source-and-artifact' }),
    skill('source-audit', 1, { sourcePaths: ['src/rules.ts'] }),
    skill('isolated-audit', 2)
  ] };
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: ['code'] });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.affectedPhaseIds, ['code']);
  assert.deepEqual(result.preservedPhaseIds, ['isolated-audit']);
  assert.deepEqual(result.unknown.map(({ phaseId }) => phaseId), ['source-audit']);
});

test('an input that differs from its exact accepted producer output cannot be preserved', () => {
  const consumer = skill('audit', 2, { inputs: [input('requirements', 'primary')] });
  consumer.skillBinding.bindingRefs.inputs[0].path = 'artifacts/requirements/wrong.md';
  const resolution = { phases: [
    template('requirements', 0), skill('analysis', 1), consumer
  ] };
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: ['analysis'] });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.preservedPhaseIds, ['requirements']);
  assert.deepEqual(result.unknown.map(({ phaseId }) => phaseId), ['audit']);
});

test('a directly replaced phase with incomplete binding is affected but blocks selective reuse', () => {
  const root = skill('analysis', 0);
  delete root.skillBinding.compilationSha256;
  const resolution = { phases: [root, skill('independent', 1)] };
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: ['analysis'] });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.affectedPhaseIds, ['analysis']);
  assert.deepEqual(result.unknown.map(({ phaseId }) => phaseId), ['analysis']);
});

test('the plan refuses unselected packages and non-ordered or duplicate phases', () => {
  assert.throws(() => planSkillAmendmentEvidence({ phases: [skill('analysis', 0)] },
    { replacedSkillIds: ['other'] }), { code: 'SKP_AMENDMENT_PLAN_INVALID' });
  assert.throws(() => planSkillAmendmentEvidence({ phases: [skill('analysis', 0), skill('analysis', 1)] },
    { replacedSkillIds: ['analysis'] }), { code: 'SKP_AMENDMENT_PLAN_INVALID' });
  assert.throws(() => planSkillAmendmentEvidence({ phases: [skill('analysis', 2)] },
    { replacedSkillIds: ['analysis'] }), { code: 'SKP_AMENDMENT_PLAN_INVALID' });
});

test('one shared skill-package replacement affects each selected phase and its consumers', () => {
  const resolution = { phases: [
    skill('collect', 0, { skillId: 'shared' }),
    skill('compare', 1, { skillId: 'shared' }),
    skill('report', 2, { inputs: [input('compare')] })
  ] };
  const result = planSkillAmendmentEvidence(resolution, { replacedSkillIds: ['shared'] });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.affectedPhaseIds, ['collect', 'compare', 'report']);
  assert.deepEqual(result.preservedPhaseIds, []);
});
