import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import {
  createLearningFixture, createLearningModule, createLearningWorkspaceService,
  createReadOnlyLessonCatalog, platformSha256, validateLearningFixture,
  validateLearningModule, validateLearningOfflineBundle
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

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-learning-workspace-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Learning Tester'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'learning@example.invalid'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Learning host\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function learningFixture(overrides = {}) {
  return createLearningFixture({
    kind: 'learning-fixture', id: 'recovery-refusal-fixture', version: 1,
    files: [{
      path: 'README.md',
      content: '# Disposable recovery exercise\n\nEdit this copy; it has no governance authority.\n'
    }],
    ...overrides
  });
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

test('learning fixtures are bounded text-only identities and refuse unsafe payloads', () => {
  const fixture = learningFixture();
  assert.equal(validateLearningFixture(fixture).fixtureSha256, fixture.fixtureSha256);

  const traversal = structuredClone(fixture);
  delete traversal.fixtureSha256;
  traversal.files[0].path = '../outside.txt';
  assert.throws(() => createLearningFixture(traversal),
    (error) => error.code === 'SGOS_LEARN_FIXTURE_PATH_INVALID');

  const executable = structuredClone(fixture);
  delete executable.fixtureSha256;
  executable.files[0].command = ['node', 'exercise.js'];
  assert.throws(() => createLearningFixture(executable), /unknown field 'command'/);

  const secret = structuredClone(fixture);
  delete secret.fixtureSha256;
  secret.files[0].content = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key';
  assert.throws(() => createLearningFixture(secret),
    (error) => error.code === 'SGOS_LEARN_SECRET_REFUSED');
});

test('offline learning bundles carry exact inert content but never Pack authority', async (t) => {
  const firstRoot = await repository(t);
  const secondRoot = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const pack = packFor(module);
  const request = { role: 'developer', lessonId: module.id, module, fixture };
  const first = createLearningWorkspaceService({
    lessonCatalog: createReadOnlyLessonCatalog({ packRegistry: registry(pack) }),
    repositoryRoot: firstRoot
  });
  const bundle = await first.offlineBundle(request);
  assert.equal(validateLearningOfflineBundle(bundle).bundleSha256, bundle.bundleSha256);
  assert.equal(bundle.networkRequired, false);
  assert.equal(bundle.authority, false);
  assert.equal(bundle.activation, false);
  assert.equal(bundle.certification, false);
  assert.equal(bundle.authorityRequirement, 'matching-active-pack');

  const second = createLearningWorkspaceService({
    lessonCatalog: createReadOnlyLessonCatalog({ packRegistry: registry(pack) }),
    repositoryRoot: secondRoot
  });
  const plan = await second.bundlePlan(bundle);
  const materialized = await second.materializeBundle(bundle, plan.confirmationSha256);
  assert.equal(materialized.status, 'ready');
  assert.equal(await readFile(path.join(materialized.workspacePath, 'README.md'), 'utf8'),
    fixture.files[0].content);

  const tampered = structuredClone(bundle);
  tampered.fixture.files[0].content = 'changed after export\n';
  assert.throws(() => validateLearningOfflineBundle(tampered),
    (error) => ['SGOS_LEARN_FIXTURE_TAMPERED', 'SGOS_LEARN_BUNDLE_TAMPERED'].includes(error.code));

  const replacementPack = { ...pack, recordSha256: platformSha256('replacement-pack') };
  const stale = createLearningWorkspaceService({
    lessonCatalog: createReadOnlyLessonCatalog({ packRegistry: registry(replacementPack) }),
    repositoryRoot: secondRoot
  });
  await assert.rejects(() => stale.bundlePlan(bundle),
    (error) => error.code === 'SGOS_LEARN_BUNDLE_PACK_MISMATCH');
  assert.equal(execFileSync('git', ['status', '--porcelain'], {
    cwd: secondRoot, encoding: 'utf8'
  }), '');
});

test('learning workspace materialization is confirmation-bound, disposable, and outside Git', async (t) => {
  const root = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const packRegistry = registry(packFor(module));
  const catalog = createReadOnlyLessonCatalog({ packRegistry });
  const service = createLearningWorkspaceService({ lessonCatalog: catalog, repositoryRoot: root });
  const request = { role: 'developer', lessonId: module.id, module, fixture };
  const plan = await service.plan(request);
  assert.equal(plan.effects.machineLocalTutorial, 'create-or-verify');
  await assert.rejects(() => service.materialize({ ...request, confirm: platformSha256('wrong') }),
    (error) => error.code === 'SGOS_LEARN_CONFIRMATION_MISMATCH');

  const before = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const materialized = await service.materialize({ ...request, confirm: plan.confirmationSha256 });
  assert.equal(materialized.status, 'ready');
  assert.equal(materialized.authority, false);
  assert.equal(materialized.certification, false);
  assert.equal(materialized.employeeScoring, false);
  assert.equal(await readFile(path.join(materialized.workspacePath, 'README.md'), 'utf8'),
    fixture.files[0].content);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    before);
  assert.equal((await service.status(materialized.missionId)).status, 'ready');

  await writeFile(path.join(materialized.workspacePath, 'README.md'), 'learner edit\n');
  const changed = await service.status(materialized.missionId);
  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.files.changed, ['README.md']);

  const resetPlan = await service.resetPlan(materialized.missionId);
  await assert.rejects(() => service.reset(materialized.missionId, platformSha256('wrong')),
    (error) => error.code === 'SGOS_LEARN_CONFIRMATION_MISMATCH');
  const reset = await service.reset(materialized.missionId, resetPlan.confirmationSha256);
  assert.equal(reset.status, 'reset');
  assert.equal((await service.status(materialized.missionId)).status, 'not-materialized');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    before);
});

test('interrupted learning materialization is diagnosed and resumes exact fixture bytes', async (t) => {
  const root = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const catalog = createReadOnlyLessonCatalog({ packRegistry: registry(packFor(module)) });
  const service = createLearningWorkspaceService({ lessonCatalog: catalog, repositoryRoot: root });
  const request = { role: 'developer', lessonId: module.id, module, fixture };
  const plan = await service.plan(request);
  const missionSegment = plan.missionId.slice('sha256:'.length);
  const partialWorkspace = path.join(
    root, '.git', 'singularity-flow', 'sgos', 'learning', missionSegment, 'workspace'
  );
  await mkdir(partialWorkspace, { recursive: true });
  await writeFile(path.join(partialWorkspace, 'README.md'), fixture.files[0].content);

  const interrupted = await service.status(plan.missionId);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.recovery, 'repeat-confirmed-materialize');
  assert.equal(interrupted.partialEntryCount, 1);

  const resumed = await service.materialize({ ...request, confirm: plan.confirmationSha256 });
  assert.equal(resumed.status, 'ready');
  assert.equal((await service.status(plan.missionId)).status, 'ready');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
});

test('learning workspace confirmation cannot outlive signed Pack lesson authority', async (t) => {
  const root = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const packRegistry = registry(packFor(module));
  const catalog = createReadOnlyLessonCatalog({ packRegistry });
  const service = createLearningWorkspaceService({ lessonCatalog: catalog, repositoryRoot: root });
  const request = { role: 'developer', lessonId: module.id, module, fixture };
  const plan = await service.plan(request);
  packRegistry.replace();
  await assert.rejects(
    () => service.materialize({ ...request, confirm: plan.confirmationSha256 }),
    (error) => error.code === 'SGOS_LEARN_LESSON_UNAVAILABLE'
  );
});

test('learning progress is identity-free, monotonic, portable, and never certification', async (t) => {
  const firstRoot = await repository(t);
  const secondRoot = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const pack = packFor(module);
  const firstCatalog = createReadOnlyLessonCatalog({ packRegistry: registry(pack) });
  const secondCatalog = createReadOnlyLessonCatalog({ packRegistry: registry(pack) });
  const first = createLearningWorkspaceService({
    lessonCatalog: firstCatalog, repositoryRoot: firstRoot
  });
  const second = createLearningWorkspaceService({
    lessonCatalog: secondCatalog, repositoryRoot: secondRoot
  });
  const common = { role: 'developer', lessonId: module.id, module, fixture };
  const firstPlan = await first.plan(common);
  const firstWorkspace = await first.materialize({
    ...common, confirm: firstPlan.confirmationSha256
  });
  const secondPlan = await second.plan(common);
  await second.materialize({ ...common, confirm: secondPlan.confirmationSha256 });

  const failed = await first.recordCheck({
    ...common, checkId: 'recovery-choice',
    answer: { selectedOptionIds: ['copy-new-digest'] }
  });
  assert.equal(failed.changed, false);
  assert.equal(failed.result.status, 'needs-review');
  assert.equal((await first.progress(firstWorkspace.missionId)).status, 'not-started');

  const passed = await first.recordCheck({
    ...common, checkId: 'recovery-choice',
    answer: { selectedOptionIds: ['review-current-plan'] }
  });
  assert.equal(passed.changed, true);
  assert.deepEqual(passed.progress.completedCheckIds, ['recovery-choice']);
  assert.equal(passed.progress.recordsAttempts, false);
  assert.equal(passed.progress.recordsIdentity, false);
  assert.equal(passed.progress.recordsTime, false);
  assert.equal(passed.progress.recordsAnswers, false);
  assert.equal(passed.progress.certification, false);

  const transfer = await first.exportProgress(firstWorkspace.missionId);
  assert.equal(transfer.containsIdentity, false);
  assert.equal(transfer.containsAnswers, false);
  assert.equal(transfer.containsTiming, false);
  assert.doesNotMatch(transfer.transfer, /Learning Tester|review-current-plan|copy-new-digest/);
  const importPlan = await second.importPlan(transfer.transfer);
  assert.deepEqual(importPlan.checksAdded, ['recovery-choice']);
  await assert.rejects(
    () => second.importProgress(transfer.transfer, platformSha256('wrong')),
    (error) => error.code === 'SGOS_LEARN_CONFIRMATION_MISMATCH'
  );
  const imported = await second.importProgress(transfer.transfer, importPlan.confirmationSha256);
  assert.equal(imported.changed, true);
  assert.equal(imported.authority, false);
  assert.equal(imported.certification, false);
  assert.equal(imported.employeeScoring, false);
  assert.deepEqual((await second.progress(firstWorkspace.missionId)).completedCheckIds,
    ['recovery-choice']);
  const repeatedPlan = await second.importPlan(transfer.transfer);
  assert.deepEqual(repeatedPlan.checksAdded, []);
  const repeated = await second.importProgress(transfer.transfer,
    repeatedPlan.confirmationSha256);
  assert.equal(repeated.changed, false);

  const replacement = transfer.transfer.endsWith('A') ? 'B' : 'A';
  await assert.rejects(
    () => second.importPlan(`${transfer.transfer.slice(0, -1)}${replacement}`),
    (error) => ['SGOS_LEARN_PROGRESS_TRANSFER_INVALID', 'SGOS_LEARN_PROGRESS_TAMPERED']
      .includes(error.code)
  );
  assert.equal(execFileSync('git', ['status', '--porcelain'], {
    cwd: firstRoot, encoding: 'utf8'
  }), '');
  assert.equal(execFileSync('git', ['status', '--porcelain'], {
    cwd: secondRoot, encoding: 'utf8'
  }), '');
});

test('learning progress v1 migrates in memory and its portable token remains importable', async (t) => {
  const firstRoot = await repository(t);
  const secondRoot = await repository(t);
  const fixture = learningFixture();
  const module = learningModule({
    sandboxFixture: {
      kind: 'descriptor-only', fixtureId: fixture.id, fixtureSha256: fixture.fixtureSha256
    }
  });
  const pack = packFor(module);
  const request = { role: 'developer', lessonId: module.id, module, fixture };
  const first = createLearningWorkspaceService({
    lessonCatalog: createReadOnlyLessonCatalog({ packRegistry: registry(pack) }),
    repositoryRoot: firstRoot
  });
  const second = createLearningWorkspaceService({
    lessonCatalog: createReadOnlyLessonCatalog({ packRegistry: registry(pack) }),
    repositoryRoot: secondRoot
  });
  const firstPlan = await first.plan(request);
  const firstWorkspace = await first.materialize({
    ...request, confirm: firstPlan.confirmationSha256
  });
  const secondPlan = await second.plan(request);
  await second.materialize({ ...request, confirm: secondPlan.confirmationSha256 });

  const v1Core = {
    schemaVersion: 1,
    kind: 'learning-progress',
    missionId: firstWorkspace.missionId,
    lessonId: firstWorkspace.lessonId,
    role: firstWorkspace.role,
    packId: firstWorkspace.packId,
    packSha256: firstWorkspace.packSha256,
    moduleSha256: firstWorkspace.moduleSha256,
    fixtureSha256: firstWorkspace.fixtureSha256,
    completedCheckIds: ['recovery-choice'],
    authority: false,
    certification: false,
    employeeScoring: false
  };
  const v1 = { ...v1Core, progressSha256: platformSha256(v1Core) };
  const missionSegment = firstWorkspace.missionId.slice('sha256:'.length);
  const progressFile = path.join(
    firstRoot, '.git', 'singularity-flow', 'sgos', 'learning', missionSegment, 'progress.json'
  );
  await writeFile(progressFile, canonicalJson(v1));

  const migrated = await first.progress(firstWorkspace.missionId);
  assert.deepEqual(migrated.completedCheckIds, ['recovery-choice']);
  const exported = await first.exportProgress(firstWorkspace.missionId);
  assert.match(exported.transfer, /^sflow-learning-progress-v2\./);

  const legacyTransfer = `sflow-learning-progress-v1.${Buffer.from(canonicalJson(v1), 'utf8').toString('base64url')}`;
  const importPlan = await second.importPlan(legacyTransfer);
  assert.deepEqual(importPlan.checksAdded, ['recovery-choice']);
  const imported = await second.importProgress(legacyTransfer, importPlan.confirmationSha256);
  assert.deepEqual(imported.progress.completedCheckIds, ['recovery-choice']);

  await first.recordCheck({
    ...request,
    checkId: 'recovery-teach-back',
    answer: { text: 'Review current plan and its exact digest.' }
  });
  const upgraded = JSON.parse(await readFile(progressFile, 'utf8'));
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.progressProfile, 'identity-free-monotonic-v2');
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
    employeeScoring: false,
    progress: {
      persistence: 'machine-local-optional',
      portableTransfer: 'explicit-content-addressed-copy',
      identity: false, timing: false, answers: false, authority: false
    }
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
