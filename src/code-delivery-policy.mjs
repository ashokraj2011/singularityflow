import { SingularityFlowError } from './util.mjs';

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
    requireExecutableSource: true, minimumDiscovered: 1, executionAssurance: 'module',
    stringCommands: 'reject', unknownModelPolicy: 'block', requireResultAdapter: true,
    requireAffectedModuleCoverage: true
  }),
  traceability: Object.freeze({
    source: 'pinned-spec-index', requireNamespaceQualifiedIds: true,
    bareIdCompatibility: 'unique-only'
  }),
  publication: Object.freeze({ idempotency: 'generation-intent' }),
  display: Object.freeze({ source: 'reference-preview', previewBytes: 4096, fullDocumentMaximumBytes: 65536 }),
  model: Object.freeze({ minimumAssurance: 'observed' })
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
      executionAssurance: enumValue(tests.executionAssurance, ['module', 'testcase-exact'], 'codeDelivery.tests.executionAssurance'),
      stringCommands: enumValue(tests.stringCommands, ['reject'], 'codeDelivery.tests.stringCommands'),
      unknownModelPolicy: enumValue(tests.unknownModelPolicy, ['block'], 'codeDelivery.tests.unknownModelPolicy'),
      requireResultAdapter: requiredBoolean(tests.requireResultAdapter, true, 'codeDelivery.tests.requireResultAdapter'),
      requireAffectedModuleCoverage: booleanValue(tests.requireAffectedModuleCoverage, 'codeDelivery.tests.requireAffectedModuleCoverage')
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
