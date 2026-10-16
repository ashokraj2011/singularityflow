/** Typed phase references in validated markup contracts. Never rewrite arbitrary prose or IDs. */
export function remapMarkupPhase(original, remap) {
  const phase = structuredClone(original);
  if (phase.inputs) phase.inputs = phase.inputs.map(input => typeof input === 'string'
    ? remap(input) : { ...input, phase: remap(input.phase) });
  // The native schema declares one producer phase, not an array of producers.
  if (phase.testEvidenceFrom) phase.testEvidenceFrom = remap(phase.testEvidenceFrom);
  if (phase.approval?.rejectTo) phase.approval.rejectTo = phase.approval.rejectTo.map(remap);
  if (phase.repairBudget?.resetOnPhase) phase.repairBudget.resetOnPhase = remap(phase.repairBudget.resetOnPhase);
  return phase;
}

/** Rewrite only declared workflow reference fields; decisions have their own route/ID lowering. */
export function remapMarkupWorkflow(original, remap) {
  const workflow = structuredClone(original);
  if (workflow.plannedClaims?.clausePhases) workflow.plannedClaims.clausePhases = workflow.plannedClaims.clausePhases.map(remap);
  if (workflow.plannedClaims?.owners) workflow.plannedClaims.owners = Object.fromEntries(
    Object.entries(workflow.plannedClaims.owners).map(([code, owner]) => [remap(code), remap(owner)]));
  for (const key of ['phaseOverrides', 'templateOverrides']) if (workflow[key]) {
    workflow[key] = Object.fromEntries(Object.entries(workflow[key]).map(([phase, value]) => [
      remap(phase), key === 'phaseOverrides' ? remapMarkupPhase(value, remap) : value
    ]));
  }
  if (workflow.documents?.allowedPhases) workflow.documents.allowedPhases = workflow.documents.allowedPhases.map(remap);
  if (workflow.sourceReview?.phases) workflow.sourceReview.phases = workflow.sourceReview.phases.map(remap);
  if (workflow.reworkLoops) workflow.reworkLoops = workflow.reworkLoops.map(loop => ({ ...loop,
    from: remap(loop.from), to: remap(loop.to), ...(loop.resetOnPhase ? { resetOnPhase: remap(loop.resetOnPhase) } : {}) }));
  if (workflow.contextPolicy?.phaseOverrides) workflow.contextPolicy.phaseOverrides = Object.fromEntries(
    Object.entries(workflow.contextPolicy.phaseOverrides).map(([phase, value]) => [remap(phase), value]));
  if (workflow.designSources) {
    workflow.designSources.capturePhase = remap(workflow.designSources.capturePhase ?? 'design-intake');
    if (workflow.designSources.consumeIn) workflow.designSources.consumeIn = workflow.designSources.consumeIn.map(remap);
  }
  const stop = workflow.auto?.defaultUntil;
  if (stop && !['first-human-boundary', 'story-complete'].includes(stop)) {
    const [, milestone, phase] = /^(?:(published|submitted|phase-complete):)?(.+)$/u.exec(stop);
    workflow.auto.defaultUntil = `${milestone ? milestone + ':' : ''}${remap(phase)}`;
  }
  return workflow;
}
