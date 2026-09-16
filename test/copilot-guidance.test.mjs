import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionCommandLines,
  copilotAction,
  copilotCommandForCommand,
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
  assert.equal(copilotSkillForCommand('singularity-flow intent ratify intent-ir.json'), '/sf-sgos');
  assert.equal(copilotSkillForCommand('singularity-flow prepare intake'), '/sf-phase');
  assert.equal(copilotSkillForCommand('singularity-flow submit intake'), '/sf-submit');
  assert.equal(copilotSkillForCommand('singularity-flow epic create-stories'), '/sf-epic-publish');
  assert.equal(copilotSkillForCommand('singularity-flow initiative evidence add check-1'), '/sf-initiative-evidence');
  assert.equal(copilotSkillForCommand('singularity-flow gate --terminal'), '/sf-gate');
  assert.equal(copilotSkillForCommand('singularity-flow configuration show'), '/sf-configuration');
  assert.equal(copilotSkillForCommand('singularity-flow not-a-command'), '/sf-next');
});

test('SGOS and learning commands never route through the workflow catalog skill', () => {
  for (const family of [
    'program', 'process', 'policy', 'task', 'request', 'evidence', 'candidate', 'execution-unit',
    'device', 'authority-store', 'pack', 'memory', 'meta-tool'
  ]) {
    assert.equal(copilotSkillForCommand(`singularity-flow ${family} status`), '/sf-sgos', family);
    assert.equal(copilotSkillForCommand(`sflow ${family} status`), '/sf-sgos', `sflow ${family}`);
  }
  assert.equal(copilotSkillForCommand('singularity-flow learn list'), '/sf-learn');
  assert.equal(copilotSkillForCommand('sflow learn show lesson-1'), '/sf-learn');
  assert.equal(copilotSkillForCommand('singularity-flow workflow list'), '/sf-workflows');
});

test('the SGOS Copilot command retains the exact family, subcommand, and arguments', () => {
  assert.equal(
    copilotCommandForCommand('singularity-flow process status --json'),
    '/sf-sgos process status --json'
  );
  assert.equal(
    copilotCommandForCommand('sflow policy show delivery --json'),
    '/sf-sgos policy show delivery --json'
  );
  assert.equal(
    copilotCommandForCommand('singularity-flow resume WORK-1', '/sf-resume WORK-1'),
    '/sf-resume WORK-1'
  );
  assert.equal(
    copilotCommandForCommand('singularity-flow auto pause AFL-1 --confirm sha256:abc'),
    '/sf-auto pause AFL-1 --confirm sha256:abc'
  );
});

test('Jira subcommands select their exact specialized Copilot skill', () => {
  const cases = {
    status: '/sf-jira-status',
    doctor: '/sf-jira-doctor',
    assigned: '/sf-jira-assigned',
    list: '/sf-jira-assigned',
    pull: '/sf-jira-story',
    show: '/sf-jira-story',
    get: '/sf-jira-story',
    boards: '/sf-jira-board',
    board: '/sf-jira-board',
    transitions: '/sf-jira-update',
    transition: '/sf-jira-update',
    assign: '/sf-jira-update',
    priority: '/sf-jira-update',
    sprint: '/sf-jira-update',
    comment: '/sf-jira-update',
    projects: '/sf-jira-initiative',
    epics: '/sf-jira-initiative',
    children: '/sf-jira-initiative',
    permissions: '/sf-jira-initiative',
    fields: '/sf-jira-work'
  };
  for (const [subcommand, skill] of Object.entries(cases)) {
    assert.equal(copilotSkillForCommand(`singularity-flow jira ${subcommand} argument`), skill, subcommand);
  }
});

test('capability reads and diagnostics do not route through the mapping mutation journey', () => {
  assert.equal(copilotSkillForCommand('singularity-flow capability show rule-engine --json'), '/sf-capabilities');
  assert.equal(copilotSkillForCommand('singularity-flow capability organisation https://example.test/repo.git --json'), '/sf-capabilities');
  assert.equal(copilotSkillForCommand('singularity-flow capability leads --json'), '/sf-capability-doctor');
  assert.equal(copilotSkillForCommand('singularity-flow capability fsck --json'), '/sf-capability-doctor');
  assert.equal(copilotSkillForCommand('singularity-flow capability map rule-engine --json'), '/sf-capability-map');
});

test('initiative and Epic routes are closed over real skill names', () => {
  assert.equal(copilotSkillForCommand('singularity-flow initiative evidence add check-1'), '/sf-initiative-evidence');
  assert.equal(copilotSkillForCommand('singularity-flow initiative unknown'), '/sf-initiative-next');
  assert.equal(copilotSkillForCommand('singularity-flow epic planning prepare'), '/sf-epic-planning');
  assert.equal(copilotSkillForCommand('singularity-flow epic report'), '/sf-epic-status');
  assert.equal(copilotSkillForCommand('singularity-flow epic unknown'), '/sf-epic-next');
});

test('rendered action guidance leads with the command, then the Copilot skill', () => {
  const action = copilotAction({ skill: '/sflow-phase', command: 'singularity-flow prepare intake' });
  assert.equal(action.copilotCommand, '/sf-phase');
  assert.deepEqual(actionCommandLines(action), [
    'Run:',
    'Shell: singularity-flow prepare intake',
    'Copilot: /sf-phase'
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
