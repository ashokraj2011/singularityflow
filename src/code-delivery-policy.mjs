import { SingularityFlowError } from './util.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';

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
    requireAffectedModuleCoverage: true,
    testcaseExact: Object.freeze({
      mode: 'disabled', adapter: null, requiredWitnessTypes: Object.freeze(['test']),
      evidenceTier: 'testcase-local-observed'
    })
  }),
  traceability: Object.freeze({
    source: 'pinned-spec-index', requireNamespaceQualifiedIds: true,
    bareIdCompatibility: 'unique-only'
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

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError(`${label} must be an object.`);
  }
  return value;
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new SingularityFlowError(
      `${label} contains unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`,
      { code: 'WEL_POLICY_UNSUPPORTED' }
    );
  }
}

function stringList(value, allowed, label) {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string')) {
    throw new SingularityFlowError(`${label} must be a non-empty string array.`);
  }
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (!normalized.length || normalized.some((item) => !allowed.includes(item))) {
    throw new SingularityFlowError(`${label} currently supports only: ${allowed.join(', ')}.`);
  }
  return normalized;
}

function normalizeTestcaseExactPolicy(value, defaults) {
  const source = value == null ? {} : plainObject(value, 'codeDelivery.tests.testcaseExact');
  rejectUnknownKeys(source, ['mode', 'adapter', 'requiredWitnessTypes', 'evidenceTier'], 'codeDelivery.tests.testcaseExact');
  const mode = enumValue(source.mode ?? defaults.mode, ['disabled', 'observe', 'enforce'], 'codeDelivery.tests.testcaseExact.mode');
  if (mode === 'enforce') {
    throw new SingularityFlowError(
      'codeDelivery.tests.testcaseExact.mode enforce is unavailable until an approved CAB execution profile and SGOS lifecycle bridge are configured. Use observe or disabled.',
      { code: 'WEL_ENFORCEMENT_UNAVAILABLE' }
    );
  }
  const adapter = source.adapter ?? defaults.adapter;
  if (adapter != null && adapter !== 'junit5-surefire-v1') {
    throw new SingularityFlowError(
      "codeDelivery.tests.testcaseExact.adapter currently supports only 'junit5-surefire-v1'.",
      { code: 'WEL_TEST_ADAPTER_UNSUPPORTED' }
    );
  }
  if (mode === 'observe' && adapter == null) {
    throw new SingularityFlowError(
      'codeDelivery.tests.testcaseExact.adapter is required when exact-test observation is enabled.',
      { code: 'WEL_TEST_ADAPTER_REQUIRED' }
    );
  }
  const evidenceTier = enumValue(
    source.evidenceTier ?? defaults.evidenceTier,
    ['testcase-local-observed'],
    'codeDelivery.tests.testcaseExact.evidenceTier'
  );
  return {
    mode,
    adapter,
    requiredWitnessTypes: stringList(
      source.requiredWitnessTypes ?? defaults.requiredWitnessTypes,
      ['test'],
      'codeDelivery.tests.testcaseExact.requiredWitnessTypes'
    ),
    evidenceTier
  };
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
  tests.testcaseExact = normalizeTestcaseExactPolicy(value.tests?.testcaseExact, defaults.tests.testcaseExact);
  const traceability = { ...defaults.traceability, ...(value.traceability ?? {}) };
  const publication = { ...defaults.publication, ...(value.publication ?? {}) };
  const display = { ...defaults.display, ...(value.display ?? {}) };
  const model = { ...defaults.model, ...(value.model ?? {}) };
  return {
    schemaVersion: 2,
    mode: enumValue(value.mode ?? defaults.mode, ['enforce'], 'codeDelivery.mode'),
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
      executionAssurance: enumValue(tests.executionAssurance, ['module', 'testcase-exact'], 'codeDelivery.tests.executionAssurance'),
      stringCommands: enumValue(tests.stringCommands, ['reject'], 'codeDelivery.tests.stringCommands'),
      unknownModelPolicy: enumValue(tests.unknownModelPolicy, ['block'], 'codeDelivery.tests.unknownModelPolicy'),
      requireResultAdapter: requiredBoolean(tests.requireResultAdapter, true, 'codeDelivery.tests.requireResultAdapter'),
      requireAffectedModuleCoverage: booleanValue(tests.requireAffectedModuleCoverage, 'codeDelivery.tests.requireAffectedModuleCoverage'),
      testcaseExact: tests.testcaseExact
    },
    traceability: {
      source: enumValue(traceability.source, ['pinned-spec-index'], 'codeDelivery.traceability.source'),
      requireNamespaceQualifiedIds: booleanValue(traceability.requireNamespaceQualifiedIds, 'codeDelivery.traceability.requireNamespaceQualifiedIds'),
      bareIdCompatibility: enumValue(traceability.bareIdCompatibility, ['unique-only'], 'codeDelivery.traceability.bareIdCompatibility')
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

/** One deterministic authoring route for every code task, independent of phase name. */
export function generationSkillForPhase(phase) {
  if (phase?.id === 'convergence' && phaseUsesDeterministicGeneration(phase)) return '/sflow-converge';
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
