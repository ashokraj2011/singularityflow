/** Legacy host bridge. Configured preparation has one registered execution path. */

/**
 * Prepare one phase through its configured generator.
 *
 * Convergence is not a generic template: its deterministic artifact is a projection of the
 * implementation reconciliation and clause evidence. Both legacy entry points delegate to the
 * same operation so `next` and `prepare` cannot select different generators.
 */
export async function prepareConfiguredPhase(root, config, workflow, phase) {
  const {createGitPhasePreparationEngine}=await import('../../engine-compatibility/git-phase-entry.mjs');
  const binding=createGitPhasePreparationEngine({root,initialContext:{config,workflow}});
  await binding.engine.run('phase.prepare',{workId:workflow.workItem.id,phaseId:phase.id});
  return binding.presentation().prepared;
}
