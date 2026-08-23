import { SingularityFlowError } from './util.mjs';

const CODE_DELIVERY_ARTIFACT_KINDS = new Set(['implementation-summary']);

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
