/** Shared workflow policy values and validators. No host, source-control, provider or storage access. */
import { SingularityFlowError } from '../foundation/failures.mjs';

// session-policy.mjs

export function normalizeSessionPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('session must be an object.');
  for (const key of Object.keys(value)) if (!['workItemSelection', 'requireBeforeTools'].includes(key)) throw new SingularityFlowError(`session contains unknown field '${key}'.`);
  const workItemSelection = value.workItemSelection ?? 'off';
  if (!['off', 'reuse', 'prompt'].includes(workItemSelection)) throw new SingularityFlowError('session.workItemSelection must be off, reuse, or prompt.');
  if (value.requireBeforeTools != null && typeof value.requireBeforeTools !== 'boolean') throw new SingularityFlowError('session.requireBeforeTools must be boolean.');
  return {
    workItemSelection,
    requireBeforeTools: value.requireBeforeTools ?? false
  };
}

// template-catalog.mjs

const REFERENCE = /^template:(?<id>[a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Whether a value names a catalog entry rather than a path or an agent template. */
export function isTemplateReference(value) {
  return typeof value === 'string' && value.startsWith('template:');
}

export function parseTemplateReference(value, label = 'Template reference') {
  const match = REFERENCE.exec(String(value ?? ''));
  if (!match) {
    throw new SingularityFlowError(
      `${label} '${value}' must be template:<id>, where the id is lower-case kebab-case.`,
      { code: 'TEMPLATE_REFERENCE_INVALID', details: { value } }
    );
  }
  return match.groups.id;
}

function assertRelativePath(value, label) {
  if (!value || typeof value !== 'string' || value.startsWith('/') || value.split(/[\\/]/).includes('..')) {
    throw new SingularityFlowError(`${label} must be a repository-relative path without '..'.`, { code: 'TEMPLATE_PATH_INVALID' });
  }
  return value;
}

/**
 * Normalize the `templates:` catalog.
 *
 * An entry is a path or an object; the object form is what lets a template carry the things a path
 * cannot — a human label for the designer, and the artifact kind it produces.
 */
export function normalizeTemplateCatalog(value, { label = 'templates' } = {}) {
  if (value == null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object of template id to definition.`, { code: 'TEMPLATE_CATALOG_INVALID' });
  }
  const catalog = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`${label} id '${id}' must be lower-case kebab-case.`, { code: 'TEMPLATE_CATALOG_INVALID' });
    }
    const source = typeof entry === 'string' ? { path: entry } : entry;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new SingularityFlowError(`${label}.${id} must be a path or an object.`, { code: 'TEMPLATE_CATALOG_INVALID' });
    }
    for (const key of Object.keys(source)) {
      if (!['path', 'label', 'kind', 'description'].includes(key)) {
        throw new SingularityFlowError(`${label}.${id} contains unknown field '${key}'.`, { code: 'TEMPLATE_CATALOG_INVALID' });
      }
    }
    catalog[id] = Object.freeze({
      id,
      path: assertRelativePath(source.path, `${label}.${id}.path`),
      label: source.label ?? id,
      kind: source.kind ?? null,
      description: source.description ?? null
    });
  }
  return Object.freeze(catalog);
}

/**
 * Turn whatever a phase or work type named into the thing that will actually be read.
 *
 * One resolver, because the alternative is each of the five readers deciding for itself what a
 * template value means — and the moment two of them disagree, a phase renders from one file while
 * the designer reports another.
 *
 * Agent references are returned unresolved on purpose: they need the network and a locked digest,
 * which is `materializeAgentTemplate`'s job and not something a configuration read should trigger.
 */
export function resolveTemplate(definition, value, { label = 'Template' } = {}) {
  if (value == null) return null;
  if (isTemplateReference(value)) {
    const id = parseTemplateReference(value, label);
    const raw = Object.hasOwn(definition?.templates ?? {}, id) ? definition.templates[id] : null;
    if (raw == null) {
      const known = Object.keys(definition?.templates ?? {});
      throw new SingularityFlowError(
        `${label} references template '${id}', which the catalog does not declare.`
        + (known.length ? ` Declared: ${known.sort().join(', ')}.` : ' No templates are declared.'),
        { code: 'TEMPLATE_UNKNOWN', details: { id, known } }
      );
    }
    // validateDefinition checks a normalized local view, but intentionally retains raw YAML.
    // Resolve both historical string declarations and object rows through this same owner.
    const entry = typeof raw === 'string' ? normalizeTemplateCatalog({ [id]: raw })[id] : raw;
    return { source: 'catalog', id, path: entry.path, label: entry.label, kind: entry.kind };
  }
  if (typeof value === 'string' && value.startsWith('agent:')) {
    return { source: 'agent', id: null, path: null, reference: value, label: value, kind: null };
  }
  return { source: 'path', id: null, path: value, label: value, kind: null };
}

/** The path a template value resolves to, or null when only an agent can produce it. */
export function templatePath(definition, value, options = {}) {
  return resolveTemplate(definition, value, options)?.path ?? null;
}

/**
 * Everything that names a template, for the designer and for the rename/delete guard.
 *
 * Both stores are walked, because a template declared once is exactly the kind of asset that ends
 * up referenced from a place its author forgot about.
 */
export function templateReferences(definition, value) {
  const references = [];
  const matches = (candidate) => candidate === value
    || (isTemplateReference(candidate) && definition?.templates?.[parseTemplateReference(candidate)]?.path === value);
  for (const [phaseId, phase] of Object.entries(definition?.phases ?? {})) {
    if (matches(phase?.defaultTemplate)) references.push(`phase ${phaseId}`);
  }
  for (const [workTypeId, workType] of Object.entries(definition?.workTypes ?? {})) {
    for (const [phaseId, candidate] of Object.entries(workType?.templateOverrides ?? {})) {
      if (matches(candidate)) references.push(`workflow ${workTypeId}/${phaseId}`);
    }
  }
  return references;
}

// repair-budget.mjs

const PHASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A declared loop is a bounded, reviewer-directed backward rejection edge. */
export function normalizeReworkLoops(value = [], { workTypeId = 'work type', phases = [] } = {}) {
  if (!Array.isArray(value)) {
    throw new SingularityFlowError(`Work type '${workTypeId}' reworkLoops must be an array.`);
  }
  const seen = new Set();
  const targetPolicies = new Map();
  return value.map((entry, index) => {
    const label = `Work type '${workTypeId}' reworkLoops[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SingularityFlowError(`${label} must be an object.`);
    }
    for (const key of Object.keys(entry)) {
      if (!['from', 'to', 'maxAttempts', 'resetOnPhase'].includes(key)) {
        throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
      }
    }
    if (!PHASE_ID.test(entry.from ?? '') || !PHASE_ID.test(entry.to ?? '')
        || !phases.includes(entry.from) || !phases.includes(entry.to)) {
      throw new SingularityFlowError(`${label} must name two active phases in this Story workflow.`);
    }
    if (phases.indexOf(entry.to) >= phases.indexOf(entry.from)) {
      throw new SingularityFlowError(`${label} must return from a later phase to an earlier phase.`);
    }
    if (!Number.isInteger(entry.maxAttempts) || entry.maxAttempts < 1 || entry.maxAttempts > 100) {
      throw new SingularityFlowError(`${label}.maxAttempts must be an integer from 1 through 100.`);
    }
    const resetOnPhase = entry.resetOnPhase ?? null;
    if (resetOnPhase != null && (!PHASE_ID.test(resetOnPhase)
        || !phases.includes(resetOnPhase) || phases.indexOf(resetOnPhase) >= phases.indexOf(entry.to))) {
      throw new SingularityFlowError(`${label}.resetOnPhase must name an active phase before '${entry.to}'.`);
    }
    const edge = `${entry.from}\0${entry.to}`;
    if (seen.has(edge)) throw new SingularityFlowError(`${label} repeats the same backward edge.`);
    seen.add(edge);
    const policy = `${entry.maxAttempts}\0${resetOnPhase ?? ''}`;
    if (targetPolicies.has(entry.to) && targetPolicies.get(entry.to) !== policy) {
      throw new SingularityFlowError(`${label} conflicts with another loop targeting '${entry.to}': repair budgets must agree.`);
    }
    targetPolicies.set(entry.to, policy);
    return {
      from: entry.from, to: entry.to, maxAttempts: entry.maxAttempts,
      ...(resetOnPhase != null ? { resetOnPhase } : {})
    };
  });
}

export function normalizeRepairBudget(value = null, { phaseId = 'phase', phases = [] } = {}) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!['maxAttempts', 'resetOnPhase'].includes(key)) {
      throw new SingularityFlowError(`Phase '${phaseId}' repairBudget contains unknown field '${key}'.`);
    }
  }
  if (!Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 100) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget.maxAttempts must be an integer from 1 through 100.`);
  }
  const resetOnPhase = value.resetOnPhase ?? null;
  if (resetOnPhase != null && !phases.includes(resetOnPhase)) {
    throw new SingularityFlowError(`Phase '${phaseId}' repairBudget.resetOnPhase references unknown phase '${resetOnPhase}'.`);
  }
  return { maxAttempts: value.maxAttempts, resetOnPhase };
}

// intelligence-policy.mjs

export const WORK_TYPE_WORLD_MODEL_MODES = Object.freeze(['inherit', 'required', 'off']);

export const WORK_TYPE_AST_MODES = Object.freeze(['inherit', 'optional-context', 'required-context', 'off']);

export const WORK_TYPE_AGENT_BRIEF_MODES = Object.freeze(['inherit', 'required', 'off']);

/**
 * The intelligence profile is pinned with a Story so a benchmark arm cannot drift when shared
 * configuration changes. Existing work types inherit today's behavior; benchmark profiles opt in
 * to a stronger, explicit contract.
 */
export function normalizeWorkTypeIntelligence(value = null, label = 'Work type intelligence') {
  const source = value ?? {};
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  for (const key of Object.keys(source)) {
    if (!['worldModel', 'ast', 'agentBriefs'].includes(key)) {
      throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
    }
  }
  const worldModel = source.worldModel ?? 'inherit';
  const ast = source.ast ?? 'inherit';
  const agentBriefs = source.agentBriefs ?? 'inherit';
  if (!WORK_TYPE_WORLD_MODEL_MODES.includes(worldModel)) {
    throw new SingularityFlowError(`${label}.worldModel must be ${WORK_TYPE_WORLD_MODEL_MODES.join(', ')}.`);
  }
  if (!WORK_TYPE_AST_MODES.includes(ast)) {
    throw new SingularityFlowError(`${label}.ast must be ${WORK_TYPE_AST_MODES.join(', ')}.`);
  }
  if (!WORK_TYPE_AGENT_BRIEF_MODES.includes(agentBriefs)) {
    throw new SingularityFlowError(`${label}.agentBriefs must be ${WORK_TYPE_AGENT_BRIEF_MODES.join(', ')}.`);
  }
  return Object.freeze({ worldModel, ast, agentBriefs });
}

export function astContextRequired(workflow) {
  return astContextRequested(workflow);
}

/**
 * Whether a work type would benefit from bounded AST context. `required-context` is retained as a
 * backward-compatible spelling, but has optional semantics: failure to obtain AST context never
 * prevents the model-backed operation from continuing with ordinary repository file access.
 */
export function astContextRequested(workflow) {
  return ['optional-context', 'required-context'].includes(workflow?.resolution?.intelligence?.ast);
}



export function astDisabledForWorkflow(workflow) {
  return workflow?.resolution?.intelligence?.ast === 'off';
}


export function worldModelDisabledForWorkflow(workflow) {
  return workflow?.resolution?.intelligence?.worldModel === 'off';
}

// model-tasks.mjs

/**
 * The closed v1 enum, in the order a reader should meet it: dispatch, then questions, then the
 * three kinds of production, then prose.
 */
export const MODEL_TASKS = Object.freeze([
  'relay',      // dispatch and faithful narration of a deterministic result
  'clarify',    // formulating the questions a human must answer
  'reason',     // design, planning, trade-off analysis
  'code',       // implementation and test generation
  'analyze',    // assisted convergence and review commentary
  'summarize'   // narrative prose passes
]);

/**
 * Contract class → task.
 *
 * Dispatch classes run a CLI command or a deterministic planner and reproduce its result
 * without adding judgment, which is exactly `relay`. `deterministic-mutation` is included here and
 * the specification's own list omits it — an omission rather than a decision, since its contract
 * ("let the CLI validate and mutate state; preserve its exact result") is the relay contract with a
 * write behind it. Leaving it unmapped would have given every skill of that class no task at all,
 * which is the one outcome the taxonomy exists to prevent.
 *
 * `clarification-and-artifact` is the only class that does two different jobs, so it does not
 * appear here: it resolves through `taskForContractClass` with the intent it is being asked for.
 */
const CONTRACT_CLASS_TASKS = Object.freeze({
  'guided-actions': 'relay',
  'conversational-guidance': 'relay',
  'concise-relay': 'relay',
  'explicit-selection': 'relay',
  'governed-review': 'relay',
  'deterministic-mutation': 'relay',
  'canonical-delegation': 'relay',
  // The advisory skill relays the confirmed operation; its separate analysis process owns reasoning.
  'advisory-analysis': 'relay',
  // Currently the comments-only source repair contract, not a lifecycle publication operation.
  'scoped-repair': 'code'
});

/** The class that asks questions before it drafts, and therefore needs to be told which it is doing. */
export const DUAL_INTENT_CONTRACT_CLASS = 'clarification-and-artifact';

export function assertModelTask(task, label = 'Model task') {
  if (!MODEL_TASKS.includes(task)) {
    throw new SingularityFlowError(
      `${label} '${task}' is not one of ${MODEL_TASKS.join(', ')}. The task enum is closed: adding one is a reviewed schema change, not a configuration edit.`,
      { code: 'MODEL_TASK_UNKNOWN', details: { task, allowed: [...MODEL_TASKS] } }
    );
  }
  return task;
}

/**
 * The task a skill's contract class performs. `[ADP:REQ-011]`
 *
 * `intent` matters only for the dual-intent class: asking the unresolved questions is `clarify`,
 * and drafting the artifact afterwards is whatever the phase declared its generation to be — the
 * skill does not get its own opinion about how hard its phase's drafting is.
 */
export function taskForContractClass(contractClass, { intent = 'questions', generationTask = null } = {}) {
  if (contractClass === DUAL_INTENT_CONTRACT_CLASS) {
    if (intent === 'questions') return 'clarify';
    if (!generationTask) {
      throw new SingularityFlowError(
        `Drafting under '${DUAL_INTENT_CONTRACT_CLASS}' needs the phase's declared generation task; none was supplied.`,
        { code: 'MODEL_TASK_UNRESOLVED', details: { contractClass, intent } }
      );
    }
    return assertModelTask(generationTask, 'Phase generation task');
  }
  const task = CONTRACT_CLASS_TASKS[contractClass];
  if (!task) {
    throw new SingularityFlowError(
      `Contract class '${contractClass}' declares no model task. Every class must name one, or work of that class routes nowhere.`,
      { code: 'MODEL_TASK_UNMAPPED', details: { contractClass, mapped: Object.keys(CONTRACT_CLASS_TASKS) } }
    );
  }
  return task;
}

/** Every contract class this module can route, for the check that keeps it level with the registry. */
export function mappedContractClasses() {
  return Object.freeze([...Object.keys(CONTRACT_CLASS_TASKS), DUAL_INTENT_CONTRACT_CLASS].sort());
}

/**
 * The task a phase's generation performs. `[ADP:REQ-012]`
 *
 * Declared per phase and folded through the standard policy layers before it is pinned, so what a
 * story routes by is the approved answer rather than whatever the configuration says today. A phase
 * that declares nothing routes as `reason`: generation is drafting, and drafting is the task that
 * degrades most visibly when it is under-served.
 */
export function generationTaskForPhase(definition, phaseId) {
  const declared = definition?.phases?.[phaseId]?.generation?.task;
  return declared ? assertModelTask(declared, `Phase '${phaseId}' generation task`) : 'reason';
}

// harness-import-policy.mjs

export const HARNESS_IMPORTS_HARD_MAXIMUM_BYTES = 65_536;

export const HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES = 16_384;

export const HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES = 32_768;

export const HARNESS_IMPORTS_MODES = new Set(['off', 'record', 'enforce']);

export function normalizeHarnessImports(value = null) {
  if (value == null) return {
    mode: 'off', previewTextBytes: HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES,
    totalEnvelopeBytes: HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES,
    knowledge: { enabled: false, maximumBytes: 8192 },
    conformance: { questionPrecedesMutation: 'off', maximumActions: 'off' }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('harnessImports must be an object.');
  for (const key of Object.keys(value)) if (!['mode', 'previewTextBytes', 'totalEnvelopeBytes', 'knowledge', 'conformance'].includes(key)) throw new SingularityFlowError(`harnessImports contains unknown field '${key}'.`);
  const mode = value.mode ?? 'off';
  if (!HARNESS_IMPORTS_MODES.has(mode)) throw new SingularityFlowError('harnessImports.mode must be off, record, or enforce.');
  const previewTextBytes = value.previewTextBytes ?? HARNESS_IMPORTS_DEFAULT_PREVIEW_BYTES;
  if (!Number.isInteger(previewTextBytes) || previewTextBytes < 1 || previewTextBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) {
    throw new SingularityFlowError(`harnessImports.previewTextBytes must be an integer from 1 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  }
  const totalEnvelopeBytes = value.totalEnvelopeBytes ?? HARNESS_IMPORTS_DEFAULT_ENVELOPE_BYTES;
  if (!Number.isInteger(totalEnvelopeBytes) || totalEnvelopeBytes < 1024 || totalEnvelopeBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) {
    throw new SingularityFlowError(`harnessImports.totalEnvelopeBytes must be an integer from 1024 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  }
  if (previewTextBytes >= totalEnvelopeBytes) {
    throw new SingularityFlowError('harnessImports.previewTextBytes must be smaller than totalEnvelopeBytes so metadata remains bounded.');
  }
  const knowledge = value.knowledge ?? {};
  if (!knowledge || typeof knowledge !== 'object' || Array.isArray(knowledge)) throw new SingularityFlowError('harnessImports.knowledge must be an object.');
  for (const key of Object.keys(knowledge)) if (!['enabled', 'maximumBytes'].includes(key)) throw new SingularityFlowError(`harnessImports.knowledge contains unknown field '${key}'.`);
  const maximumBytes = knowledge.maximumBytes ?? 8192;
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > HARNESS_IMPORTS_HARD_MAXIMUM_BYTES) throw new SingularityFlowError(`harnessImports.knowledge.maximumBytes must be an integer from 1 through ${HARNESS_IMPORTS_HARD_MAXIMUM_BYTES}.`);
  const conformance = value.conformance ?? {};
  if (!conformance || typeof conformance !== 'object' || Array.isArray(conformance)) throw new SingularityFlowError('harnessImports.conformance must be an object.');
  const allowedCheckers = new Set(['verbatimRelay', 'questionPrecedesMutation', 'maximumActions', 'previewRespected']);
  const allowedModes = new Set(['off', 'observe', 'warn', 'enforce']);
  for (const [key, checkerMode] of Object.entries(conformance)) {
    if (!allowedCheckers.has(key)) throw new SingularityFlowError(`harnessImports.conformance contains unknown checker '${key}'.`);
    if (!allowedModes.has(checkerMode)) throw new SingularityFlowError(`harnessImports.conformance.${key} must be off, observe, warn, or enforce.`);
  }
  if (mode === 'enforce' && ['verbatimRelay', 'previewRespected'].some((key) => conformance[key] === 'enforce')) {
    throw new SingularityFlowError('Host-observed harness checkers cannot be enforced until exact host instrumentation is configured.');
  }
  return {
    mode, previewTextBytes, totalEnvelopeBytes,
    knowledge: { enabled: knowledge.enabled === true, maximumBytes },
    conformance: {
      verbatimRelay: conformance.verbatimRelay ?? 'off',
      questionPrecedesMutation: conformance.questionPrecedesMutation ?? 'off',
      maximumActions: conformance.maximumActions ?? 'off',
      previewRespected: conformance.previewRespected ?? 'off'
    }
  };
}

// context-policy.mjs

export const CONTEXT_BOUNDARY_MODES = new Set(['keep', 'compact', 'new']);

function mode(value, label, fallback) {
  const selected = value ?? fallback;
  if (!CONTEXT_BOUNDARY_MODES.has(selected)) {
    throw new SingularityFlowError(`${label} must be keep, compact, or new.`);
  }
  return selected;
}

export function normalizeContextPolicy(value = {}, { phaseIds = null, label = 'contextPolicy' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  const allowed = new Set(['phaseBoundary', 'onApproval', 'onRejection', 'phaseOverrides']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
  }
  if (value.phaseBoundary != null && value.onApproval != null && value.phaseBoundary !== value.onApproval) {
    throw new SingularityFlowError(`${label}.phaseBoundary and ${label}.onApproval must match when both are configured.`);
  }
  const onApproval = mode(value.onApproval ?? value.phaseBoundary, `${label}.onApproval`, 'keep');
  const onRejection = mode(value.onRejection, `${label}.onRejection`, 'keep');
  const overrides = value.phaseOverrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SingularityFlowError(`${label}.phaseOverrides must be an object.`);
  }
  const known = phaseIds ? new Set(phaseIds) : null;
  const phaseOverrides = {};
  for (const [phaseId, selected] of Object.entries(overrides)) {
    if (known && !known.has(phaseId)) {
      throw new SingularityFlowError(`${label}.phaseOverrides references unknown phase '${phaseId}'.`);
    }
    phaseOverrides[phaseId] = mode(selected, `${label}.phaseOverrides.${phaseId}`);
  }
  return { onApproval, onRejection, phaseOverrides };
}

// test-runtime.mjs

const NODE_OPTIONS = new Set(['--no-experimental-webstorage']);

export function normalizeTestRuntime(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'nodeOptions')
      || (Object.hasOwn(value, 'nodeOptions') && (!Array.isArray(value.nodeOptions)
        || value.nodeOptions.some(flag => !NODE_OPTIONS.has(flag))))) {
    throw new SingularityFlowError('repositoryReadiness.testRuntime supports only nodeOptions: [--no-experimental-webstorage].',
      { code: 'TEST_RUNTIME_INVALID' });
  }
  return { nodeOptions: [...new Set(value.nodeOptions ?? [])].sort() };
}

// code-delivery-policy.mjs

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

// specifications.mjs

const DEFAULT_LIMITS = Object.freeze({
  maxClausesPerArtifact: 2000,
  maxDependenciesPerClause: 100,
  maxPathsPerClaim: 1000,
  maxClaimBytes: 2 * 1024 * 1024
});

export function normalizeSpecPolicy(value = {}) {
  if (value == null) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('spec must be an object.');
  }
  const allowed = new Set(['mode', 'namespace', 'coverage', 'acceptance', 'conformanceRows', 'testCommands', 'excludes', 'limits', 'compositionCache']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SingularityFlowError(`spec contains unknown field '${key}'.`);
  const mode = value.mode ?? 'off';
  if (!['off', 'record', 'enforce'].includes(mode)) throw new SingularityFlowError('spec.mode must be off, record, or enforce.');
  const namespace = value.namespace ?? null;
  if (namespace != null && !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(namespace)) {
    throw new SingularityFlowError('spec.namespace must use upper-case letters, digits, dots, underscores, or hyphens.');
  }
  const coverage = value.coverage ?? mode;
  if (!['off', 'record', 'enforce'].includes(coverage)) throw new SingularityFlowError('spec.coverage must be off, record, or enforce.');
  const acceptance = value.acceptance ?? 'off';
  if (!['off', 'presence', 'test-first', 'verify'].includes(acceptance)) {
    throw new SingularityFlowError('spec.acceptance must be off, presence, test-first, or verify.');
  }
  // A pinned legacy Story keeps its historical report interpretation. New starter Stories require
  // one explicit qualified conformance row per authoritative clause at the terminal gate.
  // Newly resolved workflows use exact per-clause reports. Historical Story resolutions are
  // checked through their pinned raw field, so an absent field there remains legacy behavior.
  const conformanceRows = value.conformanceRows ?? 'qualified';
  if (!['legacy', 'qualified'].includes(conformanceRows)) {
    throw new SingularityFlowError('spec.conformanceRows must be legacy or qualified.');
  }
  const testCommands = value.testCommands ?? {};
  if (!testCommands || typeof testCommands !== 'object' || Array.isArray(testCommands)) {
    throw new SingularityFlowError('spec.testCommands must be an object keyed by command ID.');
  }
  for (const [id, command] of Object.entries(testCommands)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new SingularityFlowError(`spec.testCommands key '${id}' must be lower-case kebab-case.`);
    if (!Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== 'string' || !part)) {
      throw new SingularityFlowError(`spec.testCommands.${id} must be a non-empty argv array.`);
    }
  }
  // A configured prefix left changed paths out of coverage, so application logic could escape
  // requirement accounting [E2G-012]. Only the kernel's own governance roots stay outside it.
  const governanceRoots = ['singularity', '.github/agents', '.git', 'node_modules'];
  const configuredExcludes = value.excludes ?? [];
  // A normalized policy carries the governance roots, so normalizing it again stays unchanged.
  if (!Array.isArray(configuredExcludes) || configuredExcludes.some((item) => !governanceRoots.includes(item))) {
    throw new SingularityFlowError(
      'spec.excludes was retired because a path left out of coverage escaped requirement accounting. '
      + "List a lockfile, build, CI, metadata or documentation change under the plan's Supporting files, "
      + 'or account for a changed path with singularity-flow decision plan.',
      { code: 'SPEC_EXCLUDES_RETIRED' }
    );
  }
  const excludes = governanceRoots;
  const limits = { ...DEFAULT_LIMITS, ...(value.limits ?? {}) };
  for (const [key, maximum] of Object.entries({
    maxClausesPerArtifact: 10000,
    maxDependenciesPerClause: 1000,
    maxPathsPerClaim: 10000,
    maxClaimBytes: 10 * 1024 * 1024
  })) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum) {
      throw new SingularityFlowError(`spec.limits.${key} must be an integer from 1 to ${maximum}.`);
    }
  }
  const compositionCache = value.compositionCache ?? 'local';
  if (!['off', 'local'].includes(compositionCache)) throw new SingularityFlowError('spec.compositionCache must be off or local.');
  return { mode, namespace, coverage, acceptance, conformanceRows, testCommands, excludes, limits, compositionCache };
}

// token-economy.mjs

export const TOKEN_ECONOMY_MODES = Object.freeze(['off', 'observe', 'assist', 'enforce']);

export const TOKEN_ECONOMY_COMPOSERS = Object.freeze(['legacy-v1', 'tkr-v1']);

const PROVIDER_TELEMETRY_MODES = Object.freeze(['off', 'optional', 'required']);

const CAPABILITY_MODES = Object.freeze(['off', 'optional', 'required']);

const BREACH_POLICIES = Object.freeze(['refuse', 'partial']);

const DEFAULT_PROFILE = Object.freeze({
  maximumEstimatedPromptTokens: 18_000,
  reservedOutputTokens: 6_000,
  maxExpansionTokens: 8_000,
  observationCapsuleTokens: 3_000,
  policyOnBudgetBreach: 'refuse'
});

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  return value;
}

function integer(value, fallback, label, { minimum = 0, maximum = 1_000_000 } = {}) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new SingularityFlowError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return selected;
}

function enumeration(value, fallback, allowed, label) {
  const selected = value ?? fallback;
  if (!allowed.includes(selected)) {
    throw new SingularityFlowError(`${label} must be ${allowed.join(', ')}; got '${selected}'.`);
  }
  return selected;
}

function enabled(value, fallback, label) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') throw new SingularityFlowError(`${label} must be true or false.`);
  return selected;
}

function normalizeProfile(value, label) {
  const source = object(value ?? {}, label);
  for (const key of Object.keys(source)) if (![
    'maximumEstimatedPromptTokens', 'maxInputTokens', 'reservedOutputTokens', 'maxExpansionTokens',
    'observationCapsuleTokens', 'policyOnBudgetBreach'
  ].includes(key)) throw new SingularityFlowError(`${label} contains unknown field '${key}'.`);
  if (source.maximumEstimatedPromptTokens != null && source.maxInputTokens != null
      && source.maximumEstimatedPromptTokens !== source.maxInputTokens) {
    throw new SingularityFlowError(`${label} cannot give maximumEstimatedPromptTokens and legacy maxInputTokens different values.`);
  }
  return Object.freeze({
    maximumEstimatedPromptTokens: integer(
      source.maximumEstimatedPromptTokens ?? source.maxInputTokens,
      DEFAULT_PROFILE.maximumEstimatedPromptTokens,
      `${label}.maximumEstimatedPromptTokens`, { minimum: 1024 }
    ),
    reservedOutputTokens: integer(source.reservedOutputTokens, DEFAULT_PROFILE.reservedOutputTokens, `${label}.reservedOutputTokens`),
    maxExpansionTokens: integer(source.maxExpansionTokens, DEFAULT_PROFILE.maxExpansionTokens, `${label}.maxExpansionTokens`),
    observationCapsuleTokens: integer(source.observationCapsuleTokens, DEFAULT_PROFILE.observationCapsuleTokens, `${label}.observationCapsuleTokens`),
    policyOnBudgetBreach: enumeration(
      source.policyOnBudgetBreach, DEFAULT_PROFILE.policyOnBudgetBreach,
      BREACH_POLICIES, `${label}.policyOnBudgetBreach`
    )
  });
}

/**
 * Normalize the repository policy. Observe is intentionally the compatibility default: it records
 * honest measurements but does not replace the context a host already sends to an agent.
 */
export function normalizeTokenEconomy(value = {}) {
  const source = object(value ?? {}, 'tokenEconomy');
  for (const key of Object.keys(source)) if (![
    'enabled', 'mode', 'profile', 'profiles', 'observationFirewall', 'progressiveRetrieval',
    'historicalMemory', 'cacheStableComposition', 'providerTelemetry', 'ast', 'composer'
  ].includes(key)) throw new SingularityFlowError(`tokenEconomy contains unknown field '${key}'.`);
  const isEnabled = enabled(source.enabled, true, 'tokenEconomy.enabled');
  const declaredMode = enumeration(source.mode, 'observe', TOKEN_ECONOMY_MODES, 'tokenEconomy.mode');
  const mode = isEnabled ? declaredMode : 'off';
  const profile = String(source.profile ?? 'standard').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile)) {
    throw new SingularityFlowError('tokenEconomy.profile must be lower-case kebab-case.');
  }
  const declaredProfiles = object(source.profiles ?? { standard: DEFAULT_PROFILE }, 'tokenEconomy.profiles');
  const profiles = Object.fromEntries(Object.entries(declaredProfiles).map(([id, definition]) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new SingularityFlowError(`tokenEconomy profile '${id}' must be lower-case kebab-case.`);
    }
    return [id, normalizeProfile(definition, `tokenEconomy.profiles.${id}`)];
  }));
  if (!profiles[profile]) throw new SingularityFlowError(`tokenEconomy.profile references unknown profile '${profile}'.`);
  if (mode === 'enforce') {
    const unsafe = Object.entries(profiles)
      .filter(([, definition]) => definition.policyOnBudgetBreach === 'partial')
      .map(([id]) => id);
    if (unsafe.length) {
      throw new SingularityFlowError(
        `tokenEconomy.mode enforce requires policyOnBudgetBreach refuse; partial is configured for ${unsafe.join(', ')}.`,
        {
          code: 'TKN_ENFORCE_PARTIAL_UNSAFE',
          details: {
            profiles: unsafe,
            nextAction: 'Set policyOnBudgetBreach to refuse, or use assist mode for explicitly partial composition.'
          }
        }
      );
    }
  }
  const normalized = {
    enabled: isEnabled,
    mode,
    // Existing workflow instances remain on the byte-compatible composer unless their governed
    // configuration explicitly pins the TKR contract. M4 evaluation decides any future default.
    composer: enumeration(
      source.composer, 'legacy-v1', TOKEN_ECONOMY_COMPOSERS, 'tokenEconomy.composer'
    ),
    profile,
    profiles,
    observationFirewall: enabled(source.observationFirewall, true, 'tokenEconomy.observationFirewall'),
    progressiveRetrieval: enabled(source.progressiveRetrieval, true, 'tokenEconomy.progressiveRetrieval'),
    historicalMemory: enabled(source.historicalMemory, false, 'tokenEconomy.historicalMemory'),
    cacheStableComposition: enabled(source.cacheStableComposition, true, 'tokenEconomy.cacheStableComposition'),
    providerTelemetry: enumeration(source.providerTelemetry, 'optional', PROVIDER_TELEMETRY_MODES, 'tokenEconomy.providerTelemetry'),
    ast: enumeration(source.ast, 'optional', CAPABILITY_MODES, 'tokenEconomy.ast')
  };
  return Object.freeze(normalized);
}

// document-storage-policy.mjs

function fail(message, code, details) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export const DOCUMENT_STORAGE_KINDS = Object.freeze(['git', 'local']);

/** New uploads stay on this laptop unless approved policy explicitly requests shared storage. */
const DEFAULT_STORAGE = 'local';

/** Destinations people ask for that have no implementation yet; refused by name, not as unknown. */
const PLANNED_STORAGE_KINDS = Object.freeze(['onedrive', 'sharepoint', 'jira']);

/**
 * What a document policy lets a person choose: the allowed storage, in a stable order, and the one
 * used when they choose nothing (the approved default, else local when allowed).
 * Editors offer exactly these, so a choice they show is never one the CLI then refuses.
 */
export function documentStorageChoices(policy = {}) {
  const configured = policy?.storage ?? {};
  const allowed = Array.isArray(configured.allowed) && configured.allowed.length
    ? DOCUMENT_STORAGE_KINDS.filter((kind) => configured.allowed.includes(kind))
    : [...DOCUMENT_STORAGE_KINDS];
  const fallback = allowed.includes(DEFAULT_STORAGE) ? DEFAULT_STORAGE : allowed[0];
  return { allowed, default: allowed.includes(configured.default) ? configured.default : fallback };
}

/**
 * The storage a new document uses: the one asked for, else the policy default, else local (or the
 * only storage the policy allows). The policy (`documents.storage: {allowed, default}`) may narrow
 * what a Story accepts.
 */
export function resolveDocumentStorage(requested, policy = {}) {
  const configured = policy?.storage ?? {};
  const kind = String(requested ?? documentStorageChoices(policy).default).trim().toLowerCase();
  if (PLANNED_STORAGE_KINDS.includes(kind)) {
    fail(`Keeping Story documents in ${kind} is not available yet. Use --store git to commit the document, or --store local to keep it on this machine only.`,
      'DOCUMENT_STORAGE_UNSUPPORTED', { storage: kind });
  }
  if (!DOCUMENT_STORAGE_KINDS.includes(kind)) {
    fail(`Unknown document storage '${requested}'. Choose git or local.`, 'DOCUMENT_STORAGE_INVALID', { storage: kind });
  }
  const allowed = Array.isArray(configured.allowed) && configured.allowed.length ? configured.allowed : DOCUMENT_STORAGE_KINDS;
  if (!allowed.includes(kind)) {
    fail(`This Story's document policy does not allow '${kind}' storage. Allowed: ${allowed.join(', ')}.`,
      'DOCUMENT_STORAGE_NOT_ALLOWED', { storage: kind, allowed: [...allowed] });
  }
  return kind;
}

/** Validate `documents.storage` in a workflow definition or work type. */
export function assertDocumentStoragePolicy(storage, label = 'documents.storage') {
  if (storage == null) return;
  if (typeof storage !== 'object' || Array.isArray(storage)) fail(`${label} must be an object with allowed and default.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  const allowed = storage.allowed ?? DOCUMENT_STORAGE_KINDS;
  if (!Array.isArray(allowed) || !allowed.length || allowed.some((kind) => !DOCUMENT_STORAGE_KINDS.includes(kind))) {
    fail(`${label}.allowed must list one or more of: ${DOCUMENT_STORAGE_KINDS.join(', ')}.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  }
  if (storage.default != null && !allowed.includes(storage.default)) {
    fail(`${label}.default '${storage.default}' is not one of ${label}.allowed.`, 'DOCUMENT_STORAGE_POLICY_INVALID');
  }
}
// Internal compatibility bindings used by native presentation/execution helpers.
export { DEFAULT_LIMITS as DEFAULT_SPECIFICATION_LIMITS };
