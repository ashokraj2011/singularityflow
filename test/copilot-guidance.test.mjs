import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionCommandLines,
  copilotAction,
  copilotSkillForCommand,
  directCopilotSkill,
  submissionReadinessPresentation
} from '../src/copilot-guidance.mjs';

test('user-facing skills always use the direct sf namespace', () => {
  assert.equal(directCopilotSkill('/sflow-submit'), '/sf-submit');
  assert.equal(directCopilotSkill('sflow-approve'), '/sf-approve');
  assert.equal(directCopilotSkill('/sf-next'), '/sf-next');
});

test('CLI lifecycle commands map to installed direct Copilot skills', () => {
  assert.equal(copilotSkillForCommand('singularity-flow intent workflow-guide intent-ir.json'), '/sf-sgos-create');
  assert.equal(copilotSkillForCommand('singularity-flow intent workflow-create intent-ir.json'), '/sf-sgos-create');
  assert.equal(copilotSkillForCommand('singularity-flow intent ratify intent-ir.json'), '/sf-workflows');
  assert.equal(copilotSkillForCommand('singularity-flow prepare intake'), '/sf-phase');
  assert.equal(copilotSkillForCommand('singularity-flow submit intake'), '/sf-submit');
  assert.equal(copilotSkillForCommand('singularity-flow epic create-stories'), '/sf-epic-publish');
  assert.equal(copilotSkillForCommand('singularity-flow initiative evidence add check-1'), '/sf-initiative-evidence');
  assert.equal(copilotSkillForCommand('singularity-flow gate --terminal'), '/sf-gate');
  assert.equal(copilotSkillForCommand('singularity-flow configuration show'), '/sf-configuration');
  assert.equal(copilotSkillForCommand('singularity-flow not-a-command'), '/sf-next');
});

test('rendered action guidance leads with the command, then the Copilot skill', () => {
  const action = copilotAction({ skill: '/sflow-phase', command: 'singularity-flow prepare intake' });
  assert.deepEqual(actionCommandLines(action), [
    'Run: singularity-flow prepare intake',
    'In Copilot: /sf-phase'
  ]);
});

test('an unpublished seeded draft disables submit and offers one phase-generation action', () => {
  const presentation = submissionReadinessPresentation({
    classification: 'generation-required',
    lifecycleReady: false,
    phaseId: 'specification',
    currentGeneration: 0,
    publishedGeneration: null,
    publicationRecorded: false,
    draftExists: true,
    draftModified: false,
    nextSkill: '/sf-phase',
    nextCommand: 'singularity-flow prepare specification'
  });

  assert.equal(presentation.statusLabel, 'Seeded draft — not published');
  assert.equal(presentation.submitEnabled, false);
  assert.deepEqual(presentation.primaryActions, [{
    label: 'Generate and publish Specification',
    skill: '/sf-phase',
    command: 'singularity-flow prepare specification',
    enabled: true,
    primary: true,
    kind: 'generate-and-publish'
  }]);
});

test('a current immutable publication is described as ready to submit', () => {
  const presentation = submissionReadinessPresentation({
    classification: 'ready-to-attempt',
    lifecycleReady: true,
    phaseId: 'implementation-spec',
    currentGeneration: 3,
    publishedGeneration: 3,
    publicationRecorded: true,
    nextSkill: '/sf-submit',
    nextCommand: 'singularity-flow submit implementation-spec --work-id READY-1'
  });

  assert.equal(presentation.statusLabel, 'Published generation 3 — ready to submit');
  assert.equal(presentation.submitEnabled, true);
  assert.deepEqual(presentation.primaryActions, [{
    label: 'Submit Implementation Spec',
    skill: '/sf-submit',
    command: 'singularity-flow submit implementation-spec --work-id READY-1',
    enabled: true,
    primary: true,
    kind: 'submit'
  }]);
});

test('non-generation refusals never get rewritten into phase generation', () => {
  const presentation = submissionReadinessPresentation({
    classification: 'synchronization-required',
    lifecycleReady: false,
    phaseId: 'specification',
    currentGeneration: 1,
    publishedGeneration: 1,
    publicationRecorded: true,
    nextSkill: '/sf-sync',
    nextCommand: 'singularity-flow sync'
  });

  assert.equal(presentation.statusLabel, 'Published generation 1 — synchronization required');
  assert.equal(presentation.submitEnabled, false);
  assert.deepEqual(presentation.primaryActions, []);
});

test('code phases preserve their engine-selected authoring skill and phase label', () => {
  const presentation = submissionReadinessPresentation({
    classification: 'generation-required',
    lifecycleReady: false,
    phaseId: 'implementation',
    phaseLabel: 'Build and test',
    currentGeneration: 0,
    publicationRecorded: false,
    draftExists: true,
    nextSkill: '/sf-code',
    nextCommand: 'singularity-flow prepare implementation'
  });

  assert.equal(presentation.primaryActions.length, 1);
  assert.equal(presentation.primaryActions[0].label, 'Generate and publish Build and test');
  assert.equal(presentation.primaryActions[0].skill, '/sf-code');
});

test('deterministic convergence preserves its engine-selected generation skill', () => {
  const presentation = submissionReadinessPresentation({
    classification: 'generation-required',
    lifecycleReady: false,
    phaseId: 'convergence',
    currentGeneration: 0,
    publicationRecorded: false,
    nextSkill: '/sf-converge',
    nextCommand: 'singularity-flow prepare convergence'
  });

  assert.equal(presentation.primaryActions.length, 1);
  assert.equal(presentation.primaryActions[0].skill, '/sf-converge');
});

test('incomplete readiness never invents a Copilot route', () => {
  const generation = submissionReadinessPresentation({
    classification: 'generation-required', lifecycleReady: false,
    phaseId: 'specification', currentGeneration: 0, publicationRecorded: false,
    draftExists: true, nextSkill: null,
    nextCommand: 'singularity-flow prepare specification'
  });
  assert.equal(generation.submitEnabled, false);
  assert.deepEqual(generation.primaryActions, []);

  const submission = submissionReadinessPresentation({
    classification: 'ready-to-attempt', lifecycleReady: true,
    phaseId: 'specification', currentGeneration: 1, publishedGeneration: 1,
    publicationRecorded: true, nextSkill: '/sf-submit', nextCommand: null
  });
  assert.equal(submission.submitEnabled, false);
  assert.deepEqual(submission.primaryActions, []);
});
