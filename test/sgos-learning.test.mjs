import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLearningModule, createReadOnlyLessonCatalog, platformSha256, validateLearningModule
} from '../src/sgos/platform/index.mjs';

function learningModule(overrides = {}) {
  return createLearningModule({
    kind: 'learning-module',
    id: 'recovery-basics',
    version: 1,
    role: 'developer',
    title: 'Recover a refused Process safely',
    objectives: [{
      objectiveId: 'diagnose-refusal',
      statement: 'Distinguish a refusal from permission to retry.'
    }],
    sandboxFixture: {
      kind: 'descriptor-only',
      fixtureId: 'recovery-refusal-fixture',
      fixtureSha256: platformSha256('fixture:recovery-refusal')
    },
    steps: [{
      stepId: 'inspect-refusal',
      title: 'Inspect the refusal',
      kind: 'refusal-diagnosis',
      instruction: 'Read the declared refusal and identify the stable error code.',
      objectiveIds: ['diagnose-refusal'],
      evidenceIds: ['refusal-observed'],
      failureExerciseIds: ['unsafe-retry'],
      completionCheckIds: ['recovery-choice', 'recovery-teach-back'],
      change: {
        effect: 'none',
        description: 'This inspection is declarative and changes no state.'
      }
    }],
    expectedEvidence: [{
      evidenceId: 'refusal-observed',
      kind: 'refusal-code',
      description: 'The learner identifies the refusal code.',
      expected: 'SGOS_RECOVERY_CONFIRMATION_REQUIRED'
    }],
    failureExercises: [{
      exerciseId: 'unsafe-retry',
      title: 'Retry without a current plan',
      scenario: 'A stale confirmation digest is supplied after Process state changes.',
      expectedRefusalCode: 'SGOS_RECOVERY_CONFIRMATION_MISMATCH',
      recovery: 'Inspect the current recovery plan and review its exact digest.'
    }],
    completionChecks: [{
      checkId: 'recovery-choice',
      type: 'quiz',
      prompt: 'Which action is safe after a stale recovery confirmation?',
      options: [
        { optionId: 'copy-new-digest', label: 'Copy the newly printed digest without review.' },
        { optionId: 'review-current-plan', label: 'Review the current plan and confirm those exact bytes.' }
      ],
      acceptedOptionIds: ['review-current-plan'],
      explanation: 'A fresh plan must be reviewed because state may have changed.'
    }, {
      checkId: 'recovery-teach-back',
      type: 'teach-back',
      prompt: 'Explain the recovery safety boundary.',
      requiredConcepts: ['exact digest', 'review current plan'],
      explanation: 'Both the reviewed plan and its exact digest are required.'
    }],
    ...overrides
  });
}

function registry(...packs) {
  let active = packs;
  return {
    profile: 'signed-declarative-local-v1',
    async listActive() { return active; },
    replace(...next) { active = next; }
  };
}

function packFor(module, { packId = 'software-delivery', role = 'developer' } = {}) {
  return {
    packId,
    recordSha256: platformSha256(`pack:${packId}`),
    domain: packId,
    lessons: [{
      lessonId: module.id,
      title: module.title,
      roles: [role],
      contentSha256: module.moduleSha256
    }]
  };
}

test('learning-module v1 is strict, bounded, content-addressed, and non-executable', () => {
  const module = learningModule();
  assert.equal(validateLearningModule(module).moduleSha256, module.moduleSha256);

  const tampered = structuredClone(module);
  tampered.title = 'Changed after Pack review';
  assert.throws(() => validateLearningModule(tampered), (error) =>
    error.code === 'SGOS_LEARN_MODULE_TAMPERED');

  assert.throws(() => createLearningModule({
    ...structuredClone(module),
    moduleSha256: undefined
  }), /without moduleSha256/);

  const executable = structuredClone(module);
  delete executable.moduleSha256;
  executable.sandboxFixture.command = ['node', 'fixture.js'];
  assert.throws(() => createLearningModule(executable), /unknown field 'command'/);

  const escaped = structuredClone(module);
  delete escaped.moduleSha256;
  escaped.steps[0].change.effect = 'repository-write';
  assert.throws(() => createLearningModule(escaped), /change effect is not installed/);

  const excessive = structuredClone(module);
  delete excessive.moduleSha256;
  excessive.steps = Array.from({ length: 129 }, (_, index) => ({
    ...excessive.steps[0], stepId: `step-${String(index).padStart(3, '0')}`
  }));
  assert.throws(() => createLearningModule(excessive), (error) => error.code === 'SGOS_LEARN_LIMIT');
});

test('signed active Pack catalog filters by role and Pack and binds the exact module digest', async () => {
  const module = learningModule();
  const first = packFor(module);
  const second = packFor(module, { packId: 'operations' });
  const packRegistry = registry(first, second);
  const catalog = createReadOnlyLessonCatalog({ packRegistry });

  assert.equal((await catalog.list({ role: 'developer' })).length, 2);
  assert.deepEqual((await catalog.list({ role: 'developer', packId: 'operations' }))
    .map((lesson) => lesson.packId), ['operations']);
  assert.deepEqual(await catalog.list({ role: 'reviewer' }), []);
  await assert.rejects(() => catalog.show({ role: 'developer', lessonId: module.id }),
    (error) => error.code === 'SGOS_LEARN_LESSON_AMBIGUOUS');
  assert.equal((await catalog.show({
    role: 'developer', lessonId: module.id, packId: first.packId
  })).contentSha256, module.moduleSha256);

  const stale = learningModule({ title: 'Different reviewed bytes' });
  await assert.rejects(() => catalog.start({
    role: 'developer', lessonId: module.id, packId: first.packId, module: stale
  }), (error) => error.code === 'SGOS_LEARN_MODULE_BINDING_MISMATCH');
  await assert.rejects(() => catalog.list({ role: 'Playwright Test Engineer' }),
    (error) => error.code === 'SGOS_LEARN_ROLE_INVALID');

  packRegistry.replace();
  await assert.rejects(() => catalog.start({
    role: 'developer', lessonId: module.id, packId: first.packId, module
  }), (error) => error.code === 'SGOS_LEARN_LESSON_UNAVAILABLE');
});

test('mission planning, inspection, and change explanation are explicit read-only projections', async () => {
  const module = learningModule();
  const pack = packFor(module);
  const catalog = createReadOnlyLessonCatalog({ packRegistry: registry(pack) });

  const plan = await catalog.start({ role: 'developer', lessonId: module.id, module });
  assert.equal(plan.kind, 'learning-mission-plan');
  assert.equal(plan.sandbox.materialization, 'not-performed');
  assert.equal(plan.sandbox.executionAllowed, false);
  assert.deepEqual(plan.boundary, {
    profile: 'descriptor-only-guided-mission-v1',
    execution: 'none', modelInvocations: 0, toolInvocations: 0,
    repositoryChanges: false, gitChanges: false, processAuthority: false,
    employeeScoring: false, progress: { persistence: 'none', authority: false }
  });
  assert.equal(Object.hasOwn(plan, 'command'), false);
  assert.equal(Object.hasOwn(plan, 'path'), false);

  const inspection = await catalog.inspect({ role: 'developer', lessonId: module.id, module });
  assert.deepEqual(inspection.counts, {
    steps: 1, evidence: 1, failureExercises: 1, completionChecks: 2
  });
  const explanation = await catalog.explainChange({
    role: 'developer', lessonId: module.id, module, stepId: 'inspect-refusal'
  });
  assert.deepEqual(explanation.effects, {
    repository: 'none', git: 'none', governedProcess: 'none', devices: 'none',
    secrets: 'not-accepted', machineLocalTutorial: 'none'
  });
  await assert.rejects(() => catalog.explainChange({
    role: 'developer', lessonId: module.id, module, stepId: 'missing-step'
  }), (error) => error.code === 'SGOS_LEARN_STEP_UNAVAILABLE');
});

test('quiz and teach-back evaluation are deterministic, bounded, non-authoritative, and redact answers', async () => {
  const module = learningModule();
  const catalog = createReadOnlyLessonCatalog({ packRegistry: registry(packFor(module)) });
  const common = { role: 'developer', lessonId: module.id, module };

  const passedQuiz = await catalog.quiz({
    ...common, checkId: 'recovery-choice', answer: { selectedOptionIds: ['review-current-plan'] }
  });
  assert.equal(passedQuiz.status, 'passed');
  assert.equal(passedQuiz.certification, false);
  assert.equal(passedQuiz.authority, false);
  const failedQuiz = await catalog.quiz({
    ...common, checkId: 'recovery-choice', answer: { selectedOptionIds: ['copy-new-digest'] }
  });
  assert.equal(failedQuiz.status, 'needs-review');

  const teachBack = await catalog.teachBack({
    ...common,
    checkId: 'recovery-teach-back',
    answer: { text: 'I review current plan bytes, then bind the exact digest.' }
  });
  assert.equal(teachBack.status, 'passed');
  assert.deepEqual(teachBack.missingConcepts, []);
  assert.doesNotMatch(JSON.stringify(teachBack), /I review current plan bytes/);
  assert.match(teachBack.limitations, /does not establish semantic understanding/);

  const incomplete = await catalog.teachBack({
    ...common, checkId: 'recovery-teach-back', answer: { text: 'I retry the request.' }
  });
  assert.equal(incomplete.status, 'needs-review');
  assert.deepEqual(incomplete.missingConcepts, ['exact digest', 'review current plan']);

  await assert.rejects(() => catalog.teachBack({
    ...common,
    checkId: 'recovery-teach-back',
    answer: { text: `Use ghp_${'A'.repeat(40)} for the exercise.` }
  }), (error) => error.code === 'SGOS_LEARN_SECRET_REFUSED');
});
