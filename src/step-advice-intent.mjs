/**
 * A Story step's intent for its advice (step-advice.mjs), with the step-intent inference over the Story's steps when the
 * step names none and SFlow does not ship it. Apart from the table so the VS Code pages, which read only the table, never
 * bundle the inference.
 */
import { declaredIntent, GENERIC_INTENT, resolvedPhase, shipped, stepIntentOf } from './step-advice.mjs';

/** A step's intent: what it names, else the one SFlow ships, else the inference, else generic. Never throws. */
export async function storyStepIntent(workflow, phaseId) {
  const known = declaredIntent(workflow, phaseId) ?? shipped(phaseId);
  if (known) return known;
  try {
    const { inferStepIntents } = await import('./step-intents.mjs');
    const steps = (workflow?.phaseOrder ?? []).map((id) => {
      const phase = resolvedPhase(workflow, id) ?? workflow?.phases?.[id] ?? {};
      return { id, label: workflow?.phases?.[id]?.label ?? phase.label ?? id, agent: phase.agent ?? null,
        declared: declaredIntent(workflow, id), shipped: shipped(id),
        kind: phase.artifact?.kind ?? null, task: phase.generation?.task ?? null, writeScope: phase.writeScope ?? 'artifact-only',
        testEvidenceFrom: phase.testEvidenceFrom ?? null, repositoryTests: phase.repositoryTests ?? null };
    });
    return stepIntentOf(workflow, phaseId, inferStepIntents(steps).find((row) => row.step === phaseId)?.intent ?? null);
  } catch { return GENERIC_INTENT; }
}

