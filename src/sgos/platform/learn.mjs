import { canonicalJson } from '../../records.mjs';
import { scanText } from '../../secrets.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { clonePlatformJson, isPlainPlatformObject, platformSha256 } from './contracts.mjs';

const MODULE_KIND = 'learning-module';
const MODULE_VERSION = 1;
const MODULE_MAX_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 4 * 1024;
const STEP_KINDS = Object.freeze([
  'approval-exercise', 'evidence-exercise', 'performance-explanation', 'read',
  'recovery-drill', 'refusal-diagnosis', 'workflow-visualization'
]);
const EVIDENCE_KINDS = Object.freeze([
  'explanation', 'human-observation', 'record-digest', 'refusal-code'
]);
const CHANGE_EFFECTS = Object.freeze(['none', 'machine-local-tutorial']);

function fail(message, code = 'SGOS_LEARN_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function cloneJson(value) {
  return clonePlatformJson(value, '$learningModule');
}

function exactKeys(value, allowed, label) {
  if (!isPlainPlatformObject(value)) fail(`${label} must be an object.`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) fail(`${label} contains unknown field '${key}'.`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing required field '${key}'.`);
  }
}

function boundedString(value, label, { pattern = null, maximumBytes = MAX_TEXT_BYTES } = {}) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail(`${label} must be a non-empty trimmed string.`);
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit.`, 'SGOS_LEARN_LIMIT');
  if (pattern && !pattern.test(value)) fail(`${label} has an invalid format.`);
  const findings = scanText(value, { path: '<learning-content>' });
  if (findings.length) {
    fail(`${label} contains credential-shaped content and is refused.`, 'SGOS_LEARN_SECRET_REFUSED', {
      rules: [...new Set(findings.map((finding) => finding.rule))].sort()
    });
  }
  return value;
}

function identifier(value, label) {
  return boundedString(value, label, {
    pattern: /^[a-z0-9][a-z0-9._:-]{1,127}$/, maximumBytes: 128
  });
}

function role(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) {
    fail('Learning role must use lower-case kebab case.', 'SGOS_LEARN_ROLE_INVALID');
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be exactly 'sha256:' plus 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function boundedArray(value, label, maximum, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${label} must contain between ${minimum} and ${maximum} entries.`, 'SGOS_LEARN_LIMIT');
  }
  return value;
}

function sortedUniqueIdentifiers(value, label, maximum) {
  boundedArray(value, label, maximum);
  for (let index = 0; index < value.length; index += 1) {
    identifier(value[index], `${label}[${index}]`);
    if (index > 0 && value[index - 1] >= value[index]) fail(`${label} must be sorted and unique.`);
  }
  return value;
}

function uniqueRecordIds(records, key, label) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record[key])) fail(`${label} IDs must be unique.`);
    seen.add(record[key]);
  }
  return seen;
}

function assertReferences(values, known, label) {
  for (const value of values) {
    if (!known.has(value)) fail(`${label} references unknown ID '${value}'.`);
  }
}

function moduleDigest(module) {
  const core = cloneJson(module);
  delete core.moduleSha256;
  return platformSha256(core);
}

/**
 * Validate one static learning descriptor. It is deliberately not executable Pack content: the
 * fixture is only an ID and digest, steps contain no command/path/URL field, and completion checks
 * can neither approve work nor mutate Process state.
 */
export function validateLearningModule(input) {
  exactKeys(input, [
    'kind', 'id', 'version', 'role', 'title', 'objectives', 'sandboxFixture', 'steps',
    'expectedEvidence', 'failureExercises', 'completionChecks', 'moduleSha256'
  ], 'learning module');
  if (input.kind !== MODULE_KIND) fail(`Learning module kind must be '${MODULE_KIND}'.`);
  if (input.version !== MODULE_VERSION) fail(`Learning module version must be ${MODULE_VERSION}.`);
  identifier(input.id, 'learning module.id');
  role(input.role);
  boundedString(input.title, 'learning module.title', { maximumBytes: 256 });

  boundedArray(input.objectives, 'learning module.objectives', 64, { minimum: 1 });
  for (const [index, objective] of input.objectives.entries()) {
    exactKeys(objective, ['objectiveId', 'statement'], `learning module.objectives[${index}]`);
    identifier(objective.objectiveId, `learning module.objectives[${index}].objectiveId`);
    boundedString(objective.statement, `learning module.objectives[${index}].statement`);
  }
  const objectiveIds = uniqueRecordIds(input.objectives, 'objectiveId', 'Learning objective');

  exactKeys(input.sandboxFixture, ['kind', 'fixtureId', 'fixtureSha256'],
    'learning module.sandboxFixture');
  if (input.sandboxFixture.kind !== 'descriptor-only') {
    fail("learning module.sandboxFixture.kind must be 'descriptor-only'.",
      'SGOS_LEARN_EXECUTABLE_FIXTURE_REFUSED');
  }
  identifier(input.sandboxFixture.fixtureId, 'learning module.sandboxFixture.fixtureId');
  digest(input.sandboxFixture.fixtureSha256, 'learning module.sandboxFixture.fixtureSha256');

  boundedArray(input.expectedEvidence, 'learning module.expectedEvidence', 64);
  for (const [index, evidence] of input.expectedEvidence.entries()) {
    exactKeys(evidence, ['evidenceId', 'kind', 'description', 'expected'],
      `learning module.expectedEvidence[${index}]`);
    identifier(evidence.evidenceId, `learning module.expectedEvidence[${index}].evidenceId`);
    if (!EVIDENCE_KINDS.includes(evidence.kind)) fail('Learning evidence kind is not installed.');
    boundedString(evidence.description, `learning module.expectedEvidence[${index}].description`);
    boundedString(evidence.expected, `learning module.expectedEvidence[${index}].expected`);
  }
  const evidenceIds = uniqueRecordIds(input.expectedEvidence, 'evidenceId', 'Expected evidence');

  boundedArray(input.failureExercises, 'learning module.failureExercises', 32);
  for (const [index, exercise] of input.failureExercises.entries()) {
    exactKeys(exercise, ['exerciseId', 'title', 'scenario', 'expectedRefusalCode', 'recovery'],
      `learning module.failureExercises[${index}]`);
    identifier(exercise.exerciseId, `learning module.failureExercises[${index}].exerciseId`);
    boundedString(exercise.title, `learning module.failureExercises[${index}].title`, {
      maximumBytes: 256
    });
    boundedString(exercise.scenario, `learning module.failureExercises[${index}].scenario`);
    boundedString(exercise.expectedRefusalCode,
      `learning module.failureExercises[${index}].expectedRefusalCode`, {
        pattern: /^[A-Z][A-Z0-9_]{2,127}$/, maximumBytes: 128
      });
    boundedString(exercise.recovery, `learning module.failureExercises[${index}].recovery`);
  }
  const failureIds = uniqueRecordIds(input.failureExercises, 'exerciseId', 'Failure exercise');

  boundedArray(input.completionChecks, 'learning module.completionChecks', 64, { minimum: 1 });
  for (const [index, check] of input.completionChecks.entries()) {
    if (!isPlainPlatformObject(check)) {
      fail(`learning module.completionChecks[${index}] must be an object.`);
    }
    if (check.type === 'quiz') {
      exactKeys(check, ['checkId', 'type', 'prompt', 'options', 'acceptedOptionIds', 'explanation'],
        `learning module.completionChecks[${index}]`);
      identifier(check.checkId, `learning module.completionChecks[${index}].checkId`);
      boundedString(check.prompt, `learning module.completionChecks[${index}].prompt`);
      boundedArray(check.options, `learning module.completionChecks[${index}].options`, 16, {
        minimum: 2
      });
      for (const [optionIndex, option] of check.options.entries()) {
        exactKeys(option, ['optionId', 'label'],
          `learning module.completionChecks[${index}].options[${optionIndex}]`);
        identifier(option.optionId,
          `learning module.completionChecks[${index}].options[${optionIndex}].optionId`);
        boundedString(option.label,
          `learning module.completionChecks[${index}].options[${optionIndex}].label`, {
            maximumBytes: 512
          });
      }
      const optionIds = uniqueRecordIds(check.options, 'optionId', 'Quiz option');
      sortedUniqueIdentifiers(check.acceptedOptionIds,
        `learning module.completionChecks[${index}].acceptedOptionIds`, 16);
      if (!check.acceptedOptionIds.length) fail('Quiz checks require at least one accepted option.');
      assertReferences(check.acceptedOptionIds, optionIds,
        `learning module.completionChecks[${index}].acceptedOptionIds`);
      boundedString(check.explanation, `learning module.completionChecks[${index}].explanation`);
    } else if (check.type === 'teach-back') {
      exactKeys(check, ['checkId', 'type', 'prompt', 'requiredConcepts', 'explanation'],
        `learning module.completionChecks[${index}]`);
      identifier(check.checkId, `learning module.completionChecks[${index}].checkId`);
      boundedString(check.prompt, `learning module.completionChecks[${index}].prompt`);
      boundedArray(check.requiredConcepts,
        `learning module.completionChecks[${index}].requiredConcepts`, 16, { minimum: 1 });
      for (const [conceptIndex, concept] of check.requiredConcepts.entries()) {
        boundedString(concept,
          `learning module.completionChecks[${index}].requiredConcepts[${conceptIndex}]`, {
            pattern: /^[a-z0-9][a-z0-9 -]{0,127}$/, maximumBytes: 128
          });
        if (conceptIndex > 0 && check.requiredConcepts[conceptIndex - 1] >= concept) {
          fail('Teach-back requiredConcepts must be sorted and unique.');
        }
      }
      boundedString(check.explanation, `learning module.completionChecks[${index}].explanation`);
    } else {
      fail("Learning completion check type must be 'quiz' or 'teach-back'.");
    }
  }
  const checkIds = uniqueRecordIds(input.completionChecks, 'checkId', 'Completion check');

  boundedArray(input.steps, 'learning module.steps', 128, { minimum: 1 });
  for (const [index, step] of input.steps.entries()) {
    exactKeys(step, [
      'stepId', 'title', 'kind', 'instruction', 'objectiveIds', 'evidenceIds',
      'failureExerciseIds', 'completionCheckIds', 'change'
    ], `learning module.steps[${index}]`);
    identifier(step.stepId, `learning module.steps[${index}].stepId`);
    boundedString(step.title, `learning module.steps[${index}].title`, { maximumBytes: 256 });
    if (!STEP_KINDS.includes(step.kind)) fail('Learning step kind is not installed.');
    boundedString(step.instruction, `learning module.steps[${index}].instruction`);
    sortedUniqueIdentifiers(step.objectiveIds, `learning module.steps[${index}].objectiveIds`, 64);
    sortedUniqueIdentifiers(step.evidenceIds, `learning module.steps[${index}].evidenceIds`, 64);
    sortedUniqueIdentifiers(step.failureExerciseIds,
      `learning module.steps[${index}].failureExerciseIds`, 32);
    sortedUniqueIdentifiers(step.completionCheckIds,
      `learning module.steps[${index}].completionCheckIds`, 64);
    assertReferences(step.objectiveIds, objectiveIds, `learning module.steps[${index}].objectiveIds`);
    assertReferences(step.evidenceIds, evidenceIds, `learning module.steps[${index}].evidenceIds`);
    assertReferences(step.failureExerciseIds, failureIds,
      `learning module.steps[${index}].failureExerciseIds`);
    assertReferences(step.completionCheckIds, checkIds,
      `learning module.steps[${index}].completionCheckIds`);
    exactKeys(step.change, ['effect', 'description'], `learning module.steps[${index}].change`);
    if (!CHANGE_EFFECTS.includes(step.change.effect)) fail('Learning step change effect is not installed.');
    boundedString(step.change.description, `learning module.steps[${index}].change.description`);
  }
  uniqueRecordIds(input.steps, 'stepId', 'Learning step');

  digest(input.moduleSha256, 'learning module.moduleSha256');
  const actualDigest = moduleDigest(input);
  if (input.moduleSha256 !== actualDigest) {
    fail('Learning module failed self-hash verification.', 'SGOS_LEARN_MODULE_TAMPERED', {
      expected: input.moduleSha256, actual: actualDigest
    });
  }
  const bytes = Buffer.byteLength(canonicalJson(input), 'utf8');
  if (bytes > MODULE_MAX_BYTES) {
    fail(`Learning module exceeds the ${MODULE_MAX_BYTES}-byte limit.`, 'SGOS_LEARN_LIMIT', {
      bytes, maximumBytes: MODULE_MAX_BYTES
    });
  }
  return freezeDeep(cloneJson(input));
}

/** Create the self-hash for an otherwise complete v1 module. */
export function createLearningModule(input) {
  if (!isPlainPlatformObject(input) || Object.hasOwn(input, 'moduleSha256')) {
    fail('Learning module creation expects an object without moduleSha256.');
  }
  const candidate = { ...cloneJson(input), moduleSha256: null };
  candidate.moduleSha256 = moduleDigest(candidate);
  return validateLearningModule(candidate);
}

function normalizeTeachBack(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function checkAnswerDigest(answer) {
  const bytes = Buffer.byteLength(canonicalJson(answer), 'utf8');
  if (bytes > 16 * 1024) fail('Learning answer exceeds the 16384-byte limit.', 'SGOS_LEARN_LIMIT');
  const findings = scanText(canonicalJson(answer), { path: '<learning-answer>' });
  if (findings.length) {
    fail('Learning answers cannot contain credential-shaped content.', 'SGOS_LEARN_SECRET_REFUSED', {
      rules: [...new Set(findings.map((finding) => finding.rule))].sort()
    });
  }
  return platformSha256(answer);
}

export function createReadOnlyLessonCatalog({ packRegistry }) {
  if (!packRegistry || packRegistry.profile !== 'signed-declarative-local-v1'
      || typeof packRegistry.listActive !== 'function') {
    fail('Learning catalog requires the signed active Capability Pack registry.',
      'SGOS_LEARN_PACK_REGISTRY_REQUIRED');
  }

  async function visibleLessons(requestedRole, requestedPackId = null) {
    const normalizedRole = role(requestedRole);
    const normalizedPackId = requestedPackId === null || requestedPackId === undefined
      ? null : identifier(requestedPackId, 'packId');
    const packs = await packRegistry.listActive();
    const lessons = [];
    for (const pack of packs) {
      if (normalizedPackId && pack.packId !== normalizedPackId) continue;
      for (const lesson of pack.lessons) {
        if (!lesson.roles.includes(normalizedRole)) continue;
        lessons.push(Object.freeze({
          lessonId: lesson.lessonId,
          title: lesson.title,
          role: normalizedRole,
          contentSha256: lesson.contentSha256,
          packId: pack.packId,
          packSha256: pack.recordSha256,
          domain: pack.domain
        }));
      }
    }
    lessons.sort((left, right) => left.lessonId.localeCompare(right.lessonId)
      || left.packId.localeCompare(right.packId) || left.packSha256.localeCompare(right.packSha256));
    return Object.freeze(lessons);
  }

  async function resolve({ role: requestedRole, lessonId, packId = null, module = null }) {
    if (typeof lessonId !== 'string' || !lessonId) fail('lessonId is required.');
    const matches = (await visibleLessons(requestedRole, packId))
      .filter((lesson) => lesson.lessonId === lessonId);
    if (!matches.length) {
      fail(`Lesson '${lessonId}' is not available for this role.`, 'SGOS_LEARN_LESSON_UNAVAILABLE');
    }
    if (matches.length > 1) {
      fail(`Lesson '${lessonId}' is ambiguous across active packs.`, 'SGOS_LEARN_LESSON_AMBIGUOUS');
    }
    if (module === null) return { lesson: matches[0], module: null };
    const validatedModule = validateLearningModule(module);
    if (validatedModule.id !== matches[0].lessonId || validatedModule.role !== matches[0].role
        || validatedModule.moduleSha256 !== matches[0].contentSha256) {
      fail('Learning module does not match the selected signed active Pack lesson, role, and digest.',
        'SGOS_LEARN_MODULE_BINDING_MISMATCH', {
          lessonId: matches[0].lessonId,
          role: matches[0].role,
          packId: matches[0].packId,
          expectedModuleSha256: matches[0].contentSha256
        });
    }
    return { lesson: matches[0], module: validatedModule };
  }

  function publicBoundary() {
    return Object.freeze({
      profile: 'descriptor-only-guided-mission-v1',
      execution: 'none',
      modelInvocations: 0,
      toolInvocations: 0,
      repositoryChanges: false,
      gitChanges: false,
      processAuthority: false,
      employeeScoring: false,
      progress: Object.freeze({ persistence: 'none', authority: false })
    });
  }

  async function bound(request) {
    const selected = await resolve(request);
    return { ...selected, boundary: publicBoundary() };
  }

  return Object.freeze({
    profile: 'read-only-role-catalog-v1',

    async list({ role: requestedRole, packId = null }) {
      return visibleLessons(requestedRole, packId);
    },

    async show({ role: requestedRole, lessonId, packId = null }) {
      return (await resolve({ role: requestedRole, lessonId, packId })).lesson;
    },

    async start({ role: requestedRole, lessonId, packId = null, module }) {
      const selected = await bound({ role: requestedRole, lessonId, packId, module });
      return freezeDeep({
        kind: 'learning-mission-plan',
        missionId: platformSha256({
          moduleSha256: selected.module.moduleSha256,
          packSha256: selected.lesson.packSha256,
          role: selected.lesson.role
        }),
        lesson: selected.lesson,
        module: selected.module,
        sandbox: {
          ...selected.module.sandboxFixture,
          materialization: 'not-performed',
          executionAllowed: false
        },
        boundary: selected.boundary
      });
    },

    async inspect({ role: requestedRole, lessonId, packId = null, module }) {
      const selected = await bound({ role: requestedRole, lessonId, packId, module });
      return freezeDeep({
        kind: 'learning-mission-inspection',
        lesson: selected.lesson,
        moduleSha256: selected.module.moduleSha256,
        title: selected.module.title,
        objectives: selected.module.objectives,
        counts: {
          steps: selected.module.steps.length,
          evidence: selected.module.expectedEvidence.length,
          failureExercises: selected.module.failureExercises.length,
          completionChecks: selected.module.completionChecks.length
        },
        stepIndex: selected.module.steps.map((step, index) => ({
          index: index + 1, stepId: step.stepId, title: step.title, kind: step.kind
        })),
        boundary: selected.boundary
      });
    },

    async explainChange({ role: requestedRole, lessonId, stepId, packId = null, module }) {
      const selected = await bound({ role: requestedRole, lessonId, packId, module });
      const step = selected.module.steps.find((candidate) => candidate.stepId === stepId);
      if (!step) fail(`Learning step '${stepId}' is unavailable.`, 'SGOS_LEARN_STEP_UNAVAILABLE');
      return freezeDeep({
        kind: 'learning-change-explanation',
        lesson: selected.lesson,
        moduleSha256: selected.module.moduleSha256,
        stepId,
        declaredChange: step.change,
        effects: {
          repository: 'none',
          git: 'none',
          governedProcess: 'none',
          devices: 'none',
          secrets: 'not-accepted',
          machineLocalTutorial: step.change.effect === 'machine-local-tutorial'
            ? 'declarative-description-only' : 'none'
        },
        boundary: selected.boundary
      });
    },

    async quiz({ role: requestedRole, lessonId, checkId, answer, packId = null, module }) {
      const selected = await bound({ role: requestedRole, lessonId, packId, module });
      const check = selected.module.completionChecks.find((candidate) => candidate.checkId === checkId);
      if (!check || check.type !== 'quiz') {
        fail(`Quiz check '${checkId}' is unavailable.`, 'SGOS_LEARN_CHECK_UNAVAILABLE');
      }
      exactKeys(answer, ['selectedOptionIds'], 'quiz answer');
      sortedUniqueIdentifiers(answer.selectedOptionIds, 'quiz answer.selectedOptionIds', 16);
      const known = new Set(check.options.map((option) => option.optionId));
      assertReferences(answer.selectedOptionIds, known, 'quiz answer.selectedOptionIds');
      const answerSha256 = checkAnswerDigest(answer);
      const passed = canonicalJson(answer.selectedOptionIds) === canonicalJson(check.acceptedOptionIds);
      return freezeDeep({
        kind: 'learning-check-result',
        evaluation: 'deterministic-exact-option-set',
        lesson: selected.lesson,
        moduleSha256: selected.module.moduleSha256,
        checkId,
        checkType: 'quiz',
        answerSha256,
        status: passed ? 'passed' : 'needs-review',
        explanation: check.explanation,
        certification: false,
        authority: false,
        boundary: selected.boundary
      });
    },

    async teachBack({ role: requestedRole, lessonId, checkId, answer, packId = null, module }) {
      const selected = await bound({ role: requestedRole, lessonId, packId, module });
      const check = selected.module.completionChecks.find((candidate) => candidate.checkId === checkId);
      if (!check || check.type !== 'teach-back') {
        fail(`Teach-back check '${checkId}' is unavailable.`, 'SGOS_LEARN_CHECK_UNAVAILABLE');
      }
      exactKeys(answer, ['text'], 'teach-back answer');
      boundedString(answer.text, 'teach-back answer.text', { maximumBytes: 8 * 1024 });
      const answerSha256 = checkAnswerDigest(answer);
      const normalized = ` ${normalizeTeachBack(answer.text)} `;
      const matchedConcepts = check.requiredConcepts.filter((concept) =>
        normalized.includes(` ${normalizeTeachBack(concept)} `));
      const missingConcepts = check.requiredConcepts.filter((concept) => !matchedConcepts.includes(concept));
      return freezeDeep({
        kind: 'learning-check-result',
        evaluation: 'deterministic-required-concept-presence',
        lesson: selected.lesson,
        moduleSha256: selected.module.moduleSha256,
        checkId,
        checkType: 'teach-back',
        answerSha256,
        status: missingConcepts.length ? 'needs-review' : 'passed',
        matchedConcepts,
        missingConcepts,
        explanation: check.explanation,
        limitations: 'Concept presence does not establish semantic understanding; no employee score or certification is produced.',
        certification: false,
        authority: false,
        boundary: selected.boundary
      });
    }
  });
}
