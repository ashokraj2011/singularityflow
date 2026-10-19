/** Pure accepted input selection; no artifact loading, generation or publication imports. */

export function workflowInputsMode(workflow) {
  return workflow.resolution?.inputsMode ?? 'off';
}

export function resolvedPhaseInputs(workflow, phase) {
  return workflow.resolution?.phases?.find((candidate) => candidate.id === phase.id)?.inputs ?? phase.inputs ?? [];
}

export function approvedInputPhases(workflow, phase) {
  if (!workflow || !phase || workflowInputsMode(workflow) === 'off') return [];
  return [...new Set(resolvedPhaseInputs(workflow, phase)
    .map((entry) => typeof entry === 'string' ? entry : entry?.phase).filter(Boolean))];
}
