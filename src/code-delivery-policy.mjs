import { SingularityFlowError } from './util.mjs';
import { readRecord } from './schema-migrations.mjs';
import { authoringSkillCatalog, authoringSkillEntry, authoringSkillSourceId } from './authoring-skills.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { isConvergencePhase } from './phase-roles.mjs';
import { phaseNeedsGeneration } from './phase-generation-need.mjs';

const CODE_DELIVERY_ARTIFACT_KINDS = new Set(['implementation-summary']);

export const DEFAULT_CODE_DELIVERY_POLICY = Object.freeze({
  schemaVersion: 2,
  mode: 'enforce',
  generationBoundary: Object.freeze({ requireBegin: true, dirtyStart: 'block' }),
  changeSet: Object.freeze({
    renameDetection: 'required', includeCommitted: true, includeIndex: true,
    includeWorktree: true, includeUntracked: true, symlinks: 'reject'
  }),
  tests: Object.freeze({
    requireExecutableSource: true, minimumDiscovered: 1, minimumPassed: 1, executionAssurance: 'module',
    stringCommands: 'reject', unknownModelPolicy: 'block', requireResultAdapter: true,
    requireAffectedModuleCoverage: true
  }),
  traceability: Object.freeze({
    source: 'pinned-spec-index', requireNamespaceQualifiedIds: true,
    bareIdCompatibility: 'unique-only',
    // New definitions, including imported/BYO workflows that omit this field, enforce source
    // bindings. Existing Story resolutions are read directly and an absent pinned field stays off.
    sourceBindings: 'enforce'
  }),
  publication: Object.freeze({ idempotency: 'generation-intent' }),
  display: Object.freeze({ source: 'reference-preview', previewBytes: 4096, fullDocumentMaximumBytes: 65536 }),
  // Copilot-hosted generation is outside the kernel model runner. Until the host supplies a
  // generation-bound observation receipt, the only honest default is unavailable.
  model: Object.freeze({ minimumAssurance: 'unavailable' })
});

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new SingularityFlowError(`${label} must be ${allowed.join(', ')}.`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') throw new SingularityFlowError(`${label} must be boolean.`);
  return value;
}

function requiredBoolean(value, expected, label) {
  const normalized = booleanValue(value, label);
  if (normalized !== expected) {
    throw new SingularityFlowError(`${label} currently supports only ${expected}; the alternative is not implemented and cannot be pinned as policy.`);
  }
  return normalized;
}

function integerValue(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SingularityFlowError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

/** Normalize once at configuration load and pin the exact result into every Story. */
export function normalizeCodeDeliveryPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('codeDelivery must be an object.');
  }
  const defaults = DEFAULT_CODE_DELIVERY_POLICY;
  const generationBoundary = { ...defaults.generationBoundary, ...(value.generationBoundary ?? {}) };
  const changeSet = { ...defaults.changeSet, ...(value.changeSet ?? {}) };
  const tests = { ...defaults.tests, ...(value.tests ?? {}) };
  // Exact test identity is no longer an opt-in observation: every Jest, Vitest and JUnit 5 module
  // gets it from its adapter (ADR 0016). The old knob is refused rather than silently ignored.
  if (value.tests?.testcaseExact !== undefined) {
    throw new SingularityFlowError(
      'codeDelivery.tests.testcaseExact is retired: exact test identity now comes from each module\'s test adapter. Remove the setting.',
      { code: 'CODE_DELIVERY_POLICY_RETIRED' }
    );
  }
  const traceability = { ...defaults.traceability, ...(value.traceability ?? {}) };
  const publication = { ...defaults.publication, ...(value.publication ?? {}) };
  const display = { ...defaults.display, ...(value.display ?? {}) };
  const model = { ...defaults.model, ...(value.model ?? {}) };
  return {
    schemaVersion: 2,
    mode: enumValue(value.mode ?? defaults.mode, ['enforce'], 'codeDelivery.mode'),
    ...(value.cornerCaseObligations === undefined ? {} : {
      cornerCaseObligations: enumValue(value.cornerCaseObligations, ['off', 'advisory', 'enforce'], 'codeDelivery.cornerCaseObligations')
    }),
    ...(value.assertionAdequacy === undefined ? {} : {
      assertionAdequacy: enumValue(value.assertionAdequacy, ['off', 'advisory', 'enforce'], 'codeDelivery.assertionAdequacy')
    }),
    generationBoundary: {
      requireBegin: booleanValue(generationBoundary.requireBegin, 'codeDelivery.generationBoundary.requireBegin'),
      dirtyStart: enumValue(generationBoundary.dirtyStart, ['block', 'allow-explicit-adoption'], 'codeDelivery.generationBoundary.dirtyStart')
    },
    changeSet: {
      renameDetection: enumValue(changeSet.renameDetection, ['required'], 'codeDelivery.changeSet.renameDetection'),
      includeCommitted: requiredBoolean(changeSet.includeCommitted, true, 'codeDelivery.changeSet.includeCommitted'),
      includeIndex: requiredBoolean(changeSet.includeIndex, true, 'codeDelivery.changeSet.includeIndex'),
      includeWorktree: requiredBoolean(changeSet.includeWorktree, true, 'codeDelivery.changeSet.includeWorktree'),
      includeUntracked: requiredBoolean(changeSet.includeUntracked, true, 'codeDelivery.changeSet.includeUntracked'),
      symlinks: enumValue(changeSet.symlinks, ['reject', 'record-link-only'], 'codeDelivery.changeSet.symlinks')
    },
    tests: {
      requireExecutableSource: requiredBoolean(tests.requireExecutableSource, true, 'codeDelivery.tests.requireExecutableSource'),
      minimumDiscovered: integerValue(tests.minimumDiscovered, 1, 1_000_000, 'codeDelivery.tests.minimumDiscovered'),
      minimumPassed: integerValue(tests.minimumPassed, 1, 1_000_000, 'codeDelivery.tests.minimumPassed'),
      executionAssurance: enumValue(tests.executionAssurance, ['module'], 'codeDelivery.tests.executionAssurance'),
      stringCommands: enumValue(tests.stringCommands, ['reject'], 'codeDelivery.tests.stringCommands'),
      unknownModelPolicy: enumValue(tests.unknownModelPolicy, ['block'], 'codeDelivery.tests.unknownModelPolicy'),
      requireResultAdapter: requiredBoolean(tests.requireResultAdapter, true, 'codeDelivery.tests.requireResultAdapter'),
      requireAffectedModuleCoverage: booleanValue(tests.requireAffectedModuleCoverage, 'codeDelivery.tests.requireAffectedModuleCoverage')
    },
    traceability: {
      source: enumValue(traceability.source, ['pinned-spec-index'], 'codeDelivery.traceability.source'),
      requireNamespaceQualifiedIds: booleanValue(traceability.requireNamespaceQualifiedIds, 'codeDelivery.traceability.requireNamespaceQualifiedIds'),
      bareIdCompatibility: enumValue(traceability.bareIdCompatibility, ['unique-only'], 'codeDelivery.traceability.bareIdCompatibility'),
      sourceBindings: enumValue(traceability.sourceBindings, ['off', 'enforce'], 'codeDelivery.traceability.sourceBindings')
    },
    publication: {
      idempotency: enumValue(publication.idempotency, ['generation-intent'], 'codeDelivery.publication.idempotency')
    },
    display: {
      source: enumValue(display.source, ['reference-preview'], 'codeDelivery.display.source'),
      previewBytes: integerValue(display.previewBytes, 1, 65536, 'codeDelivery.display.previewBytes'),
      fullDocumentMaximumBytes: integerValue(display.fullDocumentMaximumBytes, 1, 1048576, 'codeDelivery.display.fullDocumentMaximumBytes')
    },
    model: {
      minimumAssurance: enumValue(model.minimumAssurance, ['unavailable', 'observed', 'provider-reported', 'policy-selected'], 'codeDelivery.model.minimumAssurance')
    }
  };
}

function generationTask(phase) {
  return phase?.generationPolicy?.task ?? phase?.generation?.task ?? null;
}

function artifactKind(phase) {
  return phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
}

/**
 * Identify phases that owe executable code-delivery evidence.
 *
 * Current workflows declare `generation.task: code`. Older installed workflows predate that field,
 * but already identify their implementation contract with an `implementation-summary` artifact.
 * Treat that legacy shape as code unless the workflow explicitly selects another task (for example
 * the intentionally non-code chore profile). This keeps old and in-flight Stories fail-closed.
 */
export function phaseRequiresCodeDelivery(phase) {
  if (!phase) return false;
  const task = generationTask(phase);
  if (task != null) return task === 'code';
  return CODE_DELIVERY_ARTIFACT_KINDS.has(artifactKind(phase));
}

/**
 * A step the kernel builds entirely: a deterministic producer and no code to deliver.
 *
 * On a code step, a deterministic producer builds the summary from what changed; the code itself is
 * still written (quick-fix's `implement`). From 2026-10-08 the session, entry admission and mutation
 * contract treated every deterministic step as kernel-owned, so no agent could write that code
 * while every route still offered /sf-code. Only a kernel-owned step clears the agent, skips
 * composition and refuses source edits; a deterministic code step keeps its summary engine-built.
 */
export function phaseKernelOwned(phase) {
  // Story state pins `generationPolicy`; a resolved definition or raw configuration carries `generation`.
  const deterministic = phase?.generationPolicy ? phaseUsesDeterministicGeneration(phase) : deterministicOnlyGeneration(phase);
  return Boolean(deterministic) && !phaseRequiresCodeDelivery(phase);
}

/**
 * Project the code-generation contract of one resolved workflow.
 *
 * Callers must pass the result of `resolveWorkType`, not raw work-type phase ids: generation task
 * overrides and the legacy implementation-summary inference are resolved at the phase boundary.
 * Keeping this projection beside `phaseRequiresCodeDelivery` prevents CLI and editor surfaces from
 * inventing a second, phase-name-based definition of "generates code".
 */
export function workflowCodeGeneration(resolvedWorkflow) {
  const phases = Array.isArray(resolvedWorkflow) ? resolvedWorkflow : resolvedWorkflow?.phases;
  const codePhases = Array.isArray(phases)
    ? phases.filter((phase) => phaseRequiresCodeDelivery(phase)).map((phase) => phase.id)
    : [];
  return { generatesCode: codePhases.length > 0, codePhases };
}

function generationRequirement(phase) {
  const generation = phase?.generationPolicy ?? phase?.generation;
  return typeof generation === 'string' ? generation : generation?.requirement ?? null;
}

/**
 * What a step produces, by the engine's own contract: `none`, `code`, `analysis` or `document`.
 *
 * Configuration validation, routing, Workflow Studio and its picker all use this one
 * classification. Write scope is deliberately not consulted: a verification or testing step may
 * write tests against source without delivering code, and an explicit `analyze` task is an
 * analysis whatever its scope.
 */
export function stepOutputKind(phase) {
  if (!phase) return 'document';
  if (generationRequirement(phase) === 'none') return 'none';
  if (phaseRequiresCodeDelivery(phase)) return 'code';
  return generationTask(phase) === 'analyze' ? 'analysis' : 'document';
}

/**
 * Whether only the engine's deterministic generator may produce a step, read from Story state
 * (`generationPolicy`), a resolved definition (`generation.allowedProducers`) or raw configuration
 * (`generation.producer`). Such a step is generated, not drafted, so no skill can be chosen for it.
 */
export function deterministicOnlyGeneration(phase) {
  const policy = phase?.generationPolicy
    ?? (phase?.generation && typeof phase.generation === 'object' ? phase.generation : null);
  if (!policy) return false;
  if (Array.isArray(policy.allowedProducers) && policy.allowedProducers.length) {
    return policy.allowedProducers.length === 1 && policy.allowedProducers[0] === 'deterministic';
  }
  return policy.producer === 'deterministic' || policy.defaultProducer === 'deterministic';
}

/** A version-3 compiled skill step: its reviewed binding decides how it is drafted. */
export function compiledSkillStep(phase) {
  return phase?.kind === 'skill';
}

/**
 * Deterministic convergence, read from Story state (`generationPolicy`), a resolved definition or raw
 * configuration, so Workflow Studio shows the same fixed route a Story uses.
 */
function deterministicConvergence(phase) {
  if (!isConvergencePhase(phase)) return false;
  if (phase.generationPolicy) return phaseUsesDeterministicGeneration(phase);
  return deterministicOnlyGeneration(phase);
}

/**
 * The authoring skill a step names. In a Story it comes from the pinned resolution, which is hashed
 * and anchored to the Story's creation commit, never from the mutable step state; outside a Story
 * (a resolved workflow being validated, simulated or shown) it comes from the resolved step.
 */
export function configuredAuthoringSkill(phase, workflow = null) {
  if (workflow?.resolution) {
    const pinned = (workflow.resolution.phases ?? []).find((entry) => entry?.id === phase?.id);
    return typeof pinned?.authoringSkill === 'string' ? pinned.authoringSkill : null;
  }
  return typeof phase?.authoringSkill === 'string' ? phase.authoringSkill : null;
}

/**
 * How a step is drafted: the configured skill, the skill drafting is routed to, and why.
 *
 * A step that drafts nothing has no route. A step only the deterministic generator may produce is
 * fixed: convergence uses `/sf-converge`, any other such step keeps its automatic route, and neither
 * can choose a skill. A configured skill this build does not list, one that cannot draft the step's
 * output, or one on a compiled skill step falls back to the automatic route with a warning:
 * guidance never names a skill that has not promised to honour the choice.
 */
export function authoringRoute(phase, workflow = null) {
  const authoringSkill = configuredAuthoringSkill(phase, workflow);
  const route = (effectiveAuthoringSkill, authoringSkillSource, warning = null) => Object.freeze({
    authoringSkill, effectiveAuthoringSkill, authoringSkillSource,
    ...(warning ? { authoringSkillWarning: warning } : {})
  });
  const ignored = (effective, why) => authoringSkill
    ? `Step '${phase.id}' names authoring skill '${authoringSkill}', but ${why}, so ${effective} is used.`
    : null;
  const output = stepOutputKind(phase);
  if (output === 'none') return route(null, 'none', ignored('nothing', 'it drafts nothing'));
  const automatic = output === 'code' ? '/sf-code' : '/sf-phase';
  if (deterministicConvergence(phase)) {
    return route('/sf-converge', 'fixed', ignored('/sf-converge', 'deterministic convergence is generated by the engine'));
  }
  if (deterministicOnlyGeneration(phase)) {
    return route(automatic, 'fixed', ignored(automatic, 'only the deterministic generator produces it'));
  }
  if (!authoringSkill) return route(automatic, 'automatic');
  if (compiledSkillStep(phase)) {
    return route(automatic, 'automatic', ignored(automatic, 'its compiled skill binding decides how it is drafted'));
  }
  const entry = authoringSkillEntry(authoringSkill);
  if (!entry) {
    return route(automatic, 'automatic', `Step '${phase.id}' names authoring skill '${authoringSkill}', which this build does not list, so ${automatic} drafts it.`);
  }
  if (!entry.produces.includes(output)) {
    return route(automatic, 'automatic', `Step '${phase.id}' names authoring skill '${authoringSkill}', which cannot draft ${output === 'analysis' ? 'an analysis' : `a ${output}`} step, so ${automatic} drafts it.`);
  }
  return route(`/${authoringSkill}`, 'configured');
}

/**
 * The specialised skill that still accepts a built-in step it was written for (`sf-design` for
 * `design`) when the step names no skill and drafts on the automatic `/sf-phase` route, or null.
 * The skills' own selection check uses exactly this rule, so a step changed into code or sign-off
 * only is never sent back to them.
 */
export function legacyAuthoringSkill(phase, workflow = null) {
  const route = authoringRoute(phase, workflow);
  if (route.authoringSkill || route.authoringSkillSource !== 'automatic' || route.effectiveAuthoringSkill !== '/sf-phase') return null;
  return authoringSkillCatalog().find((entry) => entry.legacyPhases.includes(phase?.id))?.id ?? null;
}

/** Every step's drafting route in a Story, keyed by step id, for status output. */
export function workflowAuthoringRoutes(workflow) {
  return Object.fromEntries((workflow?.phaseOrder ?? []).map((id) => [id, authoringRoute(workflow.phases?.[id] ?? { id }, workflow)]));
}

/**
 * One deterministic authoring route for every step, independent of its name: deterministic
 * convergence, then the step's configured authoring skill, then code delivery, then `/sflow-phase`.
 * It is `authoringRoute` in packaged-skill form, so the two can never disagree. Story callers must
 * pass the workflow so the configured skill comes from the pinned resolution.
 */
export function generationSkillForPhase(phase, workflow = null) {
  const route = authoringRoute(phase, workflow);
  if (stepOutputKind(phase) === 'none') return null;
  if (route.effectiveAuthoringSkill === '/sf-converge') return '/sflow-converge';
  if (route.authoringSkillSource === 'configured') return `/${authoringSkillSourceId(route.authoringSkill)}`;
  return phaseRequiresCodeDelivery(phase) ? '/sflow-code' : '/sflow-phase';
}

/** Pin the inferred legacy contract into newly resolved or hydrated workflow state. */
export function pinCodeDeliveryTask(phase, policyField = 'generation') {
  if (!phaseRequiresCodeDelivery(phase)) return phase?.[policyField] ?? null;
  const current = phase?.[policyField] ?? {};
  if (current.task != null) return current;
  return { ...current, task: 'code' };
}

/** Refuse unsafe code phases while configuration is loaded, not at their first publication. */
export function assertCodeDeliveryConfiguration(phase, label = `Phase '${phase?.id ?? 'unknown'}'`) {
  if (!phaseRequiresCodeDelivery(phase)) return;
  if ((phase.writeScope ?? 'artifact-only') !== 'source-and-artifact') {
    throw new SingularityFlowError(
      `${label} is a code-delivery phase but writeScope is not 'source-and-artifact'. `
      + 'A document-only implementation is forbidden.',
      { code: 'CODE_DELIVERY_SCOPE_INVALID' }
    );
  }
}

/** Explicit application-review adoption shares the existing code-policy configuration entry. */

export const ARA_VERSION = 1;
export const ARA_NAMESPACE = 'ARA';
export const ARA_SURFACES = Object.freeze(['auto', 'web', 'backend', 'cli', 'library', 'artifact']);
export const ARA_ACTIONS = Object.freeze(['plan', 'start', 'status', 'inspect', 'feedback', 'repair', 'repair-result', 'recheck', 'accept', 'capture', 'defer', 'close', 'browser']);
export const ARA_READS = Object.freeze(['plan', 'status']);

/** Later reporting phases inspect the latest delivered code, rather than starting a non-code review. */
export function applicationReviewPhase(workflow) {
  if (phaseRequiresCodeDelivery(workflow.phases?.[workflow.currentPhase])) return workflow.currentPhase;
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  const current = order.indexOf(workflow.currentPhase);
  return order.slice(0, current < 0 ? order.length : current).findLast(id => phaseRequiresCodeDelivery(workflow.phases?.[id])
    && workflow.phases[id].generation > 0) ?? workflow.currentPhase;
}

/** A stable delivery offers inspection; an offer never starts a preview or records acceptance. */
export function applicationReviewOffer(workflow, phase) {
  const policy = workflow.resolution?.applicationReview;
  if (!policy || policy.mode === 'off' || !phaseRequiresCodeDelivery(phase)) return null;
  return { copilotCommand: '/sf-app-review', command: `singularity-flow app-review start --work-id ${workflow.workItem.id} --phase ${phase.id}`,
    modelFreeCommand: null, required: policy.mode === 'required',
    reason: 'Inspect the delivered application and report problems. Final acceptance uses this generation’s submitted test results; phase approval stays separate.' };
}

/** Every delivered code phase hands back to a person; the read never adopts acceptance policy. */
export function codeOutcomeReviewOffer(workflow, phase) {
  if (!workflow?.workItem?.id || !phaseRequiresCodeDelivery(phase)
      || workflow.status && workflow.status !== 'in_progress'
      || !Number.isSafeInteger(phase.generation) || phase.generation < 1
      || phase.generationIntent?.status === 'open' || phaseNeedsGeneration(workflow, phase)) return null;
  const workId = workflow.workItem.id;
  return { workId, phase: phase.id, generation: phase.generation,
    key: JSON.stringify([workId, workflow.workItem.createdAt ?? null, phase.id, phase.generation]),
    command: `singularity-flow outcome ${workId}`, copilotCommand: `/sf-outcome ${workId}`, modelFreeCommand: null,
    agentCommand: `singularity-flow outcome ${workId} --for-agent --json`,
    required: false, recordsAcceptance: false,
    reason: 'Try this Story’s application and check each acceptance criterion, its test results and outstanding human checks before approval.',
    instruction: 'Open the outcome review for this exact Story. Inspection starts no application and records no acceptance or approval. Let the person try the result or request a repair. Final application acceptance, when adopted, uses submitted test evidence; continue through the existing submission and approval routes.' };
}
export function araFail(code, message, details = {}) {
  throw new SingularityFlowError(message, { code, details });
}
export function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) araFail('ARA_INPUT_INVALID', `${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) araFail('ARA_INPUT_INVALID', `${label} has unsupported fields: ${unknown.join(', ')}.`);
}
const bounded = (value, fallback, min, max, label) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) araFail('ARA_POLICY_INVALID', `${label} must be an integer from ${min} to ${max}.`);
  return result;
};
export function reviewRelativePath(value, label = 'Review path') {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f<>:"|?*]/u.test(value)
      || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    araFail('ARA_PATH_INVALID', `${label} must be a portable repository-relative path.`);
  }
  return value;
}

/** Absent means off; only an explicit work-type adoption is pinned into a new Story. */
export function normalizeApplicationReview(value) {
  if (value == null) return null;
  exactFields(value, ['schemaVersion', 'mode', 'surface', 'preview', 'repairAttempts', 'totalRepairAttempts', 'capture', 'quality', 'authorities'], 'applicationReview');
  readRecord('application-review-policy', value);
  const mode = value.mode ?? 'optional';
  const surface = value.surface ?? 'auto';
  if (!['off', 'optional', 'required'].includes(mode) || !ARA_SURFACES.includes(surface)) araFail('ARA_POLICY_INVALID', 'Invalid applicationReview mode or surface.');
  let preview = null;
  if (value.preview != null) {
    exactFields(value.preview, ['entry', 'outputDirectory'], 'applicationReview.preview');
    if (value.preview.entry != null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.preview.entry)) araFail('ARA_POLICY_INVALID', 'preview.entry names a declared application entry.');
    preview = { entry: value.preview.entry ?? null, outputDirectory: reviewRelativePath(value.preview.outputDirectory ?? 'dist') };
  }
  const quality = value.quality ?? [];
  if (value.authorities != null && (!Array.isArray(value.authorities) || !value.authorities.length
      || value.authorities.some(item => typeof item !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item)))) araFail('ARA_POLICY_INVALID', 'applicationReview.authorities names existing approval groups.');
  if (!Array.isArray(quality) || quality.length > 50 || quality.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)) araFail('ARA_POLICY_INVALID', 'applicationReview.quality is at most 50 explicit inspection expectations.');
  const capture = value.capture ?? {};
  exactFields(capture, ['maximumPages', 'casesPerPage', 'maximumBytes', 'timeoutMs', 'viewport'], 'applicationReview.capture');
  const viewport = capture.viewport ?? { width: 1280, height: 800 };
  exactFields(viewport, ['width', 'height'], 'capture.viewport');
  return {
    schemaVersion: ARA_VERSION, mode, surface, preview, ...(value.authorities ? { authorities: [...new Set(value.authorities)] } : {}),
    repairAttempts: bounded(value.repairAttempts, 2, 1, 10, 'repairAttempts'),
    totalRepairAttempts: bounded(value.totalRepairAttempts, 10, 1, 100, 'totalRepairAttempts'),
    quality: [...new Set(quality.map(item => item.trim()))],
    capture: {
      maximumPages: bounded(capture.maximumPages, 100, 1, 500, 'capture.maximumPages'),
      casesPerPage: bounded(capture.casesPerPage, 20, 1, 50, 'capture.casesPerPage'),
      maximumBytes: bounded(capture.maximumBytes, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024, 'capture.maximumBytes'),
      timeoutMs: bounded(capture.timeoutMs, 120000, 1000, 600000, 'capture.timeoutMs'),
      viewport: { width: bounded(viewport.width, 1280, 640, 3840, 'viewport.width'), height: bounded(viewport.height, 800, 480, 2160, 'viewport.height') }
    }
  };
}
